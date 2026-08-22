const fs = require('fs');
const Module = require('module');

if (!global.__ME2_AUTOPILOT_RETRY_PATCHED__) {
  global.__ME2_AUTOPILOT_RETRY_PATCHED__ = true;
  const originalJs = Module._extensions['.js'];

  Module._extensions['.js'] = function patchedJs(mod, filename) {
    if (!filename.endsWith(`${require('path').sep}scheduler.js`)) {
      return originalJs(mod, filename);
    }

    let source = fs.readFileSync(filename, 'utf8');
    const oldFn = "function startAutopilotJob(){const nextRunAt=new Map();cron.schedule('* * * * *',async()=>{const now=Date.now();for(const s of listAllAccountsForSystem()){const account=getAccount(s.id);if(!account.autopilot_enabled){nextRunAt.delete(account.id);continue;}if(hasCoupangKeys(account)){const cooldown=coupangApi.getApiCooldown?.(account.id);if(cooldown)continue;}const due=nextRunAt.get(account.id)||0;if(now<due)continue;nextRunAt.set(account.id,now+randomIntervalMinutes()*60*1000);try{await runAutopilotOnce(account);}catch(err){if(coupangApi.isRateLimitError?.(err)){console.error(`[완전자동화 중단][Coupang rate limit] account #${account.id}: ${err.message}`);continue;}console.error(`[완전자동화 실패] account #${account.id}:`,err.response?.data||err.message);}}});}";

    const newFn = `function startAutopilotJob(){
  const nextRunAt=new Map();
  const RETRY_MINUTES=Math.max(1,Number(process.env.AUTOPILOT_RETRY_MINUTES||5));
  cron.schedule('* * * * *',async()=>{
    const now=Date.now();
    for(const s of listAllAccountsForSystem()){
      const account=getAccount(s.id);
      if(!account.autopilot_enabled){nextRunAt.delete(account.id);continue;}

      const dbNext=account.autopilot_next_at?new Date(account.autopilot_next_at).getTime():NaN;
      const memoryNext=nextRunAt.get(account.id)||0;
      const due=Number.isFinite(dbNext)?Math.min(memoryNext||dbNext,dbNext):(memoryNext||0);
      if(now<due)continue;

      if(hasCoupangKeys(account)){
        const cooldown=coupangApi.getApiCooldown?.(account.id);
        if(cooldown){
          const cooldownMs=new Date(cooldown.cooldown_until).getTime();
          const retryAt=Number.isFinite(cooldownMs)?cooldownMs:now+RETRY_MINUTES*60*1000;
          nextRunAt.set(account.id,retryAt);
          db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(new Date(retryAt).toISOString(),account.id);
          continue;
        }
      }

      try{
        await runAutopilotOnce(account);
        const successNext=Date.now()+randomIntervalMinutes()*60*1000;
        nextRunAt.set(account.id,successNext);
        db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(new Date(successNext).toISOString(),account.id);
        console.log(\`[Autopilot][SUCCESS SCHEDULE] account #\${account.id} next=\${new Date(successNext).toISOString()}\`);
      }catch(err){
        const retryAt=Date.now()+RETRY_MINUTES*60*1000;
        nextRunAt.set(account.id,retryAt);
        db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(new Date(retryAt).toISOString(),account.id);
        if(coupangApi.isRateLimitError?.(err)){
          console.error(\`[완전자동화 보충대기][Coupang rate limit] account #\${account.id}: \${err.message} next=\${new Date(retryAt).toISOString()}\`);
          continue;
        }
        console.error(\`[완전자동화 실패→보충예약] account #\${account.id}:\`,err.response?.data||err.message,\`next=\${new Date(retryAt).toISOString()}\`);
      }
    }
  });
}`;

    if (!source.includes(oldFn)) {
      console.warn('[Autopilot][RETRY UNTIL SUCCESS PATCH] scheduler 함수 패턴을 찾지 못해 원본으로 실행합니다');
      return originalJs(mod, filename);
    }

    source = source.replace(oldFn, newFn);
    console.log('[Autopilot][RETRY UNTIL SUCCESS PATCH] 실패 시 5분 간격 새소재 재시도 + 성공 시에만 정규주기 전환 활성화');
    mod._compile(source, filename);
  };
}
