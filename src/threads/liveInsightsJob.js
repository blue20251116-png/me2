'use strict';
// Collects Threads insights for posts from the last 24h: every minute for the first 2 hours,
// every 5 minutes up to 6h, every 15 minutes up to 24h. Feeds the dashboard's live chart.
const cron = require('node-cron');
const { db, getAccount, listAllAccountsForSystem } = require('../infra/db');
const threadsApi = require('./threadsApi');

// ---------- 1분 단위 Threads 인사이트 수집 ----------
let liveInsightRunning = false;
function roundedMinuteIso(){return new Date(Math.floor(Date.now()/60000)*60000).toISOString();}
function shouldCollectByAge(postedAt, nowMs){
  const ageMin=Math.max(0,(nowMs-new Date(postedAt).getTime())/60000);
  const minute=new Date(nowMs).getMinutes();
  if(ageMin<=120)return true;
  if(ageMin<=360)return minute%5===0;
  if(ageMin<=1440)return minute%15===0;
  return false;
}
async function collectLiveInsights(){
  if(liveInsightRunning)return;
  liveInsightRunning=true;
  try{
    const nowMs=Date.now();
    const since=new Date(nowMs-24*60*60*1000).toISOString();
    const capturedAt=roundedMinuteIso();
    for(const summary of listAllAccountsForSystem()){
      const account=getAccount(summary.id);
      if(!account?.threads_access_token)continue;
      const posts=db.prepare(`SELECT id, posted_at, threads_media_id FROM posts WHERE account_id=? AND status='posted' AND posted_at>=? AND threads_media_id IS NOT NULL ORDER BY posted_at DESC`).all(account.id,since);
      for(const post of posts){
        if(!shouldCollectByAge(post.posted_at,nowMs))continue;
        try{
          const stats=await threadsApi.getMediaInsights(account.id,post.threads_media_id);
          const views=Number(stats.views||0),likes=Number(stats.likes||0),replies=Number(stats.replies||0),reposts=Number(stats.reposts||0),quotes=Number(stats.quotes||0);
          db.prepare(`INSERT INTO insights (post_id,views,likes,replies,reposts,quotes,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,reposts=excluded.reposts,quotes=excluded.quotes,updated_at=excluded.updated_at`).run(post.id,views,likes,replies,reposts,quotes,capturedAt);
          db.prepare(`INSERT OR REPLACE INTO insight_history (post_id,account_id,views,likes,replies,reposts,quotes,captured_at) VALUES (?,?,?,?,?,?,?,?)`).run(post.id,account.id,views,likes,replies,reposts,quotes,capturedAt);
        }catch(e){console.error(`[실시간 인사이트 실패] account #${account.id} post #${post.id}:`,e.message);}
      }
    }
    // 8일보다 오래된 분단위 이력은 정리해 DB가 무한히 커지는 것을 막는다.
    db.prepare(`DELETE FROM insight_history WHERE captured_at < ?`).run(new Date(nowMs-8*24*60*60*1000).toISOString());
  }finally{liveInsightRunning=false;}
}
function startLiveInsightsJob(){
  cron.schedule('* * * * *',collectLiveInsights,{noOverlap:true});
  setTimeout(()=>collectLiveInsights().catch(()=>{}),15000);
}

module.exports = { startLiveInsightsJob, collectLiveInsights, shouldCollectByAge };
