const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { db, listAllAccountsForSystem, getAccount, canPublish, logUsage, findMediaSourceForProduct, markMediaSourceUsed } = require('./db');
const { publishPost, publishCarouselPost, publishReply, getMediaInsights } = require('./threadsApi');
const coupangApi = require('./coupangApi');
const { generateRecipe: generateContentOnlyRecipe } = require('./contentOnlyAutomation');
const { buildThreadsFirstAutopilot } = require('./autopilotMaterialEngine');
const { importThreadsVideo } = require('./threadsMediaImporter');

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
function buildDisclosureOnly(account){const t=String(account.coupang_disclosure_template||`${DEFAULT_COUPANG_DISCLOSURE}\n\n{link}`);return t.replace(/\{link\}/g,'').replace(/\n{3,}/g,'\n\n').trim();}
function trimToLimit(text,limit){const n=String(text||'').trim();const cap=Math.max(0,Number(limit)||0);if(!cap)return'';if(n.length<=cap)return n;if(cap===1)return'…';return `${n.slice(0,cap-1).trimEnd()}…`;}
function cleanCommentLine(line){return String(line||'').replace(/\s+/g,' ').trim();}
function compactRecipePrefix(prefix,limit){const cap=Math.max(0,Number(limit)||0);if(!cap)return'';const raw=String(prefix||'').replace(/\r/g,'').trim();if(!raw)return'';if(raw.length<=cap)return raw;const lines=raw.split('\n').map(cleanCommentLine).filter(Boolean);const ingredientIdx=lines.findIndex(x=>/재료/.test(x));const methodIdx=lines.findIndex(x=>/(만드는\s*법|조리\s*법|만들기)/.test(x));const isRecipe=ingredientIdx>=0||methodIdx>=0;if(!isRecipe){const out=[];let used=0;for(const line of lines){const add=(out.length?1:0)+line.length;if(used+add>cap)break;out.push(line);used+=add;}return out.join('\n');}const ingredientHeader='🥘 재료';const methodHeader='🍳 만드는 법';let ingredients=[];let methods=[];const ingStart=ingredientIdx>=0?ingredientIdx+1:0;const ingEnd=methodIdx>ingStart?methodIdx:lines.length;for(const line of lines.slice(ingStart,ingEnd)){const cleaned=line.replace(/^[▪•·\-–—*✅\s]+/,'').trim();if(cleaned&&!/^(재료|만드는\s*법|조리\s*법)$/i.test(cleaned))ingredients.push(cleaned);}if(methodIdx>=0){for(const line of lines.slice(methodIdx+1)){const cleaned=line.replace(/^\s*\d+[.)]\s*/,'').replace(/^[▪•·\-–—*✅\s]+/,'').trim();if(cleaned)methods.push(cleaned);}}if(!ingredients.length&&ingredientIdx>=0){const inline=lines[ingredientIdx].replace(/^.*?재료\s*[:：]?\s*/,'').trim();if(inline)ingredients=[inline];}if(!methods.length&&methodIdx>=0){const inline=lines[methodIdx].replace(/^.*?(?:만드는\s*법|조리\s*법|만들기)\s*[:：]?\s*/,'').trim();if(inline)methods=[inline];}const render=(ings,steps)=>{const a=ings.length?`${ingredientHeader}\n${ings.join(', ')}`:'';const b=steps.length?`${methodHeader}\n${steps.map((x,i)=>`${i+1}. ${x}`).join('\n')}`:'';return[a,b].filter(Boolean).join('\n\n');};let ing=ingredients.slice(0,8),steps=methods.slice(0,4),out=render(ing,steps);while(out.length>cap&&steps.length>1){steps.pop();out=render(ing,steps);}while(out.length>cap&&ing.length>3){ing.pop();out=render(ing,steps);}if(out.length<=cap&&ing.length&&steps.length)return out;const minIng=ingredients.slice(0,3);const minSteps=methods.slice(0,1);out=render(minIng,minSteps);if(out.length<=cap&&minIng.length&&minSteps.length)return out;const safe=[];let used=0;for(const line of lines){const add=(safe.length?1:0)+line.length;if(used+add>cap)break;safe.push(line);used+=add;}return safe.join('\n');}
function buildDoubleLinkComment(account,prefix,link,maxLength=490){const cap=Math.min(490,Math.max(1,Number(maxLength)||490));const l=String(link||'').trim();let disclosure=isCoupangLink(l)?buildDisclosureOnly(account):'';const links=l?`${l}\n${l}`:'';let tail=[links,disclosure].filter(Boolean).join('\n\n');if(tail.length>cap&&isCoupangLink(l)){disclosure=DEFAULT_COUPANG_DISCLOSURE;tail=[links,disclosure].filter(Boolean).join('\n\n');}if(tail.length>cap)throw new Error(`댓글 필수영역(링크 2개+고지문)이 Threads ${cap}자 제한을 초과했습니다: ${tail.length}자`);const available=cap-tail.length-(tail?2:0);const head=compactRecipePrefix(prefix,available);const out=[head,tail].filter(Boolean).join('\n\n');if(out.length>cap)throw new Error(`댓글 길이 조립 오류: ${out.length}/${cap}자`);return out;}

function formatThreadsBody(text){return require('./threadsVoicePolicy').formatVoice(text);}

const uploadsDir=path.join(__dirname,'uploads');
if(!fs.existsSync(uploadsDir))fs.mkdirSync(uploadsDir,{recursive:true});
function getPublicBaseUrl(){const explicit=String(process.env.PUBLIC_BASE_URL||process.env.APP_URL||'').trim().replace(/\/$/,'');if(/^https?:\/\//i.test(explicit))return explicit;const railway=String(process.env.RAILWAY_PUBLIC_DOMAIN||'').trim().replace(/^https?:\/\//i,'').replace(/\/$/,'');if(railway)return `https://${railway}`;return'';}
function publicUploadUrl(filename){const base=getPublicBaseUrl();if(!base)throw new Error('공개 서비스 주소를 확인할 수 없습니다. PUBLIC_BASE_URL 또는 RAILWAY_PUBLIC_DOMAIN이 필요합니다.');return `${base}/uploads/${encodeURIComponent(filename)}`;}
function localPathFromUploadUrl(url){if(!url)return null;const marker='/uploads/';const idx=url.indexOf(marker);if(idx===-1)return null;return path.join(uploadsDir,decodeURIComponent(url.slice(idx+marker.length)));}
function mediaSourceFilesExist(media){const p=localPathFromUploadUrl(media.image_url);if(!p||!fs.existsSync(p))return false;if(media.extra_image_url){const e=localPathFromUploadUrl(media.extra_image_url);if(!e||!fs.existsSync(e))return false;}return true;}
async function buildCommentText(account,post){if(hasCoupangKeys(account)&&post.recipe_comment_text&&!post.link)throw new Error('쿠팡 자동댓글 링크가 비어 있어 댓글 발행을 중단했습니다');if(!post.link)return compactRecipePrefix(post.recipe_comment_text||'',490);return buildDoubleLinkComment(account,post.recipe_comment_text||'',post.link,490);}
function startPublishJob(){return require("./publishQueue").startPublishJob({buildCommentText});}
function startInsightsJob(){cron.schedule('*/10 * * * *',async()=>{const start=new Date();start.setHours(0,0,0,0);for(const s of listAllAccountsForSystem()){const posts=db.prepare(`SELECT * FROM posts WHERE account_id=? AND status='posted' AND posted_at>=? AND threads_media_id IS NOT NULL`).all(s.id,start.toISOString());for(const p of posts){try{const stats=await getMediaInsights(s.id,p.threads_media_id);db.prepare(`INSERT INTO insights (post_id,views,likes,replies,reposts,quotes,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,reposts=excluded.reposts,quotes=excluded.quotes,updated_at=excluded.updated_at`).run(p.id,stats.views||0,stats.likes||0,stats.replies||0,stats.reposts||0,stats.quotes||0,new Date().toISOString());}catch(e){console.error(`[인사이트 갱신 실패] account #${s.id}:`,e.message);}}}});}
function randomIntervalMinutes(){return 60+Math.random()*15;}const AUTOPILOT_TARGETS=['전체','20대 여자','20대 남자','30대 여자','30대 남자','40대 이상'];
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
async function runAutopilotOnce(account,scheduledAt=null){const target=AUTOPILOT_TARGETS[Math.floor(Math.random()*AUTOPILOT_TARGETS.length)];if(!hasCoupangKeys(account)){await runContentOnlyAutopilot(account,target,scheduledAt);return;}const cooldown=coupangApi.getApiCooldown?.(account.id);if(cooldown){const e=new Error(`쿠팡 API cooldown 중: ${cooldown.cooldown_until}`);e.code='COUPANG_RATE_LIMIT';e.isCoupangRateLimit=true;throw e;}const result=await buildThreadsFirstAutopilot(account.id,{target});const affiliateLink=await makeAffiliateLink(account,result);const media=await chooseSourceMedia(result);saveAutopilotPost({accountId:account.id,text:result.text,link:affiliateLink,imageUrl:media.imageUrl,extraImageUrl:media.extraImageUrl,videoUrl:media.videoUrl,recipeCommentText:result.commentLead,scheduledAt});const last=result.productSearchTerm||result.secretTerm||result.topic;recordAutopilotLast(account.id,last,target);console.log(`[자동발행 예약][V15 MATERIAL-MIXED-MEDIA] account #${account.id} target="${target}" mode="${result.mode}" topic="${result.topic}" product="${result.product.name}" source="${result.sourceUrl}" media="${media.imageSourceLabel}" affiliateLink=yes`);}
function startAutopilotJob(){const nextRunAt=new Map();cron.schedule('* * * * *',async()=>{const now=Date.now();for(const s of listAllAccountsForSystem()){const account=getAccount(s.id);if(!account.autopilot_enabled){nextRunAt.delete(account.id);continue;}if(hasCoupangKeys(account)){const cooldown=coupangApi.getApiCooldown?.(account.id);if(cooldown)continue;}const due=nextRunAt.get(account.id)||0;if(now<due)continue;nextRunAt.set(account.id,now+randomIntervalMinutes()*60*1000);try{await runAutopilotOnce(account);}catch(err){if(coupangApi.isRateLimitError?.(err)){console.error(`[완전자동화 중단][Coupang rate limit] account #${account.id}: ${err.message}`);continue;}console.error(`[완전자동화 실패] account #${account.id}:`,err.response?.data||err.message);}}});}
module.exports={startPublishJob,startInsightsJob,startAutopilotJob,runAutopilotOnce};

