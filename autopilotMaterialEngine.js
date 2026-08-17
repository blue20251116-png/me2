const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const { collectBenchmarkMaterials, collectPostDetails, markUsedPost } = require('./benchmarkAccounts');
const coupangApi = require('./coupangApi');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function callOpenAI(accountId, system, user, { maxTokens = 1800, temperature = 0.55 } = {}) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', temperature, max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });
  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 결과가 비어 있습니다');
  return JSON.parse(raw);
}

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalized(value) { return clean(value).toLowerCase().replace(/[\s\-_/()[\]{}.,!?~'"“”‘’]/g, ''); }
function hasExternalLink(text) { return /(?:https?:\/\/|www\.)\S+/i.test(String(text || '')) || /\b(?:link\.coupang\.com|naver\.me)\b/i.test(String(text || '')); }

function materialScore(item) {
  const text = clean(item?.text); let score = 0;
  if (item?.hasVideo || Number(item?.videoCount || 0) > 0) score += 3;
  if (Number(item?.imageCount || 0) > 0 || (Array.isArray(item?.images) && item.images.length)) score += 2;
  if (text.length >= 40 && text.length <= 1000) score += 4; else if (text.length >= 20) score += 2;
  if (/(레시피|소스|양념|재료|만드는|볶|굽|끓|에어프라이어|큰술|스푼|\bT\b)/i.test(text)) score += 5;
  if (/(비밀|핵심|이거|댓글|진짜|ㅋㅋ|꿀템|사버|추천)/i.test(text)) score += 2;
  if (hasExternalLink(text)) score -= 30;
  return score + Math.random();
}

async function pickThreadsMaterial() {
  const materials = await collectBenchmarkMaterials({ limit: 12 });
  const usable = (materials || []).filter(x => x?.url && clean(x.text).length >= 12 && !hasExternalLink(x.text));
  if (!usable.length) throw new Error('Threads에서 사용할 소재를 찾지 못했습니다');
  usable.sort((a, b) => materialScore(b) - materialScore(a));
  return usable[0];
}

async function enrichThreadsMaterial(item) {
  let sourceText = clean(item?.text), authorReplies = '';
  let images = Array.isArray(item?.images) ? item.images.filter(Boolean) : [], videos = [];
  if (item?.url && item?.username) {
    try {
      const d = await collectPostDetails(item.url, item.username);
      if (clean(d?.sourceText).length >= 8) sourceText = clean(d.sourceText);
      authorReplies = Array.isArray(d?.authorReplies) ? d.authorReplies.filter(Boolean).join('\n\n') : '';
      if (Array.isArray(d?.images) && d.images.length) images = d.images.filter(Boolean);
      if (Array.isArray(d?.videos)) videos = d.videos.filter(Boolean);
    } catch (err) { console.log(`[AutopilotV3][Threads detail] 상세 수집 실패, 목록 소재 사용: ${err.message}`); }
  }
  return { ...item, sourceText, authorReplies, images, videos };
}

function grounded(term, evidence) {
  const t = normalized(term), e = normalized(evidence);
  if (!t || !e) return false;
  if (e.includes(t)) return true;
  const tokens = clean(term).split(/\s+/).map(normalized).filter(x => x.length >= 2);
  return tokens.length > 0 && tokens.every(token => e.includes(token));
}

async function analyzeMaterial(accountId, material, target) {
  const evidence = `${material.sourceText}\n${material.authorReplies}`;
  const data = await callOpenAI(accountId,
    `너는 한국 Threads 소재를 쿠팡파트너스 상품과 연결하는 편집자다. 가장 중요한 원칙은 Threads 소재가 먼저다. 쿠팡 상품에 맞춰 소재를 바꾸면 안 된다.
원 게시물과 같은 작성자의 추가댓글을 사실 자료로 읽고 mode(recipe/product/lifestyle), topic, secretTerm, searchTerms, facts, hookStyle을 판단한다.
searchTerms는 원문 또는 작성자댓글에 실제 근거가 있는 상품/재료/소스/도구만 허용한다. 레시피에서 비밀 소스나 핵심 재료가 있으면 그것을 최우선 상품으로 잡는다. 구매 연결할 구체적 항목이 없으면 빈 배열로 둔다.
JSON만 출력: {"mode":"recipe|product|lifestyle","topic":"","secretTerm":"","hideInBody":true,"searchTerms":["",""],"facts":[""],"hookStyle":""}`,
    `타겟: ${target || '전체'}\n\n[원 게시물]\n${material.sourceText.slice(0,5000)}\n\n[작성자 추가댓글]\n${material.authorReplies.slice(0,5000) || '(없음)'}`,
    { maxTokens: 1000, temperature: 0.12 });
  const terms = [...new Set((Array.isArray(data.searchTerms) ? data.searchTerms : []).map(clean).filter(Boolean))].filter(term => grounded(term, evidence)).slice(0,3);
  const secret = clean(data.secretTerm);
  return { mode: ['recipe','product','lifestyle'].includes(data.mode) ? data.mode : 'lifestyle', topic: clean(data.topic)||'Threads 소재', secretTerm: secret && grounded(secret,evidence) ? secret : '', hideInBody: data.mode === 'recipe' ? true : data.hideInBody !== false, searchTerms: terms, facts: Array.isArray(data.facts) ? data.facts.map(clean).filter(Boolean).slice(0,10) : [], hookStyle: clean(data.hookStyle) };
}

async function findProduct(accountId, terms) {
  for (const term of (terms || []).slice(0,3)) {
    const products = await coupangApi.searchProducts(accountId, term, 8);
    if (!products.length) continue;
    const tokens = clean(term).split(/\s+/).map(normalized).filter(x => x.length >= 2);
    const exactish = products.find(p => { const n=normalized(p.name); return tokens.length>0 && tokens.every(t=>n.includes(t)); });
    return { product: exactish || products[0], searchTerm: term };
  }
  return { product:null, searchTerm:null };
}

function scrubSecret(text, secretTerm, productName) {
  let out=String(text||'').trim();
  for (const value of [secretTerm,productName]) { const term=clean(value); if(term.length>=2) out=out.split(term).join('비밀 재료'); }
  return out;
}

async function generatePost(accountId, { material, analysis, product, target }) {
  const productName=clean(product?.name);
  const data=await callOpenAI(accountId,
    `너는 한국 Threads 글 편집자다. 반드시 제공된 Threads 소재를 중심으로 새 글을 쓴다. 쿠팡 상품을 먼저 홍보하는 광고글로 바꾸면 안 된다.
공통: 원문 문장 복사 금지, 원문/작성자댓글에 없는 경험·효능·수치·재료·조리시간 창작 금지, 자연스러운 반말과 짧은 줄, 음슴체 금지.
레시피: 원문의 레시피 정보에 근거하고 secretTerm/쿠팡상품 정체는 본문에서 밝히지 않는다. 댓글을 봐야 핵심 재료를 알 수 있게 한다. 레시피 본문에는 링크·광고고지를 넣지 않는다.
제품/생활: 반드시 아래 고정 포맷으로 text를 만든다. 광고고지문은 시스템이 맨 위에 붙이므로 네가 쓰지 않는다. 링크 자리에는 정확히 {{COUPANG_LINK}} 문자열만 넣는다. 이 링크 자리는 반드시 '✅ 핵심만' 바로 위에 와야 한다.

[일반상품 고정 포맷]
후킹 한두 줄

{{COUPANG_LINK}}

✅ 핵심만
- 원문에서 확인되는 핵심 포인트
- 원문에서 확인되는 핵심 포인트
- 필요하면 세 번째 포인트

짧은 마무리 한 줄

중요:
- {{COUPANG_LINK}}보다 위에는 후킹만 둔다.
- {{COUPANG_LINK}} 바로 아래에 '✅ 핵심만'이 와야 한다.
- 상품명/스펙/효능을 원문 근거 없이 만들지 않는다.
- '내가 본 건', '내가 산 건', '써봤는데', '사용해보니', '직접 써보니까' 등 확인되지 않은 개인 경험 표현은 절대 금지한다.
- 제품/생활은 commentLead를 빈 문자열로 출력한다.
레시피만 commentLead를 짧게 생성한다.
JSON만 출력: {"text":"본문","commentLead":""}`,
    `타겟: ${target||'전체'}\n모드: ${analysis.mode}\n주제: ${analysis.topic}\n숨길 핵심어: ${analysis.secretTerm||'(없음)'}\n쿠팡 연결 상품: ${productName||'(없음)'}\n\n[Threads 원문]\n${material.sourceText.slice(0,5000)}\n\n[작성자 추가댓글]\n${material.authorReplies.slice(0,5000)||'(없음)'}`,
    { maxTokens:1800, temperature:0.65 });
  let text=String(data.text||'').trim();
  if(!text) throw new Error('Threads 소재 기반 본문 생성 결과가 비었습니다');
  if(analysis.mode==='recipe' && analysis.hideInBody) text=scrubSecret(text,analysis.secretTerm,productName);
  if(analysis.mode!=='recipe' && !text.includes('{{COUPANG_LINK}}')) {
    const marker='✅ 핵심만';
    text=text.includes(marker) ? text.replace(marker, `{{COUPANG_LINK}}\n\n${marker}`) : `${text}\n\n{{COUPANG_LINK}}\n\n✅ 핵심만`;
  }
  let commentLead='';
  if(analysis.mode==='recipe') commentLead=String(data.commentLead||'').trim() || `본문에서 말한 비밀 재료는 이거야 👇\n${productName}`;
  return { text, commentLead };
}

async function buildThreadsFirstAutopilot(accountId,{target}) {
  const picked=await pickThreadsMaterial();
  const material=await enrichThreadsMaterial(picked);
  const analysis=await analyzeMaterial(accountId,material,target);
  if(!analysis.searchTerms.length){ markUsedPost(material.url); throw new Error(`Threads 소재 "${analysis.topic}"에서 쿠팡으로 연결할 구체적 상품을 찾지 못했습니다`); }
  const found=await findProduct(accountId,analysis.searchTerms);
  if(!found.product){ markUsedPost(material.url); throw new Error(`Threads 소재 기반 쿠팡 상품을 찾지 못했습니다: ${analysis.searchTerms.join(', ')}`); }
  const generated=await generatePost(accountId,{material,analysis,product:found.product,target});
  markUsedPost(material.url);
  return { text:generated.text, commentLead:generated.commentLead, product:found.product, productSearchTerm:found.searchTerm, mode:analysis.mode, topic:analysis.topic, secretTerm:analysis.secretTerm, sourceUrl:material.url, sourceUsername:material.username||null, referenceImage:material.images?.[0]||null };
}

module.exports={buildThreadsFirstAutopilot};
