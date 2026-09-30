'use strict';
// Browser-side Threads scraping. Runs ONLY inside the isolated browser worker
// (infra/isolatedBrowserWorker.js); the rest of the app calls threads/threadsCollector.js.
const { listBenchmarkAccounts } = require('./benchmarkAccounts');
const { isHttpVideoUrl, isTextReadFailure } = require('./postUrls');
const { shuffle, openBrowser, mapWithConcurrency } = require('./scraper/session');
const { collectProfilePostsWithContext, collectProfilePosts } = require('./scraper/profile');
const { collectPostDetailsRaw } = require('./scraper/postPage');
const { videoFallbackFromProfile, extractPlayableVideoUrls } = require('./scraper/video');
const { collectFallbackDetails } = require('./scraper/fallbackReader');

// Read the post page; if its text can't be read, fall back to the author's profile listing.
async function readPostOrProfile(url, username) {
  try {
    return await collectPostDetailsRaw(url, username);
  } catch (err) {
    if (!isTextReadFailure(err)) throw err;
    console.warn(
      `[Threads][EARLY TEXT FALLBACK] 원문 직접 추출 실패 → 프로필 fallback @${username || '-'} source=${url}`
    );
    const details = await videoFallbackFromProfile(url, username);
    if (!details || !String(details.sourceText || '').trim()) throw err;
    return details;
  }
}

// A post flagged as having video but without a playable URL gets a dedicated extraction pass.
async function withPlayableVideos(url, username, details) {
  const existing = Array.isArray(details?.videos) ? details.videos.filter(isHttpVideoUrl) : [];
  if (existing.length) return { ...details, videos: existing, hasVideo: true };
  if (!details?.hasVideo) return details;
  const videos = await extractPlayableVideoUrls(url);
  console.log(
    `[Threads][VIDEO EXTRACT] @${username || '-'} detected=${details?.hasVideo ? 'yes' : 'no'} playable=${videos.length}`
  );
  return { ...details, videos, hasVideo: details?.hasVideo || videos.length > 0 };
}

// Full post detail: post page (or profile fallback) + playable videos; if all text reads fail,
// a last-resort fallback reader.
async function collectPostDetails(url, username) {
  try {
    return await withPlayableVideos(url, username, await readPostOrProfile(url, username));
  } catch (err) {
    if (!isTextReadFailure(err)) throw err;
    console.warn(`[Threads][TEXT FALLBACK] 원문 직접 추출 실패 → fallback @${username} source=${url}`);
    return collectFallbackDetails(url, username);
  }
}

async function collectBenchmarkMaterials({ limit = 10 } = {}) {
  const accounts = shuffle(listBenchmarkAccounts());
  if (!accounts.length) throw new Error('관리자 페이지에서 소재 참고 계정을 먼저 등록해주세요.');
  const batchSize = Math.max(4, Math.min(12, Number(process.env.THREADS_BENCHMARK_BATCH_SIZE || 12)));
  const maxAccounts = Math.max(
    batchSize,
    Math.min(accounts.length, Number(process.env.THREADS_BENCHMARK_MAX_SCAN || Math.min(accounts.length, 72)))
  );
  let browser, context;
  try {
    ({ browser, context } = await openBrowser());
    const all = [],
      seen = new Set();
    let scannedAccounts = 0,
      successfulPools = 0,
      challengeCount = 0;
    for (let offset = 0; offset < maxAccounts && all.length < limit; offset += batchSize) {
      const batch = accounts.slice(offset, Math.min(offset + batchSize, maxAccounts));
      if (!batch.length) break;
      const perAccount = Math.max(12, Math.ceil((limit - all.length) / Math.max(1, batch.length)) + 8);
      const scanned = await mapWithConcurrency(batch, 2, async account => {
        const rows = await collectProfilePostsWithContext(context, account.username, { limit: perAccount });
        if (rows && rows.__threadsChallenge) challengeCount++;
        return rows || [];
      });
      scannedAccounts += batch.length;
      const pools = scanned.filter(Array.isArray).filter(x => x.length);
      successfulPools += pools.length;
      let round = 0;
      while (all.length < limit && pools.some(p => p.length > round)) {
        for (const pool of shuffle(pools)) {
          if (all.length >= limit) break;
          const item = pool[round];
          if (!item || seen.has(item.url)) continue;
          seen.add(item.url);
          all.push(item);
        }
        round++;
      }
      console.log(
        `[Threads benchmark batch] scanned=${scannedAccounts}/${maxAccounts} pools=${successfulPools} collected=${all.length}/${limit} challenged=${challengeCount}`
      );
      if (!all.length && challengeCount >= Math.max(4, Math.ceil(scannedAccounts * 0.5))) {
        console.error(
          `[Threads][CIRCUIT OPEN] challenged=${challengeCount}/${scannedAccounts} · profile scan stopped to protect collector session`
        );
        break;
      }
    }
    console.log(
      `[Threads benchmark] accounts=${scannedAccounts} pools=${successfulPools} collected=${all.length} requested=${limit}`
    );
    return all.slice(0, limit);
  } finally {
    if (context)
      try {
        await context.close();
      } catch {}
    if (browser)
      try {
        await browser.close();
      } catch {}
  }
}

async function runThreadsAccessDiag() {
  let browser, context;
  const cases = [
    ['FAIL_CASE', 'https://www.threads.com/@a_rzen2/post/DcIPOtYAaqJ'],
    ['SUCCESS_CASE', 'https://www.threads.com/@chi_chi1200/post/DcL0JJoG6U7/media'],
  ];
  try {
    ({ browser, context } = await openBrowser());
    for (const [label, url] of cases) {
      const page = await context.newPage();
      try {
        page.setDefaultTimeout(16000);
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 16000 });
        await page.waitForTimeout(4000);
        const data = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          body: document.body?.innerText?.slice(0, 500) || '',
          htmlLength: document.documentElement?.outerHTML?.length || 0,
          postLinks: document.querySelectorAll('a[href*="/post/"]').length,
          images: document.images.length,
          videos: document.querySelectorAll('video').length,
          readyState: document.readyState,
        }));
        console.log(
          `[THREADS ACCESS DIAG][${label}] ${JSON.stringify({ status: response?.status?.() ?? null, ...data })}`
        );
      } catch (err) {
        console.log(`[THREADS ACCESS DIAG][${label}] ${JSON.stringify({ error: String(err?.message || err), url })}`);
      } finally {
        try {
          await page.close();
        } catch {}
      }
    }
  } catch (err) {
    console.log(`[THREADS ACCESS DIAG][BOOT_ERROR] ${JSON.stringify({ error: String(err?.message || err) })}`);
  } finally {
    if (context)
      try {
        await context.close();
      } catch {}
    if (browser)
      try {
        await browser.close();
      } catch {}
  }
}

module.exports = {
  collectBenchmarkMaterials,
  collectPostDetails,
  collectProfilePosts,
  extractPlayableVideoUrls,
  videoFallbackFromProfile,
  runThreadsAccessDiag,
};
