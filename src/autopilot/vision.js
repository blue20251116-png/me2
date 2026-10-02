'use strict';
const { isAiBudgetOrCreditError } = require('../integrations/aiRequestGuard');
// Understanding a source post: what is actually being sold (images + sampled video frames) and a structured analysis.
const axios = require('axios');
const { getAiKey, callAiText, callAiVision, clean } = require('./aiCalls');
const { normalized } = require('./materials');
const { purchasableTerm } = require('./productMatching');

function grounded(term, evidence) {
  const t = normalized(term),
    e = normalized(evidence);
  if (!t || !e) return false;
  if (e.includes(t)) return true;
  const tokens = clean(term)
    .split(/\s+/)
    .map(normalized)
    .filter(x => x.length >= 2);
  return tokens.length > 0 && tokens.every(x => e.includes(x));
}

function commerceTargetPrompt() {
  return `너는 Threads 쇼핑 소재의 실제 판매/추천 대상을 식별하는 검수자다. 본문과 작성자 댓글을 우선 보고, 이미지가 제공되면 보조 근거로만 사용한다. 화면에 보이는 주변 물건을 판매 대상으로 착각하지 않는다. 음식이면 완성요리와 실제 제휴 핵심재료/소스/조미료를 구분한다. 브랜드/모델은 근거가 있을 때만 쓴다. searchTerms는 쿠팡에서 실제 상품을 찾기 좋은 검색어 최대 2개다. 단순 주제어(예: 운동, 다이어트, 일상)만 쓰지 말고 실제 구매 가능한 물건/식품명이어야 한다. confidence는 반드시 0~100 사이 정수로 쓰고, 판매 대상이 본문·작성자 댓글·이미지 중 둘 이상의 근거로 명확하면 70 이상을 준다. 이미지가 있으면 mediaFlags도 판단한다: adLabel은 이미지 안에 "광고", "AD", "유료광고", "협찬" 같은 광고 표시 글자가 박혀 있으면 true, watermark는 다른 계정의 @아이디·채널 로고·워터마크가 박혀 있으면 true다. 이미지가 없으면 둘 다 false. JSON만 출력: {"kind":"product|food|recipe|lifestyle","soldObject":"","dish":"","promotedIngredient":"","searchTerms":[""],"confidence":0,"evidence":"","mediaFlags":{"adLabel":false,"watermark":false}}`;
}

function commerceTargetText(m) {
  return `[Threads 본문]\n${m.sourceText.slice(0, 4500)}\n\n[작성자 댓글]\n${m.authorReplies.slice(0, 3500) || '(없음)'}`;
}

function normalizeVisionResult(d) {
  return {
    kind: ['product', 'food', 'recipe', 'lifestyle'].includes(d?.kind) ? d.kind : 'product',
    soldObject: clean(d?.soldObject),
    dish: clean(d?.dish),
    promotedIngredient: clean(d?.promotedIngredient),
    searchTerms: [...new Set((Array.isArray(d?.searchTerms) ? d.searchTerms : []).map(clean).filter(Boolean))].slice(
      0,
      2
    ),
    confidence: (() => {
      let n = Number(d?.confidence);
      if (Number.isFinite(n) && n > 0 && n <= 1) n *= 100;
      if (!Number.isFinite(n) || n < 0) n = 0;
      n = Math.min(100, n);
      if (n === 0) {
        const sold = clean(d?.soldObject),
          dish = clean(d?.dish),
          ingredient = clean(d?.promotedIngredient),
          terms = (Array.isArray(d?.searchTerms) ? d.searchTerms : []).map(clean).filter(Boolean);
        if (sold && terms.length) n = 75;
        else if (dish && ingredient && terms.length) n = 70;
        else if ((sold || dish) && terms.length) n = 60;
      }
      return n;
    })(),
    evidence: clean(d?.evidence).slice(0, 300),
    mediaFlags: { adLabel: d?.mediaFlags?.adLabel === true, watermark: d?.mediaFlags?.watermark === true },
  };
}

// Sampled video frames per source video, cached for 6 hours (bounded).
const videoFrameVisionCache = new Map();

const VIDEO_FRAME_CACHE_TTL = 6 * 60 * 60 * 1000;

const VIDEO_FRAME_CACHE_MAX = 80;

function execVideoTool(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function pruneVideoFrameCache() {
  const now = Date.now();
  for (const [k, v] of videoFrameVisionCache) {
    if (now - v.at > VIDEO_FRAME_CACHE_TTL) videoFrameVisionCache.delete(k);
  }
  while (videoFrameVisionCache.size > VIDEO_FRAME_CACHE_MAX)
    videoFrameVisionCache.delete(videoFrameVisionCache.keys().next().value);
}

async function extractVisionFrames(videoUrl, count) {
  const url = String(videoUrl || '').trim();
  if (!/^https?:\/\//i.test(url) || count < 1) return [];
  pruneVideoFrameCache();
  const key = url + '|' + count;
  const cached = videoFrameVisionCache.get(key);
  if (cached && Date.now() - cached.at <= VIDEO_FRAME_CACHE_TTL) {
    console.log('[AutopilotV3][VIDEO VISION CACHE HIT] frames=' + cached.frames.length);
    return cached.frames;
  }
  const fs = require('fs');
  const os = require('os');
  const p = require('path');
  const crypto = require('crypto');
  const id = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const videoFile = p.join(os.tmpdir(), 'threads-vision-' + id + '.mp4');
  const frameFiles = [];
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 5,
      maxContentLength: 30 * 1024 * 1024,
      maxBodyLength: 30 * 1024 * 1024,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
        referer: 'https://www.threads.com/',
        accept: 'video/mp4,video/*,*/*;q=0.8',
      },
      validateStatus: s => s >= 200 && s < 400,
    });
    const body = Buffer.from(r.data || []);
    if (body.length < 4096) throw new Error('video body too small');
    fs.writeFileSync(videoFile, body);
    const durationRaw = await execVideoTool(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoFile],
      10000
    );
    const duration = Number.parseFloat(durationRaw);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobe duration unavailable');
    const ratios = count >= 3 ? [0.2, 0.5, 0.8] : [0.3, 0.7];
    const frames = [];
    for (let i = 0; i < Math.min(count, ratios.length); i++) {
      const at = Math.max(0.05, Math.min(Math.max(0.05, duration - 0.05), duration * ratios[i]));
      const out = p.join(os.tmpdir(), 'threads-vision-' + id + '-' + i + '.jpg');
      frameFiles.push(out);
      await execVideoTool(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          at.toFixed(3),
          '-i',
          videoFile,
          '-frames:v',
          '1',
          '-vf',
          'scale=720:-2',
          '-q:v',
          '5',
          '-y',
          out,
        ],
        15000
      );
      const img = fs.readFileSync(out);
      if (img.length >= 1024) frames.push('data:image/jpeg;base64,' + img.toString('base64'));
    }
    if (frames.length) {
      videoFrameVisionCache.set(key, { at: Date.now(), frames });
      pruneVideoFrameCache();
      console.log(
        '[AutopilotV3][VIDEO VISION] source=' +
          new URL(url).hostname +
          ' duration=' +
          duration.toFixed(1) +
          's frames=' +
          frames.length +
          ' bytes=' +
          body.length
      );
    }
    return frames;
  } catch (e) {
    console.warn(
      '[AutopilotV3][VIDEO VISION] 프레임 추출 실패 → 기존 이미지 Vision 유지: ' +
        (e.response?.status || '-') +
        ' ' +
        e.message
    );
    return [];
  } finally {
    for (const f of [videoFile, ...frameFiles]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

// Images sent per source to the vision call. Each image costs ~2.8k input tokens at low detail on
// gpt-4o-mini, about 3x the text, so images were ~98% of autopilot AI input (production log
// 2026-10-01: 52 vision calls, 44 images, 175k tokens for 2 published posts). The body text and the
// author's replies are the primary evidence (the prompt treats images as supporting), so one image
// is enough to confirm the object and catch a watermark. AUTOPILOT_VISION_IMAGES=2|3 restores more.
function visionImageLimit(env = process.env) {
  const n = Number(env.AUTOPILOT_VISION_IMAGES);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1;
}

async function buildVideoVisionMedia(m, max = visionImageLimit()) {
  const originals = (Array.isArray(m?.images) ? m.images : []).filter(Boolean);
  const videos = (Array.isArray(m?.videos) ? m.videos : []).filter(v => /^https?:\/\//i.test(String(v || '')));
  if (!videos.length) return { images: originals.slice(0, max), frameCount: 0 };
  const wanted = originals.length ? max - 1 : max;
  // With room for only one image and a photo available, skip frame extraction (no ffmpeg run).
  if (wanted <= 0) return { images: originals.slice(0, max), frameCount: 0 };
  const frames = await extractVisionFrames(videos[0], wanted);
  if (!frames.length) return { images: originals.slice(0, max), frameCount: 0 };
  const images = originals.length ? [originals[0], ...frames] : frames;
  console.log(
    '[AutopilotV3][VIDEO VISION MIX] originals=' +
      (originals.length ? 1 : 0) +
      ' frames=' +
      frames.length +
      ' total=' +
      Math.min(max, images.length)
  );
  return { images: images.slice(0, max), frameCount: frames.length };
}

async function identifyCommerceTarget(accountId, m) {
  const visionMedia = await buildVideoVisionMedia(m);
  const images = visionMedia.images;
  const system = commerceTargetPrompt();
  const text =
    commerceTargetText(m) +
    (visionMedia.frameCount
      ? '\n\n[영상 분석] 동일 원본 영상에서 시간차로 추출한 대표 프레임 ' +
        visionMedia.frameCount +
        '장을 포함했다. 여러 프레임에서 반복되거나 실제 사용·시연되는 대상을 우선하고 배경 소품은 제외하라.'
      : '');
  // Fail loudly on a missing AI key before the catch blocks below could turn it into a misleading
  // "low confidence" result for every material.
  if (!getAiKey(accountId)) {
    throw new Error('Anthropic API 키가 설정되지 않았습니다');
  }
  if (images.length) {
    try {
      const d = await callAiVision(accountId, system, `${text}\n\n대표 시각자료 ${images.length}장.`, images, {
        maxTokens: 1200,
        temperature: 0.1,
      });
      const result = normalizeVisionResult(d);
      console.log(
        `[AutopilotV3][VISION TARGET] kind=${result.kind} sold="${result.soldObject || '-'}" dish="${result.dish || '-'}" ingredient="${result.promotedIngredient || '-'}" confidence=${result.confidence} terms="${result.searchTerms.join(' / ')}"`
      );
      return result;
    } catch (e) {
      if (isAiBudgetOrCreditError(e)) {
        throw e;
      }
      console.warn(
        `[AutopilotV3][VISION TARGET] 이미지 분석 실패 → 텍스트 재시도: ${e.response?.status || '-'} ${e.response?.data?.error?.message || e.message}`
      );
    }
  }
  try {
    const d = await callAiText(accountId, system, text, { maxTokens: 1200, temperature: 0.1 });
    const result = normalizeVisionResult(d);
    console.log(
      `[AutopilotV3][TEXT TARGET] kind=${result.kind} sold="${result.soldObject || '-'}" dish="${result.dish || '-'}" ingredient="${result.promotedIngredient || '-'}" confidence=${result.confidence} terms="${result.searchTerms.join(' / ')}"`
    );
    return result;
  } catch (e) {
    if (isAiBudgetOrCreditError(e)) {
      throw e;
    }
    console.warn(
      `[AutopilotV3][TEXT TARGET] 실패: ${e.response?.status || '-'} ${e.response?.data?.error?.message || e.message}`
    );
    return {
      kind: 'product',
      soldObject: '',
      dish: '',
      promotedIngredient: '',
      searchTerms: [],
      confidence: 0,
      evidence: '',
    };
  }
}

async function analyzeMaterial(accountId, m, target, vision) {
  const evidence = `${m.sourceText}\n${m.authorReplies}`;
  const visionText =
    vision && vision.confidence >= 45 ? JSON.stringify(vision) : '(Vision/Text 타겟 확신 부족 또는 없음)';
  const d = await callAiText(
    accountId,
    `너는 한국 Threads 쇼핑 소재를 쿠팡파트너스 상품과 연결하는 편집자다. 실제 구매 가능한 상품을 식별한다. mode(recipe/product/lifestyle), topic, secretTerm, searchTerms, facts, hookStyle을 판단한다. searchTerms는 최대 2개이며 반드시 쿠팡에서 구매 가능한 구체적인 물건/식품/소스명이어야 한다. '운동','다이어트','일상','레시피' 같은 추상 주제어만 출력하면 안 된다. 본문·작성자 댓글·이미지/영상에서 실제 구매 가능한 대상을 최대한 구체적으로 추론하되 근거 없는 브랜드/모델은 만들지 않는다. 작성자 댓글에 쇼핑 링크가 없어도 정상 소재로 처리한다. JSON만 출력: {"mode":"recipe|product|lifestyle","topic":"","secretTerm":"","hideInBody":true,"searchTerms":[""],"facts":[""],"hookStyle":""}`,
    `타겟:${target || '전체'}\n[원 게시물]\n${m.sourceText.slice(0, 5000)}\n[작성자 추가댓글]\n${m.authorReplies.slice(0, 5000) || '(없음)'}\n[판매대상 검수]\n${visionText}`,
    { maxTokens: 1200, temperature: 0.15 }
  );
  let terms = [
    ...new Set((Array.isArray(d.searchTerms) ? d.searchTerms : []).map(clean).filter(purchasableTerm)),
  ].slice(0, 2);
  if (vision?.confidence >= 55 && vision.searchTerms?.length) {
    terms = [...new Set([...vision.searchTerms, ...terms].map(clean).filter(purchasableTerm))].slice(0, 2);
  }
  if (d.mode !== 'recipe' && vision?.confidence < 55) {
    const groundedTerms = terms.filter(t => grounded(t, evidence));
    if (groundedTerms.length) terms = groundedTerms;
  }
  return {
    mode: ['recipe', 'product', 'lifestyle'].includes(d.mode) ? d.mode : 'lifestyle',
    topic: clean(d.topic) || vision?.soldObject || vision?.dish || 'Threads 소재',
    secretTerm: clean(d.secretTerm) || vision?.promotedIngredient || '',
    hideInBody: d.mode === 'recipe' ? true : d.hideInBody !== false,
    searchTerms: terms,
    facts: Array.isArray(d.facts) ? d.facts.map(clean).filter(Boolean).slice(0, 10) : [],
    hookStyle: clean(d.hookStyle),
    vision,
  };
}

// Which media flags drop a source. A watermark (another creator's @id/logo burned into the image)
// always does. adLabel does not by default: almost every Coupang-affiliate source carries the
// "쿠팡 파트너스 … 수수료" disclosure in its text/comments, and the low-detail vision call reads that
// as an in-image ad label - in production (2026-10-01) it rejected about half of all candidates
// (25 of ~45 in 30 minutes, watermark=false every time) and starved publishing. Set
// AUTOPILOT_SKIP_AD_LABEL=1 to skip ad-labelled sources again.
function mediaFlagSkipReason(flags, env = process.env) {
  if (flags?.watermark) return '원본 미디어에 다른 계정 워터마크가 있음';
  if (flags?.adLabel && String(env.AUTOPILOT_SKIP_AD_LABEL || '') === '1') return '원본 미디어에 광고 표시가 있음';
  return null;
}

module.exports = {
  identifyCommerceTarget,
  analyzeMaterial,
  normalizeVisionResult,
  mediaFlagSkipReason,
  visionImageLimit,
  buildVideoVisionMedia,
};
