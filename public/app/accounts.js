// 대시보드: 계정 전환·탭·연결 상태·대시보드 숫자. apiFetch/activeAccountId는 다른 화면 스크립트도 씀.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global loadAutopilotStatus, loadPosts, loadReachReport, loadSettings */

// ================= 계정(멀티 계정) 관리 =================
let accounts = [];
let activeAccountId = Number(localStorage.getItem('activeAccountId')) || null;

// accountId를 항상 붙여서 fetch하는 헬퍼
async function apiFetch(url, options = {}) {
  const hasQuery = url.includes('?');
  const withAccount = activeAccountId ? `${url}${hasQuery ? '&' : '?'}accountId=${activeAccountId}` : url;
  return fetch(withAccount, options);
}

async function loadAccounts() {
  const res = await fetch('/api/accounts');
  accounts = await res.json();

  if (!accounts.length) {
    // 계정이 하나도 없으면 처음 쓰는 것이므로 기본 계정 하나 자동 생성
    const created = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '계정 1' }),
    }).then(r => r.json());
    activeAccountId = created.id;
    localStorage.setItem('activeAccountId', activeAccountId);
    accounts = await fetch('/api/accounts').then(r => r.json());
  }

  if (!activeAccountId || !accounts.find(a => a.id === activeAccountId)) {
    activeAccountId = accounts[0].id;
    localStorage.setItem('activeAccountId', activeAccountId);
  }

  renderAccountStrip();
}

function renderAccountStrip() {
  const strip = document.getElementById('accountStrip');
  strip.innerHTML = accounts
    .map(
      a => `
    <button class="account-chip ${a.id === activeAccountId ? 'active' : ''} ${a.connected ? 'connected' : ''}" data-id="${a.id}">
      <span class="dot"></span>${escapeHtml(a.label)}
    </button>`
    )
    .join('');

  if (accounts.length < 5) {
    strip.innerHTML += `<button class="account-chip add-chip" id="addAccountChip">+ 계정 추가</button>`;
  }

  strip.querySelectorAll('.account-chip[data-id]').forEach(chip => {
    chip.addEventListener('click', () => switchAccount(Number(chip.dataset.id)));
  });

  const addChip = document.getElementById('addAccountChip');
  if (addChip) addChip.addEventListener('click', addAccount);
}

async function switchAccount(id) {
  if (id === activeAccountId) return;
  activeAccountId = id;
  localStorage.setItem('activeAccountId', id);
  renderAccountStrip();
  await refreshActiveTabData();
}

async function addAccount() {
  const label = prompt('새 계정 이름을 입력하세요 (예: 젠틀블루)');
  if (!label || !label.trim()) return;
  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: label.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '계정 추가 실패');
    return;
  }
  activeAccountId = data.id;
  localStorage.setItem('activeAccountId', activeAccountId);
  await loadAccounts();
  await refreshActiveTabData();
}

async function refreshActiveTabData() {
  loadConnectionStatus();
  loadDashboard();
  loadSettings();
  loadAutopilotStatus();
  const activeTab = document.querySelector('.nav-btn.active')?.dataset.tab;
  if (activeTab === 'posts') loadPosts();
}

// ---- 계정 이름 변경/삭제 (연결 설정 탭) ----
document.getElementById('renameAccountForm').addEventListener('submit', async e => {
  e.preventDefault();
  const label = e.target.label.value.trim();
  const msg = document.getElementById('accountManageMsg');
  if (!label) return;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    msg.textContent = '이름 변경 완료';
    msg.className = 'msg';
    await loadAccounts();
    updateCurrentAccountLabel();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
  const account = accounts.find(a => a.id === activeAccountId);
  if (!account) return;
  if (!confirm(`"${account.label}" 계정을 삭제할까요? 이 계정의 예약/발행 기록도 모두 함께 삭제됩니다.`)) return;

  await apiFetch(`/api/accounts/${activeAccountId}`, { method: 'DELETE' });
  localStorage.removeItem('activeAccountId');
  activeAccountId = null;
  await loadAccounts();
  await refreshActiveTabData();
});

function updateCurrentAccountLabel() {
  const account = accounts.find(a => a.id === activeAccountId);
  document.getElementById('currentAccountLabel').textContent = account?.label || '–';
}

// ---- 탭 전환 (하단 네비게이션) ----
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    document.querySelector('.app-content').scrollTop = 0;
    if (btn.dataset.tab === 'posts') loadPosts();
  });
});

// ---- 연결 상태 ----
async function loadConnectionStatus() {
  const el = document.getElementById('connStatus');
  if (!activeAccountId) return;
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/connection-status`);
    const data = await res.json();
    if (data.connected) {
      el.textContent = `연결됨${data.username ? ' · @' + data.username : ''}`;
      el.className = 'conn-badge conn-yes';
    } else {
      el.textContent = '스레드 계정 미연결 · 연결 설정 탭 확인';
      el.className = 'conn-badge conn-no';
    }
  } catch {
    el.textContent = '상태 확인 실패';
    el.className = 'conn-badge conn-no';
  }
}

// ---- 대시보드 데이터 ----
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadDashboard() {
  if (!activeAccountId) return;
  if (typeof loadReachReport === 'function') loadReachReport().catch(() => {});
  const res = await apiFetch('/api/dashboard');
  const data = await res.json();

  document.getElementById('statPending').textContent = data.pendingToday;
  document.getElementById('statNextTime').textContent = data.nextPost
    ? `다음 ${fmtTime(data.nextPost.scheduled_at)}`
    : '예정된 글 없음';

  document.getElementById('statPosted').textContent = data.postedTodayCount;
  document.getElementById('statTotal').textContent = `전체 예약 ${data.totalScheduled}개`;

  document.getElementById('statViews').textContent = data.totalViews.toLocaleString('ko-KR');
  document.getElementById('statViewsSub').textContent = `${data.postedTodayCount}개 글 합계`;

  document.getElementById('panelHeadSummary').textContent = `완료 ${data.postedTodayCount} · 예정 ${data.pendingToday}`;

  const grid = document.getElementById('hourlyGrid');
  grid.innerHTML = '';
  data.hourly.forEach(h => {
    const cell = document.createElement('div');
    cell.className = `hour-cell ${h.count > 0 ? 'has-posts' : 'empty'}`;
    cell.innerHTML = `
      <div class="h-label">${String(h.hour).padStart(2, '0')}</div>
      <div class="h-count">${h.count > 0 ? h.count : '–'}</div>
    `;
    grid.appendChild(cell);
  });

  const detail = document.getElementById('hourDetail');
  if (data.postedToday.length) {
    detail.innerHTML =
      '오늘 발행: ' +
      data.postedToday
        .map(p => `${escapeHtml(fmtTime(p.posted_at))} · 조회 ${Number(p.insights?.views) || 0}`)
        .join(' &nbsp;|&nbsp; ');
  } else {
    detail.textContent = '오늘 아직 발행된 글이 없습니다.';
  }
}
