const { db } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS threads_benchmark_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS threads_benchmark_used_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_url TEXT NOT NULL UNIQUE,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function normalizeUsername(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  try { if (/^https?:\/\//i.test(v)) { const u=new URL(v); const m=u.pathname.match(/^\/@?([^/]+)/); if(m)v=m[1]; } } catch {}
  v=v.replace(/^@+/,'').split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9._]{1,64}$/.test(v)?v:'';
}
function parseUsernames(value){const raw=Array.isArray(value)?value.join('\n'):String(value||'');return[...new Set(raw.split(/[\s,;]+/).map(normalizeUsername).filter(Boolean))];}
function listBenchmarkAccounts(){return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all();}
function addBenchmarkAccount(value){const username=normalizeUsername(value);if(!username)throw new Error('올바른 Threads 아이디를 입력해주세요.');db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username=?').get(username);}
function addBenchmarkAccountsBulk(value){const usernames=parseUsernames(value);if(!usernames.length)throw new Error('등록할 Threads 아이디가 없습니다.');const insert=db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)');let added=0,skipped=0;for(const username of usernames){const info=insert.run(username);if(Number(info?.changes||0)>0)added++;else skipped++;}return{added,skipped,total:usernames.length,accounts:listBenchmarkAccounts()};}
function deleteBenchmarkAccount(id){return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id=?').run(Number(id));}
function markUsedPost(url){if(url)db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url));}
function isUsedPost(url){return!!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url));}
function shuffle(items){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
async function openBrowser(){const playwright=require('playwright');const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});const context=await browser.newContext({locale:'ko-KR',viewport:{width:1100,height:1500},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});return{browser,context};}

async function collectProfilePostsWithContext(context,username,{limit=2}={}){
 const page=await context.newPage();try{page.setDefaultTimeout(12000);await page.goto(`https://www.threads.com/@${encodeURIComponent(username)}`,{waitUntil:'domcontentloaded',timeout:12000});await page.waitForTimeout(1600);for(let i=0;i<3;i++){await page.mouse.wheel(0,900);await page.waitForTimeout(350);}return await page.evaluate(({username,limit})=>{const clean=s=>String(s||'').replace(/\s+/g,' ').trim();const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`;}catch{return String(href||'').split(/[?#]/)[0];}};const findRoot=(a,target)=>{const article=a.closest('article,[role="article"]');if(article&&clean(article.innerText).length>=8)return article;let node=a.parentElement,best=null;for(let i=0;i<9&&node;i++,node=node.parentElement){const txt=clean(node.innerText);if(txt.length<8)continue;const links=[...new Set([...node.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href)))];if(links.length===1&&links[0]===target&&txt.length<=5000)best=node;if(links.length>1&&best)break;}return best;};const out=[],seen=new Set();for(const a of document.querySelectorAll('a[href*="/post/"]')){if(out.length>=limit)break;const href=canonical(a.href||'');if(!href||seen.has(href))continue;seen.add(href);if(!/\/post\//i.test(new URL(href).pathname))continue;const root=findRoot(a,href);if(!root)continue;const text=clean(root.innerText||'').slice(0,1800);if(text.length<8)continue;const images=[...root.querySelectorAll('img')].map(x=>x.currentSrc||x.src).filter(Boolean);const videos=[...root.querySelectorAll('video')];out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length});}return out;},{username,limit});}finally{try{await page.close();}catch{}}}
async function collectProfilePosts(username,{limit=2}={}){let browser,context;try{({browser,context}=await openBrowser());return await collectProfilePostsWithContext(context,username,{limit});}finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}}
async function expandReplies(page){for(let round=0;round<5;round++){let clicked=0;try{clicked=await page.evaluate(()=>{const clean=s=>String(s||'').replace(/\s+/g,' ').trim();const re=/(답글\s*(?:보기|더\s*보기)|댓글\s*(?:보기|더\s*보기)|답글\s*\d+개|댓글\s*\d+개|view\s+(?:more\s+)?repl(?:y|ies)|more\s+repl(?:y|ies))/i;let n=0;for(const el of document.querySelectorAll('button,[role="button"],a')){if(n>=12)break;const t=clean(el.innerText||el.textContent||'');if(!t||t.length>80||!re.test(t))continue;try{el.click();n++;}catch{}}return n;});}catch{}await page.mouse.wheel(0,850);await page.waitForTimeout(clicked?650:350);if(!clicked&&round>=2)break;}}

async function collectPostDetails(url,username){let browser,context;try{({browser,context}=await openBrowser());const page=await context.newPage();page.setDefaultTimeout(18000);await page.goto(url,{waitUntil:'domcontentloaded',timeout:18000});await page.waitForTimeout(2200);await expandReplies(page);await page.mouse.wheel(0,900);await page.waitForTimeout(500);
 const data=await page.evaluate(({username,sourceUrl})=>{const clean=s=>String(s||'').replace(/\s+/g,' ').trim();const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`;}catch{return String(href||'').split(/[?#]/)[0];}};const target=canonical(sourceUrl),targetUser=String(username||'').toLowerCase();const sameUser=a=>{try{return new URL(a.href,location.origin).pathname.toLowerCase().replace(/\/$/,'')===`/@${targetUser}`;}catch{return false;}};let main=null;for(const a of document.querySelectorAll('a[href*="/post/"]')){if(canonical(a.href||'')!==target)continue;const article=a.closest('article,[role="article"]');if(article){main=article;break;}let n=a.parentElement;for(let i=0;i<10&&n;i++,n=n.parentElement){const links=[...new Set([...n.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href)))];if(links.length===1&&links[0]===target&&clean(n.innerText).length<=6000)main=n;}}
 const metas=[document.querySelector('meta[property="og:description"]')?.content,document.querySelector('meta[name="description"]')?.content,document.querySelector('meta[name="twitter:description"]')?.content].map(clean).filter(Boolean);
 const jsonTexts=[];for(const s of document.querySelectorAll('script[type="application/ld+json"],script[type="application/json"]')){const raw=s.textContent||'';if(raw.length>200000)continue;for(const m of raw.matchAll(/"(?:text|caption|description)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)){try{jsonTexts.push(clean(JSON.parse('"'+m[1]+'"')));}catch{}}}
 const bodyCandidates=[...document.querySelectorAll('[dir="auto"],span,div')].map(el=>clean(el.innerText||'')).filter(t=>t.length>=12&&t.length<=2500&&!/^(좋아요|답글|공유|팔로우)/.test(t));
 const mainText=clean(main?.innerText||'');const sourceText=[mainText,...metas,...jsonTexts,...bodyCandidates].find(t=>t&&t.length>=12)||'';
 const images=[],videos=[];const mediaRoot=main||document;for(const v of mediaRoot.querySelectorAll('video')){const src=v.currentSrc||v.src||'';if(src&&!videos.includes(src))videos.push(src);}for(const img of mediaRoot.querySelectorAll('img')){const src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase(),r=img.getBoundingClientRect();if(!src||r.width<160||r.height<160||/profile|프로필|avatar|사용자/.test(alt))continue;if(!images.includes(src))images.push(src);}
 const authorReplies=[],seen=new Set();for(const a of document.querySelectorAll('a[href]')){if(!sameUser(a))continue;const root=a.closest('article,[role="article"]')||a.parentElement?.parentElement;if(!root||root===main)continue;let text=clean(root.innerText||'');const links=[...root.querySelectorAll('a[href]')].map(x=>x.href).filter(h=>/^https?:\/\//i.test(h)&&!/threads\.(com|net)/i.test(h));text=[text,...links].join('\n').slice(0,6000);if(text.length>=8&&!seen.has(text)){seen.add(text);authorReplies.push(text);}}
 const aff=authorReplies.join('\n').match(/https?:\/\/[^\s)\]}>,]+/gi)||[];
 return{sourceText,metaDescription:metas[0]||'',authorReplies:authorReplies.slice(0,15),images:images.slice(0,10),videos:videos.slice(0,5),hasVideo:videos.length>0,exactUrl:canonical(location.href)===target,affiliateLinkCount:aff.filter(x=>/coupang|naver/i.test(x)).length};},{username,sourceUrl:url});
 let sourceText=String(data.sourceText||data.metaDescription||'').trim();
 let images=Array.isArray(data.images)?data.images.filter(Boolean):[];
 let videos=Array.isArray(data.videos)?data.videos.filter(Boolean):[];
 // 상세 DOM이 깨지는 경우에도 반드시 같은 post URL의 프로필 카드만 재사용한다.
 if(!sourceText || (!images.length && !videos.length)){
   try{
     const profile=await collectProfilePostsWithContext(context,username,{limit:16});
     const wanted=String(url||'').split(/[?#]/)[0].replace(/\/media$/,'');
     const hit=profile.find(x=>String(x.url||'').split(/[?#]/)[0].replace(/\/media$/,'')===wanted);
     if(hit){
       if(!sourceText){sourceText=String(hit.text||'').trim();if(sourceText)console.log(`[Threads detail fallback] @${username} 프로필 본문 재사용 source=${sourceText.length}`);}
       if(!images.length&&Array.isArray(hit.images)&&hit.images.length){images=[...new Set(hit.images.filter(Boolean))].slice(0,10);console.log(`[Threads media fallback] @${username} 동일 post 프로필 이미지 재사용 images=${images.length} source=${url}`);}
       // 프로필 카드에서 video src가 없더라도 hasVideo 신호는 보존한다. 실제 영상 URL은 threadsVideoPatch/importer가 동일 post URL에서 재추출한다.
       if(!videos.length&&hit.hasVideo)console.log(`[Threads media fallback] @${username} 동일 post 영상 존재 신호 확인 source=${url}`);
     }
   }catch(err){console.log(`[Threads detail fallback] @${username} 실패: ${err.message}`);}
 }
 if(!sourceText)throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');
 console.log(`[Threads detail] @${username} source=${sourceText.length} replies=${(data.authorReplies||[]).length} affiliateLinks=${data.affiliateLinkCount||0} images=${images.length} videos=${videos.length}`);
 return{sourceText,authorReplies:(data.authorReplies||[]).filter(Boolean),images,videos,hasVideo:videos.length>0||!!data.hasVideo,exactUrl:!!data.exactUrl};
 }finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}}
async function mapWithConcurrency(items,concurrency,worker){const results=[];let cursor=0;async function run(){while(true){const i=cursor++;if(i>=items.length)return;try{results[i]=await worker(items[i],i);}catch(err){results[i]={error:err};}}}await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run));return results;}
async function collectBenchmarkMaterials({limit=10}={}){const accounts=shuffle(listBenchmarkAccounts());if(!accounts.length)throw new Error('관리자 페이지에서 소재 참고 계정을 먼저 등록해주세요.');const sample=accounts.slice(0,Math.min(accounts.length,12));let browser,context;try{({browser,context}=await openBrowser());const perAccount=Math.max(8,Math.ceil(limit/Math.max(1,sample.length))+4);const scanned=await mapWithConcurrency(sample,4,async account=>(await collectProfilePostsWithContext(context,account.username,{limit:perAccount})).filter(x=>!isUsedPost(x.url)));const pools=scanned.filter(Array.isArray).filter(x=>x.length),all=[];let round=0;while(all.length<limit&&pools.some(p=>p.length>round)){for(const pool of shuffle(pools)){if(all.length>=limit)break;if(pool[round])all.push(pool[round]);}round++;}console.log(`[Threads benchmark] accounts=${sample.length} pools=${pools.length} collected=${all.length} requested=${limit}`);return all.slice(0,limit);}finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}}
module.exports={listBenchmarkAccounts,addBenchmarkAccount,addBenchmarkAccountsBulk,deleteBenchmarkAccount,markUsedPost,collectBenchmarkMaterials,collectPostDetails,collectProfilePosts};