// 대시보드: 연결·API 키 설정, 로그인 회원 정보와 로그아웃.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global activeAccountId, apiFetch, disclosureTemplate:writable, updateCommentPreview, updateCurrentAccountLabel */

// ---- 설정 저장 ----
async function loadSettings() {
  if (!activeAccountId) return;
  const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`);
  const data = await res.json();

  updateCurrentAccountLabel();
  document.getElementById('renameAccountForm').label.value = '';
  document.getElementById('renameAccountForm').label.placeholder = data.label || '';

  const form = document.getElementById('settingsForm');
  form.THREADS_APP_ID.value = data.THREADS_APP_ID;
  form.THREADS_REDIRECT_URI.value = data.THREADS_REDIRECT_URI;
  form.THREADS_APP_SECRET.placeholder = data.hasThreadsSecret ? '저장됨 (변경 시에만 입력)' : '';

  const cForm = document.getElementById('coupangForm');
  cForm.COUPANG_ACCESS_KEY.value = data.COUPANG_ACCESS_KEY || '';
  cForm.COUPANG_SUB_ID.value = data.COUPANG_SUB_ID || '';
  cForm.COUPANG_SECRET_KEY.placeholder = data.hasCoupangSecret ? '저장됨 (변경 시에만 입력)' : '';

  const aForm = document.getElementById('anthropicForm');
  aForm.ANTHROPIC_API_KEY.placeholder = data.hasAnthropicKey
    ? '저장됨 (변경 시에만 입력)'
    : 'sk-... (변경 시에만 입력)';

  const nForm = document.getElementById('naverForm');
  nForm.NAVER_CLIENT_ID.value = data.NAVER_CLIENT_ID || '';
  nForm.NAVER_CLIENT_SECRET.placeholder = data.hasNaverSecret ? '저장됨 (변경 시에만 입력)' : '';

  disclosureTemplate = data.COUPANG_DISCLOSURE_TEMPLATE || '';
  document.getElementById('disclosureForm').template.value = disclosureTemplate;

  document.getElementById('connectBtn').href = `/auth/login?accountId=${activeAccountId}`;
}

document.getElementById('anthropicForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('anthropicMsg');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ANTHROPIC_API_KEY: form.ANTHROPIC_API_KEY.value,
      }),
    });
    if (!res.ok) throw new Error('저장 실패');
    msg.textContent = '저장 완료';
    msg.className = 'msg';
    form.reset();
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

async function clearAiKey(clearField) {
  const msg = document.getElementById('anthropicMsg');
  if (!confirm('이 키를 지울까요?')) return;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [clearField]: true }),
    });
    if (!res.ok) throw new Error('삭제 실패');
    msg.textContent = '삭제 완료';
    msg.className = 'msg';
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
}

document.getElementById('clearAnthropicKeyBtn').addEventListener('click', () => clearAiKey('CLEAR_ANTHROPIC_KEY'));

document.getElementById('naverForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('naverMsg');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        NAVER_CLIENT_ID: form.NAVER_CLIENT_ID.value,
        NAVER_CLIENT_SECRET: form.NAVER_CLIENT_SECRET.value,
      }),
    });
    if (!res.ok) throw new Error('저장 실패');
    msg.textContent = '저장 완료';
    msg.className = 'msg';
    form.NAVER_CLIENT_SECRET.value = '';
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('clearNaverKeyBtn').addEventListener('click', async () => {
  const msg = document.getElementById('naverMsg');
  if (!confirm('네이버 API 키를 지울까요?')) return;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CLEAR_NAVER_KEY: true }),
    });
    if (!res.ok) throw new Error('삭제 실패');
    msg.textContent = '삭제 완료';
    msg.className = 'msg';
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('coupangForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('coupangMsg');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        COUPANG_ACCESS_KEY: form.COUPANG_ACCESS_KEY.value,
        COUPANG_SECRET_KEY: form.COUPANG_SECRET_KEY.value,
        COUPANG_SUB_ID: form.COUPANG_SUB_ID.value,
      }),
    });
    if (!res.ok) throw new Error('저장 실패');
    msg.textContent = '저장 완료';
    msg.className = 'msg';
    loadSettings();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('disclosureForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.getElementById('disclosureMsg');
  const template = e.target.template.value;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/disclosure-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    disclosureTemplate = template;
    msg.textContent = '템플릿 저장 완료';
    msg.className = 'msg';
    updateCommentPreview();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  await apiFetch(`/api/accounts/${activeAccountId}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      THREADS_APP_ID: form.THREADS_APP_ID.value,
      THREADS_APP_SECRET: form.THREADS_APP_SECRET.value,
      THREADS_REDIRECT_URI: form.THREADS_REDIRECT_URI.value,
    }),
  });
  loadSettings();
  alert('저장되었습니다');
});

// ---- 로그인 회원 정보 / 로그아웃 ----
async function loadMe() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const me = await res.json();
    document.getElementById('myUserEmail').textContent = me.email;
    if (me.role === 'admin') {
      document.getElementById('adminLink').classList.remove('hidden');
    }
  } catch {
    /* 무시 — 로그인 정보 표시는 부가 기능이라 실패해도 나머지 화면은 그대로 씀 */
  }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});
