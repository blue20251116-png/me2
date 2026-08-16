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
    } catch {
      return false;
    }
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
      if (lastMirroredNaver && coupangInput.value.trim() === lastMirroredNaver) {
        coupangInput.value = '';
      }
      lastMirroredNaver = '';
      if (msg) {
        msg.textContent = '';
        msg.className = 'msg';
      }
      return;
    }

    if (!isNaverUrl(url)) {
      if (msg) {
        msg.textContent = 'naver.me 또는 네이버 도메인의 커넥트 링크를 입력해주세요.';
        msg.className = 'msg error';
      }
      return;
    }

    coupangInput.value = url;
    lastMirroredNaver = url;
    if (msg) {
      msg.textContent = '네이버 커넥트 링크 적용됨 · 예약 발행 시 커넥트 고지문과 함께 댓글로 등록됩니다.';
      msg.className = 'msg';
    }
    renderPreview();
  }

  naverInput.addEventListener('input', syncNaverLink);
  naverInput.addEventListener('change', syncNaverLink);
  autoComment?.addEventListener('change', () => setTimeout(renderPreview, 0));

  form.addEventListener('submit', (e) => {
    const url = naverInput.value.trim();
    if (!url) return;
    if (!isNaverUrl(url)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (msg) {
        msg.textContent = '네이버 커넥트 링크 형식을 확인해주세요.';
        msg.className = 'msg error';
      }
      naverInput.focus();
      return;
    }
    coupangInput.value = url;
    lastMirroredNaver = url;
  }, true);

  coupangInput.addEventListener('input', () => {
    const current = coupangInput.value.trim();
    if (naverInput.value.trim() && current !== naverInput.value.trim()) {
      naverInput.value = '';
      lastMirroredNaver = '';
      if (msg) msg.textContent = '';
    }
  });
})();

// 쿠팡 API가 없어도 사용할 수 있는 Threads 소재 찾기 UI를 글 예약 탭에 추가한다.
(() => {
  if (document.getElementById('threadsMaterialSearchInput')) return;
  const panels = [...document.querySelectorAll('#tab-compose > .panel')];
  const shortsPanel = panels.find(p => p.querySelector('h2')?.textContent.includes('관련 쇼츠'));
  const composePanel = panels.find(p => p.querySelector('h2')?.textContent.includes('새 글 예약'));
  const anchor = shortsPanel || composePanel;
  if (!anchor?.parentElement) return;

  const panel = document.createElement('div');
  panel.className = 'panel narrow';
  panel.innerHTML = `
    <h2>Threads 소재 자동찾기</h2>
    <p class="hint">쿠팡 API 없이 Threads 공개 게시물에서 상품·레시피 소재를 찾고, 선택한 소재로 AI 글과 영상을 한 번에 준비합니다.</p>
    <label>종류
      <select id="threadsMaterialMode">
        <option value="product">상품/생활용품</option>
        <option value="recipe">레시피/요리</option>
      </select>
    </label>
    <div class="search-row">
      <input type="text" id="threadsMaterialSearchInput" placeholder="예: 폼롤러, 접이식 계단, 김치볶음밥" />
      <button type="button" id="threadsMaterialSearchBtn" class="btn-secondary">찾기</button>
    </div>
    <p id="threadsMaterialMsg" class="msg"></p>
    <div id="threadsMaterialResults" class="product-results"></div>
  `;
  anchor.parentElement.insertBefore(panel, anchor);

  const script = document.createElement('script');
  script.src = '/threadsMaterialUi.js';
  script.defer = true;
  document.body.appendChild(script);
})();
