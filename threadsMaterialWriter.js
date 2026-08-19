const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function stripAffiliateNoise(value, { preserveLines = true } = {}) {
  let s = String(value || '');
  if (!s.trim()) return '';
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/\b(?:link\.coupang\.com|naver\.me|brandconnect\.naver\.com|m\.site\.naver\.com)\/\S*/gi, ' ');
  s = s.replace(/\[?광고\]?\s*/gi, ' ');
  s = s.replace(/(?:이\s*포스팅은|본\s*포스팅은)?\s*쿠팡\s*파트너스\s*활동의\s*일환으로\s*,?\s*이에\s*따른\s*일정액의\s*수수료를\s*(?:제공받습니다|받습니다)\.?/gi, ' ');
  s = s.replace(/(?:이\s*포스팅은|본\s*포스팅은)?\s*쿠팡\s*파트너스[^\n.!?]*(?:제공받습니다|받습니다|발생합니다)\.?/gi, ' ');
  s = s.replace(/네이버\s*쇼핑\s*커넥트[^\n.!?]*(?:제공받을\s*수\s*있습니다|받습니다)?\.?/gi, ' ');
  s = s.replace(/^\s*스레드\s*조회\s*[\d.,천만억]+회\s*/gim, '');
  s = s.replace(/^(?:인기순|최신순|전체)\s*/gim, '');
  s = s.replace(/(?:^|\s)@?[A-Za-z0-9._]{2,64}\s+(?:방금|\d+\s*(?:분|시간|일))\s*[·•]?\s*/g, ' ');
  s = s.replace(/\b(?:좋아요|답글|리포스트|공유)\b/g, ' ');
  if (preserveLines) {
    s = s.split(/\r?\n/).map(line => line.replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean).join('\n');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

function cleanThreadsReplyBlock(value) {
  let s = stripAffiliateNoise(value, { preserveLines: false });
  if (!s) return '';
  const authorMatches = [...s.matchAll(/\b작성자\b\s*/g)];
  if (authorMatches.length) {
    const last = authorMatches[authorMatches.length - 1];
    s = s.slice(last.index + last[0].length).trim();
  }
  s = s.replace(/\s(?:\d+\s+){2,5}(?=@?[A-Za-z0-9._]{2,64}\s+(?:방금|\d+\s*(?:분|시간|일)))/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function sanitizeAuthorReplies(authorReplies) {
  const raw = String(authorReplies || '').trim();
  if (!raw) return '';
  const blocks = raw.split(/\n\n+/).map(cleanThreadsReplyBlock).filter(Boolean);
  const unique = [];
  for (const block of blocks) {
    if (block.length < 6) continue;
    if (!unique.includes(block)) unique.push(block);
  }
  return unique.slice(0, 8).join('\n\n');
}

function sanitizeGeneratedComment(value) {
  let s = stripAffiliateNoise(value, { preserveLines: true });
  if (!s) return '';
  return s.replace(/\b(?:쿠파스|쿠팡)\s*링크\b\s*:?/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Threads 본문에서는 문장 끝 마침표를 쓰지 않는다
// 소수점(1.5), URL 등 내부 점은 건드리지 않고 줄/문장 종결의 점만 제거한다
function removeSentencePeriods(value) {
  return String(value || '')
    .split('\n')
    .map(line => line.replace(/\.(?=\s*$)/g, '').trimEnd())
    .join('\n');
}

function formatThreadsBody(value) {
  let s = removeSentencePeriods(stripAffiliateNoise(value, { preserveLines: true }).trim());
  if (!s) return '';

  const existingLines = s.split(/\n/).map(x => x.trim()).filter(Boolean);
  if (existingLines.length >= 3) {
    const out = [];
    for (let i = 0; i < existingLines.length; i++) {
      out.push(removeSentencePeriods(existingLines[i]));
      if (i % 2 === 1 && i < existingLines.length - 1) out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  const flat = s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map(x => removeSentencePeriods(x.trim())).filter(Boolean) || [flat];
  if (sentences.length <= 1) return removeSentencePeriods(flat);

  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    out.push(sentences[i]);
    if (i % 2 === 1 && i < sentences.length - 1) out.push('');
  }
  return removeSentencePeriods(out.join('\n').replace(/\n{3,}/g, '\n\n').trim());
}

function detectRecipe(sourceText, authorReplies, requestedMode) {
  if (requestedMode === 'recipe') return true;
  const t = `${String(sourceText || '')}\n${String(authorReplies || '')}`.toLowerCase();
  const food = /(레시피|재료|양념|소스|계란|두부|고기|삼겹|닭|버섯|밥|면|파스타|샌드위치|아보카도|채소|야채|국|찌개|볶음|구이|간식|요리)/.test(t);
  const action = /(만드는\s*법|만드는방법|볶|굽|끓|튀기|찜|삶|썰|섞|버무|에어프라이어|전자레인지|중약불|약불|강불|분\s*정도|큰술|작은술|\d+\s*(?:t|ml|g|개|스푼|큰술|작은술))/i.test(t);
  return food && action;
}

async function generateFromThreadsMaterial(accountId, { keyword, sourceText, authorReplies = '', mode = 'product' }) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('관리자 OpenAI API 키가 설정되어 있지 않습니다.');
  const cleanedSource = stripAffiliateNoise(sourceText, { preserveLines: true });
  const cleanedReplies = sanitizeAuthorReplies(authorReplies);
  const isRecipe = detectRecipe(cleanedSource, cleanedReplies, mode);

  const styleRules = `
한국 Threads에서 실제 사람이 바로 쓴 것처럼 작성한다
- 원글의 정보와 소재는 참고하지만 문장은 새로 쓴다
- 가장 중요한 목표는 상품 설명이 아니라 스크롤을 멈추게 하는 짧은 반응형 글이다
- 첫 1~2줄에서 궁금증, 의외성, 공감, 개인 반응 중 하나를 만든다
- 제품의 모든 장점을 설명하지 않는다
- 사진/영상만 봐도 알 수 있는 정보는 본문에서 반복 설명하지 않는다
- 한 게시물에서 강한 감탄이나 강한 평가는 최대 1회만 사용한다
- '신기해 → 소름 → 무조건 사야 해 → 편해 → 최고'처럼 칭찬을 연속으로 붙이지 않는다
- 구매 권유를 기본적으로 하지 않는다
- '무조건 사야 해', '꼭 사', '강추', '필수템', '인생템', '추천해', '쟁여둬' 같은 표현은 쓰지 않는다
- 마지막에 제품을 다시 칭찬하는 총평을 억지로 붙이지 않는다
- 설명문, 리뷰문, 블로그 문체, AI식 감상문을 쓰지 않는다
- 자연스러운 반말을 사용하고 음슴체(~함/~임/~됨)는 쓰지 않는다
- 문장 끝에 마침표(.)를 절대 붙이지 않는다
- 물음표, 느낌표, ㅋㅋ, ㄷㄷ 등은 문맥상 자연스러울 때만 쓴다
- 본문은 2~6줄을 기본으로 하고 길이를 억지로 채우지 않는다
- 한 줄에는 가급적 한 문장만 둔다
- 짧은 문장 1~2개 뒤에는 자연스럽게 빈 줄을 넣을 수 있다
- 원문에 없는 경험, 효능, 수치, 제품 성능을 사실처럼 만들지 않는다
- 입력 자료의 광고 고지, 쿠팡/네이버 링크, 작성자 UI 정보는 절대 출력하지 않는다
- text와 comment 어디에도 URL을 출력하지 않는다
- 5개 버전은 첫 문장과 전개를 확실히 다르게 한다
- 상황형, 발견형, 공감형, 의문형, 짧은 반응형을 섞고 모든 글을 같은 공식으로 만들지 않는다
`;

  const system = isRecipe
    ? `${styleRules}
레시피/음식 소재다
[본문]
- 2~6줄 정도의 짧은 Threads 후킹글만 쓴다
- 레시피 전체를 본문에 나열하지 않는다
- 음식 이름과 장점을 설명하기보다 첫 반응이나 비교, 궁금증을 앞세운다
- '맛있다/대박/최고/무조건' 같은 평가를 연속으로 쓰지 않는다
- 사진이 맛과 비주얼을 보여주면 본문은 그 설명을 반복하지 않는다
- 마지막에 '꼭 만들어봐/추천해' 같은 권유를 붙이지 않는다
[댓글 - 형식 강제]
댓글은 반드시 아래 순서를 지킨다
🥘 재료
- 재료를 한 줄에 하나씩 작성
- 원문/작성자댓글에 실제 있는 재료와 계량을 우선 사용

🍳 만드는 법
1. 한 단계씩 줄바꿈
2. 실제로 따라갈 수 있게 순서대로 정리
3. 원문/작성자댓글에 있는 시간/온도/양은 정확히 유지
필요한 경우 마지막에 짧은 팁 1개만 추가할 수 있다
- 광고 문구, 제휴 고지, URL, 쿠팡 링크는 절대 쓰지 않는다
- 모든 재료를 한 줄에 몰아쓰지 않는다
- 만드는 법도 한 문장에 번호 여러 개를 몰아쓰지 않는다
- 댓글은 반드시 실제 줄바꿈을 사용한다
- 원문에 없는 재료를 임의 추가하지 않는다
반드시 JSON만 출력: {"items":[{"text":"본문","comment":"댓글"}, ...]} 정확히 5개`
    : `${styleRules}
생활/제품 소재다
[본문]
- 제품 설명 목록이 아니라 상황/발견/불편/반응 중심의 짧은 Threads 글로 쓴다
- 핵심 특징은 최대 1개만 본문에 자연스럽게 사용하고 나머지는 사진/영상과 댓글에 맡긴다
- 제품명을 첫 줄부터 설명하듯 시작하지 않는다
- 본문에는 '✅ 핵심만', 상품 스펙 목록, 링크, 광고고지를 넣지 않는다
- 확인되지 않은 '내가 샀다/써봤다/사용해봤다' 같은 경험을 만들지 않는다
- 구매 권유 대신 '이걸 왜 이제 봤지', '이 생각을 어떻게 했지'처럼 자연스러운 개인 반응으로 끝낼 수 있다
[댓글 - 형식 강제]
댓글은 반드시 아래 형식으로만 작성한다
✅ 핵심만
- 원문에서 확인되는 핵심 포인트 1
- 원문에서 확인되는 핵심 포인트 2
- 필요하면 핵심 포인트 3
- 링크와 광고고지는 쓰지 않는다. 시스템이 이 댓글 아래에 같은 쿠파스 링크 2개와 고지문을 붙인다
- 링크 자리표시자도 쓰지 않는다
- 핵심 포인트를 한 줄에 몰아쓰지 않는다
- 반드시 실제 줄바꿈을 사용한다
반드시 JSON만 출력: {"items":[{"text":"본문","comment":"댓글"}, ...]} 정확히 5개`;

  const user = `키워드: ${String(keyword || '').trim()}

[원 게시물 - 정제된 사실 자료 A]
${cleanedSource.slice(0, 5000)}

[같은 작성자의 추가 설명/댓글 - 정제된 사실 자료 B]
${cleanedReplies.slice(0, 5000) || '(추가 설명 없음)'}

A/B의 광고 고지와 외부 링크는 이미 제거되어 있다
출력에서 광고문구나 링크를 복원하거나 추측하지 말 것
A와 B에 있는 사실만 사용하고 문장은 새로 작성할 것
특히 text 본문은 한 문단으로 붙이지 말고 실제 줄바꿈을 넣을 것
본문 문장 끝에는 마침표(.)를 절대 붙이지 말 것`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: isRecipe ? 0.32 : 0.82,
    max_tokens: isRecipe ? 4200 : 3000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(x => ({ text: formatThreadsBody(x?.text || ''), comment: sanitizeGeneratedComment(x?.comment) })).filter(x => x.text).slice(0, 5)
    : [];
  if (!items.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');

  const fallbackSource = String(cleanedReplies || cleanedSource || '').trim();
  for (const item of items) {
    if (!item.comment) {
      item.comment = isRecipe
        ? `🥘 재료\n- 원문에 확인되는 재료 정보가 부족합니다\n\n🍳 만드는 법\n1. 원문에서 확인되는 조리 과정만 참고해주세요`
        : `✅ 핵심만\n- ${fallbackSource ? fallbackSource.slice(0, 180) : '원문에서 확인되는 핵심 정보를 참고해주세요'}`;
    }
    item.comment = sanitizeGeneratedComment(item.comment);
    item.text = formatThreadsBody(item.text);
  }

  return { mode: isRecipe ? 'recipe' : 'product', items, texts: items.map(x => x.text), comments: items.map(x => x.comment) };
}

module.exports = { generateFromThreadsMaterial };
