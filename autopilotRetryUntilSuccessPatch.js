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
    } else if (source.includes('[완전자동화 실패→보충예약]')) {
      console.log('[Autopilot][RETRY UNTIL SUCCESS PATCH] 이미 적용됨');
    } else {
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
          console.log(\`[완전자동화 보충대기][Coupang cooldown] account #\${account.id} next=\${new Date(retryAt).toISOString()}\`);
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

      source = source.slice(0, start) + newFn + source.slice(end);
      fs.writeFileSync(schedulerPath, source, 'utf8');
      console.log('[Autopilot][RETRY UNTIL SUCCESS PATCH] 런타임 scheduler 직접교체 완료 · 실패 시 5분 뒤 새소재 재시도 · 성공 시에만 정규주기');
    }
  } catch (err) {
    console.error('[Autopilot][RETRY UNTIL SUCCESS PATCH] 적용 실패:', err.message);
  }
}
