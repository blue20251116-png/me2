const axios = require('axios');
const writer = require('./threadsMaterialWriter');
const { getAccount, getSystemApiSettings } = require('./db');

const originalGenerate = writer.generateFromThreadsMaterial.bind(writer);

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .trim();
}

function basicReject(text) {
  const t = String(text || '');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/(없겠음|좋겠음|괜찮겠음|되겠음|했음|있음|없음|좋음|편함)(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/실물\s*(?:보니까|봤)|써\s*보니까|사용해\s*보니까|사\s*봤|추가\s*구매|재구매/i.test(t)) return true;
  if (/인싸\s*가능성|유용할\s*줄\s*몰랐|없으면\s*아쉬|완전\s*추천/i.test(t)) return true;
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.some(x => x.length > 34)) return true;
  return false;
}

async function rewriteBatch(accountId, sourceText, mode, items) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey || !Array.isArray(items) || !items.length) return items;

  const isRecipe = mode === 'recipe';
  const source = String(sourceText || '').slice(0, 4500);
  const originals = items.map((x, i) => `${i + 1}. ${String(x.text || '').replace(/\n/g, ' / ')}`).join('\n');

  const example = isRecipe
    ? `이거 알려준 스치니 어딨어ㅜㅠ\n와 대박 집에서 호텔 냄새 나!!\n이거 하나면 비싼 디퓨저 필요 없어\n신기해 재료는 댓글에 적어둘게`
    : `이거 왜 이렇게 눈에 들어오지ㅋㅋ\n처음엔 그냥 지나쳤는데 자꾸 보게 돼\n포인트 하나는 확실한 것 같아`;

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.65,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `한국 Threads 최종 문체 편집기다
목표는 잘 쓴 광고문이 아니라 사람이 순간적으로 툭 쓴 글이다

절대 규칙
- 원문에 확인되는 사실만 사용하고 새로운 남편 친구 가족 구매 사용 경험을 만들지 않는다
- 설명하려고 정보를 다 쓰지 말고 가장 재밌거나 눈에 띄는 포인트 하나만 남긴다
- 기본 2~4줄
- 한 줄은 하나의 완결된 짧은 반응이나 문장
- 문장 중간을 줄 수 맞추려고 자르지 않는다
- 한 줄 34자 안쪽을 우선한다
- 빈 줄 금지
- 마침표 쉼표 금지
- ~냐 금지
- 음슴체 금지
- 상품 장점 나열 금지
- 마지막에 친절한 총평 금지
- 실물 보니까 써보니까 사용해보니까 추가 구매 재구매 같은 확인되지 않은 경험 금지
- 인싸 가능성 유용할 줄 몰랐어 없으면 아쉬워 완전 추천 같은 AI식 표현 금지
- ㅋㅋ ㅎㅎ ㅠㅜ는 필요할 때만 자연스럽게 붙인다
- 예시의 문장을 복사하지 말고 호흡과 느낌만 참고한다
${isRecipe ? '- 음식/레시피 소재라면 자연스러울 때만 마지막에 재료나 레시피를 댓글에 적는다는 한 줄을 쓸 수 있다' : '- 일반 상품은 댓글 유도 문구를 억지로 넣지 않는다'}

스타일 예시
${example}

JSON만 출력한다
{"items":[{"index":1,"text":""}]}`,
        },
        {
          role: 'user',
          content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n내용을 늘리지 말고 사람 말투로 다시 써줘`,
        },
      ],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      timeout: 30000,
    });

    const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
    const rewritten = Array.isArray(parsed.items) ? parsed.items : [];
    const byIndex = new Map(rewritten.map(x => [Number(x.index), clean(x.text)]));

    return items.map((item, idx) => {
      const candidate = byIndex.get(idx + 1);
      if (!candidate || basicReject(candidate)) return item;
      return { ...item, text: candidate };
    });
  } catch (e) {
    console.warn(`[Threads][HUMAN TONE] 재작성 실패 → 기존 본문 유지 reason="${e.response?.data?.error?.message || e.message}"`);
    return items;
  }
}

writer.generateFromThreadsMaterial = async function patchedGenerate(accountId, args = {}) {
  const result = await originalGenerate(accountId, args);
  if (!result?.items?.length) return result;

  result.items = await rewriteBatch(accountId, args.sourceText, result.mode, result.items);
  result.texts = result.items.map(x => x.text);
  result.comments = result.items.map(x => x.comment);

  console.log(`[Threads][HUMAN TONE] 최종 사람말투 재작성 적용 mode=${result.mode} items=${result.items.length}`);
  return result;
};

console.log('[Threads][HUMAN TONE] 스친 반응형 짧은 호흡 최종 편집 활성화');
