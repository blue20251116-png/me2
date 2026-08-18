const Module = require('module');
const path = require('path');

const realJsLoader = Module._extensions['.js'];
let patched = false;

Module._extensions['.js'] = function patchedJsLoader(mod, filename) {
  if (!patched && path.basename(filename) === 'scheduler.js') {
    const fs = require('fs');
    let src = fs.readFileSync(filename, 'utf8');

    const oldContentOnly = "if(!hasCoupangKeys(account)){await runContentOnlyAutopilot(account,target);return;}";
    const newContentOnly = "if(!hasCoupangKeys(account)){throw new Error('쿠팡 API 키가 없어 Threads 원본 자동화만 사용합니다');}";
    if (src.includes(oldContentOnly)) src = src.replace(oldContentOnly, newContentOnly);
    else console.warn('[SCHEDULER POLICY PATCH] ContentOnly 분기 패턴을 찾지 못했습니다');

    const oldStart = "function startAutopilotJob(){const nextRunAt=new Map();cron.schedule('* * * * *',async()=>{";
    const newStart = "function startAutopilotJob(){const nextRunAt=new Map();const adminRunning=new Set();cron.schedule('* * * * *',async()=>{";
    if (src.includes(oldStart)) src = src.replace(oldStart, newStart);
    else console.warn('[SCHEDULER POLICY PATCH] startAutopilotJob 시작 패턴을 찾지 못했습니다');

    const oldDue = "const due=nextRunAt.get(account.id)||0;if(now<due)continue;nextRunAt.set(account.id,now+randomIntervalMinutes()*60*1000);try{await runAutopilotOnce(account);}";
    const newDue = "const role=String(db.prepare('SELECT role FROM users WHERE id=?').get(account.user_id)?.role||'').toLowerCase();const isAdmin=role==='admin';const due=isAdmin?0:(nextRunAt.get(account.id)||0);if(!isAdmin&&now<due)continue;if(isAdmin){if(adminRunning.has(account.id))continue;adminRunning.add(account.id);console.log(`[Autopilot][ADMIN IMMEDIATE] account #${account.id} 간격제한 없이 실행`);}else{nextRunAt.set(account.id,now+randomIntervalMinutes()*60*1000);}try{await runAutopilotOnce(account);}";
    if (src.includes(oldDue)) src = src.replace(oldDue, newDue);
    else console.warn('[SCHEDULER POLICY PATCH] 관리자 due 패턴을 찾지 못했습니다');

    const oldCatchEnd = "console.error(`[완전자동화 실패] account #${account.id}:`,err.response?.data||err.message);}}});}";
    const newCatchEnd = "console.error(`[완전자동화 실패] account #${account.id}:`,err.response?.data||err.message);}finally{if(isAdmin)adminRunning.delete(account.id);}}});}";
    if (src.includes(oldCatchEnd)) src = src.replace(oldCatchEnd, newCatchEnd);
    else console.warn('[SCHEDULER POLICY PATCH] 관리자 running 해제 패턴을 찾지 못했습니다');

    mod._compile(src, filename);
    patched = true;
    console.log('[SCHEDULER POLICY PATCH] 관리자 즉시 자동화 + 일반회원 60~75분 유지 + ContentOnly 비활성화');
    return;
  }
  return realJsLoader(mod, filename);
};
