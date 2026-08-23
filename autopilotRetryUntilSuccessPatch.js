const fs = require('fs');
const path = require('path');

if (!global.__ME2_AUTOPILOT_RETRY_PATCHED__) {
  global.__ME2_AUTOPILOT_RETRY_PATCHED__ = true;

  try {
    const schedulerPath = path.join(__dirname, 'scheduler.js');
    let source = fs.readFileSync(schedulerPath, 'utf8');
    const startMarker = 'function startAutopilotJob(){';
    const endMarker = '\nmodule.exports={startPublishJob,startInsightsJob,startAutopilotJob};';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);

    if (start < 0 || end < 0) {
      console.warn('[Autopilot][RETRY UNTIL SUCCESS PATCH] scheduler 함수 위치를 찾지 못해 적용하지 못했습니다');
    } else {
      const newFn = `function startAutopilotJob(){
  const nextRunAt=new Map();
  const waitLoggedFor=new Map();
  let running=false;
  const RETRY_MINUTES=Math.max(1,Number(process.env.AUTOPILOT_RETRY_MINUTES||5));

  const runTick=async()=>{
    if(running){console.log('[Autopilot][TICK] 이전 자동화 실행 중 → 이번 tick 생략');return;}
    running=true;
    try{
      const now=Date.now();
      for(const s of listAllAccountsForSystem()){
        const account=getAccount(s.id);
        if(!account.autopilot_enabled){nextRunAt.delete(account.id);waitLoggedFor.delete(account.id);continue;}

        const dbNext=account.autopilot_next_at?new Date(account.autopilot_next_at).getTime():NaN;
        const memoryNext=nextRunAt.get(account.id)||0;
        const due=Number.isFinite(dbNext)?Math.min(memoryNext||dbNext,dbNext):(memoryNext||0);

        if(due&&now<due){
          if(waitLoggedFor.get(account.id)!==due){
            waitLoggedFor.set(account.id,due);
            console.log(\`[Autopilot][WAIT] account #\${account.id} next=\${new Date(due).toISOString()} inSec=\${Math.max(0,Math.ceil((due-now)/1000))}\`);
          }
          continue;
        }
        waitLoggedFor.delete(account.id);
        console.log(\`[Autopilot][DUE] account #\${account.id} next=\${Number.isFinite(due)&&due?new Date(due).toISOString():'immediate'} → 실행 시작\`);

        if(hasCoupangKeys(account)){
          const cooldown=coupangApi.getApiCooldown?.(account.id);
          if(cooldown){
            const cooldownMs=new Date(cooldown.cooldown_until).getTime();
            const retryAt=Number.isFinite(cooldownMs)?cooldownMs:now+RETRY_MINUTES*60*1000;
            nextRunAt.set(account.id,retryAt);
            db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(new Date(retryAt).toISOString(),account.id);
            console.log(\`[완전자동화 보충대기][Coupang cooldown] account #\${account.id} next=\${new Date(retryAt).toISOString()}\`);
            continue;
          }
        }

        global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID=account.id;
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
        }finally{
          if(global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID===account.id)delete global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID;
        }
      }
    }finally{running=false;}
  };

  cron.schedule('* * * * *',()=>runTick().catch(e=>console.error('[Autopilot][TICK ERROR]',e.message)));
  setTimeout(()=>runTick().catch(e=>console.error('[Autopilot][STARTUP TICK ERROR]',e.message)),3000);
}`;

      source = source.slice(0, start) + newFn + source.slice(end);
      fs.writeFileSync(schedulerPath, source, 'utf8');
      console.log('[Autopilot][RETRY UNTIL SUCCESS PATCH] 시작 3초 후 즉시 상태확인 + due 즉시실행 + 실패 5분 보충 + 대기시간 로그 활성화');
    }
  } catch (err) {
    console.error('[Autopilot][RETRY UNTIL SUCCESS PATCH] 적용 실패:', err.message);
  }
}
