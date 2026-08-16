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

    // 서버는 기존 link 필드 하나를 저장하므로 내부적으로 같은 필드에 미러링한다.
    // 둘 다 입력된 경우 사용자가 명시적으로 넣은 네이버 커넥트 링크를 우선한다.
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

  // 기존 app.js의 submit 핸들러보다 먼저 실행되도록 capture 단계에서 링크를 동기화한다.
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

  // 쿠팡 링크를 직접 다시 입력하면 네이버 커넥트 선택을 해제한다.
  coupangInput.addEventListener('input', () => {
    const current = coupangInput.value.trim();
    if (naverInput.value.trim() && current !== naverInput.value.trim()) {
      naverInput.value = '';
      lastMirroredNaver = '';
      if (msg) msg.textContent = '';
    }
  });
})();
