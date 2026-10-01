// 대시보드: 전체 글 목록.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global activeAccountId, apiFetch, fmtTime, loadDashboard */

// ---- 전체 글 목록 ----
const statusLabel = { pending: '예정', posted: '완료', failed: '실패' };
const commentStatusLabel = { none: '해당없음', pending: '대기', posted: '완료', failed: '실패' };

// The backend already returns error_message on every failed post (server.js's /api/posts does a
// plain SELECT *), but until now nothing in this page ever rendered it - a failed post showed
// only "실패" with zero indication of why, and this app's users have no access to server logs to
// find out themselves. Most stored messages are already plain Korean sentences (e.g. autopilot's
// "OpenAI API 키가 설정되지 않았습니다"), but a few are internal codes with no Korean at all -
// translate just those known codes and fall back to showing the raw message otherwise.
function friendlyPostError(message) {
  const raw = String(message || '');
  if (raw === 'THREADS_TOKEN_MISSING') return 'Threads 연동이 끊어졌습니다. 계정 설정에서 다시 로그인해주세요.';
  if (raw === 'PUBLISH_LIMIT_OR_SUBSCRIPTION') return '일일 발행 한도 또는 구독 상태를 확인해주세요.';
  if (raw === 'ACCOUNTING_REVIEW_REQUIRED')
    return 'Threads에는 올라갔지만 처리 확인이 필요합니다. 관리자에게 문의해주세요.';
  if (/^PUBLISH_OUTCOME_UNKNOWN/.test(raw)) return '발행 결과를 확인하지 못했습니다. Threads 앱에서 직접 확인해주세요.';
  if (/^OPENAI_HOURLY_BUDGET_EXCEEDED/.test(raw) || /credit balance is too low|insufficient_quota/i.test(raw))
    return 'AI 요청 한도 또는 크레딧 부족일 수 있습니다. OpenAI API 키/크레딧을 확인해주세요.';
  return raw;
}

async function loadPosts() {
  if (!activeAccountId) return;
  const res = await apiFetch('/api/posts');
  const rows = await res.json();
  const tbody = document.getElementById('postsTableBody');
  tbody.innerHTML = rows
    .map(
      p => `
    <tr>
      <td>
        <span class="status-pill status-${escapeHtml(p.status)}">${escapeHtml(statusLabel[p.status] || p.status)}</span>
        ${p.status === 'failed' && p.error_message ? `<div class="post-error-text">${escapeHtml(friendlyPostError(p.error_message))}</div>` : ''}
      </td>
      <td class="text-cell">${escapeHtml(p.text)}</td>
      <td>${fmtTime(p.status === 'posted' ? p.posted_at : p.scheduled_at)}</td>
      <td>–</td>
      <td><span class="status-pill status-${p.comment_status === 'posted' ? 'posted' : p.comment_status === 'failed' ? 'failed' : p.comment_status === 'pending' ? 'pending' : 'none'}">${commentStatusLabel[p.comment_status] || '해당없음'}</span></td>
      <td>${p.status === 'pending' ? `<button class="del-btn" data-id="${Number(p.id)}">삭제</button>` : ''}</td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await apiFetch(`/api/posts/${btn.dataset.id}`, { method: 'DELETE' });
      loadPosts();
      loadDashboard();
    });
  });
}
