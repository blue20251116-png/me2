// 대시보드 시작점. 기능별 코드는 public/app/*.js에 있고 index.html에서 이 파일보다 먼저 불러온다.
// ---- 초기 로드 ----
/* global loadAccounts, loadAutopilotStatus, loadConnectionStatus, loadDashboard, loadMe, loadSettings */
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
