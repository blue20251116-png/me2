const dbModule = require('./db');

const originalCanPublish = dbModule.canPublish.bind(dbModule);

dbModule.canPublish = function patchedCanPublish(userId) {
  const user = dbModule.getUserById(userId);
  if (user?.role === 'admin') {
    if (user.status !== 'active') return false;
    if (user.expires_at && new Date(user.expires_at) < new Date()) return false;
    return true;
  }
  return originalCanPublish(userId);
};

console.log('[Publish][ADMIN LIMIT PATCH] 관리자 계정은 일일 발행 한도에서 제외');
