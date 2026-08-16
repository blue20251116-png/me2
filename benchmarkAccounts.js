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
  try {
    if (/^https?:\/\//i.test(v)) {
      const u = new URL(v);
      const m = u.pathname.match(/^\/@?([^/]+)/);
      if (m) v = m[1];
    }
  } catch {}
  v = v.replace(/^@+/, '').split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9._]{1,64}$/.test(v) ? v : '';
}

function parseUsernames(value) {
  const raw = Array.isArray(value) ? value.join('\n') : String(value || '');
  return [...new Set(raw.split(/[\s,;]+/).map(normalizeUsername).filter(Boolean))];
}

function listBenchmarkAccounts() {
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all();
}
function addBenchmarkAccount(value) {
  const username = normalizeUsername(value);
  if (!username) throw new Error('올바른 Threads 아이디를 입력해주세요.');
  db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username=?').get(username);
}
function addBenchmarkAccountsBulk(value) {
  const usernames = parseUsernames(value);
  if (!usernames.length) throw new Error('등록할 Threads 아이디가 없습니다.');

  const insert = db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)');
  let added = 0;
  let skipped = 0;

  for (const username of usernames) {
    const info = insert.run(username);
    if (Number(info?.changes || 0) > 0) added++;
    else skipped++;
  }

  return {
    added,
    skipped,
    total: usernames.length,
    accounts: listBenchmarkAccounts()
  };
}
function deleteBenchmarkAccount(id) { return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id=?').run(Number(id)); }
function markUsedPost(url) { if (url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url)); }
function isUsedPost(url) { return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url=?').get(String(url)); }
function shuffle(items) { const a=[...items]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

async function openBrowser() {
  const playwright = require('playwright');
  const browser = await playwright.chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
  const context = await browser.newContext({ locale:'ko-KR', viewport:{width:1100,height:1350}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' });
  return { browser, context };
}

async function collectProfilePostsWithContext(context, username, {limit=2}={}) {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(10000);
    await page.goto(`https://www.threads.com/@${encodeURIComponent(username)}`, { waitUntil:'domcontentloaded', timeout:10000 });
    await page.waitForTimeout(1400);
    await page.mouse.wheel(0,850);
    await page.waitForTimeout(350);
    return await page.evaluate(({username,limit}) => {
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`;}catch{return String(href||'').split(/[?#]/)[0];}};
      const rectOverlap=(a,b)=>{const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));const inter=x*y;if(!inter)return 0;return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));};
      const findRoot=(a,target)=>{
        let node=a.closest('article,[role="article"]')||a.parentElement,best=null;
        for(let i=0;i<10&&node;i++,node=node.parentElement){
          const links=[...node.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href));
          const uniq=[...new Set(links)];
          if(uniq.length===1&&uniq[0]===target&&clean(node.innerText).length>=8)best=node;
          if(uniq.length>1&&best)break;
        }
        return best;
      };
      const mediaFromRoot=root=>{
        if(!root)return{images:[],hasVideo:false,videoCount:0};
        const videos=[...root.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>=180&&r.height>=180;});
        const videoRects=videos.map(v=>v.getBoundingClientRect());
        const images=[];
        for(const img of root.querySelectorAll('img')){
          const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();
          if(!src||r.width<180||r.height<180)continue;
          if(/profile|프로필|avatar|사용자/.test(alt))continue;
          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;
          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;
          if(!images.includes(src))images.push(src);
        }
        return{images:images.slice(0,10),hasVideo:videos.length>0,videoCount:videos.length};
      };
      const out=[],seen=new Set();
      for(const a of document.querySelectorAll('a[href*="/post/"]')){
        const href=canonical(a.href||''); if(!href||seen.has(href))continue;
        let p=''; try{p=new URL(href).pathname;}catch{} if(!/\/post\//i.test(p))continue;
        const root=findRoot(a,href); if(!root)continue;
        const text=clean(root.innerText||'').slice(0,1600); if(!text)continue;
        const media=mediaFromRoot(root); seen.add(href);
        out.push({url:href,text,username,images:media.images,thumbnail:media.images[0]||'',imageCount:media.images.length,hasVideo:media.hasVideo,videoCount:media.videoCount});
        if(out.length>=limit)break;
      }
      return out;
    }, {username,limit});
  } finally { try{await page.close();}catch{} }
}

async function collectProfilePosts(username,{limit=2}={}) {
  let browser,context;
  try { ({browser,context}=await openBrowser()); return await collectProfilePostsWithContext(context,username,{limit}); }
  finally { if(context)try{await context.close();}catch{} if(browser)try{await browser.close();}catch{} }
}

async function collectPostDetails(url, username) {
  let browser,context;
  try {
    ({browser,context}=await openBrowser());
    const page=await context.newPage();
    page.setDefaultTimeout(14000);
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:14000});
    await page.waitForTimeout(1800);
    await page.mouse.wheel(0,900);
    await page.waitForTimeout(700);
    await page.mouse.wheel(0,900);
    await page.waitForTimeout(550);

    const data=await page.evaluate(({username,sourceUrl})=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const canonical=href=>{try{const u=new URL(href,location.origin);return`${u.origin}${u.pathname}`;}catch{return String(href||'').split(/[?#]/)[0];}};
      const rectOverlap=(a,b)=>{const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));const inter=x*y;if(!inter)return 0;return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));};
      const targetUrl=canonical(sourceUrl),targetUser=String(username||'').toLowerCase();

      function postRootFromLink(a, expectedUrl='') {
        let node=a.closest('article,[role="article"]')||a.parentElement,best=null;
        for(let i=0;i<12&&node;i++,node=node.parentElement){
          const txt=clean(node.innerText);
          if(txt.length<4)continue;
          const postLinks=[...node.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href||''));
          const uniq=[...new Set(postLinks)];
          if(expectedUrl){
            if(uniq.includes(expectedUrl))best=node;
            if(uniq.length>1&&best)break;
          } else {
            if(uniq.length<=1)best=node;
            if(uniq.length>1&&best)break;
          }
        }
        return best;
      }

      const mainCandidates=[];
      for(const a of document.querySelectorAll('a[href*="/post/"]')){
        if(canonical(a.href||'')!==targetUrl)continue;
        const root=postRootFromLink(a,targetUrl);
        if(root&&!mainCandidates.includes(root))mainCandidates.push(root);
      }
      const main=mainCandidates.sort((a,b)=>clean(b.innerText).length-clean(a.innerText).length)[0]||null;
      const sourceText=clean(main?.innerText||'').slice(0,5000);

      const videos=[];
      const videoRects=[];
      if(main){
        for(const v of main.querySelectorAll('video')){
          const r=v.getBoundingClientRect(); if(r.width<180||r.height<180)continue;
          videoRects.push(r);
          const src=v.currentSrc||v.src||''; if(src&&!videos.includes(src))videos.push(src);
        }
      }

      const images=[];
      if(main){
        for(const img of main.querySelectorAll('img')){
          const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();
          if(!src||r.width<180||r.height<180)continue;
          if(/profile|프로필|avatar|사용자/.test(alt))continue;
          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;
          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;
          if(!images.includes(src))images.push(src);
        }
      }

      const authorReplies=[];
      const seenText=new Set();
      const profileAnchors=[...document.querySelectorAll('a[href]')].filter(a=>{
        const h=String(a.getAttribute('href')||'').toLowerCase().replace(/\/$/,'');
        return h===`/@${targetUser}` || h.endsWith(`/@${targetUser}`);
      });
      for(const a of profileAnchors){
        const root=postRootFromLink(a,'');
        if(!root||root===main||main?.contains(root)||root.contains(main))continue;
        let text=clean(root.innerText);
        if(!text||text.length<8)continue;
        text=text.replace(/^(?:@?[^ ]+\s+)?(?:방금|\d+\s*(?:분|시간|일))\s*/,'').trim();
        if(text.length<8||seenText.has(text))continue;
        seenText.add(text);
        authorReplies.push(text.slice(0,3500));
      }

      for(const block of document.querySelectorAll('article,[role="article"]')){
        if(block===main||main?.contains(block)||block.contains(main))continue;
        let text=clean(block.innerText); if(!text||text.length<8)continue;
        const links=[...block.querySelectorAll('a[href]')].map(a=>String(a.getAttribute('href')||'').toLowerCase());
        const isAuthor=links.some(h=>h.includes('/@'+targetUser))||text.toLowerCase().startsWith(targetUser)||text.toLowerCase().includes('@'+targetUser);
        if(isAuthor&&!seenText.has(text)){seenText.add(text);authorReplies.push(text.slice(0,3500));}
      }

      const metaDescription=clean(document.querySelector('meta[property="og:description"]')?.content||document.querySelector('meta[name="description"]')?.content||'');
      return{
        sourceText,
        authorReplies:authorReplies.slice(0,10),
        images:images.slice(0,10),
        videos:videos.slice(0,5),
        hasVideo:videoRects.length>0,
        exactUrl:canonical(location.href)===targetUrl,
        metaDescription
      };
    },{username,sourceUrl:url});

    const sourceText=String(data.sourceText||data.metaDescription||'').trim();
    console.log(`[Threads detail] @${username} source=${sourceText.length} replies=${(data.authorReplies||[]).length} images=${(data.images||[]).length} videos=${(data.videos||[]).length}`);
    return{sourceText,authorReplies:(data.authorReplies||[]).filter(Boolean),images:data.images||[],videos:data.videos||[],hasVideo:!!data.hasVideo,exactUrl:!!data.exactUrl};
  } finally {
    if(context)try{await context.close();}catch{}
    if(browser)try{await browser.close();}catch{}
  }
}

async function mapWithConcurrency(items,concurrency,worker){
  const results=[];let cursor=0;
  async function run(){while(true){const i=cursor++;if(i>=items.length)return;try{results[i]=await worker(items[i],i);}catch(err){results[i]={error:err};}}}
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run));
  return results;
}

async function collectBenchmarkMaterials({limit=10}={}){
  const accounts=shuffle(listBenchmarkAccounts());
  if(!accounts.length)throw new Error('관리자 페이지에서 소재 참고 계정을 먼저 등록해주세요.');
  const sample=accounts.slice(0,Math.min(accounts.length,12));
  let browser,context;
  try{
    ({browser,context}=await openBrowser());
    const scanned=await mapWithConcurrency(sample,4,async account=>(await collectProfilePostsWithContext(context,account.username,{limit:2})).filter(x=>!isUsedPost(x.url)));
    const pools=scanned.filter(Array.isArray).filter(x=>x.length),all=[];let round=0;
    while(all.length<limit&&pools.some(p=>p.length>round)){
      for(const pool of shuffle(pools)){if(all.length>=limit)break;if(pool[round])all.push(pool[round]);}
      round++;
    }
    return all.slice(0,limit);
  } finally { if(context)try{await context.close();}catch{} if(browser)try{await browser.close();}catch{} }
}

module.exports={listBenchmarkAccounts,addBenchmarkAccount,addBenchmarkAccountsBulk,deleteBenchmarkAccount,markUsedPost,collectBenchmarkMaterials,collectPostDetails,collectProfilePosts};
