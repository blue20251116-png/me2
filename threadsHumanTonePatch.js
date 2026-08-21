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
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .trim();
}

function basicReject(text) {
  const t = String(text || '');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/(없겠음|좋겠음|괜찮겠음|되겠음|했음|있음|없음|좋음|편함)(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/실물\s*(?:보니까|봤)|써\s*보니까|사용해\s*보니까|사\s*봤|추가\s*구매|재구매/i.test(t)) return true;
  if (/인싸\s*가능성|유용할\s*줄\s*몰랐|없으면\s*아쉬|완전\s*추천/i.test(t)) return true;
  if (/확실히|공간\s*차지|깔끔해짐|걱정\s*없|장점이야|활용도|효율적|편리하|정리가\s*되고/i.test(t)) return true;
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|(?:먹어|써|사용해|사|해)\s*봐야\s*(?:해|겠다)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|강추|놓치면\s*후회|진짜\s*최고야|완전\s*최고야/i.test(t)) return true;
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length > 6) return true;
  if (lines.some(x => x.length > 38)) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;
  return false;
}

async function rewriteBatch(accountId, sourceText, mode, items) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey || !Array.isArray(items) || !items.length) return items;

  const isRecipe = mode === 'recipe';
  const source = String(sourceText || '').slice(0, 4500);
  const originals = items.map((x, i) => `${i + 1}. ${String(x.text || '').replace(/\n/g, ' / ')}`).join('\n');

  const examples = isRecipe
    ? `이거 알려준 스치니 어딨어ㅜㅠ\n와 이건 진짜 생각도 못했어ㅋㅋ\n\n이렇게 하면 되는 거였네\n재료는 댓글에 적어둘게\n\n30년 식당하신 이모한테 알아낸 건데\n미역국 끓일 때 이거 반 스푼 넣으면\n\n국물 느낌 확 달라지네ㅋㅋ\n\n이거 알려준 사람 어디갔어ㅠㅠ\n휴게소 감자 생각나는 비주얼인데\n\n이건 좀 궁금하다ㅋㅋ`
    : `이거 진짜 대박이야ㅋㅋ\n아몬드랑 헤이즐넛이 이렇게 들어있어\n\n너무 맛있어\n견과류 좋아하는 사람한테 완전 뿅 가는 맛이지\n\n이거 왜 이제 알았지ㅋㅋ\n새 방석 바꿔줬더니 하루 종일 여기서 안 나옴\n\n그냥 쏙 들어가서 자는데\n저 다리 나온 거 너무 웃겨ㅋㅋ\n\n이거 알려준 스치니 어딨어ㅜㅠ\n와 대박 집에서 호텔 냄새 나!!\n\n이거 하나면 비싼 디퓨저 필요 없어\n신기해 재료는 댓글에 적어둘게\n\n직관 갔다가 이거 보고 빵터짐ㅋㅋ\n우산이 이렇게까지 커질 일이야?\n\n근데 비 올 때는 좀 탐난다`;

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.9,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `한국 Threads 글을 실제 사람이 즉흥적으로 쓴 것처럼 최종 편집한다
기계적으로 정리된 리뷰보다 감정이 먼저 튀어나오는 짧은 글을 쓴다

최우선 스타일
- 첫 줄은 강한 반응으로 시작해도 좋다: 이거 진짜 대박이야ㅋㅋ / 이거 왜 이제 알았지ㅋㅋ / 와 이건 좀 미쳤다ㅋㅋ
- ㅋㅋ ㅎㅎ ㅠㅠ ㅜㅠ ㄷㄷ 같은 SNS 표현을 적극적으로 자연스럽게 쓴다
- ㅋㅋ는 금지어가 아니다. 어울리면 한 글에 1~3번 써도 된다
- 맛있어 웃겨 신기해 미쳤어 대박이야 뿅 가는 맛이지 같은 직설적인 감정 표현을 적극 허용한다
- 제품을 객관적으로 평가하려 하지 말고 사람이 보고 바로 느낀 반응처럼 쓴다
- 문단 사이 빈 줄을 적극 사용한다
- 1~2줄 말한 뒤 빈 줄 하나를 넣고 다음 반응으로 넘어가는 호흡을 우선한다
- 모든 줄을 한 덩어리로 붙이지 않는다
- 짧은 문장과 긴 문장을 섞는다
- 너무 매끈하고 논리적인 설명문보다 약간 즉흥적인 SNS 호흡이 우선이다

내용 방향
- 원문에서 가장 강한 장면 맛 특징 반응 중 1~2개만 잡는다
- 모든 특징을 빠짐없이 설명하지 않는다
- 발견 → 감정 → 핵심 한 가지 → 감정 마무리 정도면 충분하다
- 음식이면 맛 표현을 자연스럽게 강하게 써도 된다
- 생활상품이면 웃긴 장면 신기한 사용 모습 의외성을 우선한다

절대 규칙
- 원문에서 확인되는 사실만 사용한다
- 새로운 남편 친구 가족 회사 구매 사용 경험을 만들지 않는다
- 현재 생성문에 있는 허구 경험도 원문에 없으면 제거한다
- 보통 3~5개의 실제 문장으로 쓴다
- 문단은 2~3개 정도 허용하고 문단 사이에는 빈 줄 하나를 쓸 수 있다
- 마침표 쉼표 금지
- ~냐 금지
- 음슴체 금지
- 존댓말 설명체 금지
- 상품 소개서 같은 장점 나열 금지
- 확실히 정리가 되고 공간 차지도 안 하고 활용도가 좋다 효율적이다 편리하다 장점이다 같은 AI 리뷰 문장 금지
- 한 번 먹어봐야 해 한번 먹어봐 써봐야 해 한번 써봐 사봐야 해 같은 행동 권유형 문장 금지
- 꼭 먹어봐 꼭 써봐 꼭 사봐 추천해 강추 놓치면 후회 같은 직접 CTA 금지
- 독자에게 구매 사용 섭취 저장 공유를 요구하지 않는다
- 모습이 느낌이 생각이 제품이 장면이 부분이 점이처럼 문장이 덜 끝난 형태로 줄을 끝내지 않는다
- 첫 문장을 항상 같은 표현으로 반복하지 않는다
- 스치니를 매번 쓰지 않는다
- 일부러 모든 글에 ㅋㅋ를 넣을 필요는 없지만 감정이 살아나는 소재에는 과감하게 쓴다
- 맞춤법보다 실제 SNS 호흡을 우선하되 일부러 오타를 만들지는 않는다
- 원문에 수치가 핵심이 아니면 숫자와 스펙은 빼도 된다
${isRecipe ? '- 음식/레시피는 자연스러울 때 마지막에 재료나 레시피를 댓글에 적어둔다고 할 수 있다' : '- 일반 상품은 댓글 유도 문구를 억지로 붙이지 않는다'}

좋은 스타일 예시
${examples}

중요: 예시의 문장을 복사하는 것이 아니라 감정 강도 줄바꿈 빈 줄 SNS 호흡을 따라간다
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`,
        },
        {
          role: 'user',
          content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n기계적인 설명문을 버리고 감정 표현을 훨씬 강하게 살려줘. ㅋㅋ 같은 SNS 표현과 문단 사이 빈 줄도 자연스럽게 사용해서 실제 Threads 사람이 쓴 글처럼 다시 써줘`,
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

console.log('[Threads][HUMAN TONE] 실제 Threads 반응형 말투 v5 감정강화+문단호흡 활성화');
