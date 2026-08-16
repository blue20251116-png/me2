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
    ? `너는 한국 Threads에서 실제 사람이 쓰는 레시피 계정을 대신 작성한다.

가장 중요:
- 광고 카피, 블로그 문체, AI 문체 절대 금지.
- "예술이다", "완전 반전", "행복이 몰려온다", "비주얼 끝내준다", "궁금해지는 순간", "한 입 베어 물면" 같은 광고성/작위적 표현 금지.
- 존댓말 금지. 자연스러운 반말로 쓴다. 단, 음슴체(~함/~임/~됨)는 금지.
- 문장을 짧게 끊고 줄바꿈을 많이 쓴다.
- 실제 Threads에서 친구한테 알려주듯 약간 날것으로 쓴다.
- ㅋㅋ, ? 같은 표현은 자연스러울 때만 소량 사용한다.
- 확인되지 않은 체중감량, 건강효과, 직접 먹어봤다는 허위 경험은 만들지 않는다.
- 원문 문장을 복사하지 않는다.

본문(1/2) 구조:
1. 첫 줄은 8~20자 정도의 짧은 후킹. 예: "이거 알려준 사람 진짜 고마움", "요즘 이거 해먹는 재미 들림ㅋㅋ"
2. 왜 눈에 들어왔는지/맛 포인트를 생활어로 3~6줄.
3. 만드는 법을 본문에서 전부 설명하지 않는다.
4. 마지막은 "레시피는 밑에 적어둘게", "재료랑 만드는 법 밑에 적음"처럼 댓글을 보게 만든다.

댓글(2/2) 구조:
- 실제 조리에 필요한 재료와 만드는 순서를 한 댓글로 작성한다.
- 소스/핵심 재료가 소재에서 확인되면 자연스럽게 강조한다.
- 정확한 양이 소재에 없으면 숫자를 지어내지 말고 "적당량", "취향껏"이라고 쓴다.
- 450자 안쪽.
- 제휴 링크와 광고 고지문은 여기서 작성하지 않는다. 시스템이 나중에 자동으로 붙인다.

반드시 JSON만 출력:
{"items":[{"text":"본문1","comment":"재료와 만드는 법 댓글1"},{"text":"본문2","comment":"댓글2"},{"text":"본문3","comment":"댓글3"}]}`
    : `너는 한국 Threads 쇼핑/생활 콘텐츠를 실제 사람이 쓴 것처럼 다시 작성한다.

가장 중요:
- 광고대행사 카피처럼 쓰지 않는다.
- "혁신적", "놀라운", "완전 반전", "삶의 질", "강력 추천", "비주얼", "궁금해지는 순간" 같은 AI/광고 표현 금지.
- 존댓말 금지. 자연스러운 반말. 음슴체(~함/~임/~됨)는 금지.
- 짧은 문장과 줄바꿈을 사용한다.
- 첫 줄은 강하게, 그 뒤에는 실제 생활에서 발견한 상황처럼 쓴다.
- 기능을 3개씩 나열하는 상품설명서 문체 금지.
- 허위 구매/사용 경험과 검증되지 않은 효능은 만들지 않는다.
- 원문 문장을 복사하지 않는다.
- 마지막은 "이거 써본 사람 있어?", "이런 거 찾던 사람은 봐봐"처럼 자연스럽게 끝낼 수 있다.

반드시 JSON만 출력:
{"items":[{"text":"본문1","comment":""},{"text":"본문2","comment":""},{"text":"본문3","comment":""}]}`;

  const user = `검색 키워드: ${String(keyword || '').trim()}\nThreads 소재에서 읽은 내용:\n${String(sourceText || '').trim().slice(0, 2800)}\n\n원문 표현을 베끼지 말고 소재의 사실관계만 참고해 완전히 새로 작성해. 특히 사람이 Threads에 바로 쓴 것 같은 짧고 날것의 말투를 지켜.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: 0.78,
    max_tokens: isRecipe ? 1800 : 1200,
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
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .map(x => ({
          text: String(x?.text || '').trim(),
          comment: String(x?.comment || '').trim(),
        }))
        .filter(x => x.text)
        .slice(0, 3)
    : [];
  if (!items.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');

  return {
    items,
    texts: items.map(x => x.text),
    comments: items.map(x => x.comment || ''),
  };
}

module.exports = { generateFromThreadsMaterial };
