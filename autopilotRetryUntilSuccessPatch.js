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
    } else if (source.includes('[완전자동화 보충대기][Gemini cooldown]')) {
      console.log('[Autopilot][RETRY UNTIL SUCCESS PATCH] Gemini 429 즉시이월 버전 이미 적용됨');
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

      global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID=account.id;
      try{
        await runAutopilotOnce(account);
        const successNext=Date.now()+randomIntervalMinutes()*60*1000;
        nextRunAt.set(account.id,successNext);
        db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(new Date(successNext).toISOString(),account.id);
        console.log(\`[Autopilot][SUCCESS SCHEDULE] account #\${account.id} next=\${new Date(successNext).toISOString()}\`);
      }catch(err){
        if(err?.isGeminiRateLimit || err?.code==='GEMINI_COOLDOWN'){
          const cooldownMs=Number(err?.geminiCooldownUntil||global.__ME2_GEMINI_COOLDOWN_UNTIL||0);
          const retryAt=Math.max(Date.now()+15000,Number.isFinite(cooldownMs)&&cooldownMs>Date.now()?cooldownMs+3000:Date.now()+60000);
          nextRunAt.set(account.id,retryAt);
          db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(new Date(retryAt).toISOString(),account.id);
          console.warn(\`[완전자동화 보충대기][Gemini cooldown] account #\${account.id} 소재보존=yes next=\${new Date(retryAt).toISOString()}\`);
          continue;
        }

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
  });
}`;

      source = source.slice(0, start) + newFn + source.slice(end);
      fs.writeFileSync(schedulerPath, source, 'utf8');
      console.log('[Autopilot][RETRY UNTIL SUCCESS PATCH] Gemini 429 즉시이월 활성화 · 해당 계정만 cooldown · 소재보존 · 다음 계정 계속');
    }
  } catch (err) {
    console.error('[Autopilot][RETRY UNTIL SUCCESS PATCH] 적용 실패:', err.message);
  }
}
