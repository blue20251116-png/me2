const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');
const { searchThreadsMaterials } = require('./threadsMaterialSearch');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function callOpenAI(accountId, system, user, { maxTokens = 1200, temperature = 0.8 } = {}) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다');
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 35000,
  });
  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 결과가 비어 있습니다');
  return JSON.parse(raw);
}

function cleanProductName(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:로켓배송|로켓프레시|무료배송|쿠팡추천|정품)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function buildThreadsQueries(accountId, productName, target) {
  const cleaned = cleanProductName(productName);
  try {
    const data = await callOpenAI(
      accountId,
      `너는 한국 Threads 소재 검색어 생성기다. 상품명을 보고 사람들이 실제로 Threads에서 쓸 법한 짧은 검색어를 만든다.
규칙:
- 브랜드/긴 옵션명은 제거하고 상품의 핵심 명사와 사용 상황 중심으로 만든다.
- 검색어는 2~12자 정도의 자연스러운 한국어를 우선한다.
- 상품명 그대로 1개, 생활상황/불편 1개, 발견형/꿀템형 1개를 만든다.
- 서로 너무 비슷한 검색어는 금지한다.
- JSON만 출력: {"queries":["검색어1","검색어2","검색어3"]}`,
      `상품명: ${cleaned}\n타겟: ${target || '전체'}`,
      { maxTokens: 250, temperature: 0.35 }
    );
    const queries = Array.isArray(data.queries) ? data.queries.map(x => String(x || '').trim()).filter(Boolean) : [];
    const unique = [...new Set([cleaned, ...queries])].filter(Boolean);
    return unique.slice(0, 3);
  } catch (err) {
    console.log(`[AutopilotV2][Query] AI 검색어 생성 실패: ${err.message}`);
    return cleaned ? [cleaned] : [];
  }
}

function scoreMaterial(item, productName) {
  const text = String(item?.text || '');
  let score = 0;
  if (item?.hasVideo) score += 4;
  if (Number(item?.imageCount || 0) > 0) score += 3;
  if (text.length >= 35 && text.length <= 350) score += 4;
  else if (text.length >= 20) score += 2;
  const tokens = cleanProductName(productName).split(/\s+/).filter(x => x.length >= 2).slice(0, 5);
  for (const token of tokens) if (text.includes(token)) score += 2;
  if (/ㅋㅋ|ㅠㅠ|;;|ㄷㄷ|진짜|이거|왜 이제|사버|탐난|개꿀|미쳤/i.test(text)) score += 1;
  if (/http|쿠팡파트너스|제휴|광고/i.test(text)) score -= 5;
  return score;
}

async function collectThreadsReferences(accountId, productName, target) {
  const queries = await buildThreadsQueries(accountId, productName, target);
  const all = [];
  const seen = new Set();
  const attempted = [];

  for (const query of queries.slice(0, 2)) {
    try {
      attempted.push(query);
      const result = await searchThreadsMaterials(query, { limit: 8, mode: 'product' });
      for (const item of result.items || []) {
        if (!item?.url || seen.has(item.url)) continue;
        seen.add(item.url);
        all.push({ ...item, searchKeyword: query, score: scoreMaterial(item, productName) });
      }
      if (all.length >= 8) break;
    } catch (err) {
      console.log(`[AutopilotV2][Threads] 검색 실패 query="${query}": ${err.message}`);
    }
  }

  all.sort((a, b) => b.score - a.score);
  return { queries, attempted, items: all.slice(0, 5) };
}

function buildReferenceText(materials) {
  if (!materials?.length) return '(Threads 참고 소재 없음)';
  return materials.map((m, i) => {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 700);
    return `[참고 ${i + 1}] 검색어=${m.searchKeyword}\n${text}\nURL=${m.url}`;
  }).join('\n\n');
}

async function generateProductPost(accountId, { product, target, materials = [], youtubeSource = null }) {
  const productName = cleanProductName(product?.name);
  const price = product?.price ? `${product.price}원` : '가격 정보 없음';
  const references = buildReferenceText(materials);
  const youtubeInfo = youtubeSource
    ? `YouTube 보조 소재: ${String(youtubeSource.title || youtubeSource.url || '').slice(0, 500)}`
    : 'YouTube 보조 소재 없음';

  const data = await callOpenAI(
    accountId,
    `너는 한국 Threads 쇼핑 콘텐츠 에디터다. 목표는 광고문이 아니라 실제 사람이 피드에 툭 올린 것 같은 짧은 글이다.

핵심 원칙:
- Threads 참고글은 소재의 결, 후킹 방식, 문장 호흡, 상황 설정만 참고한다.
- 참고글의 문장이나 고유한 표현을 그대로 복사하지 않는다.
- 참고글에 등장한 다른 제품의 사실/효능/가격/사용경험을 현재 상품에 옮겨 붙이지 않는다.
- 현재 상품에 대해 확인 가능한 사실은 제공된 상품명과 가격뿐이다. 그 외 성능, 효과, 수치, 재질, 인증, 후기, 사용 경험은 만들어내지 않는다.
- 실제로 구매/사용했다는 거짓 경험을 단정하지 않는다. '사봤는데', '써보니', '내가 샀다' 같은 표현은 상품 정보에 근거가 없으면 금지한다.
- 대신 '이런 거 찾는 사람', '이거 보고 눈길 갔다', '이런 방식이면 편하겠다'처럼 자연스러운 발견형 문장을 쓴다.
- 제품명을 첫 줄부터 광고처럼 박지 않는다. 상황/불편/반응을 먼저 두고 뒤에서 자연스럽게 드러낸다.
- 존댓말보다 자연스러운 반말을 쓴다. 음슴체(~함/~임/~됨)는 금지한다.
- 해시태그, 링크, 광고 고지문, '구매하세요', '추천드립니다' 같은 문구는 본문에 넣지 않는다.
- ㅋㅋ, ;;, ... 같은 표현은 과하지 않게 한 번 정도만 쓸 수 있다.
- 한 줄을 길게 쓰지 말고 4~8줄, 2~4문단 정도로 만든다.
- 5개 버전은 서로 다른 각도여야 한다: 공감형 / 발견형 / 문제해결형 / 짧은반응형 / 생활상황형.
- 본문 길이는 대체로 70~230자 사이로 만든다.

반드시 JSON만 출력한다.
형식: {"items":[{"text":"...","angle":"공감형"}, ...]} 정확히 5개.` ,
    `현재 상품명: ${productName}\n현재 가격: ${price}\n타겟: ${target || '전체'}\n\n${youtubeInfo}\n\n[Threads 참고 소재]\n${references}`,
    { maxTokens: 1800, temperature: 0.9 }
  );

  const items = Array.isArray(data.items)
    ? data.items.map(x => ({ text: String(x?.text || '').trim(), angle: String(x?.angle || '').trim() })).filter(x => x.text)
    : [];
  if (!items.length) throw new Error('완전자동 글 생성 결과가 비어 있습니다');
  const picked = items[Math.floor(Math.random() * items.length)];
  return { text: picked.text, angle: picked.angle || '자동', variants: items };
}

async function buildAutopilotMaterialPost(accountId, { product, target, youtubeSource = null }) {
  const refs = await collectThreadsReferences(accountId, product?.name, target);
  const generated = await generateProductPost(accountId, { product, target, materials: refs.items, youtubeSource });
  const best = refs.items[0] || null;
  return {
    text: generated.text,
    angle: generated.angle,
    referenceCount: refs.items.length,
    sourceUrl: best?.url || null,
    sourceKeyword: best?.searchKeyword || refs.attempted[0] || null,
    searchQueries: refs.queries,
    usedThreadsMaterial: refs.items.length > 0,
  };
}

module.exports = { buildAutopilotMaterialPost, buildThreadsQueries, collectThreadsReferences };
