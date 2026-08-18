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
function isAdminAccount(accountId){
  try{
    const r=db.prepare(`SELECT u.role FROM accounts a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=?`).get(Number(accountId));
    return String(r?.role||'').toLowerCase()==='admin';
  }catch{return false;}
}
function enabledNonAdminAccounts(){
  try{
    return db.prepare(`SELECT a.id,a.autopilot_next_at FROM accounts a LEFT JOIN users u ON u.id=a.user_id WHERE a.autopilot_enabled=1 AND COALESCE(u.role,'user')!='admin'`).all();
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
  try{
    accounts=db.prepare(`SELECT a.id FROM accounts a LEFT JOIN users u ON u.id=a.user_id WHERE COALESCE(u.role,'user')!='admin'`).all();
  }catch{return;}
  for(const row of accounts){
    const accountId=Number(row.id);
    let due=[];
    try{due=db.prepare(`SELECT id,scheduled_at FROM posts WHERE account_id=? AND status='pending' AND scheduled_at<=? ORDER BY scheduled_at ASC,id ASC`).all(accountId,new Date(now).toISOString());}catch{continue;}
    if(!due.length)continue;
    const last=lastPostedMs(accountId);
    let base=now;
    let allowFirst=true;
    if(last && now-last<MIN_MINUTES*60*1000){
      base=Math.max(now,last)+randomDelayMs();
      allowFirst=false;
    }
    const toDelay=allowFirst?due.slice(1):due;
    let slot=base;
    for(const post of toDelay){
      const scheduled=new Date(slot).toISOString();
      db.prepare('UPDATE posts SET scheduled_at=? WHERE id=?').run(scheduled,post.id);
      console.log(`[Publish][SPACING] account #${accountId} post #${post.id} postponed=${scheduled}`);
      slot+=randomDelayMs();
    }
  }
}

// Railway 재배포/재시작 시 일반회원 자동발행 시간이 초기화되지 않도록
// autopilot cron 실행 직전에 DB의 autopilot_next_at을 강제 적용한다.
const realSchedule = cron.schedule.bind(cron);
cron.schedule = function(expression, task, options){
  const src=String(task||'');
  const isAutopilotTask=expression==='* * * * *' && src.includes('autopilot_enabled') && src.includes('runAutopilotOnce');
  const isPublishTask=expression==='* * * * *' && src.includes("status='pending'") && src.includes('publishScheduledPost');

  if(isPublishTask){
    const wrappedPublish=async(...args)=>{
      postponePendingBursts();
      return task(...args);
    };
    console.log('[Publish][SPACING] 일반회원 연속발행 방지 활성화 · 관리자 제외');
    return realSchedule(expression,wrappedPublish,options);
  }
  if(!isAutopilotTask)return realSchedule(expression,task,options);

  const wrapped=async(...args)=>{
    const now=Date.now();
    const temporarilyDisabled=[];
    const dueAccounts=[];
    const beforePosts=new Map();

    for(const row of enabledNonAdminAccounts()){
      const parsed=Date.parse(row.autopilot_next_at||'');
      const last=lastPostedMs(row.id);

      // 최근 60분 내 실제 발행이 있으면 DB 시간이 과거여도 재배포 직후 즉시 재발행하지 않는다.
      if(last && now-last<MIN_MINUTES*60*1000){
        const next=nextIso(last);
        db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(next,row.id);
        db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);
        temporarilyDisabled.push(row.id);
        console.log(`[Autopilot][PERSIST] account #${row.id} 최근발행 보호 next=${next}`);
        continue;
      }

      if(!Number.isFinite(parsed)){
        const next=nextIso();
        db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(next,row.id);
        db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);
        temporarilyDisabled.push(row.id);
        console.log(`[Autopilot][PERSIST] account #${row.id} 초기 다음발행=${next}`);
        continue;
      }
      if(now<parsed){
        db.prepare('UPDATE accounts SET autopilot_enabled=0 WHERE id=?').run(row.id);
        temporarilyDisabled.push(row.id);
        continue;
      }

      // due 계정은 실행 중 중복 진입을 막기 위해 먼저 다음 시간을 예약한다.
      const lockNext=nextIso();
      db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(lockNext,row.id);
      dueAccounts.push(row.id);
      beforePosts.set(row.id,newestPostId(row.id));
      console.log(`[Autopilot][PERSIST] account #${row.id} 실행허용 lockNext=${lockNext}`);
    }

    try{
      await task(...args);
      for(const accountId of dueAccounts){
        const after=newestPostId(accountId);
        if(after>Number(beforePosts.get(accountId)||0)){
          const next=nextIso();
          db.prepare('UPDATE accounts SET autopilot_next_at=? WHERE id=?').run(next,accountId);
          console.log(`[Autopilot][PERSIST] account #${accountId} 생성성공 next=${next}`);
        }
      }
    }finally{
      for(const accountId of temporarilyDisabled){
        db.prepare('UPDATE accounts SET autopilot_enabled=1 WHERE id=?').run(accountId);
      }
    }
  };
  console.log('[Autopilot][PERSIST] 일반회원 DB 스케줄 보호 활성화 · 관리자 제외');
  return realSchedule(expression,wrapped,options);
};

// 관리자 페이지는 기존 서버 라우트를 건드리지 않고 응답 시 관리 UI 스크립트만 삽입한다.
const realSendFile = express.response.sendFile;
express.response.sendFile = function(filePath,...args){
  try{
    if(path.basename(String(filePath||''))==='admin.html'){
      const html=fs.readFileSync(filePath,'utf8');
      const out=html.includes('/adminMemberEnhance.js')?html:html.replace('</body>',`${ADMIN_UI_SCRIPT}\n</body>`);
      return this.type('html').send(out);
    }
  }catch(err){
    console.warn(`[ADMIN UI PATCH] inject 실패: ${err.message}`);
  }
  return realSendFile.call(this,filePath,...args);
};

console.log('[RUNTIME FIX] 자동발행 시간 영속화 + 연속발행 방지 + 관리자 회원 UI 패치 활성화');
