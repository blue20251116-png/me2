// 성과 분석 패널: 최근 기간 vs 이전 기간, 페르소나·발행 시간·주제 태그별 평균 조회수/답글.
// 데이터는 /api/reach-report (src/threads/reachReport.js).
function reachEscape(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function reachChange(cur, prev) {
  if (!prev) return cur ? '<span class="reach-up">신규</span>' : '<span class="reach-flat">–</span>';
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct > 0) return `<span class="reach-up">▲ ${pct}%</span>`;
  if (pct < 0) return `<span class="reach-down">▼ ${Math.abs(pct)}%</span>`;
  return '<span class="reach-flat">변화 없음</span>';
}

function reachTable(title, rows, limit) {
  const body = rows
    .slice(0, limit)
    .map(
      r =>
        `<tr><td>${reachEscape(r.label)}</td><td>${r.posts}</td><td>${r.avgViews.toLocaleString()}</td><td>${r.avgReplies}</td></tr>`
    )
    .join('');
  return `<div class="reach-block"><h3>${reachEscape(title)}</h3>${
    rows.length
      ? `<table class="reach-table"><thead><tr><th></th><th>글</th><th>조회</th><th>답글</th></tr></thead><tbody>${body}</tbody></table>`
      : '<p class="hint">아직 데이터가 없습니다</p>'
  }</div>`;
}

async function loadReachReport() {
  const box = document.getElementById('reachReport');
  if (!box || !activeAccountId) return;
  const res = await apiFetch('/api/reach-report');
  if (!res.ok) {
    box.innerHTML = '<p class="hint">성과 데이터를 불러오지 못했습니다</p>';
    return;
  }
  const r = await res.json();
  document.getElementById('reachPeriod').textContent = `최근 ${r.days}일 · 발행 ${r.minAgeHours}시간 지난 글 기준`;
  if (!r.current.posts && !r.previous.posts) {
    box.innerHTML = '<p class="hint">발행된 글이 쌓이면 어떤 글이 조회수가 잘 나오는지 여기에 보여드립니다.</p>';
    return;
  }
  box.innerHTML = `
    <div class="reach-kpis">
      <div class="reach-kpi"><span class="stat-label">평균 조회수</span><span class="reach-kpi-value">${r.current.avgViews.toLocaleString()}</span>${reachChange(r.current.avgViews, r.previous.avgViews)}</div>
      <div class="reach-kpi"><span class="stat-label">평균 답글</span><span class="reach-kpi-value">${r.current.avgReplies}</span>${reachChange(r.current.avgReplies, r.previous.avgReplies)}</div>
      <div class="reach-kpi"><span class="stat-label">발행 글</span><span class="reach-kpi-value">${r.current.posts}</span><span class="reach-flat">이전 ${r.previous.posts}개</span></div>
    </div>
    <div class="reach-grid">
      ${reachTable('페르소나별', r.byPersona, 8)}
      ${reachTable('잘 되는 발행 시간', r.byHour, 5)}
      ${reachTable('주제 태그별', r.byTopic, 8)}
    </div>
    <p class="hint reach-note">조회·답글은 글 1개당 평균입니다. 자동발행은 조회수·답글이 좋은 페르소나를 더 자주 고릅니다 (30%는 다른 페르소나도 계속 시도).</p>`;
}
