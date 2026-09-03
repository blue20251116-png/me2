const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const expressPath = require.resolve('express');
const realExpress = require('express');
let appInstance = null;
function wrappedExpress(...args) { appInstance = realExpress(...args); return appInstance; }
Object.assign(wrappedExpress, realExpress);
// 인증 통과 후 제공되는 메인 index.html에 실시간 조회수 UI 스크립트를 자동 주입한다.
const realStatic = realExpress.static.bind(realExpress);
wrappedExpress.static = function(root, options) {
  const middleware = realStatic(root, options);
  if (options?.index === false) return middleware;
  const resolvedRoot = path.resolve(root);
  const publicRoot = path.resolve(path.join(__dirname, 'public'));
  if (resolvedRoot !== publicRoot) return middleware;
  return function(req, res, next) {
    if (req.path !== '/' && req.path !== '/index.html') return middleware(req, res, next);
    const file = path.join(publicRoot, 'index.html');
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return middleware(req, res, next);
      const tag = '<script src="/liveInsights.js?v=1"></script>';
      if (!html.includes('/liveInsights.js')) html = html.replace('</body>', `${tag}\n</body>`);
      res.type('html').send(html);
    });
  };
};
require.cache[expressPath].exports = wrappedExpress;
require('./server');
if (!appInstance) throw new Error('Express app 초기화에 실패했습니다.');
const { db, getAccount, listAccounts, listAllAccountsForSystem, logUsage } = require('./db');
const threadsApi = require('./threadsApi');
const videoEditor = require('./videoEditor');
const threadsMediaImporter = require('./threadsMediaImporter');
const { generateFromThreadsMaterial } = require('./threadsMaterialWriter');
const { listBenchmarkAccounts, addBenchmarkAccount, addBenchmarkAccountsBulk, deleteBenchmarkAccount, markUsedPost, collectBenchmarkMaterials, collectPostDetails } = require('./benchmarkAccounts');
try { db.exec(`ALTER TABLE posts ADD COLUMN recipe_comment_text TEXT`); } catch {}
try { db.exec(`ALTER TABLE posts ADD COLUMN media_items_json TEXT`); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS insight_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  reposts INTEGER DEFAULT 0,
  quotes INTEGER DEFAULT 0,
  captured_at TEXT NOT NULL,
  UNIQUE(post_id, captured_at)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_insight_history_account_time ON insight_history(account_id, captured_at)`);
const uploadsDir = path.join(__dirname, 'db', 'uploads');
const videoEditLocks=new Set(), threadsImportLocks=new Set(), threadsSearchLocks=new Set();
function requireOwnedAccount(req,res,next){const accountId=Number(req.query.accountId||req.body?.accountId||req.params?.accountId);if(!accountId)return res.status(400).json({error:'accountId가 필요합니다'});const account=getAccount(accountId);if(!account)return res.status(404).json({error:'존재하지 않는 계정입니다'});if(!req.currentUser||account.user_id!==req.currentUser.id)return res.status(403).json({error:'본인 소유의 계정만 이용할 수 있습니다'});req.account=account;next();}
function requireAdmin(req,res,next){if(req.currentUser?.role!=='admin')return res.status(403).json({error:'관리자만 이용할 수 있습니다.'});next();}
function publicBaseUrl(req,account){if(account?.threads_redirect_uri){try{const u=new URL(account.threads_redirect_uri);return `${u.protocol}//${u.host}`;}catch{}}return `${req.protocol}://${req.get('host')}`;}
function ownVideoPath(accountId,filename){return path.join(uploadsDir,'videos',String(accountId),path.basename(String(filename||'')));}
function normalizeMediaItems(items){if(!Array.isArray(items))return[];const out=[];for(const item of items){const type=String(item?.type||'').toUpperCase();const url=String(item?.url||'').trim();if(!url||!['IMAGE','VIDEO'].includes(type))continue;if(!out.some(x=>x.type===type&&x.url===url))out.push({type,url});if(out.length>=10)break;}return out;}
function mediaBundleSentinel(items){return `__THREADS_MEDIA_BUNDLE__${encodeURIComponent(JSON.stringify(items))}`;}
function containsExternalLink(text){const t=String(text||'');return /(?:https?:\/\/|www\.)\S+/i.test(t)||/\b(?:link\.coupang\.com|naver\.me|brandconnect\.naver\.com|m\.site\.naver\.com)\b/i.test(t);}
function isUsableMaterial(item){const hasMedia=!!item?.hasVideo||Number(item?.videoCount||0)>0||Number(item?.imageCount||0)>0||(Array.isArray(item?.images)&&item.images.length>0);return hasMedia&&!containsExternalLink(item?.text);}
function withTimeout(promise,ms,label='작업'){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} 시간 초과`)),ms);})]).finally(()=>clearTimeout(timer));}

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
cron.schedule('* * * * *',collectLiveInsights);
setTimeout(()=>collectLiveInsights().catch(()=>{}),15000);

appInstance.get('/api/live-insights',requireOwnedAccount,(req,res)=>{
  try{
    const since=new Date(Date.now()-24*60*60*1000).toISOString();
    const posts=db.prepare(`SELECT p.id,p.text,p.posted_at,p.threads_media_id,COALESCE(i.views,0) views,COALESCE(i.likes,0) likes,COALESCE(i.replies,0) replies,COALESCE(i.reposts,0) reposts,COALESCE(i.quotes,0) quotes,i.updated_at FROM posts p LEFT JOIN insights i ON i.post_id=p.id WHERE p.account_id=? AND p.status='posted' AND p.posted_at>=? AND p.threads_media_id IS NOT NULL ORDER BY p.posted_at DESC LIMIT 20`).all(req.account.id,since);
    let updatedAt=null;
    const out=posts.map(p=>{
      const history=db.prepare(`SELECT views,likes,replies,reposts,quotes,captured_at FROM insight_history WHERE post_id=? ORDER BY captured_at ASC LIMIT 1500`).all(p.id);
      const u=history.length?history[history.length-1].captured_at:p.updated_at;
      if(u&&(!updatedAt||u>updatedAt))updatedAt=u;
      return {...p,history};
    });
    res.set('Cache-Control','no-store');
    res.json({success:true,updatedAt,posts:out});
  }catch(err){res.status(500).json({error:err.message||'실시간 인사이트 조회 실패'});}
});

appInstance.get('/api/threads/accounts',(req,res)=>{if(!req.currentUser)return res.status(401).json({error:'로그인이 필요합니다'});res.json({accounts:listAccounts(req.currentUser.id)});});
appInstance.get('/api/admin/benchmark-accounts',requireAdmin,(req,res)=>res.json({accounts:listBenchmarkAccounts()}));
appInstance.post('/api/admin/benchmark-accounts',requireAdmin,(req,res)=>{try{res.json({success:true,account:addBenchmarkAccount(req.body?.username)});}catch(err){res.status(400).json({error:err.message});}});
appInstance.post('/api/admin/benchmark-accounts/bulk',requireAdmin,(req,res)=>{try{const result=addBenchmarkAccountsBulk(req.body?.usernames||req.body?.text||'');res.json({success:true,...result});}catch(err){res.status(400).json({error:err.message});}});
appInstance.delete('/api/admin/benchmark-accounts/:id',requireAdmin,(req,res)=>{deleteBenchmarkAccount(req.params.id);res.json({success:true});});
appInstance.get('/api/threads/material-search',requireOwnedAccount,async(req,res)=>{if(threadsSearchLocks.has(req.account.id))return res.status(429).json({error:'이미 소재를 찾는 중입니다. 잠시 후 다시 시도해주세요.'});threadsSearchLocks.add(req.account.id);try{const requested=Math.max(1,Math.min(Number(req.query.limit)||12,20));const candidates=await collectBenchmarkMaterials({limit:Math.min(requested*3,30)});const items=candidates.filter(isUsableMaterial).slice(0,requested);res.json({success:true,items});}catch(err){console.error(`[material search] account #${req.account.id}:`,err.message);res.status(422).json({error:err.message||'소재를 찾지 못했습니다.'});}finally{threadsSearchLocks.delete(req.account.id);}});
appInstance.post('/api/threads/material-write',requireOwnedAccount,async(req,res)=>{
  const keyword=String(req.body?.keyword||'').trim(),sourceText=String(req.body?.sourceText||'').trim(),sourceUrl=String(req.body?.sourceUrl||'').trim(),username=String(req.body?.username||'').trim(),mode=req.body?.mode==='recipe'?'recipe':'product';
  if(!keyword&&!sourceText&&!sourceUrl)return res.status(400).json({error:'소재 내용이 필요합니다.'});
  try{
    let detailedText=sourceText;
    let authorReplies='';
    let detailWarning='';
    let sourceMedia={images:Array.isArray(req.body?.images)?req.body.images.filter(Boolean):[],videos:[],hasVideo:!!req.body?.hasVideo};
    if(sourceUrl&&username){
      try{
        const details=await withTimeout(collectPostDetails(sourceUrl,username),9000,'원문·댓글 확인');
        if(details?.sourceText&&details.sourceText.trim().length>=8)detailedText=details.sourceText.trim();
        if(Array.isArray(details?.authorReplies))authorReplies=details.authorReplies.filter(Boolean).join('\n\n');
        const detailImages=Array.isArray(details?.images)?details.images.filter(Boolean):[];
        const detailVideos=Array.isArray(details?.videos)?details.videos.filter(Boolean):[];
        sourceMedia={images:detailImages.length?detailImages:sourceMedia.images,videos:detailVideos,hasVideo:!!details?.hasVideo||sourceMedia.hasVideo};
      }catch(detailErr){detailWarning=String(detailErr?.message||'상세 확인 실패');console.warn(`[material detail fallback] account #${req.account.id} @${username}: ${detailWarning}`);}
    }
    if(!detailedText&&keyword)detailedText=keyword;
    if(!detailedText)return res.status(422).json({error:'소재 본문을 확인하지 못했습니다. 다른 소재를 선택해주세요.'});
    if(!sourceMedia.hasVideo&&!sourceMedia.images.length&&!sourceMedia.videos.length)return res.status(422).json({error:'사진 또는 영상이 없는 게시물은 소재로 사용할 수 없습니다.'});
    const generated=await withTimeout(generateFromThreadsMaterial(req.account.id,{keyword,sourceText:detailedText,authorReplies,mode}),22000,'AI 글 작성');
    if(req.currentUser?.id)logUsage(req.currentUser.id,'text');
    res.json({success:true,mode,sourceMedia,authorRepliesFound:authorReplies?authorReplies.split(/\n\n+/).filter(Boolean).length:0,detailWarning,...generated});
  }catch(err){res.status(422).json({error:err.response?.data?.error?.message||err.message});}
});
appInstance.post('/api/threads/material-post',requireOwnedAccount,(req,res)=>{const text=String(req.body?.text||'').trim(),scheduledAt=String(req.body?.scheduled_at||'').trim(),recipeCommentText=String(req.body?.recipe_comment_text||'').trim();if(!text||!scheduledAt)return res.status(400).json({error:'본문과 발행 예정 시각은 필수입니다.'});const mediaItems=normalizeMediaItems(req.body?.media_items);const imageList=mediaItems.filter(x=>x.type==='IMAGE').map(x=>x.url),videoList=mediaItems.filter(x=>x.type==='VIDEO').map(x=>x.url);let imageUrl=String(req.body?.image_url||'').trim()||null,extraImageUrl=String(req.body?.extra_image_url||'').trim()||null,videoUrl=String(req.body?.video_url||'').trim()||null;if(mediaItems.length===1){imageUrl=mediaItems[0].type==='IMAGE'?mediaItems[0].url:null;videoUrl=mediaItems[0].type==='VIDEO'?mediaItems[0].url:null;extraImageUrl=null;}else if(mediaItems.length>1){imageUrl=mediaBundleSentinel(mediaItems);extraImageUrl=null;videoUrl=null;}else{imageUrl=imageList[0]||imageUrl;extraImageUrl=imageList[1]||extraImageUrl;videoUrl=videoList[0]||videoUrl;}const link=String(req.body?.link||'').trim()||null,autoCommentEnabled=req.body?.auto_comment_enabled===false?0:1,commentStatus=(link||recipeCommentText)&&autoCommentEnabled?'pending':'none';const info=db.prepare(`INSERT INTO posts (account_id,text,link,image_url,extra_image_url,video_url,scheduled_at,auto_comment_enabled,comment_status,recipe_comment_text,media_items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.account.id,text,link,imageUrl,extraImageUrl,videoUrl,scheduledAt,autoCommentEnabled,commentStatus,recipeCommentText||null,mediaItems.length?JSON.stringify(mediaItems):null);res.json({success:true,id:info.lastInsertRowid,mediaCount:mediaItems.length});});
appInstance.post('/api/threads/import',requireOwnedAccount,async(req,res)=>{const url=String(req.body?.url||'').trim();if(!url)return res.status(400).json({error:'Threads 게시물 URL을 입력해주세요.'});if(threadsImportLocks.has(req.account.id))return res.status(429).json({error:'이미 Threads 영상을 가져오는 중입니다.'});threadsImportLocks.add(req.account.id);try{const outputDir=path.join(uploadsDir,'videos',String(req.account.id));if(!fs.existsSync(outputDir))fs.mkdirSync(outputDir,{recursive:true});const result=await threadsMediaImporter.importThreadsVideo({url,outputDir});markUsedPost(url);const base=publicBaseUrl(req,req.account),publicUrl=`${base}/uploads/videos/${req.account.id}/${encodeURIComponent(result.filename)}`;res.json({success:true,filename:result.filename,url:publicUrl,mediaType:'video',size:result.size,sourceUrl:result.sourceUrl,poster:result.poster||null,title:result.title||''});}catch(err){res.status(422).json({error:err.message||'Threads 영상을 가져오지 못했습니다.'});}finally{threadsImportLocks.delete(req.account.id);}});
appInstance.post('/api/video/edit',requireOwnedAccount,async(req,res)=>{const filename=path.basename(String(req.body?.filename||''));if(!filename)return res.status(400).json({error:'편집할 영상 filename이 필요합니다.'});const inputPath=ownVideoPath(req.account.id,filename);if(!fs.existsSync(inputPath))return res.status(404).json({error:'편집할 영상 파일을 찾을 수 없습니다.'});if(videoEditLocks.has(req.account.id))return res.status(429).json({error:'이미 영상 편집 중입니다.'});videoEditLocks.add(req.account.id);try{const outputDir=path.join(uploadsDir,'videos',String(req.account.id));const result=await videoEditor.editVideo({inputPath,outputDir,start:req.body?.start,end:req.body?.end,mute:req.body?.mute!==false});const base=publicBaseUrl(req,req.account),publicUrl=`${base}/uploads/videos/${req.account.id}/${encodeURIComponent(result.filename)}`;res.json({success:true,filename:result.filename,url:publicUrl,mediaType:'video',size:result.size,sourceDuration:result.sourceDuration,start:result.start,end:result.end,duration:result.duration,muted:result.muted});}catch(err){res.status(422).json({error:err.message||'영상 편집에 실패했습니다.'});}finally{videoEditLocks.delete(req.account.id);}});
console.log('[Threads material] 소재 찾기 V2 + 1분 실시간 인사이트 활성화');
