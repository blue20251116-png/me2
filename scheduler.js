const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, listAllAccountsForSystem, getAccount, getUserById, canPublish, logUsage, findMediaSourceForProduct, markMediaSourceUsed } = require('./db');
const { publishPost, publishCarouselPost, publishReply, getMediaInsights } = require('./threadsApi');
const coupangApi = require('./coupangApi');
const { generateRecipe: generateContentOnlyRecipe } = require('./contentOnlyAutomation');
const { buildThreadsFirstAutopilot } = require('./autopilotMaterialEngine');
const { importThreadsVideo } = require('./threadsMediaImporter');
const { getBrowserCircuitState, browserInfraFailure } = require('./isolatedTask');
const { setState, budgetState } = require('./automationState');

try { db.exec(`ALTER TABLE posts ADD COLUMN recipe_comment_text TEXT`); } catch {}
try { db.exec(`ALTER TABLE posts ADD COLUMN comment_retry_count INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE posts ADD COLUMN comment_next_retry_at TEXT`); } catch {}

const MEDIA_BUNDLE_PREFIX='__THREADS_MEDIA_BUNDLE__';
function encodeMediaBundle(items){
  const normalized=[];
  for(const item of items||[]){
    const type=String(item?.type||'').toUpperCase();
    const url=String(item?.url||'').trim();
    if(!url||!['IMAGE','VIDEO'].includes(type))continue;
    if(!normalized.some(x=>x.type===type&&x.url===url))normalized.push({type,url});
    if(normalized.length>=10)break;
  }
  return normalized.length?`${MEDIA_BUNDLE_PREFIX}${encodeURIComponent(JSON.stringify(normalized))}`:null;
}

function hasCoupangKeys(a){return !!(String(a?.coupang_access_key||'').trim()&&String(a?.coupang_secret_key||'').trim());}
function isCoupangLink(link){return /(^|\.)coupang\.com|link\.coupang\.com/i.test(String(link||''));}
const DEFAULT_COUPANG_DISCLOSURE='이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';
function buildDisclosureOnly(account){return DEFAULT_COUPANG_DISCLOSURE;}
function trimToLimit(text,limit){const n=String(text||'').trim();const cap=Math.max(0,Number(limit)||0);if(!cap)return'';if(n.length<=cap)return n;if(cap===1)return'…';return `${n.slice(0,cap-1).trimEnd()}…`;}
function cleanCommentLine(line){return String(line||'').replace(/\s+/g,' ').trim();}
function compactRecipePrefix(prefix,limit){const cap=Math.max(0,Number(limit)||0);if(!cap)return'';const raw=String(prefix||'').replace(/\r/g,'').trim();if(!raw)return'';if(raw.length<=cap)return raw;const lines=raw.split('\n').map(cleanCommentLine).filter(Boolean);const ingredientIdx=lines.findIndex(x=>/재료/.test(x));const methodIdx=lines.findIndex(x=>/(만드는\s*법|조리\s*법|만들기)/.test(x));const isRecipe=ingredientIdx>=0||methodIdx>=0;if(!isRecipe){const out=[];let used=0;for(const line of lines){const add=(out.length?1:0)+line.length;if(used+add>cap)break;out.push(line);used+=add;}return out.join('\n');}const ingredientHeader='🥘 재료';const methodHeader='🍳 만드는 법';let ingredients=[];let methods=[];const ingStart=ingredientIdx>=0?ingredientIdx+1:0;const ingEnd=methodIdx>ingStart?methodIdx:lines.length;for(const line of lines.slice(ingStart,ingEnd)){const cleaned=line.replace(/^[▪•·\-–—*✅\s]+/,'').trim();if(cleaned&&!/^(재료|만드는\s*법|조리\s*법)$/i.test(cleaned))ingredients.push(cleaned);}if(methodIdx>=0){for(const line of lines.slice(methodIdx+1)){const cleaned=line.replace(/^\s*\d+[.)]\s*/,'').replace(/^[▪•·\-–—*✅\s]+/,'').trim();if(cleaned)methods.push(cleaned);}}if(!ingredients.length&&ingredientIdx>=0){const inline=lines[ingredientIdx].replace(/^.*?재료\s*[:：]?\s*/,'').trim();if(inline)ingredients=[inline];}if(!methods.length&&methodIdx>=0){const inline=lines[methodIdx].replace(/^.*?(?:만드는\s*법|조리\s*법|만들기)\s*[:：]?\s*/,'').trim();if(inline)methods=[inline];}const render=(ings,steps)=>{const a=ings.length?`${ingredientHeader}\n${ings.join(', ')}`:'';const b=steps.length?`${methodHeader}\n${steps.map((x,i)=>`${i+1}. ${x}`).join('\n')}`:'';return[a,b].filter(Boolean).join('\n\n');};let ing=ingredients.slice(0,8),steps=methods.slice(0,4),out=render(ing,steps);while(out.length>cap&&steps.length>1){steps.pop();out=render(ing,steps);}while(out.length>cap&&ing.length>3){ing.pop();out=render(ing,steps);}if(out.length<=cap&&ing.length&&steps.length)return out;const minIng=ingredients.slice(0,3);const minSteps=methods.slice(0,1);out=render(minIng,minSteps);if(out.length<=cap&&minIng.length&&minSteps.length)return out;const safe=[];let used=0;for(const line of lines){const add=(safe.length?1:0)+line.length;if(used+add>cap)break;safe.push(line);used+=add;}return safe.join('\n');}
function extractFirstHttpUrl(value){const m=String(value||'').match(/https?:\/\/[^\s<>'\"\])}]+/i);return m?m[0].replace(/[.,;]+$/,''):'';}
function sanitizeCommentPrefix(value){
  const raw=String(value||'').replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim();
  if(!raw)return '';
  const isRecipe=/(🥘|🍳|재료|만드는\s*법|조리\s*법)/i.test(raw);
  if(isRecipe)return raw.replace(/^\s*✅?\s*핵심만\s*[:：]?\s*\n?/i,'').trim();
  const lines=raw.split('\n').map(x=>x.replace(/^\s*(?:✅\s*)?(?:핵심만\s*[:：]?\s*)?/i,'').replace(/^\s*[-▪•·*]+\s*/,'').trim()).filter(Boolean);
  const clean=[];for(const line of lines){if(!clean.includes(line))clean.push(line);}
  return clean.join('\n').trim();
}
function buildDoubleLinkComment(account,prefix,link,maxLength=450){
  const cap=Math.min(450,Math.max(1,Number(maxLength)||450));
  const l=extractFirstHttpUrl(link);
  if(!l)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');
  const disclosure=isCoupangLink(l)?DEFAULT_COUPANG_DISCLOSURE:'';
  // Regression: this used to repeat the exact same URL string twice ([l, l, disclosure]) to make
  // Threads see "2 URLs" and skip its single-link auto-preview card - an independently-written
  // duplicate of the same idea threadsApi.js's applyCoupangReplyPreviewGuard() already implements
  // with a differentiated #fragment variant instead of a literal repeat. Two identical copies of
  // the same link may well still read as "one link" to Threads' crawler (which is presumably why
  // the preview kept showing up), so this now uses the same fragment-variant technique instead -
  // keeping the exact same length budget (still 2 URL-worth of space reserved in `cap`), only
  // changing what the second URL string looks like.
  const alternate=l.includes('#')?`${l}preview2`:`${l}#preview2`;
  const tail=[l,alternate,disclosure].filter(Boolean).join('\n\n');
  if(tail.length>cap)throw new Error('쿠팡 링크 자체가 너무 길어 댓글을 만들 수 없습니다: '+tail.length+'자');
  const available=Math.max(0,cap-tail.length-2);
  const safePrefix=sanitizeCommentPrefix(prefix);
  const head=compactRecipePrefix(safePrefix,available);
  const comment=[head,tail].filter(Boolean).join('\n\n');
  if(comment.length>cap)throw new Error('댓글 길이 조립 오류: '+comment.length+'/'+cap+'자');
  return comment;
}

function formatThreadsBody(text){return require('./threadsVoicePolicy').formatVoice(text);}

const uploadsDir=path.join(__dirname,'db','uploads');
if(!fs.existsSync(uploadsDir))fs.mkdirSync(uploadsDir,{recursive:true});
function getPublicBaseUrl(){const explicit=String(process.env.PUBLIC_BASE_URL||process.env.APP_URL||'').trim().replace(/\/$/,'');if(/^https?:\/\//i.test(explicit))return explicit;const railway=String(process.env.RAILWAY_PUBLIC_DOMAIN||'').trim().replace(/^https?:\/\//i,'').replace(/\/$/,'');if(railway)return `https://${railway}`;return'';}
function publicUploadUrl(filename){const base=getPublicBaseUrl();if(!base)throw new Error('공개 서비스 주소를 확인할 수 없습니다. PUBLIC_BASE_URL 또는 RAILWAY_PUBLIC_DOMAIN이 필요합니다.');return `${base}/uploads/${encodeURIComponent(filename)}`;}
function localPathFromUploadUrl(url){if(!url)return null;const marker='/uploads/';const idx=url.indexOf(marker);if(idx===-1)return null;return path.join(uploadsDir,decodeURIComponent(url.slice(idx+marker.length)));}
function mediaSourceFilesExist(media){const p=localPathFromUploadUrl(media.image_url);if(!p||!fs.existsSync(p))return false;if(media.extra_image_url){const e=localPathFromUploadUrl(media.extra_image_url);if(!e||!fs.existsSync(e))return false;}return true;}
async function buildCommentText(account,post){if(hasCoupangKeys(account)&&post.recipe_comment_text&&!post.link)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');if(!post.link)return compactRecipePrefix(sanitizeCommentPrefix(post.recipe_comment_text||''),450);return buildDoubleLinkComment(account,post.recipe_comment_text||'',post.link,450);}
function startPublishJob(){return require("./publishQueue").startPublishJob({buildCommentText});}
function startInsightsJob(){cron.schedule('*/10 * * * *',async()=>{const start=new Date();start.setHours(0,0,0,0);for(const s of listAllAccountsForSystem()){const posts=db.prepare(`SELECT * FROM posts WHERE account_id=? AND status='posted' AND posted_at>=? AND threads_media_id IS NOT NULL`).all(s.id,start.toISOString());for(const p of posts){try{const stats=await getMediaInsights(s.id,p.threads_media_id);db.prepare(`INSERT INTO insights (post_id,views,likes,replies,reposts,quotes,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,reposts=excluded.reposts,quotes=excluded.quotes,updated_at=excluded.updated_at`).run(p.id,stats.views||0,stats.likes||0,stats.replies||0,stats.reposts||0,stats.quotes||0,new Date().toISOString());}catch(e){console.error(`[인사이트 갱신 실패] account #${s.id}:`,e.message);}}}},{noOverlap:true});}
const AUTOPILOT_TARGETS=['전체','20대 여자','20대 남자','30대 여자','30대 남자','40대 이상'];
function saveAutopilotPost({accountId,text,link,imageUrl,extraImageUrl,videoUrl=null,recipeCommentText=null,scheduledAt=null}){const formattedText=formatThreadsBody(text);db.prepare(`INSERT INTO posts (text,link,image_url,extra_image_url,video_url,scheduled_at,auto_comment_enabled,comment_status,account_id,recipe_comment_text,comment_retry_count,comment_next_retry_at) VALUES (?,?,?,?,?,?,1,'pending',?,?,0,NULL)`).run(formattedText,link||null,imageUrl||null,extraImageUrl||null,videoUrl||null,String(scheduledAt||new Date().toISOString()),accountId,recipeCommentText);}
function recordAutopilotLast(accountId,keyword,target){db.prepare(`UPDATE accounts SET autopilot_last_keyword=?, autopilot_last_target=? WHERE id=?`).run(keyword,target,accountId);}
async function runContentOnlyAutopilot(account,target,scheduledAt=null){const r=await generateContentOnlyRecipe(account.id,target);saveAutopilotPost({accountId:account.id,text:r.text,link:null,imageUrl:r.imageUrl,extraImageUrl:r.extraImageUrl,videoUrl:null,recipeCommentText:r.recipeCommentText,scheduledAt});recordAutopilotLast(account.id,r.keyword,target);}
function chooseImageFallback(result){const images=Array.isArray(result?.sourceImages)?result.sourceImages.filter(Boolean):[];if(images.length>=2)return{videoUrl:null,imageUrl:images[0],extraImageUrl:images[1],imageSourceLabel:'Threads 소재 원본 이미지 2장'};if(images.length===1)return{videoUrl:null,imageUrl:images[0],extraImageUrl:null,imageSourceLabel:'Threads 소재 원본 이미지 1장'};return{videoUrl:null,imageUrl:result?.product?.image||null,extraImageUrl:null,imageSourceLabel:result?.product?.image?'Threads 미디어 없음 → 쿠팡 상품 이미지 1장':'미디어 없음'};}
async function chooseSourceMedia(result){
  const videos=Array.isArray(result?.sourceVideos)?result.sourceVideos.filter(Boolean):[];
  const images=Array.isArray(result?.sourceImages)?result.sourceImages.filter(Boolean):[];
  if(videos.length&&result?.sourceUrl){
    try{
      console.log(`[Autopilot][VIDEO IMPORT] 소재찾기 importer 사용 시작 source=${result.sourceUrl}`);
      const imported=await importThreadsVideo({url:result.sourceUrl,outputDir:uploadsDir});
      const videoUrl=publicUploadUrl(imported.filename);
      const items=[{type:'VIDEO',url:videoUrl},...images.slice(0,9).map(url=>({type:'IMAGE',url}))];
      const bundle=encodeMediaBundle(items);
      console.log(`[Autopilot][VIDEO IMPORT] 성공 file=${imported.filename} size=${imported.size} method=${imported.extractionMethod} images=${images.length} bundleItems=${items.length}`);
      if(bundle&&items.length>1)return{videoUrl:null,imageUrl:bundle,extraImageUrl:null,imageSourceLabel:`Threads 소재 원본 영상 1개 + 이미지 ${Math.min(images.length,9)}개`};
      return{videoUrl,imageUrl:null,extraImageUrl:null,imageSourceLabel:'Threads 소재 원본 영상 다운로드 1개'};
    }catch(err){
      console.warn(`[Autopilot][VIDEO IMPORT] 실패 → 이미지 fallback source=${result.sourceUrl} reason="${err.message}"`);
    }
  }
  return chooseImageFallback(result);
}
function classifyCoupangUrl(raw){try{const u=new URL(String(raw||'').trim());const host=u.hostname.toLowerCase();const alreadyAffiliate=host==='link.coupang.com'||host.endsWith('.link.coupang.com')||/lptag|subid|aff/i.test(u.search);const plainCoupang=host==='coupang.com'||host==='www.coupang.com'||host.endsWith('.coupang.com');return{valid:/^https?:$/i.test(u.protocol),alreadyAffiliate,plainCoupang,host};}catch{return{valid:false,alreadyAffiliate:false,plainCoupang:false,host:''};}}
async function makeAffiliateLink(account,result){const raw=String(result?.product?.url||'').trim();if(!raw)throw new Error('쿠팡 상품 URL이 비어 있어 자동발행을 중단했습니다');const info=classifyCoupangUrl(raw);if(!info.valid||!info.plainCoupang)throw new Error(`쿠팡 상품 URL 형식이 올바르지 않습니다: ${raw.slice(0,120)}`);if(info.alreadyAffiliate){console.log(`[Coupang][LINK] 이미 파트너스 링크라 딥링크 변환 생략 host=${info.host}`);return raw;}try{const links=await coupangApi.createDeeplink(account.id,[raw]);const first=Array.isArray(links)?links[0]:null;const affiliate=String(first?.shortenUrl||first?.landingUrl||first?.originalUrl||'').trim();if(!affiliate)throw new Error('쿠팡 파트너스 링크 생성 결과가 비어 있습니다');console.log(`[Coupang][LINK] 일반 상품 URL → 딥링크 변환 성공`);return affiliate;}catch(err){const msg=String(err?.message||err?.response?.data?.rMessage||'');if(/url convert failed/i.test(msg)){console.warn(`[Coupang][LINK] 딥링크 재변환 거부 → 검색 API productUrl 그대로 사용`);return raw;}throw err;}}
// ---------- 미래 예약 슬롯 기반 타임드 프리필 컨트롤러 (account-stagger v5) ----------
const AUTOPILOT_TIMED_BUFFER = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BUFFER || 3));
const AUTOPILOT_TIMED_BATCH = Math.max(1, Number(process.env.AUTOPILOT_TIMED_BATCH || 2));
const AUTOPILOT_REFILL_CRON = String(process.env.AUTOPILOT_TIMED_REFILL_CRON || '*/10 * * * *');
const AUTOPILOT_REBALANCE_SAFETY_MINUTES = Math.max(10, Number(process.env.AUTOPILOT_REBALANCE_SAFETY_MINUTES || 15));
const COUPANG_PREFLIGHT_TTL_MS = Math.max(10 * 60000, Number(process.env.COUPANG_PREFLIGHT_TTL_MS || 6 * 60 * 60 * 1000));
// An auth failure must recover without restarting the process. Retry on a later refill tick.
const __coupangInvalidTtl = Number(process.env.COUPANG_INVALID_TTL_MS || 5 * 60000);
const COUPANG_INVALID_TTL_MS = Number.isFinite(__coupangInvalidTtl) ? Math.min(10 * 60000, Math.max(60000, __coupangInvalidTtl)) : 5 * 60000;
const autopilotRunningAccounts = new Set();
const coupangPreflightCache = new Map();
let autopilotRefillTickRunning = false;
let autopilotLastAccountId = 0;
// A single account's refill must never be able to hang the whole tick forever (e.g. a browser
// task deep in collectBenchmarkMaterials that never settles) - that would leave
// autopilotRefillTickRunning stuck true, and since cron itself is also forced to noOverlap, no
// future tick could ever run again until the process restarts. This bounds every account to a
// hard ceiling so the tick - and therefore the whole scheduler - always completes.
const ACCOUNT_REFILL_TIMEOUT_MS = Math.max(60000, Number(process.env.AUTOPILOT_ACCOUNT_TIMEOUT_MS || 6 * 60000));
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'AUTOPILOT_ACCOUNT_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function dayKeyKst(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function kstMidnight(dayKey) { return new Date(`${dayKey}T00:00:00+09:00`); }
function addDay(dayKey, n) { return dayKeyKst(new Date(kstMidnight(dayKey).getTime() + n * 86400000)); }
function targetForAccount(account) {
  if (!account?.user_id) return 25;
  const user = getUserById(account.user_id);
  if (user?.role === 'admin') return 25;
  return String(user?.plan || '').toLowerCase() === 'pro' ? 25 : 15;
}
function dayBounds(dayKey) {
  const start = kstMidnight(dayKey);
  return [start.toISOString(), new Date(start.getTime() + 86400000).toISOString()];
}
function countScheduledForDay(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  return Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`).get(accountId, start, end)?.c || 0);
}
function futurePendingCount(accountId) {
  return Number(db.prepare(`SELECT COUNT(*) c FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>?`).get(accountId, new Date().toISOString())?.c || 0);
}
function usedScheduleMinutes(accountId, dayKey) {
  const [start, end] = dayBounds(dayKey);
  return new Set(db.prepare(`SELECT scheduled_at FROM posts WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('pending','posted')`).all(accountId, start, end).map(r => String(r.scheduled_at || '').slice(0,16)));
}
function accountHash(accountId, dayKey='') {
  const s = `${Number(accountId)||0}:${dayKey}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function plannedSlots(dayKey, target, accountId) {
  const dayMinutes = 1440;
  const step = dayMinutes / Math.max(1, target);
  const seed = accountHash(accountId, dayKey);
  const phase = seed % Math.max(1, Math.floor(step));
  const out = [];
  for (let i = 0; i < target; i++) {
    const itemJitter = (((seed >>> (i % 16)) + i * 19 + Number(accountId || 0) * 7) % 15) - 7;
    let minute = Math.round(phase + i * step + itemJitter);
    minute = ((minute % dayMinutes) + dayMinutes) % dayMinutes;
    out.push(new Date(`${dayKey}T${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}:00+09:00`));
  }
  return out.sort((a,b)=>a-b);
}
function chooseFutureSlots(accountId, target, need) {
  const nowPlusSafety = Date.now() + 10 * 60000;
  const result = [];
  const today = dayKeyKst();
  for (let offset = 0; offset < 3 && result.length < need; offset++) {
    const day = addDay(today, offset);
    const already = countScheduledForDay(accountId, day);
    if (already >= target) continue;
    const capacity = target - already;
    const used = usedScheduleMinutes(accountId, day);
    const candidates = plannedSlots(day, target, accountId).filter(d => d.getTime() > nowPlusSafety && !used.has(d.toISOString().slice(0,16)));
    result.push(...candidates.slice(0, Math.min(capacity, need - result.length)));
  }
  return result;
}
function rebalanceExistingFuturePending() {
  const cutoff = new Date(Date.now() + AUTOPILOT_REBALANCE_SAFETY_MINUTES * 60000).toISOString();
  const accountRows = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
  let changed = 0;
  for (const row of accountRows) {
    const accountId = Number(row.id);
    const account = getAccount(accountId);
    if (!account) continue;
    const target = targetForAccount(account);
    for (let offset = 0; offset < 3; offset++) {
      const day = addDay(dayKeyKst(), offset);
      const [start, end] = dayBounds(day);
      const posts = db.prepare(`SELECT id,scheduled_at FROM posts WHERE account_id=? AND status='pending' AND scheduled_at>? AND scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at ASC,id ASC`).all(accountId, cutoff, start, end);
      if (!posts.length) continue;
      const slots = plannedSlots(day, target, accountId).filter(d => d.toISOString() > cutoff);
      for (let i = 0; i < posts.length && i < slots.length; i++) {
        const nextIso = slots[i].toISOString();
        if (String(posts[i].scheduled_at) === nextIso) continue;
        db.prepare(`UPDATE posts SET scheduled_at=? WHERE id=? AND status='pending'`).run(nextIso, posts[i].id);
        changed++;
      }
    }
  }
  console.log(`[Autopilot][TIMED REBALANCE] done changed=${changed} safety=${AUTOPILOT_REBALANCE_SAFETY_MINUTES}m window=24h`);
}
function credentialFingerprint(account) {
  return crypto.createHash('sha256').update(JSON.stringify([
    String(account?.coupang_access_key || '').trim(),
    String(account?.coupang_secret_key || '').trim(),
  ])).digest('hex');
}
function isCoupangAuthError(err) {
  // A 401 from Claude, Threads, or a media URL is not a Coupang credential failure.
  let fromCoupang = err?.service === 'coupang';
  try {
    const config = err?.config || err?.response?.config;
    fromCoupang ||= new URL(config?.url, config?.baseURL).hostname === 'api-gateway.coupang.com';
  } catch {}
  if (!fromCoupang) return false;
  const status = Number(err?.response?.status || 0);
  const data = err?.response?.data;
  const msg = String(data?.message || data?.rMessage || err?.message || '');
  return status === 401 || String(data?.rCode) === '401' || /invalid signature|unauthorized|invalid.*(?:access.?key|secret.?key)/i.test(msg);
}
async function ensureCoupangReady(accountId, account) {
  const fp = credentialFingerprint(account);
  if (!coupangApi.hasCredentials(account)) {
    coupangPreflightCache.set(accountId, { ok:false, reason:'missing_credentials', fp, until:Date.now()+COUPANG_INVALID_TTL_MS });
    console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} API 키 없음 → AI/Vision 생성 건너뜀`);
    return false;
  }
  const cached = coupangPreflightCache.get(accountId);
  if (cached && cached.fp === fp && cached.until > Date.now()) {
    if (!cached.ok) console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} cached-invalid reason=${cached.reason} → AI/Vision 생성 건너뜀`);
    return cached.ok;
  }
  try {
    // Claude보다 먼저 실제 서명 요청 1회로 인증 상태를 검증한다. 정상 결과는 장시간 캐시한다.
    await coupangApi.searchProducts(accountId, '물티슈', 1);
    coupangPreflightCache.set(accountId, { ok:true, reason:'ok', fp, until:Date.now()+COUPANG_PREFLIGHT_TTL_MS });
    console.log(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} AUTH OK ttl=${Math.round(COUPANG_PREFLIGHT_TTL_MS/3600000)}h`);
    return true;
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    const msg = String(err?.response?.data?.message || err?.response?.data?.rMessage || err?.message || err || '');
    if (isCoupangAuthError(err)) {
      coupangPreflightCache.set(accountId, { ok:false, reason:'invalid_signature', fp, until:Date.now()+COUPANG_INVALID_TTL_MS });
      console.error(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} AUTH INVALID → AI/Vision 생성 중단 reason="${msg.slice(0,160)}"`);
      return false;
    }
    // 호출 제한/일시 장애는 인증 실패로 오판하지 않는다.
    console.warn(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} check deferred status=${status||'-'} reason="${msg.slice(0,160)}"`);
    return true;
  }
}
async function runAutopilotOnceInner(account,scheduledAt=null){const target=AUTOPILOT_TARGETS[Math.floor(Math.random()*AUTOPILOT_TARGETS.length)];if(!hasCoupangKeys(account)){await runContentOnlyAutopilot(account,target,scheduledAt);return;}const cooldown=coupangApi.getApiCooldown?.(account.id);if(cooldown){const e=new Error(`쿠팡 API cooldown 중: ${cooldown.cooldown_until}`);e.code='COUPANG_RATE_LIMIT';e.isCoupangRateLimit=true;throw e;}const result=await buildThreadsFirstAutopilot(account.id,{target});const affiliateLink=await makeAffiliateLink(account,result);const media=await chooseSourceMedia(result);saveAutopilotPost({accountId:account.id,text:result.text,link:affiliateLink,imageUrl:media.imageUrl,extraImageUrl:media.extraImageUrl,videoUrl:media.videoUrl,recipeCommentText:result.commentLead,scheduledAt});const last=result.productSearchTerm||result.secretTerm||result.topic;recordAutopilotLast(account.id,last,target);console.log(`[자동발행 예약][V15 MATERIAL-MIXED-MEDIA] account #${account.id} target="${target}" mode="${result.mode}" topic="${result.topic}" product="${result.product.name}" source="${result.sourceUrl}" media="${media.imageSourceLabel}" affiliateLink=yes`);}
// Prevents one Chromium resource failure from being multiplied across every account in the same
// refill tick - a distinct fatal-for-this-tick error lets the timed-prefill controller stop
// account traversal instead of retrying every remaining account against a browser that's already down.
async function runAutopilotOnce(account,scheduledAt=null){
  const circuit=getBrowserCircuitState();
  if(circuit.open){const err=new Error(`Browser circuit open; retry after ${circuit.retryAfterMs}ms`);err.code='BROWSER_CIRCUIT_OPEN';err.retryAfterMs=circuit.retryAfterMs;throw err;}
  try{return await runAutopilotOnceInner(account,scheduledAt);}
  catch(err){if(browserInfraFailure(err)){err.code=err.code||'BROWSER_INFRA_FAILURE';err.stopAutopilotTick=true;}throw err;}
}
async function refillAccount(accountId) {
  if (autopilotRunningAccounts.has(accountId)) return;
  const account = getAccount(accountId);
  if (!account?.autopilot_enabled) return;
  if (!String(account.threads_access_token || '').trim() || (account.threads_token_expires_at && Date.parse(account.threads_token_expires_at)<=Date.now())) {
    setState(accountId, 'blocked', 'THREADS_TOKEN_MISSING');
    console.warn(`[Autopilot][PREFLIGHT] account #${accountId} THREADS_TOKEN_MISSING → 생성 생략`);
    return;
  }
  if (account.user_id) {
    const user = getUserById(account.user_id);
    if (!user || user.status !== 'active' || (user.expires_at && Date.parse(user.expires_at) <= Date.now())) {
      setState(accountId, 'blocked', 'SUBSCRIPTION_INACTIVE');
      return;
    }
  }
  const future = futurePendingCount(accountId);
  const need = Math.min(AUTOPILOT_TIMED_BATCH, Math.max(0, AUTOPILOT_TIMED_BUFFER - future));
  if (!need) return;
  const target = targetForAccount(account);
  const slots = chooseFutureSlots(accountId, target, need);
  if (!slots.length) return;

  // 핵심: Coupang 인증을 AI/Vision보다 먼저 확인한다.
  const coupangReady = await ensureCoupangReady(accountId, account);
  if (!coupangReady) { setState(accountId,'blocked','COUPANG_CREDENTIALS_INVALID'); return; }

  autopilotRunningAccounts.add(accountId);
  setState(accountId, 'running', 'generating');
  console.log(`[Autopilot][TIMED PREFILL] account #${accountId} target=${target}/day future=${future} preparing=${slots.length}`);
  try {
    for (const slot of slots) {
      const budget = budgetState();
      if (!budget.available) {
        setState(accountId, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
        break;
      }
      try {
        global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID = accountId;
        // Calls through module.exports (not the bare local reference) so a test can substitute a
        // fake generator to exercise refillAccount's own preflight/retry/circuit logic in
        // isolation from the real generation pipeline - see autopilotRecovery.test.js.
        await module.exports.runAutopilotOnce(account, slot.toISOString());
        setState(accountId, 'ready', 'reserved');
        console.log(`[Autopilot][TIMED PREFILL] RESERVED account #${accountId} scheduled=${slot.toISOString()}`);
      } catch (err) {
        const msg = String(err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || err || '');
        const status = Number(err?.response?.status || 0);
        console.error(`[Autopilot][TIMED PREFILL] generation failed account #${accountId}:`, err?.response?.data || err?.message || err);
        setState(accountId, 'retry', String(err?.code || 'GENERATION_FAILED'), new Date(Date.now()+10*60000).toISOString());
        if (isCoupangAuthError(err)) {
          coupangPreflightCache.set(accountId, { ok:false, reason:'invalid_signature', fp:credentialFingerprint(account), until:Date.now()+COUPANG_INVALID_TTL_MS });
          console.error(`[Autopilot][COUPANG PREFLIGHT] account #${accountId} runtime AUTH INVALID → 남은 슬롯 중단 + 다음 계정 이동`);
          break;
        }
        // Stop this account's batch, but never poison the Coupang auth cache.
        if (status === 401 || err?.isContentQualityHold || err?.code==='CONTENT_QUALITY_HOLD' || err?.code==='OPENAI_HOURLY_BUDGET_EXCEEDED' || err?.__openAiNoRetry || /no credits remaining|OPENAI_HOURLY_BUDGET_EXCEEDED|credit balance is too low|insufficient_quota/i.test(msg)) break;
        console.log(`[Autopilot][TIMED PREFILL] account #${accountId} 실패 1건은 건너뛰고 다음 예약 슬롯 계속 시도`);
      } finally {
        if (global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID === accountId) delete global.__ME2_CURRENT_AUTOPILOT_ACCOUNT_ID;
      }
    }
  } finally { autopilotRunningAccounts.delete(accountId); }
}
function startAutopilotJob(){
  const tick = async () => {
    if (autopilotRefillTickRunning) return;
    autopilotRefillTickRunning = true;
    const startedAt = Date.now();
    setState(0, 'running', 'refill');
    try {
      const accounts = db.prepare(`SELECT id FROM accounts WHERE autopilot_enabled=1 ORDER BY id`).all();
      // Resume after the last attempted account instead of starving later accounts.
      const ordered = [...accounts.filter(r=>Number(r.id)>autopilotLastAccountId), ...accounts.filter(r=>Number(r.id)<=autopilotLastAccountId)];
      // A single account can legitimately run for up to ACCOUNT_REFILL_TIMEOUT_MS (6 minutes) via
      // withTimeout(), so this check runs BEFORE starting each account and budgets for that
      // account's worst-case duration up front - the tick can never run longer than
      // TICK_TIME_BUDGET_MS in total, keeping it well inside the 10-minute cron interval.
      const TICK_TIME_BUDGET_MS = 8*60000;
      for (const row of ordered) {
        const budget = budgetState();
        if (!budget.available) {
          setState(0, 'waiting', 'AI_HOURLY_BUDGET', new Date(budget.retryAt).toISOString());
          console.log(`[Autopilot][BUDGET WAIT] retryAt=${new Date(budget.retryAt).toISOString()}`);
          return;
        }
        if (Date.now()-startedAt + ACCOUNT_REFILL_TIMEOUT_MS > TICK_TIME_BUDGET_MS) break;
        autopilotLastAccountId = Number(row.id);
        try { await withTimeout(refillAccount(autopilotLastAccountId), ACCOUNT_REFILL_TIMEOUT_MS, `account #${autopilotLastAccountId} refill exceeded ${ACCOUNT_REFILL_TIMEOUT_MS}ms`); }
        catch (err) { setState(autopilotLastAccountId,'retry',err.code||'PREFLIGHT_FAILED'); console.error(`[Autopilot][ACCOUNT ERROR] #${autopilotLastAccountId}: ${err.message}`); }
      }
      setState(0, 'idle', 'refill complete');
    } finally { autopilotRefillTickRunning = false; console.log(`[Autopilot][TICK COMPLETE] durationMs=${Date.now()-startedAt} lastAccount=${autopilotLastAccountId}`); }
  };
  try { rebalanceExistingFuturePending(); } catch (err) { console.warn('[Autopilot][TIMED REBALANCE] startup skipped:', err.message); }
  cron.schedule(AUTOPILOT_REFILL_CRON, () => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] tick:', e.message)), { timezone:'Asia/Seoul', noOverlap:true });
  setTimeout(() => tick().catch(e => console.error('[Autopilot][TIMED PREFILL] startup:', e.message)), 3000);
  console.log(`[Autopilot][TIMED PREFILL] ON buffer=${AUTOPILOT_TIMED_BUFFER} batch=${AUTOPILOT_TIMED_BATCH} basic=15/day pro=25/day window=24h account-stagger=ON retry-next-slot=ON coupang-preflight=ON cron=${AUTOPILOT_REFILL_CRON}`);
}

// 예정 시각을 조금 넘긴 새 글은 허용하되, 오래 밀린 최초 발행만 폐기한다.
// publishQueue가 명시적으로 재시도를 예약한 pending 글은 publish_next_retry_at까지 보존한다.
const STALE_MINUTES=Math.max(1,Number(process.env.STALE_PENDING_MINUTES||5));
function expireStalePendingPosts(){
  const nowMs=Date.now();const nowIso=new Date(nowMs).toISOString();
  const columns=db.prepare('PRAGMA table_info(posts)').all();
  const hasPublishRetry=columns.some(c=>c.name==='publish_next_retry_at');
  const rows=hasPublishRetry
    ?db.prepare(`SELECT id, account_id, scheduled_at, publish_next_retry_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`).all()
    :db.prepare(`SELECT id, account_id, scheduled_at, NULL AS publish_next_retry_at FROM posts WHERE status='pending' ORDER BY scheduled_at ASC`).all();
  const affectedAccounts=new Set();let expired=0;
  for(const post of rows){
    if(post.publish_next_retry_at)continue;
    const scheduledMs=new Date(post.scheduled_at).getTime();
    if(!Number.isFinite(scheduledMs))continue;
    const lateMs=nowMs-scheduledMs;
    if(lateMs<STALE_MINUTES*60*1000)continue;
    const lateMin=Math.floor(lateMs/60000);
    db.prepare(`UPDATE posts SET status='failed', error_message=? WHERE id=? AND status='pending'`).run(
      `STALE_EXPIRED: 예정시간보다 ${lateMin}분 지연되어 오래된 미발행 작업을 폐기했습니다. 밀린 글은 발행하지 않고 현재 시점부터 새 소재로 진행합니다.`,
      post.id
    );
    affectedAccounts.add(Number(post.account_id));expired++;
    console.log(`[Publish][STALE EXPIRE] account #${post.account_id} post #${post.id} late=${lateMin}m threshold=${STALE_MINUTES}m -> skip old post`);
  }
  for(const accountId of affectedAccounts){
    const account=db.prepare(`SELECT id, autopilot_enabled, autopilot_next_at FROM accounts WHERE id=?`).get(accountId);
    if(!account?.autopilot_enabled)continue;
    const nextMs=account.autopilot_next_at?new Date(account.autopilot_next_at).getTime():NaN;
    if(!Number.isFinite(nextMs)||nextMs>nowMs){
      db.prepare(`UPDATE accounts SET autopilot_next_at=? WHERE id=?`).run(nowIso,accountId);
      console.log(`[Autopilot][FRESH RESTART] account #${accountId} stale queue expired -> nextAt=${nowIso}`);
    }
  }
  if(expired)console.log(`[Publish][STALE QUEUE] expired=${expired} threshold=${STALE_MINUTES}m retries=preserved comments=untouched`);
}
function startStaleQueueJob(){
  try{expireStalePendingPosts();}catch(e){console.warn('[Publish][STALE QUEUE] startup cleanup failed:',e.message);}
  cron.schedule('* * * * *',()=>{try{expireStalePendingPosts();}catch(e){console.warn('[Publish][STALE QUEUE] cleanup failed:',e.message);}},{noOverlap:true});
  console.log(`[Publish][STALE QUEUE] 오래된 최초 미발행 ${STALE_MINUTES}분 초과 자동폐기 + 예약 재시도 보존 + 새소재 재시작 활성화`);
}
module.exports={startPublishJob,startInsightsJob,startAutopilotJob,startStaleQueueJob,runAutopilotOnce,buildDoubleLinkComment,expireStalePendingPosts};

