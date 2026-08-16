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
  const system = isRecipe
    ? `한국 Threads용 레시피 글을 작성한다. 결과는 서로 다른 완성 본문 5개다. 제목 한 줄만 만들지 말고 각 본문을 최소 5문장으로 작성한다. 짧은 문장과 자연스러운 줄바꿈을 사용한다. 자연스러운 반말을 쓰되 음슴체는 쓰지 않는다. 광고 카피나 과장 표현을 피한다. 제공된 원 게시물과 작성자 추가 설명에서 확인되는 사실만 사용한다. 재료, 양, 시간, 온도, 조리 순서는 자료에 있을 때만 사용하고 없는 숫자를 만들지 않는다. 원문 문장을 그대로 복사하지 않는다. 본문은 상황과 맛 포인트 중심으로 쓰고 마지막에 재료와 만드는 법을 아래에 적는 흐름으로 마무리한다. comment에는 확인된 재료와 조리법을 한 번에 정리한다. 반드시 JSON만 출력한다. items 배열에 text와 comment를 가진 항목 5개를 넣는다.`
    : `한국 Threads용 생활/제품 글을 작성한다. 결과는 서로 다른 완성 본문 5개다. 제목 한 줄만 만들지 말고 각 본문을 최소 5문장으로 작성한다. 짧은 문장과 자연스러운 줄바꿈을 사용한다. 자연스러운 반말을 쓰되 음슴체는 쓰지 않는다. 광고 카피, 기능 나열, 과장 표현을 피한다. 제공된 자료에서 확인되는 사실만 사용하고 구매 경험이나 성능을 임의로 만들지 않는다. 원문 문장을 그대로 복사하지 않는다. 상황, 발견 또는 문제, 핵심 포인트, 자연스러운 마무리 순서로 작성하며 5개 버전의 첫 문장과 전개를 다르게 한다. 반드시 JSON만 출력한다. items 배열에 text와 빈 comment를 가진 항목 5개를 넣는다.`;
  const user = `키워드: ${String(keyword || '').trim()}\n\n원 게시물 내용:\n${String(sourceText || '').trim().slice(0, 3500)}\n\n작성자가 직접 남긴 추가 설명:\n${String(authorReplies || '').trim().slice(0, 3500) || '(추가 설명 없음)'}\n\n위에서 확인되는 사실만 참고해 새로운 완성글 5개를 작성해.`;
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', temperature: 0.82, max_tokens: isRecipe ? 3600 : 3000,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });
  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items) ? parsed.items.map(x => ({ text: String(x?.text || '').trim(), comment: String(x?.comment || '').trim() })).filter(x => x.text).slice(0, 5) : [];
  if (!items.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');
  return { items, texts: items.map(x => x.text), comments: items.map(x => x.comment || '') };
}
module.exports = { generateFromThreadsMaterial };
