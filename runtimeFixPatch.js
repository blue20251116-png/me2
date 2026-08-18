const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const { db } = require('./db');

const MIN_MINUTES = 60;
const MAX_MINUTES = 75;
const ADMIN_UI_SCRIPT = '<script src="/adminMemberEnhance.js?v=2"></script>';

function randomDelayMs(){
  return (MIN_MINUTES + Math.floor(Math.random() * (MAX_MINUTES - MIN_MINUTES + 1))) * 60 * 1000;
}
function nextIso(base=Date.now()){ return new Date(base + randomDelayMs()).toISOString(); }
function enabledNonAdminAccounts(){
  try{
    return db.prepare(`SELECT a.id,a.autopilot_next_at,a.threads_access_token FROM accounts a LEFT JOIN users u ON u.id=a.user_id WHERE a.autopilot_enabled=1 AND COALESCE(u.role,'user')!='admin'`).all();
  }catch{return[];}
}
function newestPostId(accountId){
  try{return Number(db.prepare('SELECT COALESCE(MAX(id),0) id FROM posts WHERE account_id=?').get(accountId)?.id||0);}catch{return 0;}
}
function lastPostedMs(accountId){
  try{
    const raw=db.prepare(`SELECT posted_at FROM posts WHERE account_id=? AND status='posted' AND posted_at IS NOT NULL ORDER BY posted_at DESC LIMIT 1`).get(accountId)?.posted_at;
    const ms=Date.parse(raw||'');
    return Number.isFinite(ms)?ms:0;
  }catch{return 0;}
}
function postponePendingBursts(){
  const now=Date.now();
  let accounts=[];
  try{accounts=db.prepare(`SELECT a.id FROM accounts a LEFT JOIN users u ON u.id=a.user_id WHERE COALESCE(u.role,'user')!='admin'`).all();}catch{return;}
  for(const row of accounts){
    const accountId=Number(row.id);let due=[];
    try{due=db.prepare(`SELECT id,scheduled_at FROM posts WHERE account_id=? AND status='pending' AND scheduled_at<=? ORDER BY scheduled_at ASC,id ASC`).all(accountId,new Date(now).toISOString());}catch{continue;}
    if(!due.length)continue;
    const last=lastPostedMs(accountId);let base=now;let allowFirst=true;
    if(last && now-last<MIN_MINUTES*60*1000){base=Math.max(now,last)+randomDelayMs();allowFirst=false;}
    const toDelay=allowFirst?due.slice(1):due;let slot=base;
    for(const post of toDelay){const scheduled=new Date(slot).toISOString();db.prepare('UPDATE posts SET scheduled_at=? WHERE id=?').run(scheduled,post.id);console.log(`[Publish][SPACING] account #${accountId} post #${post.id} postponed=${scheduled}`);slot+=randomDelayMs();}
  }
}

const realSchedule = cron.schedule.bind(cron);
cron.schedule = function(expression, task, options){
  const src=String(task||'');
  const isAutopilotTask=expression==='* * * * *' && src.includes('autopilot_enabled') && src.includes('runAutopilotOnce');
  const isPublishTask=expression==='* * * * *' && src.includes("status='pending'") && src.includes('publishScheduledPost');
  if(isPublishTask){
    const wrappedPublish=async(...args)=>{postponePendingBursts();return task(...args);};
    console.log('[Publish][SPACING] 일반회원 연속발행 방지 활성화 · 관리자 제외');
    return realSchedule(expression,wrappedPublish,options);
  }
  if(!isAutopilotTask)return realSchedule(expression,task,options);

  const wrapped=async(...args)=>{
    const now=Date.now();const temporarilyDisabled=[];const dueAccounts=[];const beforePosts=new Map();
    for(const row of enabledNonAdminAccounts()){
      // Threads 미연결 계정은 소재수집/OpenAI/쿠팡검색 전에 차단해 비용과 실패 post 생성을 막는다.
      if(!String(row.threads_access_token||'').trim()){
        db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);
        temporarilyDisabled.push(row.id);
        console.warn(`[Autopilot][TOKEN SKIP] account #${row.id} Threads Access Token 없음 → 자동화 생성 단계 건너뜀`);
        continue;
      }
      const parsed=Date.parse(row.autopilot_next_at||'');const last=lastPostedMs(row.id);
      if(last && now-last<MIN_MINUTES*60*1000){
        const next=nextIso(last);db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(next,row.id);db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);temporarilyDisabled.push(row.id);console.log(`[Autopilot][PERSIST] account #${row.id} 최근발행 보호 next=${next}`);continue;
      }
      if(!Number.isFinite(parsed)){
        const next=nextIso();db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(next,row.id);db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);temporarilyDisabled.push(row.id);console.log(`[Autopilot][PERSIST] account #${row.id} 초기 다음발행=${next}`);continue;
      }
      if(now<parsed){db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);temporarilyDisabled.push(row.id);continue;}
      const lockNext=nextIso();db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(lockNext,row.id);dueAccounts.push(row.id);beforePosts.set(row.id,newestPostId(row.id));console.log(`[Autopilot][PERSIST] account #${row.id} 실행허용 lockNext=${lockNext}`);
    }
    try{
      await task(...args);
      for(const accountId of dueAccounts){
        const after=newestPostId(accountId);
        if(after>Number(beforePosts.get(accountId)||0)){const next=nextIso();db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(next,accountId);console.log(`[Autopilot][PERSIST] account #${accountId} 생성성공 next=${next}`);}
      }
    }finally{
      for(const accountId of temporarilyDisabled)db.prepare('UPDATE accounts SET autopilot_enabled=1 WHERE id=?').run(accountId);
    }
  };
  console.log('[Autopilot][PERSIST] 일반회원 DB 스케줄 보호 + Threads 토큰 사전검사 활성화 · 관리자 제외');
  return realSchedule(expression,wrapped,options);
};

const realSendFile = express.response.sendFile;
express.response.sendFile = function(filePath,...args){
  try{
    if(path.basename(String(filePath||''))==='admin.html'){
      const html=fs.readFileSync(filePath,'utf8');
      const out=html.includes('/adminMemberEnhance.js')?html:html.replace('</body>',`${ADMIN_UI_SCRIPT}\n</body>`);
      return this.type('html').send(out);
    }
  }catch(err){console.warn(`[ADMIN UI PATCH] inject 실패: ${err.message}`);}
  return realSendFile.call(this,filePath,...args);
};

console.log('[RUNTIME FIX] 자동발행 시간 영속화 + 토큰없는 일반회원 사전차단 + 연속발행 방지 + 관리자 회원 UI 패치 활성화');
