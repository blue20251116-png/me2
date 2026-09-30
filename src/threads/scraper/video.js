'use strict';
// Finds playable video URLs for a post (network sniffing, then the profile listing).
const { launchChromium } = require('../../infra/browserLauncher');
const { canonicalPostUrl, isHttpVideoUrl } = require('../postUrls');
const { collectProfilePosts } = require('./profile');

function mediaViewUrl(raw) {
  return `${canonicalPostUrl(raw).replace(/\/+$/, '')}/media`;
}
async function videoFallbackFromProfile(url, username) {
  try {
    const posts = await collectProfilePosts(username, { limit: 30 });
    const target = canonicalPostUrl(url);
    const hit = (posts || []).find(p => canonicalPostUrl(p?.url) === target);
    if (!hit) return null;
    const sourceText = String(hit.text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const images = Array.isArray(hit.images) ? hit.images.filter(Boolean) : [];
    const hasVideo = !!hit.hasVideo || Number(hit.videoCount || 0) > 0;
    console.log(
      `[Threads][EARLY TEXT FALLBACK] @${username || '-'} source=${sourceText.length} images=${images.length} hasVideo=${hasVideo ? 'yes' : 'no'}`
    );
    return { sourceText, authorReplies: [], images, videos: [], hasVideo, exactUrl: true };
  } catch (err) {
    console.warn(`[Threads][EARLY TEXT FALLBACK] 실패 @${username || '-'} reason="${err.message}"`);
    return null;
  }
}
async function extractPlayableVideoUrls(postUrl) {
  let browser;
  const found = [];
  const add = url => {
    const s = String(url || '').trim();
    if (!isHttpVideoUrl(s)) return;
    if (!found.includes(s)) found.push(s);
  };

  try {
    browser = await launchChromium({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    });
    const context = await browser.newContext({
      locale: 'ko-KR',
      viewport: { width: 1100, height: 1500 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });

    const scan = async (targetUrl, { allow429Fallback = false } = {}) => {
      const page = await context.newPage();
      page.setDefaultTimeout(16000);
      page.on('request', request => add(request.url()));
      page.on('response', async response => {
        try {
          const status = response.status();
          const url = response.url();
          const request = response.request();
          const resourceType = request.resourceType();
          const headers = await response.allHeaders().catch(() => ({}));
          const type = String(headers['content-type'] || '').toLowerCase();

          if (status === 429) {
            console.warn(
              `[Threads][429 TRACE] stage=subresponse status=429 resource=${resourceType || '-'} url=${url} retryAfter=${headers['retry-after'] || '-'} contentType=${type || '-'}`
            );
            return;
          }

          if (type.startsWith('video/') || type.includes('octet-stream') || isHttpVideoUrl(url)) add(url);
        } catch (err) {
          console.warn(`[Threads][429 TRACE ERROR] stage=subresponse reason="${err.message}"`);
        }
      });

      try {
        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 16000 });
        const status = response?.status?.() ?? 0;
        const headers = response ? await response.allHeaders().catch(() => ({})) : {};
        console.log(
          `[Threads][VIDEO PAGE] status=${status || '-'} url=${targetUrl} retryAfter=${headers['retry-after'] || '-'} server=${headers['server'] || '-'}`
        );

        if (status === 429) {
          console.warn(
            `[Threads][429 TRACE] stage=page-goto status=429 resource=document url=${targetUrl} retryAfter=${headers['retry-after'] || '-'} contentType=${headers['content-type'] || '-'}`
          );
          if (allow429Fallback) {
            console.warn(
              `[Threads][VIDEO EXTRACT SCAN] status=429 url=${targetUrl} → 이 게시물만 /media 1회 fallback 시도`
            );
            return { ok: false, status: 429 };
          }
          console.warn(`[Threads][VIDEO EXTRACT SCAN] status=429 url=${targetUrl} → 해당 소재만 실패 처리`);
          return { ok: false, status: 429 };
        }

        await page.waitForTimeout(2200);
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel(0, 650);
          await page.waitForTimeout(250);
        }
        try {
          const video = page.locator('video').first();
          if (await video.count()) {
            await video.scrollIntoViewIfNeeded().catch(() => {});
            await video.click({ force: true, timeout: 1200 }).catch(() => {});
          }
        } catch {}
        try {
          await page.evaluate(() => {
            for (const v of document.querySelectorAll('video')) {
              try {
                v.muted = true;
                v.load?.();
                v.play().catch(() => {});
              } catch {}
            }
          });
        } catch {}
        try {
          const playButtons = page.getByRole('button', { name: /play|재생/i });
          const n = Math.min(await playButtons.count(), 3);
          for (let i = 0; i < n; i++)
            await playButtons
              .nth(i)
              .click({ force: true, timeout: 1000 })
              .catch(() => {});
        } catch {}
        await page.waitForTimeout(3500);

        const domUrls = await page.evaluate(() => {
          const out = [];
          const add = v => {
            const s = String(v || '').trim();
            if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
          };
          for (const v of document.querySelectorAll('video')) {
            add(v.currentSrc);
            add(v.src);
            add(v.getAttribute('src'));
            for (const s of v.querySelectorAll('source[src]')) add(s.src || s.getAttribute('src'));
            for (const key of ['data-src', 'data-video-url', 'data-url', 'data-playable-url']) add(v.getAttribute(key));
          }
          for (const selector of [
            'meta[property="og:video"]',
            'meta[property="og:video:url"]',
            'meta[property="og:video:secure_url"]',
            'meta[name="twitter:player:stream"]',
          ])
            add(document.querySelector(selector)?.content);
          try {
            for (const e of performance.getEntriesByType('resource')) add(e?.name);
          } catch {}
          return out;
        });
        for (const u of domUrls) add(u);

        try {
          const html = await page.content();
          const patterns = [
            /"video_url"\s*:\s*"([^"]+)"/gi,
            /"playable_url"\s*:\s*"([^"]+)"/gi,
            /"playable_url_quality_hd"\s*:\s*"([^"]+)"/gi,
            /"browser_native_hd_url"\s*:\s*"([^"]+)"/gi,
            /"progressive_url"\s*:\s*"([^"]+)"/gi,
            /(https?:\\?\/\\?\/[^"'<>\s]+?\.mp4[^"'<>\s]*)/gi,
          ];
          const decode = s =>
            String(s || '')
              .replace(/\\u0026/gi, '&')
              .replace(/\\u003d/gi, '=')
              .replace(/\\u002f/gi, '/')
              .replace(/\\\//g, '/');
          for (const re of patterns) {
            let m;
            while ((m = re.exec(html)) !== null) add(decode(m[1] || m[0]));
          }
        } catch {}

        const domVideoCount = await page
          .locator('video')
          .count()
          .catch(() => 0);
        console.log(
          `[Threads][VIDEO EXTRACT SCAN] status=${status || '-'} url=${targetUrl} domVideos=${domVideoCount} playable=${found.length}`
        );
        return { ok: true, status };
      } finally {
        try {
          await page.close();
        } catch {}
      }
    };

    const primary = await scan(canonicalPostUrl(postUrl), { allow429Fallback: true });
    if (!found.length && (primary?.status === 429 || primary?.ok)) {
      const mediaUrl = mediaViewUrl(postUrl);
      console.log(
        `[Threads][VIDEO MEDIA FALLBACK] start url=${mediaUrl} reason=${primary?.status === 429 ? 'primary-429' : 'primary-no-playable'}`
      );
      const media = await scan(mediaUrl, { allow429Fallback: false });
      console.log(
        `[Threads][VIDEO MEDIA FALLBACK] done status=${media?.status || '-'} playable=${found.length} url=${mediaUrl}`
      );
    }
    await context.close();
  } catch (err) {
    console.warn(`[Threads][VIDEO EXTRACT] fallback 실패 url=${postUrl} reason="${err.message}"`);
  } finally {
    if (browser)
      try {
        await browser.close();
      } catch {}
  }

  return found.slice(0, 5);
}

module.exports = { mediaViewUrl, videoFallbackFromProfile, extractPlayableVideoUrls };
