const { db } = require('./db');

// 관리자 공용 벤치마킹 계정. 사용자별 분류 없이 아이디만 관리한다.
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
  if (!/^[A-Za-z0-9._]{1,64}$/.test(v)) return '';
  return v;
}

function listBenchmarkAccounts() {
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all();
}
function addBenchmarkAccount(value) {
  const username = normalizeUsername(value);
  if (!username) throw new Error('올바른 Threads 아이디를 입력해주세요.');
  db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username = ?').get(username);
}
function deleteBenchmarkAccount(id) {
  return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id = ?').run(Number(id));
}
function markUsedPost(url) {
  if (!url) return;
  db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url));
}
function isUsedPost(url) {
  return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url = ?').get(String(url));
}

async function collectProfilePosts(username, { limit = 12 } = {}) {
  const playwright = require('playwright');
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
    const context = await browser.newContext({
      locale: 'ko-KR', viewport: { width: 1280, height: 1600 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const profileUrl = `https://www.threads.com/@${encodeURIComponent(username)}`;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    for (let i=0;i<3;i++){ await page.mouse.wheel(0,1100); await page.waitForTimeout(700); }
    const raw = await page.evaluate(() => {
      const out=[]; const seen=new Set();
      for (const a of document.querySelectorAll('a[href*="/post/"]')) {
        const href=a.href||''; if(!href||seen.has(href)) continue; seen.add(href);
        let root=a;
        for(let i=0;i<7&&root?.parentElement;i++){ root=root.parentElement; if((root.innerText||'').trim().length>=20) break; }
        const images=[...(root?.querySelectorAll?.('img')||[])].map(x=>x.src).filter(Boolean);
        out.push({ url:href, text:String(root?.innerText||'').replace(/\s+/g,' ').trim().slice(0,900), thumbnail:images[0]||'', imageCount:images.length, hasVideo:!!root?.querySelector?.('video') });
      }
      return out;
    });
    await context.close();
    return raw.slice(0, Math.max(1, Math.min(Number(limit)||12, 30))).map(x=>({ ...x, username }));
  } finally { if(browser) try{await browser.close();}catch{} }
}

async function collectBenchmarkMaterials({ limit = 12 } = {}) {
  const accounts=listBenchmarkAccounts();
  if(!accounts.length) throw new Error('관리자 페이지에서 벤치마킹 Threads 아이디를 먼저 등록해주세요.');
  const shuffled=[...accounts].sort(()=>Math.random()-0.5);
  const all=[];
  for(const account of shuffled.slice(0, Math.min(shuffled.length, 10))){
    try {
      const items=await collectProfilePosts(account.username,{limit:8});
      for(const item of items){ if(!isUsedPost(item.url)) all.push(item); }
      if(all.length>=limit) break;
    } catch(err){ console.warn(`[benchmark @${account.username}] ${err.message}`); }
  }
  all.sort((a,b)=>Number(b.hasVideo||b.imageCount>0)-Number(a.hasVideo||a.imageCount>0));
  return all.slice(0,limit);
}

module.exports={ listBenchmarkAccounts, addBenchmarkAccount, deleteBenchmarkAccount, markUsedPost, collectBenchmarkMaterials };
