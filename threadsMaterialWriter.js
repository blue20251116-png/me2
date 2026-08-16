const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

async function generateFromThreadsMaterial(accountId, { keyword, sourceText, mode = 'product' }) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('관리자 OpenAI API 키가 설정되어 있지 않습니다.');

  const isRecipe = mode === 'recipe';
  const system = isRecipe
    ? `너는 한국 Threads 레시피 글을 쓰는 에디터다. 원문을 복사하지 않고 소재만 참고해서 완전히 새 글을 쓴다. 실제 사람이 휴대폰으로 툭 쓴 것처럼 자연스럽게 쓴다. 음슴체 금지. 과장된 효능, 허위 경험, 근거 없는 수치 금지. 첫 문장은 짧고 강하게 시작하고, 중간에는 맛/식감/조리 포인트를 자연스럽게 섞는다. 마지막에는 레시피나 재료가 궁금하도록 끝낸다. 광고 문구처럼 기능을 나열하지 않는다. JSON만 출력: {"texts":["본문1","본문2","본문3"]}`
    : `너는 한국 Threads 쇼핑/생활 콘텐츠 에디터다. 다른 게시물의 문장을 베끼지 않고 소재와 제품 특징만 참고해서 완전히 새 글을 쓴다. 실제 사람이 발견한 것처럼 자연스럽고 짧은 반말을 쓴다. 음슴체 금지. 제목, 해시태그, 번호 매기기 금지. 첫 1~2줄은 강한 생활형 후킹, 이후 문제/발견/사용 장면/왜 탐나는지 순으로 자연스럽게 이어간다. '무조건 사라', '인생템', 뻔한 광고 카피 반복 금지. 허위 사용 경험, 의학적 효능, 체중감량 수치 등 검증 안 된 주장은 만들지 않는다. JSON만 출력: {"texts":["본문1","본문2","본문3"]}`;

  const user = `검색 키워드: ${String(keyword || '').trim()}\nThreads 소재에서 읽은 내용:\n${String(sourceText || '').trim().slice(0, 2400)}\n\n이 소재를 그대로 베끼지 말고 다른 표현과 흐름으로 Threads 본문 3개를 만들어.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: 0.95,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 30000,
  });

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const texts = Array.isArray(parsed.texts)
    ? parsed.texts.map(x => String(x || '').trim()).filter(Boolean).slice(0, 3)
    : [];
  if (!texts.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');
  return texts;
}

module.exports = { generateFromThreadsMaterial };
