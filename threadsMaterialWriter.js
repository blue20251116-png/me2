const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function generateFromThreadsMaterial(accountId, { keyword, sourceText, authorReplies = '', mode = 'product' }) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('관리자 OpenAI API 키가 설정되어 있지 않습니다.');
  const isRecipe = mode === 'recipe';

  const styleRules = `
한국 Threads에서 실제 사람이 바로 쓴 것처럼 작성한다.
가장 중요한 규칙:
- 원글의 정보와 소재는 참고하지만 문장은 새로 쓴다.
- 설명문, 리뷰문, 블로그 문체로 쓰지 않는다.
- "부드럽고 고급스럽다", "정말 좋더라", "완전 달라졌다", "사르르 녹는다", "걱정 끝" 같은 AI식 감상 문장을 습관적으로 만들지 않는다.
- 한 문장을 길게 이어 쓰지 않는다. 한 줄은 대체로 짧게 쓴다.
- 전체 본문은 보통 4~8줄 정도로 끝낸다. 억지로 길게 채우지 않는다.
- 첫 1~2줄은 바로 상황이나 반응으로 시작한다. 서론이나 설명을 깔지 않는다.
- 실제 Threads에서 쓰는 정도의 ㅋㅋ, ㅠㅠ, ㄷㄷ, ;;, ... 같은 표현은 문맥에 맞을 때만 자연스럽게 쓸 수 있다.
- 자연스러운 반말을 사용한다. 음슴체(~함/~임/~됨)는 사용하지 않는다.
- 존댓말, 광고 카피, 전문가 설명체, 문학적인 표현을 사용하지 않는다.
- 같은 뜻을 다른 말로 반복하지 않는다.
- 원문에 없는 경험, 효능, 체중감량, 수치, 재료, 조리시간, 온도, 제품 성능을 만들어내지 않는다.
- 원글에 강한 후킹이 있으면 그 강도를 살리되 똑같이 베끼지 않는다.
- 5개 버전은 단어만 교체하지 말고 첫 문장과 상황 전개를 다르게 한다.
`;

  const system = isRecipe
    ? `${styleRules}
레시피/음식 소재다.
본문은 레시피 설명서가 아니라 원글처럼 "이거 왜 이렇게 맛있지", "누가 알려줬는데 해봤더니", "가족 반응이 이랬다" 같은 짧은 Threads 글의 결로 쓴다.
재료와 만드는 법은 본문에 길게 풀지 않는다. 작성자 댓글/추가 설명에서 확인된 재료와 조리법은 comment에 따로 정리한다.
작성자 추가 설명에 없는 정확한 양, 시간, 온도는 절대 추측하지 않는다.
본문은 4~8개의 짧은 줄을 권장하며 각 줄은 자연스럽게 끊는다.
반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":"재료와 만드는 법"}, ...]} 이고 정확히 5개를 만든다.`
    : `${styleRules}
생활/제품 소재다.
본문은 제품 설명이나 장점 목록이 아니라 실제 발견담/생활 썰처럼 쓴다.
원글에서 보이는 핵심 장면이나 불편, 반응을 앞에 두고 제품이나 방법은 뒤에서 자연스럽게 드러낸다.
본문은 4~8개의 짧은 줄을 권장한다.
반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":""}, ...]} 이고 정확히 5개를 만든다.`;

  const user = `키워드: ${String(keyword || '').trim()}

원 게시물 내용:
${String(sourceText || '').trim().slice(0, 3500)}

작성자가 직접 남긴 추가 설명/댓글:
${String(authorReplies || '').trim().slice(0, 3500) || '(추가 설명 없음)'}

중요: 원글의 말투 결, 문장 길이, 템포를 먼저 파악해. 블로그 후기처럼 매끈하게 설명하지 말고 Threads 피드에 섞여 있어도 티 안 나는 짧고 날것의 글 5개를 작성해. 원글의 사실만 사용하고 문장은 새로 써.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: 0.92,
    max_tokens: isRecipe ? 3000 : 2600,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(x => ({ text: String(x?.text || '').trim(), comment: String(x?.comment || '').trim() })).filter(x => x.text).slice(0, 5)
    : [];
  if (!items.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');
  return { items, texts: items.map(x => x.text), comments: items.map(x => x.comment || '') };
}

module.exports = { generateFromThreadsMaterial };
