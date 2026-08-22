'use strict';

const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { collectBenchmarkMaterials, collectPostDetails, markUsedPost } = require('./benchmarkAccounts');

if (!global.__ME2_GEMINI_EMERGENCY_FALLBACK__) {
  global.__ME2_GEMINI_EMERGENCY_FALLBACK__ = true;

  const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

  function clean(v) { return String(v || '').replace(/\s+/g, ' ').trim(); }
  function isGeminiDown(e) {
    const msg = `${e?.message || ''} ${e?.response?.data?.error?.message || ''}`;
    return !!(e?.isGeminiRateLimit || e?.code === 'GEMINI_COOLDOWN' || /prepayment credits are depleted|quota exceeded|gemini cooldown|\b429\b/i.test(msg));
  }
  function extractCoupangLinks(v) {
    const text = Array.isArray(v) ? v.join('\n\n') : String(v || '');
    return [...new Set(text.match(/https?:\/\/(?:link\.)?coupang\.com\/[^\s<>'"\])}>,]+|https?:\/\/www\.coupang\.com\/vp\/products\/\d+[^\s<>'"\])}>,]*/gi) || [])]
      .map(x => x.replace(/[.,;:!?]+$/g, ''))
      .slice(0, 4);
  }
  function productIdFrom(v) {
    const s = String(v || '');
    return s.match(/\/vp\/products\/(\d+)/i)?.[1] || s.match(/[?&]productId=(\d+)/i)?.[1] || null;
  }
  function blockedTitle(v) {
    return !clean(v) || /access denied|forbidden|robot check|captcha|로그인이 필요|페이지를 찾을 수 없|403/i.test(clean(v));
  }
  function titleFromHtml(html) {
    const s = String(html || '');
    const m = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const t = clean(m?.[1] || '').replace(/\s*-\s*쿠팡!?\s*$/i, '');
    return blockedTitle(t) ? '' : t;
  }
  async function resolveCoupang(url) {
    try {
      const r = await axios.get(url, {
        maxRedirects: 10,
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko-KR,ko;q=0.9' },
        validateStatus: s => s >= 200 && s < 500,
        maxContentLength: 2 * 1024 * 1024,
      });
      const finalUrl = r?.request?.res?.responseUrl || r?.request?._redirectable?._currentUrl || url;
      const html = typeof r.data === 'string' ? r.data : '';
      const id = productIdFrom(finalUrl) || productIdFrom(html) || productIdFrom(url);
      if (!id) return null;
      return {
        productId: id,
        name: titleFromHtml(html) || '원문 추천 상품',
        image: null,
        price: null,
        url: `https://www.coupang.com/vp/products/${id}`,
        isRocket: false,
        isFreeShipping: false,
        rank: null,
        categoryName: null,
        emergencyFallback: true,
      };
    } catch {
      const id = productIdFrom(url);
      if (!id) return null;
      return { productId: id, name: '원문 추천 상품', image: null, price: null, url: `https://www.coupang.com/vp/products/${id}`, emergencyFallback: true };
    }
  }
  function isRecipe(text) {
    return /(레시피|재료|만드는 법|만들기|큰술|스푼|볶아|구워|끓여|졸여|에어프라이어|양념|소스)/i.test(String(text || ''));
  }
  function stripAffiliate(text) {
    return String(text || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/이 포스팅은 쿠팡 파트너스[\s\S]*?수수료를 제공받습니다\.?/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function productBody() {
    return [
      '이거 아이디어 괜찮다ㅋㅋ',
      '처음엔 뭐지 싶었는데',
      '쓰는 방식 보니까 바로 이해됨',
      '이런 건 은근 하나 있으면 편하겠네'
    ].join('\n');
  }
  function recipeBody() {
    return [
      '이 조합은 좀 신기하다ㅋㅋ',
      '만드는 과정은 생각보다 단순한데',
      '완성 비주얼이 확 눈에 들어옴',
      '재료랑 만드는 법은 댓글에 적어둘게'
    ].join('\n');
  }
  function productComment(name, sourceText) {
    const hint = clean(sourceText).slice(0, 90);
    return `✅ 핵심만\n- 원문에서 소개된 ${name || '상품'}\n- ${hint || '사용 방식이 직관적인 아이템'}`;
  }
  function recipeComment(authorReplies) {
    const raw = stripAffiliate(Array.isArray(authorReplies) ? authorReplies.join('\n\n') : authorReplies);
    if (/재료|만드는 법|조리|레시피/i.test(raw) && raw.length >= 30) return raw.slice(0, 1400);
    return '🥘 재료\n- 원문에 나온 기본 재료\n- 비밀 재료\n\n🍳 만드는 법\n1 원문 순서대로 재료를 준비해\n2 비밀 재료를 넣고 알맞게 익혀';
  }
  async function emergencyBuild(accountId) {
    const materials = await collectBenchmarkMaterials({ limit: 30 });
    for (const m of materials || []) {
      if (!m?.url || !m?.username) continue;
      try {
        const d = await collectPostDetails(m.url, m.username);
        const links = extractCoupangLinks(d?.authorReplies);
        if (!links.length) continue;
        let product = null;
        for (const link of links) {
          product = await resolveCoupang(link);
          if (product) break;
        }
        if (!product) continue;

        const sourceText = clean(d?.sourceText || m.text);
        const recipe = isRecipe(`${sourceText}\n${Array.isArray(d?.authorReplies) ? d.authorReplies.join('\n') : ''}`);
        const text = recipe ? recipeBody() : productBody();
        const commentLead = recipe ? recipeComment(d?.authorReplies) : productComment(product.name, sourceText);
        markUsedPost(m.url);
        console.warn(`[AutopilotV3][EMERGENCY FALLBACK] Gemini 불가 → AI 없이 발행소재 생성 @${m.username} productId=${product.productId} mode=${recipe ? 'recipe' : 'product'}`);
        return {
          text,
          commentLead,
          product,
          productSearchTerm: 'source-author-affiliate-link-emergency',
          mode: recipe ? 'recipe' : 'product',
          topic: product.name || '원문 추천 상품',
          secretTerm: '',
          sourceUrl: m.url,
          sourceUsername: m.username,
          sourceImages: Array.isArray(d?.images) ? d.images.filter(Boolean).slice(0, 10) : [],
          sourceVideos: Array.isArray(d?.videos) ? d.videos.filter(Boolean).slice(0, 5) : [],
          referenceImage: Array.isArray(d?.images) ? d.images.find(Boolean) || null : null,
          visionTarget: { kind: recipe ? 'recipe' : 'product', soldObject: product.name || '원문 추천 상품', dish: '', promotedIngredient: '', confidence: 100, searchTerms: [], evidence: 'emergency source affiliate fallback' },
          emergencyFallback: true,
        };
      } catch (err) {
        console.warn(`[AutopilotV3][EMERGENCY FALLBACK] 후보 실패 @${m?.username || '-'} reason="${err.message}"`);
      }
    }
    throw new Error('Gemini 비상모드에서도 원문 쿠팡 링크가 있는 발행 가능 소재를 찾지 못했습니다');
  }

  engine.buildThreadsFirstAutopilot = async function emergencyFallbackBuild(accountId, options) {
    try {
      return await originalBuild(accountId, options);
    } catch (e) {
      if (!isGeminiDown(e)) throw e;
      console.warn('[AutopilotV3][EMERGENCY FALLBACK] Gemini 429/크레딧 소진 감지 → 원문 쿠팡링크 기반 비상발행 전환');
      return emergencyBuild(accountId);
    }
  };

  console.log('[Autopilot][GEMINI EMERGENCY FALLBACK] Gemini 429/크레딧 소진 시 AI 없는 원문링크 기반 비상발행 활성화');
}
