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
  return `너는 Threads 쇼핑 소재의 실제 판매/추천 대상을 식별하는 검수자다. 본문과 작성자 댓글을 우선 보고, 이미지가 제공되면 보조 근거로만 사용한다. 화면에 보이는 주변 물건을 판매 대상으로 착각하지 않는다. 음식이면 완성요리와 실제 제휴 핵심재료/소스/조미료를 구분한다. 브랜드/모델은 근거가 있을 때만 쓴다. searchTerms는 쿠팡에서 실제 상품을 찾기 좋은 검색어 최대 2개다. 단순 주제어(예: 운동, 다이어트, 일상)만 쓰지 말고 실제 구매 가능한 물건/식품명이어야 한다. confidence는 반드시 0~100 사이 정수로 쓰고, 판매 대상이 본문·작성자 댓글·이미지 중 둘 이상의 근거로 명확하면 70 이상을 준다. JSON만 출력: {"kind":"product|food|recipe|lifestyle","soldObject":"","dish":"","promotedIngredient":"","searchTerms":[""],"confidence":0,"evidence":""}`;
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
  };
}

// REGRESSION (found live, 2026-09-13, right after the OpenAI->Claude migration): when
// getAiKey() has nothing to return, every call this function makes throws "Anthropic API
// 키가 설정되지 않았습니다" - but both catch blocks below swallow that into a generic warn log and
// (for the text fallback) a zero-confidence default object, not a rethrow. buildThreadsFirstAutopilot
// then reads that as "판매 대상 신뢰도 부족" (low match confidence) and skips to the next material -
// completely masking the real, fixable cause (missing API key) behind a misleading message for
// every single material, every single run, making the actual outage undiagnosable from the logs.
// Checking this once, up front, throws the real error before either catch block gets a chance to
// bury it - it still reaches buildThreadsFirstAutopilot's own try/catch same as before, just with
// the true message intact.
// NOTE: the guard below is placed AFTER the images/system/text prologue, which now also builds
// video-frame-extraction vision support (formerly a separate videoFrameVisionPatch.js that
// exact-string-marker-spliced this prologue at require time - folded directly in here since
// there's no longer a marker to preserve). Placement doesn't matter for correctness either way;
// it still checks the key before any real API call happens.
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

async function buildVideoVisionMedia(m) {
  const originals = (Array.isArray(m?.images) ? m.images : []).filter(Boolean);
  const videos = (Array.isArray(m?.videos) ? m.videos : []).filter(v => /^https?:\/\//i.test(String(v || '')));
  if (!videos.length) return { images: originals.slice(0, 3), frameCount: 0 };
  const wanted = originals.length ? 2 : 3;
  const frames = await extractVisionFrames(videos[0], wanted);
  if (!frames.length) return { images: originals.slice(0, 3), frameCount: 0 };
  const images = originals.length ? [originals[0], ...frames] : frames;
  console.log(
    '[AutopilotV3][VIDEO VISION MIX] originals=' +
      (originals.length ? 1 : 0) +
      ' frames=' +
      frames.length +
      ' total=' +
      Math.min(3, images.length)
  );
  return { images: images.slice(0, 3), frameCount: frames.length };
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

module.exports = { identifyCommerceTarget, analyzeMaterial };
