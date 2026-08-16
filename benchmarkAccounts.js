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
function listBenchmarkAccounts() { return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts ORDER BY id DESC').all(); }
function addBenchmarkAccount(value) {
  const username = normalizeUsername(value);
  if (!username) throw new Error('올바른 Threads 아이디를 입력해주세요.');
  db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)').run(username);
  return db.prepare('SELECT id, username, created_at FROM threads_benchmark_accounts WHERE username = ?').get(username);
}
function addBenchmarkAccountsBulk(value) {
  const usernames = parseUsernames(value);
  if (!usernames.length) throw new Error('등록할 Threads 아이디가 없습니다.');
  const insert = db.prepare('INSERT OR IGNORE INTO threads_benchmark_accounts (username) VALUES (?)');
  let added = 0, skipped = 0;
  const tx = db.transaction(items => {
    for (const username of items) {
      const info = insert.run(username);
      if (info.changes) added++; else skipped++;
    }
  });
  tx(usernames);
  return { added, skipped, total: usernames.length, accounts: listBenchmarkAccounts() };
}
function deleteBenchmarkAccount(id) { return db.prepare('DELETE FROM threads_benchmark_accounts WHERE id = ?').run(Number(id)); }
function markUsedPost(url) { if (url) db.prepare('INSERT OR IGNORE INTO threads_benchmark_used_posts (post_url) VALUES (?)').run(String(url)); }
function isUsedPost(url) { return !!db.prepare('SELECT 1 FROM threads_benchmark_used_posts WHERE post_url = ?').get(String(url)); }
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function openBrowser() {
  const playwright = require('playwright');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
  const context = await browser.newContext({
    locale: 'ko-KR',
    viewport: { width: 1100, height: 1350 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
  });
  return { browser, context };
}

async function collectProfilePostsWithContext(context, username, { limit = 2 } = {}) {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(10000);
    await page.goto(`https://www.threads.com/@${encodeURIComponent(username)}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1400);
    await page.mouse.wheel(0, 850);
    await page.waitForTimeout(350);
    const raw = await page.evaluate(() => {
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/post/"]')) {
        const href = a.href || '';
        if (!href || seen.has(href)) continue;
        seen.add(href);
        let root = a;
        for (let i = 0; i < 7 && root?.parentElement; i++) {
          root = root.parentElement;
          if ((root.innerText || '').trim().length >= 20) break;
        }
        const images = [...(root?.querySelectorAll?.('img') || [])].map(x => x.src).filter(Boolean);
        out.push({
          url: href,
          text: String(root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
          thumbnail: images[0] || '',
          imageCount: images.length,
          hasVideo: !!root?.querySelector?.('video'),
          username
        });
        if (out.length >= limit) break;
      }
      return out;
    });
    return raw;
  } finally {
    try { await page.close(); } catch {}
  }
}

async function collectProfilePosts(username, { limit = 2 } = {}) {
  let browser, context;
  try {
    ({ browser, context } = await openBrowser());
    return await collectProfilePostsWithContext(context, username, { limit });
  } finally {
    if (context) try { await context.close(); } catch {}
    if (browser) try { await browser.close(); } catch {}
  }
}

async function collectPostDetails(url, username) {
  let browser, context;
  try {
    ({ browser, context } = await openBrowser());
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForTimeout(1800);
    await page.mouse.wheel(0, 750);
    await page.waitForTimeout(450);
    const data = await page.evaluate(({ username }) => {
      const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
      const target = String(username || '').toLowerCase();
      const blocks = [...document.querySelectorAll('article,[role="article"]')];
      if (!blocks.length) {
        for (const a of document.querySelectorAll('a[href*="/post/"]')) {
          let r = a;
          for (let i = 0; i < 7 && r?.parentElement; i++) r = r.parentElement;
          if (r && !blocks.includes(r)) blocks.push(r);
        }
      }
      const texts = [];
      for (const b of blocks) {
        const t = clean(b.innerText);
        if (!t || t.length < 2) continue;
        const links = [...b.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '');
        const own = links.some(h => h.toLowerCase().includes('/@' + target)) || t.toLowerCase().startsWith(target) || t.toLowerCase().includes('@' + target);
        if (own && !texts.includes(t)) texts.push(t.slice(0, 1800));
      }
      return { authorTexts: texts.slice(0, 8), pageText: clean(document.body?.innerText || '').slice(0, 5000) };
    }, { username });
    const authorTexts = (data.authorTexts || []).filter(Boolean);
    return { sourceText: authorTexts[0] || '', authorReplies: authorTexts.slice(1), fallbackText: data.pageText || '' };
  } finally {
    if (context) try { await context.close(); } catch {}
    if (browser) try { await browser.close(); } catch {}
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (err) { results[i] = { error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function collectBenchmarkMaterials({ limit = 10 } = {}) {
  const accounts = shuffle(listBenchmarkAccounts());
  if (!accounts.length) throw new Error('관리자 페이지에서 소재 참고 계정을 먼저 등록해주세요.');

  const sample = accounts.slice(0, Math.min(accounts.length, 12));
  let browser, context;
  try {
    ({ browser, context } = await openBrowser());
    const scanned = await mapWithConcurrency(sample, 4, async account => {
      const items = await collectProfilePostsWithContext(context, account.username, { limit: 2 });
      return items.filter(x => !isUsedPost(x.url));
    });

    const pools = scanned.filter(Array.isArray).filter(x => x.length);
    const all = [];
    let round = 0;
    while (all.length < limit && pools.some(p => p.length > round)) {
      for (const pool of shuffle(pools)) {
        if (all.length >= limit) break;
        if (pool[round]) all.push(pool[round]);
      }
      round++;
    }
    return all.slice(0, limit);
  } finally {
    if (context) try { await context.close(); } catch {}
    if (browser) try { await browser.close(); } catch {}
  }
}

module.exports = {
  listBenchmarkAccounts,
  addBenchmarkAccount,
  addBenchmarkAccountsBulk,
  deleteBenchmarkAccount,
  markUsedPost,
  collectBenchmarkMaterials,
  collectPostDetails,
  collectProfilePosts
};
