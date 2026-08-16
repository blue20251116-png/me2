(() => {
  const searchInput = document.getElementById('threadsMaterialSearchInput');
  const searchBtn = document.getElementById('threadsMaterialSearchBtn');
  const modeSelect = document.getElementById('threadsMaterialMode');
  const msg = document.getElementById('threadsMaterialMsg');
  const results = document.getElementById('threadsMaterialResults');
  const form = document.getElementById('composeForm');
  if (!searchInput || !searchBtn || !results || !form) return;

  let lastItems = [];
  let generatedTexts = [];
  let generatedComments = [];
  let activeRecipeComment = '';

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function setMsg(text, type = '') {
    msg.textContent = text || '';
    msg.className = `msg${type ? ' ' + type : ''}`;
  }

  function compactText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 220 ? t.slice(0, 220) + '…' : t;
  }

  function ensureRecipePreview() {
    let box = document.getElementById('threadsRecipeCommentPreview');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'threadsRecipeCommentPreview';
    box.className = 'comment-preview hidden';
    box.style.marginTop = '10px';
    box.innerHTML = `
      <span class="comment-preview-label">2/2 재료 · 만드는 법 댓글</span>
      <p id="threadsRecipeCommentText" style="white-space:pre-wrap;line-height:1.55;"></p>
      <p style="margin:8px 0 0;font-size:12px;color:#777;">네이버 커넥트 링크를 넣으면 이 댓글 아래에 고지문과 링크가 자동으로 붙어요.</p>
    `;
    const candidates = document.getElementById('aiCandidates');
    if (candidates?.parentNode) candidates.parentNode.insertBefore(box, candidates.nextSibling);
    return box;
  }

  function showRecipeComment(comment) {
    activeRecipeComment = String(comment || '').trim();
    const box = ensureRecipePreview();
    const text = document.getElementById('threadsRecipeCommentText');
    if (!activeRecipeComment) {
      box.classList.add('hidden');
      if (text) text.textContent = '';
      return;
    }
    if (text) text.textContent = activeRecipeComment;
    box.classList.remove('hidden');
  }

  function render(items) {
    lastItems = items || [];
    if (!lastItems.length) {
      results.innerHTML = '';
      setMsg('검색 결과를 찾지 못했어요. 검색어를 조금 다르게 넣어보세요.');
      return;
    }
    setMsg(`${lastItems.length}개 소재 찾음 · 원하는 소재를 골라주세요`);
    results.innerHTML = lastItems.map((item, i) => `
      <div class="product-card" style="align-items:flex-start; gap:10px;">
        ${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" style="width:82px;height:82px;object-fit:cover;border-radius:12px;" onerror="this.style.display='none'" />` : ''}
        <div class="p-info" style="min-width:0;flex:1;">
          <div class="p-name" style="white-space:normal;line-height:1.45;">${esc(compactText(item.text) || 'Threads 공개 게시물')}</div>
          <div class="p-price" style="margin-top:5px;">${item.hasVideo ? '🎬 영상 감지' : 'Threads 소재'}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
            <button type="button" class="pick-btn threads-material-use" data-idx="${i}">AI 글 + 영상 준비</button>
            <a class="btn-secondary" href="${esc(item.url)}" target="_blank" rel="noopener" style="padding:7px 10px;text-decoration:none;font-size:12px;">원문 보기</a>
          </div>
        </div>
      </div>
    `).join('');

    results.querySelectorAll('.threads-material-use').forEach(btn => {
      btn.addEventListener('click', () => prepareMaterial(Number(btn.dataset.idx), btn));
    });
  }

  async function search() {
    const keyword = searchInput.value.trim();
    if (!keyword) return setMsg('검색어를 입력해주세요.', 'error');
    searchBtn.disabled = true;
    results.innerHTML = '';
    setMsg('Threads에서 소재 찾는 중…');
    try {
      const res = await apiFetch(`/api/threads/material-search?keyword=${encodeURIComponent(keyword)}&limit=10`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '검색 실패');
      render(data.items || []);
    } catch (err) {
      setMsg('검색 실패: ' + err.message, 'error');
    } finally {
      searchBtn.disabled = false;
    }
  }

  function selectGeneratedVersion(index) {
    const textArea = document.querySelector('#composeForm textarea[name="text"]');
    if (generatedTexts[index] && textArea) textArea.value = generatedTexts[index];
    showRecipeComment(generatedComments[index] || '');
  }

  async function prepareMaterial(idx, btn) {
    const item = lastItems[idx];
    if (!item) return;
    const keyword = searchInput.value.trim();
    const mode = modeSelect?.value === 'recipe' ? 'recipe' : 'product';
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '준비 중…';
    setMsg(mode === 'recipe' ? '본문 + 재료댓글 + 영상 준비 중…' : 'AI 글 작성 + 영상 가져오기 진행 중…');

    try {
      const [writeResult, importResult] = await Promise.allSettled([
        apiFetch('/api/threads/material-write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword, sourceText: item.text || '', mode }),
        }).then(async r => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'AI 글 생성 실패');
          return d;
        }),
        apiFetch('/api/threads/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.url }),
        }).then(async r => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || '영상 가져오기 실패');
          return d;
        }),
      ]);

      const textArea = document.querySelector('#composeForm textarea[name="text"]');
      const candidatesBox = document.getElementById('aiCandidates');
      if (writeResult.status === 'fulfilled') {
        generatedTexts = writeResult.value.texts || [];
        generatedComments = writeResult.value.comments || [];
        if (generatedTexts[0] && textArea) textArea.value = generatedTexts[0];
        showRecipeComment(mode === 'recipe' ? (generatedComments[0] || '') : '');

        if (candidatesBox && generatedTexts.length) {
          candidatesBox.innerHTML = generatedTexts.map((t, i) => `
            <div class="ai-candidate ${i === 0 ? 'selected' : ''}" data-threads-idx="${i}">
              <span class="pick-label">버전 ${i + 1} · 클릭해서 교체${mode === 'recipe' ? ' (댓글도 같이 바뀜)' : ''}</span>
              <p style="white-space:pre-wrap;">${esc(t)}</p>
            </div>`).join('');
          candidatesBox.classList.remove('hidden');
          candidatesBox.querySelectorAll('.ai-candidate').forEach(card => {
            card.addEventListener('click', () => {
              candidatesBox.querySelectorAll('.ai-candidate').forEach(c => c.classList.remove('selected'));
              card.classList.add('selected');
              selectGeneratedVersion(Number(card.dataset.threadsIdx));
            });
          });
        }
      }

      if (importResult.status === 'fulfilled') {
        const videoInput = document.getElementById('videoUrlInput');
        const imageInput = document.getElementById('imageUrlInput');
        const extraInput = document.getElementById('extraImageUrlInput');
        if (videoInput) videoInput.value = importResult.value.url || '';
        if (imageInput) imageInput.value = '';
        if (extraInput) extraInput.value = '';
      }

      const writeOk = writeResult.status === 'fulfilled';
      const videoOk = importResult.status === 'fulfilled';
      if (writeOk && videoOk) {
        setMsg(mode === 'recipe'
          ? '완료 · 본문 + 2/2 재료댓글 + Threads 영상까지 채웠어요'
          : '완료 · 새 글 예약에 AI 본문과 Threads 영상이 채워졌어요');
      } else if (writeOk) {
        setMsg(`글은 완성됐어요. 영상은 못 가져왔습니다: ${importResult.reason?.message || '영상 없음'}`);
      } else if (videoOk) {
        setMsg(`영상은 가져왔어요. 글 생성은 실패했습니다: ${writeResult.reason?.message || 'AI 오류'}`, 'error');
      } else {
        throw new Error(`${writeResult.reason?.message || '글 생성 실패'} / ${importResult.reason?.message || '영상 가져오기 실패'}`);
      }

      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setMsg('준비 실패: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  // 레시피 소재에서 생성한 2/2 댓글이 있을 때는 전용 예약 API를 써서 댓글까지 DB에 함께 저장한다.
  // capture 단계에서 기존 app.js submit보다 먼저 잡는다.
  form.addEventListener('submit', async (e) => {
    if (!activeRecipeComment) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    const composeMsg = document.getElementById('composeMsg');
    const scheduledValue = form.scheduled_at?.value;
    if (!scheduledValue) {
      if (composeMsg) {
        composeMsg.textContent = '발행 예정 시각을 선택해주세요.';
        composeMsg.className = 'msg error';
      }
      return;
    }

    const body = {
      text: form.text.value,
      link: form.link.value,
      image_url: form.image_url.value,
      extra_image_url: form.extra_image_url.value,
      video_url: form.video_url.value,
      scheduled_at: new Date(scheduledValue).toISOString(),
      auto_comment_enabled: form.auto_comment_enabled.checked,
      recipe_comment_text: activeRecipeComment,
    };

    try {
      if (composeMsg) {
        composeMsg.textContent = '본문 + 재료댓글 예약 중…';
        composeMsg.className = 'msg';
      }
      const res = await apiFetch('/api/threads/material-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '예약 실패');

      if (composeMsg) {
        composeMsg.textContent = '예약 등록 완료 · 본문 발행 후 2/2 재료댓글도 자동 등록됩니다.';
        composeMsg.className = 'msg';
      }
      form.reset();
      generatedTexts = [];
      generatedComments = [];
      activeRecipeComment = '';
      document.getElementById('aiCandidates')?.classList.add('hidden');
      const preview = document.getElementById('threadsRecipeCommentPreview');
      preview?.classList.add('hidden');
      document.getElementById('videoPreviewBox')?.classList.add('hidden');
      document.getElementById('imagePreviewBox')?.classList.add('hidden');
      if (typeof updateCommentPreview === 'function') updateCommentPreview();
      if (typeof loadDashboard === 'function') loadDashboard();
    } catch (err) {
      if (composeMsg) {
        composeMsg.textContent = '오류: ' + err.message;
        composeMsg.className = 'msg error';
      }
    }
  }, true);

  searchBtn.addEventListener('click', search);
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search();
    }
  });
})();
