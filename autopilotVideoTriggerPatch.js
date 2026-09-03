const engine = require('./autopilotMaterialEngine');

const originalBuildThreadsFirstAutopilot = engine.buildThreadsFirstAutopilot.bind(engine);

async function detectThreadsVideo(postUrl) {
  if (process.env.ME2_BROWSER_WORKER !== '1') {
    try { return await require('./isolatedTask').isolatedBrowserTask('autopilotVideoTriggerPatch', 'detectThreadsVideo', [postUrl], 45000); }
    catch (err) { console.warn(`[Autopilot][VIDEO DETECT] ${err.code || err.message}`); return false; }
  }
  if (!postUrl) return false;

  let playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    console.warn(`[Autopilot][VIDEO DETECT] playwright unavailable: ${err.message}`);
    return false;
  }

  let browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    });

    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1100, height: 1500 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);

    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 16000 });
    await page.waitForTimeout(1800);

    const detected = await page.evaluate(() => {
      if (document.querySelector('video')) return true;
      if (document.querySelector('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')) return true;

      const html = document.documentElement?.innerHTML || '';
      return /"(?:video_url|playable_url|playable_url_quality_hd|browser_native_hd_url)"\s*:/i.test(html)
        || /https?:\\?\/\\?\/[^"'<>\s]+?\.mp4/i.test(html);
    });

    await context.close();
    return !!detected;
  } catch (err) {
    console.warn(`[Autopilot][VIDEO DETECT] 실패 source=${postUrl} reason="${err.message}"`);
    return false;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

engine.buildThreadsFirstAutopilot = async function patchedBuildThreadsFirstAutopilot(accountId, options) {
  const result = await originalBuildThreadsFirstAutopilot(accountId, options);
  const existingVideos = Array.isArray(result?.sourceVideos)
    ? result.sourceVideos.filter(Boolean)
    : [];

  if (existingVideos.length || !result?.sourceUrl) {
    return result;
  }

  const hasVideo = await detectThreadsVideo(result.sourceUrl);
  console.log(`[Autopilot][VIDEO DETECT] source=${result.sourceUrl} detected=${hasVideo ? 'yes' : 'no'} playableUrls=${existingVideos.length}`);

  if (!hasVideo) return result;

  // scheduler의 chooseSourceMedia()는 sourceVideos.length > 0일 때 실제 importer를 실행한다.
  // 여기서는 다운로드 URL을 위조하지 않고, '영상 존재' 신호용으로 원본 post URL을 넣는다.
  // importer는 sourceVideos 값 자체를 사용하지 않고 sourceUrl을 다시 열어 실제 mp4를 찾아 다운로드한다.
  return {
    ...result,
    sourceVideos: [result.sourceUrl],
    sourceHasVideo: true,
  };
};

console.log('[Autopilot][VIDEO TRIGGER PATCH] 영상 존재 감지 시 mp4 importer 강제 실행 활성화');

module.exports.detectThreadsVideo = detectThreadsVideo;
