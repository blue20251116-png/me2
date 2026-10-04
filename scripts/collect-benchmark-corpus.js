'use strict';
// Scrapes recent posts from every benchmark account into db/benchmark-corpus.jsonl for style
// analysis. Usage: node scripts/collect-benchmark-corpus.js [perAccount=20] [maxAccounts]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../src/config/paths');
const { listBenchmarkAccounts } = require('../src/threads/benchmarkAccounts');
const { openBrowser, mapWithConcurrency } = require('../src/threads/scraper/session');
const { collectProfilePostsWithContext } = require('../src/threads/scraper/profile');

(async () => {
  const perAccount = Number(process.argv[2] || 20);
  const accounts = listBenchmarkAccounts().slice(0, Number(process.argv[3] || 1e9));
  const out = path.join(DATA_DIR, 'benchmark-corpus.jsonl');
  const done = new Set();
  if (fs.existsSync(out))
    for (const line of fs.readFileSync(out, 'utf8').split('\n'))
      try {
        done.add(JSON.parse(line).username);
      } catch {}
  const todo = accounts.filter(a => !done.has(a.username));
  console.log(`accounts=${accounts.length} alreadyDone=${done.size} todo=${todo.length}`);
  const { browser, context } = await openBrowser();
  let challenged = 0,
    streak = 0,
    n = 0;
  try {
    await mapWithConcurrency(todo, 1, async a => {
      // Threads shows a login wall now and then; only a run of them means the session is blocked.
      if (streak >= 5) return;
      const rows = await collectProfilePostsWithContext(context, a.username, { limit: perAccount }).catch(e => {
        console.error(`@${a.username} ERR ${e.message}`);
        return [];
      });
      if (rows.__threadsChallenge) challenged++, streak++;
      else streak = 0;
      for (const r of rows)
        fs.appendFileSync(
          out,
          JSON.stringify({ username: a.username, url: r.url, text: r.text, imageCount: r.imageCount, hasVideo: r.hasVideo }) + '\n'
        );
      console.log(`[${++n}/${todo.length}] @${a.username} posts=${rows.length}${rows.__threadsChallenge ? ' CHALLENGED' : ''}`);
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000));
    });
  } finally {
    // Skip context.close() so the server's persisted Threads session file is never overwritten.
    await browser.close().catch(() => {});
  }
  console.log(`done challenged=${challenged}`);
})();
