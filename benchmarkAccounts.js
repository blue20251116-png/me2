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
function parseUsernames(value){const raw=Array.isArray(value)?value.join('\n'):String(value||'');return [...new Set(raw.split(/[\s,;]+/).map(normalizeUsername).filter(Boolean))];}
function listBenchmarkAccounts(){return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all();}
function addBenchmarkAccount(value){const username=normalizeUsername(value);if(!username)throw new Error('올바른 Threads 아이디를 입력해주세요.');db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username=?').get(username);}
function addBenchmarkAccountsBulk(value){const usernames=parseUsernames(value);if(!usernames.length)throw new Error('등록할 Threads 아이디가 없습니다.');const insert=db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)');let added=0,skipped=0;for(const username of usernames){const info=insert.run(username);if(Number(info?.changes||0)>0)added++;else skipped++;}return{added,skipped,total:usernames.length,accounts:listBenchmarkAccounts()};}
function deleteBenchmarkAccount(id){return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id=?').run(Number(id));}
function markUsedPost(url){if(url)db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url));}
function isUsedPost(url){return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url));}
function shuffle(items){const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

async function openBrowser(){
  const playwright=require('playwright');
  const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  const context=await browser.newContext({locale:'ko-KR',viewport:{width:1100,height:1500},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
  return{browser,context};
}

async function collectProfilePostsWithContext(context,username,{limit=2}={}){
  const page=await context.newPage();
  try{
    page.setDefaultTimeout(12000);
    await page.goto(`https://www.threads.com/@${encodeURIComponent(username)}`,{waitUntil:'domcontentloaded',timeout:12000});
    await page.waitForTimeout(1600);
    for(let i=0;i<3;i++){await page.mouse.wheel(0,900);await page.waitForTimeout(350);}
    return await page.evaluate(({username,limit})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`.replace(/\/media$/i,'').replace(/\/$/,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'').replace(/\/$/,'');}};
      const rectOverlap=(a,b)=>{const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));const inter=x*y;if(!inter)return 0;return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));};
      const postLinks=root=>root?[...new Set([...root.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href||'')))]:[];
      const findRoot=(a,target)=>{
        const article=a.closest('article,[role="article"]');
        if(article&&postLinks(article).includes(target)&&clean(article.innerText).length>=8)return article;
        let node=a.parentElement,best=null;
        for(let i=0;i<10&&node;i++,node=node.parentElement){
          const txt=clean(node.innerText);if(txt.length<8)continue;
          const links=postLinks(node);
          if(links.length===1&&links[0]===target&&txt.length<=5000)best=node;
          if(links.length>1&&best)break;
        }
        return best;
      };
      const belongsToPost=(el,root,target)=>{
        const article=el.closest('article,[role="article"]');
        if(article){const links=postLinks(article);return links.length===0?article===root:links.includes(target);}
        return root?.contains(el)===true;
      };
      const mediaFromRoot=(root,target)=>{
        if(!root)return{images:[],videos:[],hasVideo:false,videoCount:0};
        const videos=[...root.querySelectorAll('video')].filter(v=>belongsToPost(v,root,target)).filter(v=>{const r=v.getBoundingClientRect();return r.width>=180&&r.height>=180;});
        const videoRects=videos.map(v=>v.getBoundingClientRect());
        const videoUrls=[];for(const v of videos){const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';if(src&&!videoUrls.includes(src))videoUrls.push(src);}
        const images=[];
        for(const img of root.querySelectorAll('img')){
          if(!belongsToPost(img,root,target))continue;
          const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();
          if(!src||r.width<180||r.height<180)continue;
          if(/profile|프로필|avatar|사용자/.test(alt))continue;
          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;
          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;
          if(!images.includes(src))images.push(src);
        }
        return{images:images.slice(0,10),videos:videoUrls.slice(0,5),hasVideo:videos.length>0,videoCount:videos.length};
      };
      const out=[],seen=new Set();
      for(const a of document.querySelectorAll('a[href*="/post/"]')){
        if(out.length>=limit)break;
        const href=canonical(a.href||'');if(!href||seen.has(href))continue;seen.add(href);
        let p='';try{p=new URL(href).pathname;}catch{}if(!/\/post\//i.test(p))continue;
        const root=findRoot(a,href);if(!root)continue;
        const text=clean(root.innerText||'').slice(0,1800);if(text.length<8)continue;
        const media=mediaFromRoot(root,href);
        out.push({url:href,text,username,images:media.images,videos:media.videos,thumbnail:media.images[0]||'',imageCount:media.images.length,hasVideo:media.hasVideo,videoCount:media.videoCount});
      }
      return out;
    },{username,limit});
  }finally{try{await page.close();}catch{}}
}
async function collectProfilePosts(username,{limit=2}={}){let browser,context;try{({browser,context}=await openBrowser());return await collectProfilePostsWithContext(context,username,{limit});}finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}}

async function expandReplies(page){for(let round=0;round<5;round++){let clicked=0;try{clicked=await page.evaluate(()=>{const clean=s=>String(s||'').replace(/\s+/g,' ').trim();const re=/(답글\s*(?:보기|더\s*보기)|댓글\s*(?:보기|더\s*보기)|답글\s*\d+개|댓글\s*\d+개|view\s+(?:more\s+)?repl(?:y|ies)|more\s+repl(?:y|ies))/i;let n=0;for(const el of document.querySelectorAll('button,[role="button"],a')){if(n>=12)break;const t=clean(el.innerText||el.textContent||'');if(!t||t.length>80||!re.test(t))continue;try{el.click();n++;}catch{}}return n;});}catch{}await page.mouse.wheel(0,850);await page.waitForTimeout(clicked?650:350);if(!clicked&&round>=2)break;}}

async function collectPostDetails(url,username){
  let browser,context;
  try{
    ({browser,context}=await openBrowser());const page=await context.newPage();page.setDefaultTimeout(16000);
    const normalizedUrl=String(url||'').replace(/\/media(?:[?#].*)?$/i,'');
    await page.goto(normalizedUrl,{waitUntil:'domcontentloaded',timeout:16000});await page.waitForTimeout(1800);
    // 미디어는 댓글 확장 전에 원본 post에서 먼저 고정한다. 댓글은 링크 수집에만 사용한다.
    const rootSnapshot=await page.evaluate(({username,sourceUrl})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`.replace(/\/media$/i,'').replace(/\/$/,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'').replace(/\/$/,'');}};
      const target=canonical(sourceUrl);
      const postLinks=root=>root?[...new Set([...root.querySelectorAll('a[href*="/post/"]')].map(a=>canonical(a.href||'')))]:[];
      const compactRoot=anchor=>{const article=anchor.closest('article,[role="article"]');if(article&&postLinks(article).includes(target))return article;let node=anchor.parentElement,best=null;for(let i=0;i<10&&node;i++,node=node.parentElement){const text=clean(node.innerText||'');if(text.length<8)continue;const links=postLinks(node);if(links.length===1&&links[0]===target&&text.length<=5000)best=node;if(links.length>1&&best)break;}return best;};
      let main=null;
      for(const a of document.querySelectorAll('a[href*="/post/"]')){if(canonical(a.href||'')!==target)continue;const root=compactRoot(a);if(!root)continue;if(!main||root.getBoundingClientRect().height<main.getBoundingClientRect().height)main=root;}
      const belongs=el=>{const article=el.closest('article,[role="article"]');if(article){const links=postLinks(article);return links.length===0?article===main:links.includes(target);}return !!main&&main.contains(el);};
      const images=[],videos=[];
      if(main){
        for(const v of main.querySelectorAll('video')){if(!belongs(v))continue;const r=v.getBoundingClientRect();if(r.width<160||r.height<160)continue;const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';if(src&&!videos.includes(src))videos.push(src);}
        for(const img of main.querySelectorAll('img')){if(!belongs(img))continue;const src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase(),r=img.getBoundingClientRect();if(!src||r.width<160||r.height<160)continue;if(/profile|프로필|avatar|사용자/.test(alt))continue;if(img.closest('video'))continue;if(!images.includes(src))images.push(src);}
      }
      const metaDescription=clean(document.querySelector('meta[property="og:description"]')?.content||document.querySelector('meta[name="description"]')?.content||'');
      return{sourceText:clean(main?.innerText||metaDescription||'').slice(0,5000),images:images.slice(0,10),videos:videos.slice(0,5),hasVideo:videos.length>0,mainFound:!!main,target};
    },{username,sourceUrl:normalizedUrl});
    console.log(`[Threads][ROOT MEDIA] @${username} source=${rootSnapshot.target} main=${rootSnapshot.mainFound?'yes':'no'} images=${rootSnapshot.images.length} videos=${rootSnapshot.videos.length} scope=root-post-only`);

    await expandReplies(page);await page.mouse.wheel(0,1000);await page.waitForTimeout(500);
    const replies=await page.evaluate(({username,sourceUrl})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`.replace(/\/media$/i,'').replace(/\/$/,'');}catch{return String(href||'').split(/[?#]/)[0].replace(/\/media$/i,'').replace(/\/$/,'');}};
      const target=canonical(sourceUrl),targetUser=String(username||'').toLowerCase();
      const sameUserHref=href=>{try{const u=new URL(href,location.origin);return u.pathname.toLowerCase().replace(/\/$/,'')===`/@${targetUser}`;}catch{return false;}};
      const postLinks=root=>root?[...new Set([...root.querySelectorAll('a[href*="/post/"]')].map(a=>canonical(a.href||'')))]:[];
      const isMainRoot=root=>!!root&&postLinks(root).includes(target);
      const compactRoot=anchor=>{const article=anchor.closest('article,[role="article"]');if(article)return article;let node=anchor.parentElement,best=null;for(let i=0;i<9&&node;i++,node=node.parentElement){const text=clean(node.innerText||'');if(text.length<8)continue;if(text.length<=5000)best=node;if(text.length>5000&&best)break;}return best;};
      const externalLinks=root=>{const out=[];if(!root)return out;for(const a of root.querySelectorAll('a[href]')){try{const u=new URL(a.href||a.getAttribute('href')||'',location.origin);if(!/(^|\.)threads\.(com|net)$/i.test(u.hostname)&&/^https?:/i.test(u.href)&&!out.includes(u.href))out.push(u.href);for(const key of['u','url','target','redirect','redirect_url']){const v=u.searchParams.get(key);if(v){let d=v;try{d=decodeURIComponent(v);}catch{}if(/^https?:\/\//i.test(d)&&!out.includes(d))out.push(d);}}}catch{}}const txt=clean(root.innerText||'');for(const u of(txt.match(/https?:\/\/[^\s)\]}>,]+/gi)||[]))if(!out.includes(u))out.push(u);return out.slice(0,12);};
      const roots=new Set(),authorReplies=[],seen=new Set();
      for(const a of [...document.querySelectorAll('a[href]')].filter(a=>sameUserHref(a.href||a.getAttribute('href')||''))){const root=compactRoot(a);if(!root||isMainRoot(root))continue;roots.add(root);}
      for(const root of roots){const text=clean(root.innerText||'').slice(0,4000);const links=externalLinks(root);const reply=[text,...links].filter(Boolean).join('\n').slice(0,6000);if(!reply||reply.length<8||seen.has(reply))continue;seen.add(reply);authorReplies.push(reply);}
      const affiliateLinks=[];for(const reply of authorReplies){for(const m of(reply.match(/https?:\/\/[^\s)\]}>,]+/gi)||[])){if(/coupang|naver/i.test(m)&&!affiliateLinks.includes(m))affiliateLinks.push(m);}}
      return{authorReplies:authorReplies.slice(0,15),affiliateLinks,authorRootCount:roots.size};
    },{username,sourceUrl:normalizedUrl});

    const sourceText=String(rootSnapshot.sourceText||'').trim();if(!sourceText)throw new Error('Threads 원문 텍스트를 읽지 못했습니다.');
    console.log(`[Threads detail] @${username} source=${sourceText.length} replies=${replies.authorReplies.length} authorRoots=${replies.authorRootCount||0} affiliateLinks=${replies.affiliateLinks.length} images=${rootSnapshot.images.length} videos=${rootSnapshot.videos.length} mediaScope=root-post-only replyScope=links-only`);
    return{sourceText,authorReplies:replies.authorReplies,affiliateLinks:replies.affiliateLinks,images:rootSnapshot.images,videos:rootSnapshot.videos,hasVideo:rootSnapshot.hasVideo,exactUrl:true};
  }finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}
}

async function mapWithConcurrency(items,concurrency,worker){const results=[];let cursor=0;async function run(){while(true){const i=cursor++;if(i>=items.length)return;try{results[i]=await worker(items[i],i);}catch(err){results[i]={error:err};}}}await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run));return results;}
async function collectBenchmarkMaterials({limit=10}={}){const accounts=shuffle(listBenchmarkAccounts());if(!accounts.length)throw new Error('관리자 페이지에서 소재 참고 계정을 먼저 등록해주세요.');const sample=accounts.slice(0,Math.min(accounts.length,12));let browser,context;try{({browser,context}=await openBrowser());const perAccount=Math.max(8,Math.ceil(limit/Math.max(1,sample.length))+4);const scanned=await mapWithConcurrency(sample,4,async account=>(await collectProfilePostsWithContext(context,account.username,{limit:perAccount})).filter(x=>!isUsedPost(x.url)));const pools=scanned.filter(Array.isArray).filter(x=>x.length),all=[];let round=0;while(all.length<limit&&pools.some(p=>p.length>round)){for(const pool of shuffle(pools)){if(all.length>=limit)break;if(pool[round])all.push(pool[round]);}round++;}console.log(`[Threads benchmark] accounts=${sample.length} pools=${pools.length} collected=${all.length} requested=${limit}`);return all.slice(0,limit);}finally{if(context)try{await context.close();}catch{}if(browser)try{await browser.close();}catch{}}}
module.exports={listBenchmarkAccounts,addBenchmarkAccount,addBenchmarkAccountsBulk,deleteBenchmarkAccount,markUsedPost,collectBenchmarkMaterials,collectPostDetails,collectProfilePosts};
