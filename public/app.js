// ================= 계정(멀티 계정) 관리 =================
let accounts = [];
let activeAccountId = Number(localStorage.getItem('activeAccountId')) || null;

function qs(params) {
  return new URLSearchParams(params).toString();
}

// accountId를 항상 붙여서 fetch하는 헬퍼
async function apiFetch(url, options = {}) {
  const hasQuery = url.includes('?');
  const withAccount = activeAccountId
    ? `${url}${hasQuery ? '&' : '?'}accountId=${activeAccountId}`
    : url;
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
    }).then((r) => r.json());
    activeAccountId = created.id;
    localStorage.setItem('activeAccountId', activeAccountId);
    accounts = await fetch('/api/accounts').then((r) => r.json());
  }

  if (!activeAccountId || !accounts.find((a) => a.id === activeAccountId)) {
    activeAccountId = accounts[0].id;
    localStorage.setItem('activeAccountId', activeAccountId);
  }

  renderAccountStrip();
}

function renderAccountStrip() {
  const strip = document.getElementById('accountStrip');
  strip.innerHTML = accounts
    .map(
      (a) => `
    <button class="account-chip ${a.id === activeAccountId ? 'active' : ''} ${a.connected ? 'connected' : ''}" data-id="${a.id}">
      <span class="dot"></span>${a.label}
    </button>`
    )
    .join('');

  if (accounts.length < 5) {
    strip.innerHTML += `<button class="account-chip add-chip" id="addAccountChip">+ 계정 추가</button>`;
  }

  strip.querySelectorAll('.account-chip[data-id]').forEach((chip) => {
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
document.getElementById('renameAccountForm').addEventListener('submit', async (e) => {
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
  const account = accounts.find((a) => a.id === activeAccountId);
  if (!account) return;
  if (!confirm(`"${account.label}" 계정을 삭제할까요? 이 계정의 예약/발행 기록도 모두 함께 삭제됩니다.`)) return;

  await apiFetch(`/api/accounts/${activeAccountId}`, { method: 'DELETE' });
  localStorage.removeItem('activeAccountId');
  activeAccountId = null;
  await loadAccounts();
  await refreshActiveTabData();
});

function updateCurrentAccountLabel() {
  const account = accounts.find((a) => a.id === activeAccountId);
  document.getElementById('currentAccountLabel').textContent = account?.label || '–';
}

// ---- 탭 전환 (하단 네비게이션) ----
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
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

  document.getElementById('panelHeadSummary').textContent =
    `완료 ${data.postedTodayCount} · 예정 ${data.pendingToday}`;

  const grid = document.getElementById('hourlyGrid');
  grid.innerHTML = '';
  data.hourly.forEach((h) => {
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
        .map((p) => `${fmtTime(p.posted_at)} · 조회 ${p.insights?.views ?? 0}`)
        .join(' &nbsp;|&nbsp; ');
  } else {
    detail.textContent = '오늘 아직 발행된 글이 없습니다.';
  }
}

// ---- 현재 상품 컨텍스트 (AI 글 생성에 사용) ----
let currentProduct = { name: '', price: null };

// ---- AI로 본문 자동 생성 (5개 후보 중 선택) ----
async function runAiGenerate() {
  const btn = document.getElementById('aiGenerateBtn');
  const status = document.getElementById('aiGenerateStatus');
  const textArea = document.querySelector('#composeForm textarea[name="text"]');
  const candidatesBox = document.getElementById('aiCandidates');

  const productName = currentProduct.name || textArea.value.trim();
  if (!productName) {
    status.textContent = '먼저 상품을 검색하거나 링크를 넣어주세요';
    status.className = 'ai-status error';
    return false;
  }

  btn.disabled = true;
  status.textContent = '5개 작성 중…';
  status.className = 'ai-status';
  candidatesBox.classList.add('hidden');
  candidatesBox.innerHTML = '';

  try {
    const res = await apiFetch('/api/generate-caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName,
        price: currentProduct.price,
        target: document.getElementById('composeTargetSelect').value,
        youtubeSource: selectedYoutubeSource || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    candidatesBox.innerHTML = data.texts
      .map(
        (t, i) => `
      <div class="ai-candidate" data-idx="${i}">
        <span class="pick-label">버전 ${i + 1} · 클릭하면 본문에 채워짐</span>
        <p>${t.replace(/</g, '&lt;')}</p>
      </div>`
      )
      .join('');
    candidatesBox.classList.remove('hidden');

    candidatesBox.querySelectorAll('.ai-candidate').forEach((card) => {
      card.addEventListener('click', () => {
        candidatesBox.querySelectorAll('.ai-candidate').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        textArea.value = data.texts[Number(card.dataset.idx)];
      });
    });

    // 자동완성 흐름에서는 첫 번째 버전을 기본으로 바로 채워줌 (원하면 다른 버전으로 클릭해서 교체 가능)
    textArea.value = data.texts[0];
    candidatesBox.querySelector('.ai-candidate')?.classList.add('selected');

    status.textContent = `${data.texts.length}개 완성 · 마음에 드는 걸 눌러서 본문에 채우세요`;
    status.className = 'ai-status ok';
    return true;
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
    return false;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('aiGenerateBtn').addEventListener('click', runAiGenerate);

// ---- 쿠팡파트너스 상품 검색 ----
function fmtPrice(n) {
  if (n === null || n === undefined) return '';
  return Number(n).toLocaleString('ko-KR') + '원';
}

async function searchCoupangProducts() {
  const keyword = document.getElementById('productSearchInput').value.trim();
  const msg = document.getElementById('productSearchMsg');
  const resultsBox = document.getElementById('productResults');
  if (!keyword) return;

  msg.textContent = '검색 중…';
  msg.className = 'msg';
  resultsBox.innerHTML = '';

  try {
    const res = await apiFetch(`/api/coupang/search?keyword=${encodeURIComponent(keyword)}&limit=8`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    if (!data.products.length) {
      msg.textContent = '검색 결과가 없어요';
      return;
    }
    msg.textContent = `${data.products.length}개 상품 찾음 · 원하는 상품을 선택하세요`;

    resultsBox.innerHTML = data.products
      .map(
        (p, i) => `
      <div class="product-card">
        <img src="${p.image}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="p-info">
          <div class="p-name">${(p.name || '').replace(/</g, '&lt;')}</div>
          <div class="p-price">${fmtPrice(p.price)}</div>
        </div>
        <button type="button" class="pick-btn" data-idx="${i}">이 상품 선택</button>
      </div>`
      )
      .join('');

    resultsBox.querySelectorAll('.pick-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = data.products[Number(btn.dataset.idx)];
        applyPickedProduct(p);
      });
    });
  } catch (err) {
    msg.textContent = '검색 실패: ' + err.message;
    msg.className = 'msg error';
  }
}

// ---- 🔥 관련 쇼츠 찾기 (YouTube 콘텐츠 소싱 — 다운로드 아님, 소재 탐색용) ----
let selectedYoutubeSource = null;
// 같은 키워드+정렬로 짧은 시간 내 반복 검색하면 API 쿼터를 아끼기 위해 프론트 메모리에만 잠깐 캐시
const youtubeSearchCache = new Map();
const YOUTUBE_CACHE_TTL_MS = 2 * 60 * 1000;

function fmtViews(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${Math.round(num / 10000)}만`;
  if (num >= 10000) return `${(num / 10000).toFixed(1)}만`;
  return num.toLocaleString('ko-KR');
}

function fmtYoutubeDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function renderSelectedYoutubeSource() {
  const box = document.getElementById('youtubeSourceBox');
  if (!selectedYoutubeSource) {
    box.classList.add('hidden');
    return;
  }
  document.getElementById('youtubeSourceTitle').textContent = selectedYoutubeSource.title || '';
  document.getElementById('youtubeSourceChannel').textContent = selectedYoutubeSource.channelTitle || '';
  box.classList.remove('hidden');
}

function renderYoutubeResults(videos) {
  const msg = document.getElementById('youtubeSearchMsg');
  const resultsBox = document.getElementById('youtubeResults');

  msg.textContent = `${videos.length}개 영상 찾음 · 참고할 영상을 골라주세요`;
  msg.className = 'msg';

  resultsBox.innerHTML = videos
    .map(
      (v, i) => `
    <div class="youtube-card">
      <img src="${v.thumbnail}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="yt-info">
        <div class="yt-title">${(v.title || '').replace(/</g, '&lt;')}</div>
        <div class="yt-meta">${(v.channelTitle || '').replace(/</g, '&lt;')} · 조회수 ${fmtViews(v.views)} · ${v.duration || ''} · ${fmtYoutubeDate(v.publishedAt)}</div>
        <div class="yt-actions">
          <a href="${v.url}" target="_blank" rel="noopener noreferrer">YouTube에서 보기</a>
          <button type="button" class="use-btn" data-idx="${i}">이 소재 사용</button>
        </div>
      </div>
    </div>`
    )
    .join('');

  resultsBox.querySelectorAll('.use-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = videos[Number(btn.dataset.idx)];
      selectedYoutubeSource = {
        id: v.id,
        title: v.title,
        description: v.description,
        channelTitle: v.channelTitle,
        url: v.url,
      };
      renderSelectedYoutubeSource();
    });
  });
}

async function searchYoutubeVideos() {
  const btn = document.getElementById('youtubeSearchBtn');
  if (btn.disabled) return; // 검색 버튼 연타 방지

  const keyword = document.getElementById('youtubeSearchInput').value.trim();
  const order = document.getElementById('youtubeOrderSelect').value;
  const msg = document.getElementById('youtubeSearchMsg');
  const resultsBox = document.getElementById('youtubeResults');

  if (!keyword) {
    msg.textContent = '상품명을 먼저 입력해주세요';
    msg.className = 'msg error';
    return;
  }

  const cacheKey = `${keyword}::${order}`;
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < YOUTUBE_CACHE_TTL_MS) {
    renderYoutubeResults(cached.videos);
    return;
  }

  btn.disabled = true;
  msg.textContent = '검색 중…';
  msg.className = 'msg';
  resultsBox.innerHTML = '';

  try {
    const res = await apiFetch(
      `/api/youtube/search?keyword=${encodeURIComponent(keyword)}&order=${encodeURIComponent(order)}&limit=10`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const videos = (data.videos || []).slice(0, 6);
    youtubeSearchCache.set(cacheKey, { videos, at: Date.now() });

    if (!videos.length) {
      msg.textContent = data.message || '관련 영상을 찾지 못했습니다. 검색어를 조금 다르게 입력해보세요.';
      msg.className = 'msg error';
      return;
    }
    renderYoutubeResults(videos);
  } catch (err) {
    msg.textContent = err.message || 'YouTube 검색 중 오류가 발생했습니다.';
    msg.className = 'msg error';
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('youtubeSearchBtn').addEventListener('click', searchYoutubeVideos);
document.getElementById('youtubeSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchYoutubeVideos();
  }
});
document.getElementById('clearYoutubeSourceBtn').addEventListener('click', () => {
  selectedYoutubeSource = null;
  renderSelectedYoutubeSource();
});

// ---- 완전 자동발행(오토파일럿) ----
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadAutopilotStatus() {
  if (!activeAccountId) return;
  const textEl = document.getElementById('autopilotStatusText');
  const btn = document.getElementById('autopilotToggleBtn');
  const detail = document.getElementById('autopilotDetail');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/autopilot`);
    const data = await res.json();
    const lastInfo = data.lastKeyword
      ? ` · 직전 키워드: "${data.lastKeyword}"${data.lastTarget ? ` (타겟: ${data.lastTarget})` : ''}`
      : '';
    if (data.enabled) {
      textEl.textContent = '켜짐';
      textEl.className = 'autopilot-status-text on';
      btn.textContent = '중지';
      btn.className = 'btn-secondary on';
      detail.textContent = data.nextAt ? `다음 자동 발행: ${fmtDateTime(data.nextAt)}${lastInfo}` : '';
    } else {
      textEl.textContent = '꺼짐';
      textEl.className = 'autopilot-status-text off';
      btn.textContent = '시작';
      btn.className = 'btn-secondary off';
      detail.textContent = data.lastKeyword ? `마지막으로 썼던${lastInfo}` : '';
    }
    // "관련 쇼츠 콘텐츠 참고" 옵션 — 서버 값으로 화면 동기화 (저장 이벤트가 다시 발생하지 않도록 change 리스너 붙이기 전에 값만 세팅)
    document.getElementById('autopilotYoutubeToggle').checked = data.youtubeSourceEnabled !== false;
    document.getElementById('autopilotYoutubeOrderSelect').value = data.youtubeOrder || 'relevance';
    document.getElementById('autopilotFrameMediaToggle').checked = !!data.frameMediaEnabled;
  } catch {
    textEl.textContent = '상태를 불러오지 못했어요';
    textEl.className = 'autopilot-status-text off';
  }
}

// 완전자동화 "관련 쇼츠 콘텐츠 참고" ON/OFF + 탐색 방식은 시작/중지 버튼과 별개로 바로 저장
async function saveAutopilotYoutubeSettings() {
  if (!activeAccountId) return;
  const enabled = document.getElementById('autopilotYoutubeToggle').checked;
  const order = document.getElementById('autopilotYoutubeOrderSelect').value;
  try {
    await apiFetch(`/api/accounts/${activeAccountId}/autopilot/youtube-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, order }),
    });
  } catch {
    // 저장에 실패해도 완전자동화 자체는 계속 정상 동작하므로 조용히 무시
  }
}
document.getElementById('autopilotYoutubeToggle').addEventListener('change', saveAutopilotYoutubeSettings);
document.getElementById('autopilotYoutubeOrderSelect').addEventListener('change', saveAutopilotYoutubeSettings);

// 완전자동화 "업로드 영상 프레임 자동 사용" ON/OFF 저장
document.getElementById('autopilotFrameMediaToggle').addEventListener('change', async () => {
  if (!activeAccountId) return;
  const enabled = document.getElementById('autopilotFrameMediaToggle').checked;
  try {
    await apiFetch(`/api/accounts/${activeAccountId}/autopilot/frame-media-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  } catch {
    // 저장 실패해도 완전자동화 자체는 계속 정상 동작하므로 조용히 무시
  }
});

document.getElementById('autopilotToggleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('autopilotToggleBtn');
  const isOn = btn.classList.contains('on');
  btn.disabled = true;
  try {
    if (isOn) {
      if (!confirm('자동발행을 중지할까요? 이미 예약된 글은 그대로 발행됩니다.')) {
        btn.disabled = false;
        return;
      }
      await apiFetch(`/api/accounts/${activeAccountId}/autopilot/stop`, { method: 'POST' });
    } else {
      if (
        !confirm(
          '자동발행을 켜면 앞으로 60~75분마다 AI가 알아서 상품을 고르고 글을 써서 예약·발행합니다. 계속할까요?'
        )
      ) {
        btn.disabled = false;
        return;
      }
      await apiFetch(`/api/accounts/${activeAccountId}/autopilot/start`, { method: 'POST' });
    }
    await loadAutopilotStatus();
  } finally {
    btn.disabled = false;
  }
});

// ---- AI 완전 자동완성: 키워드 제안 → 상품 검색 → 랜덤 픽 → 글쓰기까지 한번에 ----
document.getElementById('aiAutoCompleteBtn').addEventListener('click', async () => {
  const btn = document.getElementById('aiAutoCompleteBtn');
  const status = document.getElementById('aiAutoCompleteStatus');
  const target = document.getElementById('autoCompleteTargetSelect').value;

  btn.disabled = true;
  try {
    status.textContent = 'AI가 검색 키워드 정하는 중…';
    status.className = 'ai-status';
    const kwRes = await apiFetch('/api/suggest-keyword', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const kwData = await kwRes.json();
    if (!kwRes.ok) throw new Error(kwData.error);
    const keyword = kwData.keyword;
    const trendNote = kwData.trendUsed ? ' (네이버 데이터랩 트렌드 1위)' : '';

    status.textContent = `"${keyword}"${trendNote} 검색 중…`;
    const searchRes = await apiFetch(`/api/coupang/search?keyword=${encodeURIComponent(keyword)}&limit=8`);
    const searchData = await searchRes.json();
    if (!searchRes.ok) throw new Error(searchData.error);
    if (!searchData.products.length) throw new Error(`"${keyword}" 검색 결과가 없어요, 다시 눌러보세요`);

    // 상위 결과 중 랜덤으로 하나 선택 (매번 같은 것만 고르지 않도록)
    const pickPool = searchData.products.slice(0, Math.min(5, searchData.products.length));
    const picked = pickPool[Math.floor(Math.random() * pickPool.length)];
    applyPickedProduct(picked);

    // 검색창/결과 목록에도 반영해서 뭘 골랐는지 보이게
    document.getElementById('productSearchInput').value = keyword;
    document.getElementById('productSearchMsg').textContent = `AI가 "${keyword}"${trendNote}로 검색해서 이 상품을 골랐어요: ${picked.name}`;
    document.getElementById('productSearchMsg').className = 'msg';
    // 본문 작성 폼의 타겟도 자동완성에서 고른 타겟과 맞춰줌
    document.getElementById('composeTargetSelect').value = target;

    status.textContent = '글 쓰는 중…';
    const ok = await runAiGenerate();
    status.textContent = ok
      ? `완료! "${keyword}" → "${picked.name}" 상품으로 글 5개 준비됐어요, 마음에 드는 버전 골라주세요`
      : '상품은 골랐는데 글쓰기에서 오류가 났어요, 아래에서 다시 시도해보세요';
    status.className = ok ? 'ai-status ok' : 'ai-status error';
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

function applyPickedProduct(p) {
  const form = document.getElementById('composeForm');
  form.link.value = p.url;
  form.image_url.value = p.image;
  form.video_url.value = '';
  uploadedFilename = null; // 검색 결과 이미지로 교체되므로 이전 직접 업로드 참조는 해제
  lastScrapedLink = p.url; // 자동 스크래핑이 이 링크로 또 돌지 않도록 표시
  currentProduct = { name: p.name, price: p.price };
  originalProductImage = p.image; // 라이프스타일 이미지 생성 시 레퍼런스로 사용
  // 쇼츠 찾기 입력창에도 상품명을 자동으로 채워준다 (직접 수정도 가능)
  const youtubeInput = document.getElementById('youtubeSearchInput');
  if (youtubeInput) youtubeInput.value = p.name || '';
  currentScene = null;
  resetLifestyleUI();

  document.getElementById('videoPreviewBox').classList.add('hidden');
  document.getElementById('videoUsageRow').classList.add('hidden');
  resetVideoFrameUI();
  document.getElementById('imagePreviewImg').src = p.image;
  document.getElementById('imagePreviewBox').classList.remove('hidden');
  document.getElementById('imageToolsRow').classList.remove('hidden');
  document.getElementById('lifestylePanel').classList.remove('hidden');
  document.getElementById('detailImagesGallery').classList.add('hidden');
  const scrapeStatus = document.getElementById('scrapeStatus');
  scrapeStatus.textContent = '상품 검색 결과에서 링크·사진을 채웠어요 · 이제 "AI로 글 써주기"를 눌러보세요';
  scrapeStatus.className = 'scrape-status ok';
  updateCommentPreview();
}

document.getElementById('productSearchBtn').addEventListener('click', searchCoupangProducts);
document.getElementById('productSearchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchCoupangProducts();
  }
});

// ---- 내 사진/영상 직접 업로드 ----
let uploadedFilename = null; // 삭제 API 호출용
let uploadedVideoUrl = ''; // "영상 그대로 게시" 모드로 되돌아갈 때 복원할 원본 영상 URL

document.getElementById('mediaUploadInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const status = document.getElementById('uploadStatus');
  status.textContent = '업로드 중…';
  status.className = 'scrape-status loading';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/api/upload-media', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    uploadedFilename = data.filename;
    const form = document.getElementById('composeForm');

    if (data.mediaType === 'video') {
      form.video_url.value = data.url;
      form.image_url.value = '';
      uploadedVideoUrl = data.url;
      document.getElementById('imagePreviewBox').classList.add('hidden');
      document.getElementById('videoPreviewEl').src = data.url;
      document.getElementById('videoPreviewBox').classList.remove('hidden');
      // 새 영상을 올리면 이전 영상의 프레임 추출 상태는 전부 초기화
      resetVideoFrameUI();
      document.getElementById('videoUsageRow').classList.remove('hidden');
      document.getElementById('videoUsageAsIs').checked = true;
      document.getElementById('extractFramesBtn').classList.add('hidden');
    } else {
      form.image_url.value = data.url;
      form.video_url.value = '';
      uploadedVideoUrl = '';
      document.getElementById('videoPreviewBox').classList.add('hidden');
      document.getElementById('imagePreviewImg').src = data.url;
      document.getElementById('imagePreviewBox').classList.remove('hidden');
      document.getElementById('videoUsageRow').classList.add('hidden');
      resetVideoFrameUI();
    }

    status.textContent = '업로드 완료';
    status.className = 'scrape-status ok';
  } catch (err) {
    status.textContent = '업로드 실패: ' + err.message;
    status.className = 'scrape-status error';
  } finally {
    e.target.value = ''; // 같은 파일 다시 선택 가능하도록
  }
});

async function removeUploadedMedia() {
  const form = document.getElementById('composeForm');
  if (uploadedFilename) {
    try {
      await fetch(`/api/upload-media/${uploadedFilename}`, { method: 'DELETE' });
    } catch {
      /* 서버에서 이미 지워졌어도 무시 */
    }
    uploadedFilename = null;
  }
  form.image_url.value = '';
  form.video_url.value = '';
  document.getElementById('imagePreviewBox').classList.add('hidden');
  document.getElementById('videoPreviewBox').classList.add('hidden');
  document.getElementById('imagePreviewImg').src = '';
  document.getElementById('videoPreviewEl').src = '';
  document.getElementById('uploadStatus').className = 'scrape-status hidden';
  document.getElementById('videoUsageRow').classList.add('hidden');
  await resetVideoFrameUI();
}

document.getElementById('removeMediaBtn').addEventListener('click', removeUploadedMedia);
document.getElementById('removeVideoBtn').addEventListener('click', removeUploadedMedia);

// ---- 영상에서 사진 추출 (선택적 기능 — 안 써도 기존 "영상 그대로 게시"는 그대로 동작) ----
let currentFrameJobId = null;
let currentFrames = []; // [{id, time, url}]
let selectedFrameUrls = []; // 최대 2장 (기존 Threads 게시 로직이 image_url+extra_image_url 2장까지만 지원)
let frameRecommendations = {}; // frameId -> {category, score, reason} (AI 분석 성공 시에만 채워짐)
let recommendedFrameIds = []; // AI가 우선순위대로 추천한 frameId 목록 (최대 2개)
const MAX_SELECTED_FRAMES = 2;

const CATEGORY_LABELS = {
  person_hook: '인물/후킹',
  product_usage: '제품 사용',
  product_closeup: '제품 클로즈업',
  general: '기타',
  bad: '사용 부적합',
};

// 아직 게시물에 쓰이지 않은(선택 확정 전) 추출 작업 폴더를 정리. 이미 예약글로 제출된 프레임은
// 여기서 지우지 않는다 — 이 함수는 영상 교체/삭제 시점에만 호출된다.
async function resetVideoFrameUI() {
  if (currentFrameJobId) {
    try {
      await apiFetch(`/api/video/frames/${currentFrameJobId}`, { method: 'DELETE' });
    } catch {
      /* 정리 실패해도 새 영상 작업을 막을 이유는 없음 */
    }
  }
  currentFrameJobId = null;
  currentFrames = [];
  selectedFrameUrls = [];
  frameRecommendations = {};
  recommendedFrameIds = [];
  document.getElementById('frameCandidatesBox').classList.add('hidden');
  document.getElementById('frameCandidatesGrid').innerHTML = '';
  document.getElementById('aiVisionStatus').textContent = '';
  document.getElementById('imageCompositionRow').classList.add('hidden');
  document.getElementById('extractFramesStatus').textContent = '';
  document.getElementById('compositionFramesOnly').checked = true;
  document.getElementById('compositionFramesOnlyLabel').textContent = '추출한 사진만 게시';
  document.getElementById('compositionFramesPlusProductLabel').textContent = '추출한 사진 + 상품 이미지';
  applyImageComposition();
}

document.querySelectorAll('input[name="videoUsageMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const btn = document.getElementById('extractFramesBtn');
    const toggleRow = document.getElementById('aiVisionToggleRow');
    const form = document.getElementById('composeForm');
    if (document.getElementById('videoUsageExtract').checked) {
      btn.classList.remove('hidden');
      toggleRow.classList.remove('hidden');
      // 이미지(추출 프레임)로 게시할 것이므로 영상 URL은 비운다 — 발행 로직이 videoUrl을
      // 우선하므로, 비워두지 않으면 프레임을 골라도 영상으로 그대로 게시돼버린다.
      form.video_url.value = '';
      applyImageComposition();
    } else {
      btn.classList.add('hidden');
      toggleRow.classList.add('hidden');
      // "영상 그대로 게시"로 되돌리면 지금까지 고른 프레임/상품 이미지는 게시에 쓰이지 않으므로 비운다
      form.video_url.value = uploadedVideoUrl;
      form.image_url.value = '';
      form.extra_image_url.value = '';
      document.getElementById('imagePreviewBox').classList.add('hidden');
    }
  });
});

document.getElementById('extractFramesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('extractFramesBtn');
  const status = document.getElementById('extractFramesStatus');
  if (btn.disabled) return; // 연타 방지
  if (!uploadedFilename) {
    status.textContent = '먼저 영상을 업로드해주세요';
    status.className = 'ai-status error';
    return;
  }

  btn.disabled = true;
  status.textContent = '영상 분석 중… 사진을 추출하고 있습니다…';
  status.className = 'ai-status';

  try {
    const res = await apiFetch('/api/video/frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: uploadedFilename }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentFrameJobId = data.jobId;
    currentFrames = data.frames || [];
    selectedFrameUrls = [];
    frameRecommendations = {};
    recommendedFrameIds = [];
    renderFrameCandidates();

    status.textContent = `${currentFrames.length}장의 장면을 찾았어요 · 최대 ${MAX_SELECTED_FRAMES}장까지 선택하세요`;
    status.className = 'ai-status ok';

    // "AI 베스트컷 자동 추천"이 켜져 있으면 이어서 자동으로 분석을 시도한다. 실패해도 이미
    // 위에서 프레임 후보는 정상적으로 표시된 상태라 수동 선택은 그대로 가능하다.
    if (document.getElementById('aiVisionToggle').checked) {
      await runAiFrameRecommendation();
    }
  } catch (err) {
    status.textContent = '추출 실패: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

// AI 베스트컷 추천 — 실패해도 예외를 던지지 않고 "수동 선택 가능" 상태로 조용히 남는다
async function runAiFrameRecommendation() {
  if (!currentFrameJobId) return;
  const visionStatus = document.getElementById('aiVisionStatus');
  visionStatus.textContent = 'AI가 베스트컷을 고르는 중…';
  visionStatus.className = 'ai-status';

  try {
    const res = await apiFetch(`/api/video/frames/${currentFrameJobId}/recommend`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    frameRecommendations = {};
    (data.recommendations || []).forEach((r) => {
      frameRecommendations[r.frameId] = r;
    });
    recommendedFrameIds = data.recommended || [];

    // 추천 결과를 기본 선택으로 반영 (사용자가 이후 자유롭게 바꿀 수 있음)
    selectedFrameUrls = recommendedFrameIds
      .map((id) => currentFrames.find((f) => f.id === id)?.url)
      .filter(Boolean)
      .slice(0, MAX_SELECTED_FRAMES);

    // 추천 성공 시 조합 옵션 문구를 "AI 추천 프레임" 기준으로 바꿔서 어떤 걸 쓰는지 명확히 함
    document.getElementById('compositionFramesOnlyLabel').textContent = 'AI 추천 프레임만';
    document.getElementById('compositionFramesPlusProductLabel').textContent = 'AI 추천 프레임 + 상품 이미지';
    // 기본값은 "AI 추천 프레임 + 상품 이미지" 권장 — 상품 이미지가 있을 때만 그 옵션을 기본으로 선택
    if (originalProductImage && document.getElementById('compositionFramesPlusProduct')) {
      document.getElementById('compositionFramesPlusProduct').checked = true;
    }

    renderFrameCandidates();
    applyImageComposition();

    visionStatus.textContent = recommendedFrameIds.length
      ? `AI가 ${recommendedFrameIds.length}개 장면을 추천했어요 · 마음에 안 들면 직접 바꿔도 됩니다`
      : 'AI가 추천할 만한 장면을 찾지 못했어요 · 직접 선택해주세요';
    visionStatus.className = 'ai-status ok';
  } catch (err) {
    visionStatus.textContent = 'AI 추천 없이 수동 선택 가능 (' + err.message + ')';
    visionStatus.className = 'ai-status';
  }
}

function fmtFrameTime(t) {
  return `${Number(t).toFixed(1)}초`;
}

function frameBadgeHtml(frameId) {
  const rec = frameRecommendations[frameId];
  if (!rec) return '';
  const rank = recommendedFrameIds.indexOf(frameId);
  const label = CATEGORY_LABELS[rec.category] || rec.category;
  const star = rank >= 0 ? '⭐'.repeat(1) + (rank + 1) + '순위 ' : '';
  return `<span class="frame-badge">${star}${label} ${rec.score}점</span>`;
}

function renderFrameCandidates() {
  const grid = document.getElementById('frameCandidatesGrid');
  const box = document.getElementById('frameCandidatesBox');

  grid.innerHTML = currentFrames
    .map((f) => {
      const rec = frameRecommendations[f.id];
      const isBad = rec && rec.category === 'bad';
      const isRecommended = recommendedFrameIds.includes(f.id);
      const classes = [
        'frame-thumb',
        selectedFrameUrls.includes(f.url) ? 'selected' : '',
        isRecommended ? 'ai-recommended' : '',
        isBad ? 'ai-excluded' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
    <div class="${classes}" data-url="${f.url}" data-id="${f.id}">
      <img src="${f.url}" alt="" />
      ${frameBadgeHtml(f.id)}
      <span class="frame-time">${fmtFrameTime(f.time)}</span>
      <span class="frame-check"></span>
    </div>`;
    })
    .join('');
  box.classList.remove('hidden');

  grid.querySelectorAll('.frame-thumb').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const url = thumb.dataset.url;
      const status = document.getElementById('extractFramesStatus');
      const idx = selectedFrameUrls.indexOf(url);
      if (idx >= 0) {
        selectedFrameUrls.splice(idx, 1);
      } else {
        if (selectedFrameUrls.length >= MAX_SELECTED_FRAMES) {
          status.textContent = `Threads 게시 이미지로 최대 ${MAX_SELECTED_FRAMES}장까지 선택할 수 있습니다.`;
          status.className = 'ai-status error';
          return;
        }
        selectedFrameUrls.push(url);
      }
      renderFrameCandidates();
      applyImageComposition();
    });
  });

  document.getElementById('imageCompositionRow').classList.toggle('hidden', selectedFrameUrls.length === 0);
  // 상품 이미지가 아예 없으면(쿠팡 검색 없이 영상만 올린 경우) 상품 이미지 조합 옵션은 숨긴다
  const hasProductImage = !!originalProductImage;
  document.getElementById('compositionFramesPlusProductRow').classList.toggle('hidden', !hasProductImage);
  document.getElementById('compositionProductOnlyRow').classList.toggle('hidden', !hasProductImage);
}

// 선택한 프레임(+상품 이미지) 조합을 실제로 composeForm의 image_url/extra_image_url에 반영.
// 현재 Threads 발행 로직이 이미지 2장(image_url + extra_image_url)까지만 지원하므로 그 범위 안에서 조합한다.
function applyImageComposition() {
  const form = document.getElementById('composeForm');
  const mode = document.querySelector('input[name="imageComposition"]:checked')?.value || 'frames_only';
  const previewImg = document.getElementById('imagePreviewImg');
  const previewBox = document.getElementById('imagePreviewBox');

  let imageUrl = '';
  let extraImageUrl = '';

  if (mode === 'product_only') {
    imageUrl = originalProductImage || '';
  } else if (mode === 'frames_plus_product') {
    imageUrl = selectedFrameUrls[0] || originalProductImage || '';
    extraImageUrl = selectedFrameUrls[0] ? originalProductImage || '' : '';
  } else {
    // frames_only
    imageUrl = selectedFrameUrls[0] || '';
    extraImageUrl = selectedFrameUrls[1] || '';
  }

  form.image_url.value = imageUrl;
  form.extra_image_url.value = extraImageUrl;

  if (imageUrl) {
    previewImg.src = imageUrl;
    previewBox.classList.remove('hidden');
  } else {
    previewBox.classList.add('hidden');
  }
}

document.querySelectorAll('input[name="imageComposition"]').forEach((radio) => {
  radio.addEventListener('change', applyImageComposition);
});

// ---- 링크 입력 시 상품 이미지/제목 자동 가져오기 ----
let scrapeTimer = null;
let lastScrapedLink = '';
let currentDetailImages = [];
let originalProductImage = '';
let currentScene = null;

function resetLifestyleUI() {
  document.getElementById('sceneBox').classList.add('hidden');
  document.getElementById('sceneText').textContent = '';
  document.getElementById('sceneStatus').textContent = '';
  document.getElementById('imageGenStatus').textContent = '';
  document.getElementById('generateSceneBtn').classList.remove('hidden');
  document.getElementById('regenerateSceneBtn').classList.add('hidden');
  document.getElementById('generateImageBtn').classList.add('hidden');
  document.getElementById('regenerateImageBtn').classList.add('hidden');
}

async function runGenerateScene() {
  const status = document.getElementById('sceneStatus');
  const productName = currentProduct.name || document.getElementById('composeForm').text.value.trim();
  if (!productName) {
    status.textContent = '먼저 상품을 검색하거나 링크를 넣어주세요';
    status.className = 'ai-status error';
    return;
  }
  status.textContent = 'AI가 배경 상황을 정하는 중…';
  status.className = 'ai-status';
  try {
    const res = await apiFetch('/api/generate-scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName,
        price: currentProduct.price,
        target: document.getElementById('composeTargetSelect').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    currentScene = data.scene;

    document.getElementById('sceneText').textContent = `${data.scene.location || ''} — ${data.scene.context || ''}`;
    document.getElementById('sceneBox').classList.remove('hidden');
    document.getElementById('generateSceneBtn').classList.add('hidden');
    document.getElementById('regenerateSceneBtn').classList.remove('hidden');
    document.getElementById('generateImageBtn').classList.remove('hidden');
    status.textContent = '상황 완성 · 마음에 들면 "라이프스타일 이미지 만들기"를 눌러보세요';
    status.className = 'ai-status ok';
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
  }
}

document.getElementById('generateSceneBtn').addEventListener('click', runGenerateScene);
document.getElementById('regenerateSceneBtn').addEventListener('click', runGenerateScene);

async function runGenerateLifestyleImage() {
  const genBtn = document.getElementById('generateImageBtn');
  const regenBtn = document.getElementById('regenerateImageBtn');
  const status = document.getElementById('imageGenStatus');
  const productName = currentProduct.name || document.getElementById('composeForm').text.value.trim();

  if (!originalProductImage) {
    status.textContent = '먼저 상품 사진이 있어야 라이프스타일 이미지를 만들 수 있어요';
    status.className = 'ai-status error';
    return;
  }
  if (!currentScene) {
    status.textContent = '먼저 "상황 만들기"를 눌러주세요';
    status.className = 'ai-status error';
    return;
  }

  genBtn.disabled = true;
  regenBtn.disabled = true;
  status.textContent = '이미지 만드는 중… (30초~1분 정도 걸려요)';
  status.className = 'ai-status';
  try {
    const res = await apiFetch('/api/generate-lifestyle-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productName, productImage: originalProductImage, scene: currentScene }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const img = data.images[0];
    const form = document.getElementById('composeForm');
    form.image_url.value = img.url;
    form.video_url.value = '';
    document.getElementById('videoPreviewBox').classList.add('hidden');
    document.getElementById('imagePreviewImg').src = img.url;
    document.getElementById('imagePreviewBox').classList.remove('hidden');
    uploadedFilename = img.filename; // 첨부 삭제 버튼으로 지울 수 있게 등록

    document.getElementById('generateImageBtn').classList.add('hidden');
    document.getElementById('regenerateImageBtn').classList.remove('hidden');
    status.textContent = '완성! 마음에 안 들면 "이미지 다시 만들기"를 눌러보세요';
    status.className = 'ai-status ok';
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    genBtn.disabled = false;
    regenBtn.disabled = false;
  }
}

document.getElementById('generateImageBtn').addEventListener('click', runGenerateLifestyleImage);
document.getElementById('regenerateImageBtn').addEventListener('click', runGenerateLifestyleImage);

// ---- 상세페이지 사진 더 보기 (갤러리에서 골라서 대표 이미지로 교체) ----
document.getElementById('showDetailImagesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('showDetailImagesBtn');
  const gallery = document.getElementById('detailImagesGallery');
  const status = document.getElementById('retouchStatus');
  const link = document.getElementById('composeForm').link.value.trim();
  if (!link) {
    status.textContent = '먼저 상품 링크가 있어야 상세 사진을 가져올 수 있어요';
    status.className = 'ai-status error';
    return;
  }

  btn.disabled = true;
  status.textContent = '상세페이지 사진 불러오는 중…';
  status.className = 'ai-status';
  try {
    // 이미 스크래핑해둔 후보가 있으면 재사용, 없으면 다시 가져옴
    if (!currentDetailImages.length) {
      const res = await fetch('/api/scrape-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentDetailImages = data.images || [data.imageUrl];
    }

    const currentImg = document.getElementById('composeForm').image_url.value;
    gallery.innerHTML = currentDetailImages
      .map(
        (src, i) => `
      <div class="detail-img-thumb ${src === currentImg ? 'selected' : ''}" data-idx="${i}">
        <img src="${src}" alt="" onerror="this.parentElement.style.display='none'" />
      </div>`
      )
      .join('');
    gallery.classList.remove('hidden');

    gallery.querySelectorAll('.detail-img-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        const src = currentDetailImages[Number(thumb.dataset.idx)];
        const form = document.getElementById('composeForm');
        form.image_url.value = src;
        document.getElementById('imagePreviewImg').src = src;
        gallery.querySelectorAll('.detail-img-thumb').forEach((t) => t.classList.remove('selected'));
        thumb.classList.add('selected');
      });
    });

    status.textContent = `${currentDetailImages.length}장 찾았어요 · 마음에 드는 사진을 눌러서 대표 이미지로 바꾸세요`;
    status.className = 'ai-status ok';
  } catch (err) {
    status.textContent = '상세 사진을 못 가져왔어요: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

async function runScrape(link) {
  const statusEl = document.getElementById('scrapeStatus');
  const imageInput = document.getElementById('imageUrlInput');
  const previewBox = document.getElementById('imagePreviewBox');
  const previewImg = document.getElementById('imagePreviewImg');

  statusEl.textContent = '상품 정보 가져오는 중…';
  statusEl.className = 'scrape-status loading';

  try {
    const res = await fetch('/api/scrape-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    imageInput.value = data.imageUrl;
    previewImg.src = data.imageUrl;
    previewBox.classList.remove('hidden');
    document.getElementById('imageToolsRow').classList.remove('hidden');
    document.getElementById('lifestylePanel').classList.remove('hidden');
    document.getElementById('detailImagesGallery').classList.add('hidden');
    currentDetailImages = data.images || [data.imageUrl];
    originalProductImage = data.imageUrl;
    currentScene = null;
    resetLifestyleUI();

    if (data.title) {
      currentProduct = { name: data.title, price: null };
    }

    statusEl.textContent = '상품 이미지를 자동으로 채웠어요' + (data.title ? ` · "AI로 글 써주기"를 눌러보세요` : '');
    statusEl.className = 'scrape-status ok';
  } catch (err) {
    statusEl.textContent = '자동으로 못 가져왔어요: ' + err.message;
    statusEl.className = 'scrape-status error';
  }
}

document.getElementById('linkInput').addEventListener('input', () => {
  updateCommentPreview();
  clearTimeout(scrapeTimer);
  const link = document.getElementById('linkInput').value.trim();
  if (!link || link === lastScrapedLink) return;
  scrapeTimer = setTimeout(() => {
    lastScrapedLink = link;
    runScrape(link);
  }, 900); // 타이핑 멈추고 0.9초 후 자동 실행
});

// ---- 댓글 미리보기 ----
let disclosureTemplate = '';

function updateCommentPreview() {
  const link = document.getElementById('linkInput').value.trim();
  const enabled = document.getElementById('autoCommentToggle').checked;
  const box = document.getElementById('commentPreview');
  const textEl = document.getElementById('commentPreviewText');
  if (link && enabled) {
    box.classList.remove('hidden');
    textEl.textContent = (disclosureTemplate || '{link}').replace('{link}', link);
  } else {
    box.classList.add('hidden');
  }
}
document.getElementById('autoCommentToggle').addEventListener('change', updateCommentPreview);

// ---- 글 예약 폼 ----
document.getElementById('composeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('composeMsg');
  const body = {
    text: form.text.value,
    link: form.link.value,
    image_url: form.image_url.value,
    extra_image_url: form.extra_image_url.value,
    video_url: form.video_url.value,
    scheduled_at: new Date(form.scheduled_at.value).toISOString(),
    auto_comment_enabled: form.auto_comment_enabled.checked,
    // 영상 프레임을 실제로 골라서 쓴 경우에만 채워짐 — 완전자동화가 나중에 비슷한 상품을 고를 때
    // 이 조합을 재사용할 수 있도록 media_sources에 저장하는 용도(선택 사항)
    product_name: currentFrameJobId ? currentProduct.name || '' : undefined,
    frame_job_id: currentFrameJobId || undefined,
  };
  try {
    const res = await apiFetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    msg.textContent = '예약 등록 완료';
    msg.className = 'msg';
    form.reset();
    updateCommentPreview();
    document.getElementById('imagePreviewBox').classList.add('hidden');
    document.getElementById('videoPreviewBox').classList.add('hidden');
    document.getElementById('uploadStatus').className = 'scrape-status hidden';
    document.getElementById('scrapeStatus').className = 'scrape-status hidden';
    document.getElementById('aiGenerateStatus').textContent = '';
    document.getElementById('aiCandidates').classList.add('hidden');
    document.getElementById('aiCandidates').innerHTML = '';
    document.getElementById('imageToolsRow').classList.add('hidden');
    document.getElementById('detailImagesGallery').classList.add('hidden');
    document.getElementById('retouchStatus').textContent = '';
    document.getElementById('videoUsageRow').classList.add('hidden');
    // 선택된 프레임 이미지는 방금 등록한 예약글이 계속 참조하므로 여기서 파일을 지우지 않는다 —
    // 상태 변수만 초기화한다 (실제 정리는 영상 교체/삭제 시 resetVideoFrameUI에서 처리됨).
    currentFrameJobId = null;
    currentFrames = [];
    selectedFrameUrls = [];
    frameRecommendations = {};
    recommendedFrameIds = [];
    document.getElementById('frameCandidatesBox').classList.add('hidden');
    document.getElementById('frameCandidatesGrid').innerHTML = '';
    document.getElementById('aiVisionStatus').textContent = '';
    document.getElementById('imageCompositionRow').classList.add('hidden');
    document.getElementById('compositionFramesOnlyLabel').textContent = '추출한 사진만 게시';
    document.getElementById('compositionFramesPlusProductLabel').textContent = '추출한 사진 + 상품 이미지';
    uploadedVideoUrl = '';
    currentDetailImages = [];
    originalProductImage = '';
    currentScene = null;
    resetLifestyleUI();
    document.getElementById('lifestylePanel').classList.add('hidden');
    lastScrapedLink = '';
    uploadedFilename = null;
    currentProduct = { name: '', price: null };
    selectedYoutubeSource = null;
    renderSelectedYoutubeSource();
    document.getElementById('youtubeSearchInput').value = '';
    document.getElementById('youtubeResults').innerHTML = '';
    document.getElementById('youtubeSearchMsg').textContent = '';
    loadDashboard();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});

// ---- 전체 글 목록 ----
const statusLabel = { pending: '예정', posted: '완료', failed: '실패' };
const commentStatusLabel = { none: '해당없음', pending: '대기', posted: '완료', failed: '실패' };

async function loadPosts() {
  if (!activeAccountId) return;
  const res = await apiFetch('/api/posts');
  const rows = await res.json();
  const tbody = document.getElementById('postsTableBody');
  tbody.innerHTML = rows
    .map(
      (p) => `
    <tr>
      <td><span class="status-pill status-${p.status}">${statusLabel[p.status]}</span></td>
      <td class="text-cell">${(p.text || '').replace(/</g, '&lt;')}</td>
      <td>${fmtTime(p.status === 'posted' ? p.posted_at : p.scheduled_at)}</td>
      <td>–</td>
      <td><span class="status-pill status-${p.comment_status === 'posted' ? 'posted' : p.comment_status === 'failed' ? 'failed' : p.comment_status === 'pending' ? 'pending' : 'none'}">${commentStatusLabel[p.comment_status] || '해당없음'}</span></td>
      <td>${p.status === 'pending' ? `<button class="del-btn" data-id="${p.id}">삭제</button>` : ''}</td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('.del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
      loadPosts();
      loadDashboard();
    });
  });
}

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
  aForm.ANTHROPIC_API_KEY.placeholder = data.hasAnthropicKey ? '저장됨 (변경 시에만 입력)' : 'sk-ant-... (변경 시에만 입력)';

  const nForm = document.getElementById('naverForm');
  nForm.NAVER_CLIENT_ID.value = data.NAVER_CLIENT_ID || '';
  nForm.NAVER_CLIENT_SECRET.placeholder = data.hasNaverSecret ? '저장됨 (변경 시에만 입력)' : '';

  disclosureTemplate = data.COUPANG_DISCLOSURE_TEMPLATE || '';
  document.getElementById('disclosureForm').template.value = disclosureTemplate;

  document.getElementById('connectBtn').href = `/auth/login?accountId=${activeAccountId}`;
}

document.getElementById('anthropicForm').addEventListener('submit', async (e) => {
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


document.getElementById('naverForm').addEventListener('submit', async (e) => {
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

document.getElementById('coupangForm').addEventListener('submit', async (e) => {
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

document.getElementById('disclosureForm').addEventListener('submit', async (e) => {
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

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
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

// ---- 초기 로드 ----
(async function init() {
  loadMe();
  await loadAccounts();
  loadConnectionStatus();
  loadDashboard();
  loadSettings();
  loadAutopilotStatus();
  setInterval(loadDashboard, 30000);
  setInterval(loadAutopilotStatus, 60000);
})();
