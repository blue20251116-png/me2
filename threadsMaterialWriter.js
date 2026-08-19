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

function cleanBodyPunctuation(value) {
  return String(value || '')
    .replace(/,/g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^\d])\.(?=\s|$)/g, '$1').trim())
    .join('\n');
}

function stripRecipeLanguageFromProductBody(value) {
  const banned = /(재료(?:랑|와|하고)?\s*(?:만드는\s*법|만드는법)|만드는\s*법|만드는법|레시피|요리법|조리법)/i;
  let lines = String(value || '').split('\n').map(x => x.trim()).filter(Boolean);
  lines = lines.filter(line => !banned.test(line));
  return lines.join('\n').trim();
}

function formatThreadsBody(value, { isRecipe = false } = {}) {
  let s = cleanBodyPunctuation(stripAffiliateNoise(value, { preserveLines: true }).trim());
  if (!s) return '';
  if (!isRecipe) s = stripRecipeLanguageFromProductBody(s);

  let lines = s.split(/\n/).map(x => x.trim()).filter(Boolean);
  const merged = [];
  for (const line of lines) {
    if (/^(?:ㅋ{1,4}|ㅎ{1,4}|ㄷㄷ|ㅠ{1,3}|ㅜ{1,3})[!?]*$/.test(line) && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}${line}`;
    } else {
      merged.push(line);
    }
  }
  lines = merged.slice(0, 4);
  return cleanBodyPunctuation(lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim();
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
한국 Threads에서 실제 사람이 영상이나 사진을 보고 툭 던진 것처럼 작성한다
- 원글의 사실과 소재만 참고하고 문장은 새로 쓴다
- 한 게시물에는 하나의 생각만 담는다
- 본문은 기본 2~4줄이다
- 4줄을 넘기지 않는다
- 내용을 채우기 위해 장점이나 감상을 추가하지 않는다
- 상품 설명문이나 리뷰가 아니라 짧은 반응글이어야 한다
- 첫 줄에서 궁금증 의외성 공감 개인 반응 중 하나를 만든다
- 첫 줄 질문 → 단독 ㅋㅋ → 기능 설명 → 장점 → 총평 같은 정형화된 구조를 절대 쓰지 않는다
- ㅋㅋ ㅎㅎ ㄷㄷ 등을 혼자 한 줄에 쓰지 않는다
- ㅋㅋ가 필요하면 앞 문장 끝에 자연스럽게 붙인다
- 제품 특징은 최대 1개만 언급한다
- 사진이나 영상으로 이미 보이는 내용을 여러 문장으로 다시 설명하지 않는다
- 기능 하나를 말한 뒤 편하다 깔끔하다 좋다 추천한다 같은 장점을 연달아 덧붙이지 않는다
- 강한 감탄이나 평가는 한 게시물에서 최대 1회만 쓴다
- 마지막에 억지 총평을 붙이지 않는다
- 구매 권유를 하지 않는다
- 확인되지 않은 개인 경험을 만들지 않는다
- 자연스러운 반말을 사용하고 음슴체는 쓰지 않는다
- 본문에는 마침표와 쉼표를 쓰지 않는다
- 문장을 나눌 때는 줄바꿈을 사용한다
- 입력 자료의 광고 고지 링크 작성자 UI 정보는 출력하지 않는다
- text와 comment 어디에도 URL을 출력하지 않는다
`;

  const system = isRecipe
    ? `${styleRules}\n레시피/음식 소재다\n[본문]\n- 2~4줄의 짧은 Threads 반응글만 쓴다\n- 레시피 전체를 본문에 나열하지 않는다\n[댓글 - 형식 강제]\n🥘 재료\n- 재료를 한 줄에 하나씩 작성\n\n🍳 만드는 법\n1. 한 단계씩 줄바꿈\n2. 실제로 따라갈 수 있게 순서대로 정리\n- 원문에 없는 재료를 임의 추가하지 않는다\n반드시 JSON만 출력: {\"items\":[{\"text\":\"본문\",\"comment\":\"댓글\"}, ...]} 정확히 5개`
    : `${styleRules}\n생활/제품 일반소재다\n[본문]\n- 2~4줄만 쓴다\n- 하나의 불편 발견 의외성 반응 중 하나만 선택한다\n- 제품 특징은 최대 1개만 쓴다\n- 영상 보고 사람이 친구한테 한마디 하듯 끝낸다\n- 재료 만드는 법 만드는법 레시피 요리법 조리법이라는 단어를 절대 쓰지 않는다\n- 댓글에 재료나 만드는 법을 적어준다는 CTA를 절대 쓰지 않는다\n- 댓글을 보라고 유도하는 문장을 본문에 넣지 않는다\n[댓글 - 형식 강제]\n댓글은 반드시 아래 형식으로만 작성한다\n✅ 핵심만\n- 원문에서 확인되는 핵심 포인트 1\n- 원문에서 확인되는 핵심 포인트 2\n- 필요하면 핵심 포인트 3\n- 재료 만드는 법 레시피 요리법 조리법을 쓰지 않는다\n- 링크와 광고고지는 쓰지 않는다\n반드시 JSON만 출력: {\"items\":[{\"text\":\"본문\",\"comment\":\"댓글\"}, ...]} 정확히 5개`;

  const user = `키워드: ${String(keyword || '').trim()}\n\n[원 게시물 - 정제된 사실 자료 A]\n${cleanedSource.slice(0, 5000)}\n\n[같은 작성자의 추가 설명/댓글 - 정제된 사실 자료 B]\n${cleanedReplies.slice(0, 5000) || '(추가 설명 없음)'}\n\nA와 B에 있는 사실만 사용하고 문장은 새로 작성할 것\ntext 본문은 반드시 2~4줄로 작성할 것\n본문에 마침표와 쉼표를 사용하지 말 것\nㅋㅋ를 단독 줄로 쓰지 말 것\n${isRecipe ? '' : '일반소재이므로 재료 만드는 법 레시피 요리법 조리법 관련 문구와 댓글 유도 문구를 절대 쓰지 말 것'}`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', temperature: isRecipe ? 0.32 : 0.82, max_tokens: isRecipe ? 4200 : 3000,
    response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(x => ({ text: formatThreadsBody(x?.text || '', { isRecipe }), comment: sanitizeGeneratedComment(x?.comment) })).filter(x => x.text).slice(0, 5)
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
    item.text = formatThreadsBody(item.text, { isRecipe });
  }

  return { mode: isRecipe ? 'recipe' : 'product', items, texts: items.map(x => x.text), comments: items.map(x => x.comment) };
}

module.exports = { generateFromThreadsMaterial };
