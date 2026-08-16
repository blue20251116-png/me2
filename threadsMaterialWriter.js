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
- AI식 감상/과장/정리 문장을 만들지 않는다.
- 한 문장을 길게 이어 쓰지 않는다. 한 줄은 대체로 짧게 쓴다.
- 전체 본문은 보통 4~8줄 정도로 끝낸다.
- 첫 1~2줄은 바로 상황이나 반응으로 시작한다.
- ㅋㅋ, ㅠㅠ, ㄷㄷ, ;;, ...는 원글 분위기에 맞을 때만 자연스럽게 사용한다.
- 자연스러운 반말을 사용한다. 음슴체(~함/~임/~됨)는 사용하지 않는다.
- 존댓말, 광고 카피, 전문가 설명체, 문학적인 표현을 사용하지 않는다.
- 같은 뜻을 다른 말로 반복하지 않는다.
- 원문에 없는 경험, 효능, 체중감량, 수치, 재료, 조리시간, 온도, 제품 성능을 절대 만들어내지 않는다.
- 5개 버전은 첫 문장과 전개를 다르게 한다.
`;

  const system = isRecipe
    ? `${styleRules}
레시피/음식 소재다.

[절대 규칙 - 사실 보존]
1. 원 게시물 내용과 작성자 추가 설명/댓글을 하나의 사실 자료로 읽는다.
2. 재료명, 양, 조리 순서, 시간, 온도, 도구는 자료에 실제로 적힌 것만 사용한다.
3. 자료에 없는 재료를 상식이나 다른 레시피 지식으로 보충하지 않는다. 우유, 꿀, 버터, 시나몬 등 원문에 없으면 절대 추가하지 않는다.
4. 자료에 없는 수치도 추측하지 않는다.
5. 정보가 부족하면 부족한 그대로 쓰고 창작해서 채우지 않는다.
6. 원문에 '핵심재료'처럼 이름이 가려져 있으면 그대로 '핵심재료'라고 쓴다. 임의의 식재료로 바꾸지 않는다.

[본문 작성]
- 원글의 말투, 호흡, 후킹 강도를 참고해 짧은 Threads 글로 재작성한다.
- 레시피 전체를 본문에 설명하지 않는다.
- 블로그 후기 같은 '부드럽고 고급스럽다/건강 간식/반칙 아닌가/사르르 녹는다' 식의 AI 문구를 넣지 않는다.
- 실제 사람이 친구에게 말하듯 짧고 날것으로 쓴다.

[댓글 작성]
- comment는 '원작자 댓글 요약'이 아니라 새 게시물 아래에 실제로 달 상세 레시피 댓글이다.
- 원 게시물 본문 또는 작성자 추가 설명에 재료/만드는 법이 있으면 그 정보를 빠뜨리지 말고 실사용 가능한 형태로 옮긴다.
- '~를 사용했음', '재료는 이것임' 같은 요약문 한 줄로 끝내지 않는다.
- 가능하면 '준비물/만드는 법'처럼 읽기 쉽게 구성하되 원문에 없는 정보는 추가하지 않는다.
- 광고 링크나 고지문은 여기서 만들지 않는다.

반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":"상세 레시피 댓글"}, ...]} 이고 정확히 5개를 만든다.`
    : `${styleRules}
생활/제품 소재다.
본문은 제품 설명이나 장점 목록이 아니라 실제 발견담/생활 썰처럼 쓴다.
원글에서 보이는 핵심 장면이나 불편, 반응을 앞에 두고 제품이나 방법은 뒤에서 자연스럽게 드러낸다.
본문은 4~8개의 짧은 줄을 권장한다.
반드시 JSON만 출력한다. 형식은 {"items":[{"text":"본문","comment":""}, ...]} 이고 정확히 5개를 만든다.`;

  const user = `키워드: ${String(keyword || '').trim()}

[원 게시물 - 사실 자료 A]
${String(sourceText || '').trim().slice(0, 5000)}

[같은 게시물 작성자가 직접 남긴 추가 설명/댓글 - 사실 자료 B]
${String(authorReplies || '').trim().slice(0, 5000) || '(추가 설명 없음)'}

A와 B에 실제로 존재하는 정보만 사실로 사용할 것.
특히 레시피라면 A에 재료와 만드는 법이 적혀 있어도 반드시 읽어서 comment에 반영할 것. B가 비어 있다고 해서 레시피를 새로 추측하지 말 것.
본문은 원글의 말투 결/문장 길이/템포를 참고해서 Threads스럽게 새로 쓰고, comment는 A+B에서 확인한 실제 상세정보를 보존해서 작성해.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: isRecipe ? 0.35 : 0.88,
    max_tokens: isRecipe ? 4200 : 2600,
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
