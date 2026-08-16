(() => {
  const searchInput = document.getElementById('threadsMaterialSearchInput');
  const searchBtn = document.getElementById('threadsMaterialSearchBtn');
  const modeSelect = document.getElementById('threadsMaterialMode');
  const msg = document.getElementById('threadsMaterialMsg');
  const results = document.getElementById('threadsMaterialResults');
  if (!searchInput || !searchBtn || !results) return;

  let lastItems = [];

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

  async function prepareMaterial(idx, btn) {
    const item = lastItems[idx];
    if (!item) return;
    const keyword = searchInput.value.trim();
    const mode = modeSelect?.value === 'recipe' ? 'recipe' : 'product';
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '준비 중…';
    setMsg('AI 글 작성 + 영상 가져오기 진행 중…');

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
        const texts = writeResult.value.texts || [];
        if (texts[0] && textArea) textArea.value = texts[0];
        if (candidatesBox && texts.length) {
          candidatesBox.innerHTML = texts.map((t, i) => `
            <div class="ai-candidate ${i === 0 ? 'selected' : ''}" data-threads-idx="${i}">
              <span class="pick-label">Threads 소재 버전 ${i + 1} · 클릭해서 교체</span>
              <p>${esc(t)}</p>
            </div>`).join('');
          candidatesBox.classList.remove('hidden');
          candidatesBox.querySelectorAll('.ai-candidate').forEach(card => {
            card.addEventListener('click', () => {
              candidatesBox.querySelectorAll('.ai-candidate').forEach(c => c.classList.remove('selected'));
              card.classList.add('selected');
              if (textArea) textArea.value = texts[Number(card.dataset.threadsIdx)];
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
      if (writeOk && videoOk) setMsg('완료 · 새 글 예약에 AI 본문과 Threads 영상이 채워졌어요');
      else if (writeOk) setMsg(`글은 완성됐어요. 영상은 못 가져왔습니다: ${importResult.reason?.message || '영상 없음'}`);
      else if (videoOk) setMsg(`영상은 가져왔어요. 글 생성은 실패했습니다: ${writeResult.reason?.message || 'AI 오류'}`, 'error');
      else throw new Error(`${writeResult.reason?.message || '글 생성 실패'} / ${importResult.reason?.message || '영상 가져오기 실패'}`);

      document.getElementById('composeForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setMsg('준비 실패: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  searchBtn.addEventListener('click', search);
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search();
    }
  });
})();
