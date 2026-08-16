(() => {
  const naverInput = document.getElementById('naverConnectInput');
  const coupangInput = document.getElementById('linkInput');
  const form = document.getElementById('composeForm');
  const autoComment = document.getElementById('autoCommentToggle');
  const previewBox = document.getElementById('commentPreview');
  const previewText = document.getElementById('commentPreviewText');
  const msg = document.getElementById('naverConnectMsg');
  if (!naverInput || !coupangInput || !form) return;

  const DISCLOSURE = '네이버 쇼핑 커넥트 활동을 통해 수수료를 제공받을 수 있습니다.';
  let lastMirroredNaver = '';

  function isNaverUrl(value) {
    try {
      const u = new URL(String(value || '').trim());
      if (u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      return h === 'naver.me' || h.endsWith('.naver.me') || h === 'naver.com' || h.endsWith('.naver.com');
    } catch { return false; }
  }

  function renderPreview() {
    const url = naverInput.value.trim();
    const enabled = !!autoComment?.checked;
    if (!url || !enabled) return;
    previewBox?.classList.remove('hidden');
    if (previewText) previewText.textContent = `${DISCLOSURE}\n${url}`;
  }

  function syncNaverLink() {
    const url = naverInput.value.trim();
    if (!url) {
      if (lastMirroredNaver && coupangInput.value.trim() === lastMirroredNaver) coupangInput.value = '';
      lastMirroredNaver = '';
      if (msg) { msg.textContent = ''; msg.className = 'msg'; }
      return;
    }
    if (!isNaverUrl(url)) {
      if (msg) { msg.textContent = 'naver.me 또는 네이버 도메인의 커넥트 링크를 입력해주세요.'; msg.className = 'msg error'; }
      return;
    }
    coupangInput.value = url;
    lastMirroredNaver = url;
    if (msg) { msg.textContent = '네이버 커넥트 링크 적용됨 · 예약 발행 시 커넥트 고지문과 함께 댓글로 등록됩니다.'; msg.className = 'msg'; }
    renderPreview();
  }

  naverInput.addEventListener('input', syncNaverLink);
  naverInput.addEventListener('change', syncNaverLink);
  autoComment?.addEventListener('change', () => setTimeout(renderPreview, 0));
  form.addEventListener('submit', (e) => {
    const url = naverInput.value.trim();
    if (!url) return;
    if (!isNaverUrl(url)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (msg) { msg.textContent = '네이버 커넥트 링크 형식을 확인해주세요.'; msg.className = 'msg error'; }
      naverInput.focus(); return;
    }
    coupangInput.value = url;
    lastMirroredNaver = url;
  }, true);

  coupangInput.addEventListener('input', () => {
    const current = coupangInput.value.trim();
    if (naverInput.value.trim() && current !== naverInput.value.trim()) {
      naverInput.value = ''; lastMirroredNaver = ''; if (msg) msg.textContent = '';
    }
  });
})();

// 기존 대시보드 마크업은 건드리지 않고 Threads 소재 패널만 런타임에 안전하게 추가한다.
(() => {
  if (document.getElementById('threadsMaterialSearchBtn')) return;
  const panels = [...document.querySelectorAll('#tab-compose > .panel')];
  const composePanel = panels.find(p => p.querySelector('h2')?.textContent.includes('새 글 예약'));
  if (!composePanel?.parentElement) return;

  const panel = document.createElement('div');
  panel.className = 'panel narrow';
  panel.innerHTML = `
    <h2>🔥 Threads 소재 자동찾기</h2>
    <p class="hint">검색어 입력 없이 자동으로 공개 Threads 소재를 찾습니다. 쿠팡 API가 없어도 사용할 수 있어요.</p>
    <label>소재 종류
      <select id="threadsMaterialMode">
        <option value="recipe">레시피/요리</option>
        <option value="product">상품/생활용품</option>
      </select>
    </label>
    <button type="button" id="threadsMaterialSearchBtn" class="btn-ai" style="width:100%;padding:12px;margin-top:6px;">🔥 소재 자동으로 찾기</button>
    <p id="threadsMaterialMsg" class="msg"></p>
    <div id="threadsMaterialResults" class="product-results"></div>
  `;
  composePanel.parentElement.insertBefore(panel, composePanel);

  const script = document.createElement('script');
  script.src = '/threadsMaterialUi.js?v=2';
  document.body.appendChild(script);
})();
