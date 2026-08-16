(() => {
  const form = document.getElementById('composeForm');
  if (!form) return;

  const panel = document.getElementById('threadsMaterialPanel');
  if (!panel) return;

  const h = panel.querySelector('h2');
  if (h) h.textContent = '🔥 소재 찾기';
  const hint = panel.querySelector('.hint');
  if (hint) hint.remove();

  const searchBtn = document.getElementById('threadsMaterialSearchBtn');
  const msg = document.getElementById('threadsMaterialMsg');
  const results = document.getElementById('threadsMaterialResults');
  if (!searchBtn || !msg || !results) return;
  searchBtn.textContent = '🔥 소재 찾기';

  let lastItems = [];
  let generatedTexts = [];
  let generatedComments = [];
  let activeRecipeComment = '';

  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const compact = t => {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    return t.length > 240 ? t.slice(0, 240) + '…' : t;
  };
  const setMsg = (text, type = '') => {
    msg.textContent = text || '';
    msg.className = `msg${type ? ' ' + type : ''}`;
  };
  const fetchWithTimeout = async (url, options = {}, ms = 22000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await apiFetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  function inferMode(item) {
    const t = String(item?.text || '').toLowerCase();
    return /(레시피|요리|먹|맛|볶|구이|밥|면|소스|재료|에어프라이어|간식|야식|대파|삼겹|양념|끓|굽|튀김|요거트|바나나|알룰로스|계란|두부|샐러드)/.test(t) ? 'recipe' : 'product';
  }

  function ensureRecipePreview() {
    let box = document.getElementById('threadsRecipeCommentPreview');
    if (box) return box;

    box = document.createElement('div');
    box.id = 'threadsRecipeCommentPreview';
    box.className = 'hidden';
    box.style.marginTop = '14px';
    box.innerHTML = `
      <label style="display:block;margin:0 0 7px;font-size:14px;font-weight:700;">댓글</label>
      <textarea id="threadsRecipeCommentText" rows="6" placeholder="재료 · 만드는 법 · 추가 설명이 여기에 들어갑니다" style="width:100%;box-sizing:border-box;resize:vertical;line-height:1.55;padding:14px;border-radius:14px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:inherit;"></textarea>
      <p style="margin:6px 0 0;font-size:12px;color:var(--text-dim);">예약 발행하면 본문 다음 댓글로 자동 등록됩니다.</p>`;

    const candidates = document.getElementById('aiCandidates');
    if (candidates?.parentNode) candidates.parentNode.insertBefore(box, candidates);
    else form.appendChild(box);

    const textarea = box.querySelector('#threadsRecipeCommentText');
    textarea?.addEventListener('input', () => {
      activeRecipeComment = textarea.value.trim();
    });
    return box;
  }

  function showComment(value) {
    activeRecipeComment = String(value || '').trim();
    const box = ensureRecipePreview();
    const textarea = document.getElementById('threadsRecipeCommentText');
    if (textarea) textarea.value = activeRecipeComment;
    box.classList.toggle('hidden', !activeRecipeComment);
  }

  function render(items) {
    lastItems = items || [];
    if (!lastItems.length) {
      results.innerHTML = '';
      setMsg('새 소재를 찾지 못했어요.');
      return;
    }
    setMsg(`${lastItems.length}개 소재 찾음`);
    results.innerHTML = lastItems.map((x, i) => `
      <div class="product-card" style="align-items:flex-start;gap:10px;">
        ${x.thumbnail ? `<img src="${esc(x.thumbnail)}" style="width:82px;height:82px;object-fit:cover;border-radius:12px;" onerror="this.style.display='none'">` : ''}
        <div class="p-info" style="min-width:0;flex:1;">
          <div style="font-size:12px;font-weight:700;margin-bottom:4px;">@${esc(x.username || 'threads')}</div>
          <div class="p-name" style="white-space:normal;line-height:1.45;">${esc(compact(x.text) || '소재')}</div>
          <div class="p-price" style="margin-top:5px;">${x.hasVideo ? '🎬 영상' : x.imageCount ? '🖼 사진' : '글'}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
            <button type="button" class="pick-btn threads-material-use" data-idx="${i}">이 소재로 글 만들기</button>
            <a class="btn-secondary" href="${esc(x.url)}" target="_blank" rel="noopener" style="padding:7px 10px;text-decoration:none;font-size:12px;">원문 보기</a>
          </div>
        </div>
      </div>`).join('');
    results.querySelectorAll('.threads-material-use').forEach(b => b.onclick = () => prepare(Number(b.dataset.idx), b));
  }

  async function search() {
    if (searchBtn.disabled) return;
    searchBtn.disabled = true;
    results.innerHTML = '';
    setMsg('새 소재를 찾는 중…');
    try {
      const r = await fetchWithTimeout('/api/threads/material-search?limit=10', {}, 22000);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '소재 찾기 실패');
      render(d.items || []);
    } catch (e) {
      if (e?.name === 'AbortError') setMsg('찾는 시간이 너무 길어 중단했어요. 다시 눌러주세요.', 'error');
      else setMsg('소재를 가져오지 못했어요. 잠시 후 다시 눌러주세요.', 'error');
    } finally {
      searchBtn.disabled = false;
    }
  }

  function selectVersion(i) {
    const ta = form.querySelector('textarea[name="text"]');
    if (generatedTexts[i] && ta) ta.value = generatedTexts[i];
    showComment(generatedComments[i] || '');
  }

  async function prepare(i, btn) {
    const item = lastItems[i];
    if (!item) return;
    const mode = inferMode(item);
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '준비 중…';
    setMsg(mode === 'recipe' ? '본문과 추가 설명을 확인하는 중…' : '새 글을 만드는 중…');
    try {
      const [wr, ir] = await Promise.allSettled([
        fetchWithTimeout('/api/threads/material-write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceText: item.text || '', sourceUrl: item.url || '', username: item.username || '', mode })
        }, 35000).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || '글 생성 실패'); return d; }),
        item.hasVideo ? fetchWithTimeout('/api/threads/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: item.url })
        }, 35000).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || '영상 가져오기 실패'); return d; }) : Promise.resolve(null)
      ]);

      const ta = form.querySelector('textarea[name="text"]');
      const box = document.getElementById('aiCandidates');
      if (wr.status !== 'fulfilled') throw new Error(wr.reason?.message || '글 생성 실패');
      generatedTexts = wr.value.texts || [];
      generatedComments = wr.value.comments || [];
      if (generatedTexts[0] && ta) ta.value = generatedTexts[0];
      showComment(generatedComments[0] || '');

      if (box && generatedTexts.length) {
        box.innerHTML = generatedTexts.map((t, n) => `<div class="ai-candidate ${n === 0 ? 'selected' : ''}" data-threads-idx="${n}"><span class="pick-label">버전 ${n + 1} · 클릭해서 교체</span><p style="white-space:pre-wrap;">${esc(t)}</p></div>`).join('');
        box.classList.remove('hidden');
        box.querySelectorAll('.ai-candidate').forEach(c => c.onclick = () => {
          box.querySelectorAll('.ai-candidate').forEach(z => z.classList.remove('selected'));
          c.classList.add('selected');
          selectVersion(Number(c.dataset.threadsIdx));
        });
      }

      if (ir.status === 'fulfilled' && ir.value?.url) {
        const v = document.getElementById('videoUrlInput');
        if (v) v.value = ir.value.url;
      } else if (!item.hasVideo && item.thumbnail) {
        const im = document.getElementById('imageUrlInput');
        if (im) im.value = item.thumbnail;
      }
      setMsg(`완료 · 완성글 ${generatedTexts.length}개를 만들었어요.`);
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setMsg('글 준비에 실패했어요. 다시 시도해주세요.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  form.addEventListener('submit', async e => {
    if (!activeRecipeComment) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const cm = document.getElementById('composeMsg');
    const sv = form.scheduled_at?.value;
    if (!sv) { if (cm) cm.textContent = '발행 예정 시각을 선택해주세요.'; return; }
    const body = {
      text: form.text.value,
      link: form.link.value,
      image_url: form.image_url.value,
      extra_image_url: form.extra_image_url.value,
      video_url: form.video_url.value,
      scheduled_at: new Date(sv).toISOString(),
      auto_comment_enabled: form.auto_comment_enabled.checked,
      recipe_comment_text: activeRecipeComment
    };
    try {
      const r = await apiFetch('/api/threads/material-post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '예약 실패');
      if (cm) cm.textContent = '예약 등록 완료 · 댓글도 함께 예약됐어요.';
      form.reset();
      activeRecipeComment = '';
      document.getElementById('threadsRecipeCommentPreview')?.classList.add('hidden');
      if (typeof loadDashboard === 'function') loadDashboard();
    } catch (err) {
      if (cm) cm.textContent = '오류: ' + err.message;
    }
  }, true);

  searchBtn.addEventListener('click', search);
})();
