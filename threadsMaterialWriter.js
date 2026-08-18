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
  let s = String(value || '');
  s = s.replace(/\\n/g, '\n');
  s = stripAffiliateNoise(s, { preserveLines: true });
  if (!s) return '';
  s = s.replace(/\b(?:쿠파스|쿠팡)\s*링크\b\s*:?/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// 모델이 줄바꿈 지시를 무시하고 한 문단으로 반환해도 최종 출력에서 Threads용 호흡을 강제한다.
function formatThreadsBody(value) {
  let s = String(value || '');
  s = s.replace(/\\n/g, '\n');
  s = stripAffiliateNoise(s, { preserveLines: true }).trim();
  if (!s) return '';

  // 이미 충분히 줄바꿈되어 있으면 문단 공백만 정리한다.
  const existingLines = s.split(/\n/).map(x => x.trim()).filter(Boolean);
  if (existingLines.length >= 4) {
    const out = [];
    for (let i = 0; i < existingLines.length; i++) {
      out.push(existingLines[i]);
      if (i % 2 === 1 && i < existingLines.length - 1) out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 한 덩어리로 온 경우 문장 종결부를 기준으로 잘라 1~2문장마다 빈 줄을 넣는다.
  const flat = s.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map(x => x.trim()).filter(Boolean) || [flat];
  if (sentences.length <= 1) return flat;

  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    out.push(sentences[i]);
    if (i % 2 === 1 && i < sentences.length - 1) out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
한국 Threads에서 실제 사람이 바로 쓴 것처럼 작성한다.
- 원글의 정보와 소재는 참고하지만 문장은 새로 쓴다.
- 설명문, 리뷰문, 블로그 문체, AI식 감상문을 쓰지 않는다.
- 한 문장을 길게 이어 쓰지 않는다.
- 본문은 반드시 실제 줄바꿈 문자를 사용한다.
- 한 줄에는 가급적 한 문장만 둔다.
- 1~2개의 짧은 문장 뒤에는 반드시 빈 줄을 한 번 넣는다.
- 전체 본문은 보통 4~8줄, 2~4문단으로 끝낸다.
- 자연스러운 반말을 사용하고 음슴체(~함/~임/~됨)는 쓰지 않는다.
- 원문에 없는 경험, 효능, 수치, 제품 성능을 사실처럼 만들지 않는다.
- 입력 자료에 있던 광고 고지, 쿠팡/네이버 링크, 작성자 UI 정보는 절대 출력하지 않는다.
- text와 comment 어디에도 URL을 출력하지 않는다. 링크/광고고지는 발행 시스템이 별도로 붙인다.
- 5개 버전은 첫 문장과 전개를 다르게 한다.
`;

  const system = isRecipe
    ? `${styleRules}
레시피/음식 소재다.
[본문]
- 3~7줄 정도의 짧은 Threads 후킹글만 쓴다.
- 레시피 전체를 본문에 나열하지 않는다.
- 음식의 핵심 장면/반응을 앞세운다.
- 마지막은 재료와 만드는 법을 댓글에서 볼 수 있다는 흐름이면 좋다.
[댓글 - 형식 강제]
댓글은 반드시 아래 순서를 지킨다.
🥘 재료
- 재료를 한 줄에 하나씩 작성
- 원문/작성자댓글에 실제 있는 재료와 계량을 우선 사용

🍳 만드는 법
1. 한 단계씩 줄바꿈
2. 실제로 따라갈 수 있게 순서대로 정리
3. 원문/작성자댓글에 있는 시간/온도/양은 정확히 유지
필요한 경우 마지막에 짧은 팁 1개만 추가할 수 있다.
- 광고 문구, 제휴 고지, URL, 쿠팡 링크는 절대 쓰지 않는다.
- 모든 재료를 한 줄에 몰아쓰지 않는다.
- 만드는 법도 한 문장에 번호 여러 개를 몰아쓰지 않는다.
- 댓글은 반드시 실제 줄바꿈을 사용한다.
- 원문에 없는 재료를 임의 추가하지 않는다.
반드시 JSON만 출력: {"items":[{"text":"본문","comment":"댓글"}, ...]} 정확히 5개.`
    : `${styleRules}
생활/제품 소재다.
[본문]
- 제품 설명 목록이 아니라 상황/발견/불편 중심의 짧은 Threads 글로 쓴다.
- 본문에는 '✅ 핵심만', 상품 스펙 목록, 링크, 광고고지를 넣지 않는다.
- 확인되지 않은 '내가 샀다/써봤다/사용해봤다' 같은 경험을 만들지 않는다.
[댓글 - 형식 강제]
댓글은 반드시 아래 형식으로만 작성한다.
✅ 핵심만
- 원문에서 확인되는 핵심 포인트 1
- 원문에서 확인되는 핵심 포인트 2
- 필요하면 핵심 포인트 3
- 링크와 광고고지는 쓰지 않는다. 시스템이 이 댓글 아래에 같은 쿠파스 링크 2개와 고지문을 붙인다.
- 링크 자리표시자도 쓰지 않는다.
- 핵심 포인트를 한 줄에 몰아쓰지 않는다.
- 반드시 실제 줄바꿈을 사용한다.
반드시 JSON만 출력: {"items":[{"text":"본문","comment":"댓글"}, ...]} 정확히 5개.`;

  const user = `키워드: ${String(keyword || '').trim()}

[원 게시물 - 정제된 사실 자료 A]
${cleanedSource.slice(0, 5000)}

[같은 작성자의 추가 설명/댓글 - 정제된 사실 자료 B]
${cleanedReplies.slice(0, 5000) || '(추가 설명 없음)'}

A/B의 광고 고지와 외부 링크는 이미 제거되어 있다. 따라서 출력에서 광고문구나 링크를 복원하거나 추측하지 말 것.
A와 B에 있는 사실만 사용하고, 문장은 새로 작성할 것.
특히 text 본문은 한 문단으로 붙이지 말고 실제 줄바꿈을 넣어 작성할 것.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: isRecipe ? 0.22 : 0.72,
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
        ? `🥘 재료\n- 원문에 확인되는 재료 정보가 부족합니다.\n\n🍳 만드는 법\n1. 원문에서 확인되는 조리 과정만 참고해주세요.`
        : `✅ 핵심만\n- ${fallbackSource ? fallbackSource.slice(0, 180) : '원문에서 확인되는 핵심 정보를 참고해주세요.'}`;
    }
    item.comment = sanitizeGeneratedComment(item.comment);
    item.text = formatThreadsBody(item.text);
  }

  return { mode: isRecipe ? 'recipe' : 'product', items, texts: items.map(x => x.text), comments: items.map(x => x.comment) };
}

module.exports = { generateFromThreadsMaterial };
