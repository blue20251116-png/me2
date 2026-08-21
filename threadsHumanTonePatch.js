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
  if (/간편하게\s*(?:마시|먹|사용|쓰)|맛이\s*(?:배로|두\s*배로)\s*(?:더해|살아)|여름에\s*(?:완전\s*)?(?:좋겠|좋을\s*것)|겨울에\s*(?:완전\s*)?(?:좋겠|좋을\s*것)|활용하기\s*좋|사용하기\s*좋|먹기\s*좋|마시기\s*좋/i.test(t)) return true;
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
    ? `이거 알려준 스치니 어딨어ㅜㅠ\n와 이건 진짜 생각도 못했어ㅋㅋ\n\n이렇게 하면 되는 거였네\n재료는 댓글에 적어둘게\n\n이거 진짜 미쳤다ㅋㅋ\n자몽허니블랙티 만들어봤는데\n스벅에서 먹던 그 맛이랑 거의 똑같아\n\n얼음 왕창 넣으니까 개맛있네ㅋㅋ\n비밀 재료는 댓글에 적어둘게\n\n30년 식당하신 이모한테 알아낸 건데\n미역국 끓일 때 이거 반 스푼 넣으면\n\n국물 느낌 확 달라지네ㅋㅋ`
    : `이거 진짜 대박이야ㅋㅋ\n아몬드랑 헤이즐넛이 이렇게 들어있어\n\n너무 맛있어\n견과류 좋아하는 사람한테 완전 뿅 가는 맛이지\n\n이거 왜 이제 알았지ㅋㅋ\n새 방석 바꿔줬더니 하루 종일 여기서 안 나옴\n\n그냥 쏙 들어가서 자는데\n저 다리 나온 거 너무 웃겨ㅋㅋ\n\n이거 알려준 스치니 어딨어ㅜㅠ\n와 대박 집에서 호텔 냄새 나!!\n\n이거 하나면 비싼 디퓨저 필요 없어\n신기해 재료는 댓글에 적어둘게\n\n직관 갔다가 이거 보고 빵터짐ㅋㅋ\n우산이 이렇게까지 커질 일이야?\n\n근데 비 올 때는 좀 탐난다`;

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.95,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `한국 Threads 글을 실제 사람이 즉흥적으로 쓴 것처럼 최종 편집한다
목표는 잘 쓴 광고문이 아니라 친구가 방금 보고 먹고 발견한 걸 올린 듯한 짧은 반응글이다

최우선 스타일
- 감정과 장면을 먼저 쓴다
- 이거 진짜 미쳤다ㅋㅋ / 이거 왜 이제 알았지ㅋㅋ / 와 대박 / 너무 맛있어 / 저거 너무 웃겨ㅋㅋ 같은 직접 반응을 자연스럽게 쓴다
- ㅋㅋ ㅎㅎ ㅠㅠ ㅜㅠ ㄷㄷ 같은 SNS 표현을 적극적으로 자연스럽게 쓴다
- ㅋㅋ는 금지어가 아니다. 어울리면 한 글에 1~3번 써도 된다
- 제품을 객관적으로 평가하거나 총평하지 않는다
- 제품의 장점을 설명하려 하지 말고 눈앞의 장면 맛 냄새 행동 중 제일 강한 것만 말한다
- 문단 사이 빈 줄을 적극 사용한다
- 1~2줄 말한 뒤 빈 줄 하나를 넣고 다음 반응으로 넘어간다
- 짧은 문장과 긴 문장을 섞는다
- 약간 즉흥적이고 날것인 SNS 호흡을 우선한다

AI 냄새 제거 규칙
- 여름에 간편하게 마시기 좋겠다 같은 계절+활용 총평 금지
- 맛이 배로 더해져 풍미가 살아나 활용하기 좋다 사용하기 좋다 먹기 좋다 마시기 좋다 같은 광고 카피 금지
- 간편하게 실용적 활용도 효율적 편리하다 장점이다 추천한다 같은 리뷰 단어를 가급적 쓰지 않는다
- 문장 끝을 좋겠다 괜찮겠다 유용하겠다 식으로 평가하지 않는다
- 맛있으면 그냥 너무 맛있어 개맛있네ㅋㅋ 같은 실제 반응으로 쓴다
- 웃긴 장면이면 그냥 저 다리 나온 거 너무 웃겨ㅋㅋ처럼 장면을 바로 말한다
- 신기한 물건이면 설명보다 이걸 왜 이제 알았지ㅋㅋ 같은 반응을 먼저 쓴다
- 모든 특징을 정리해서 전달하려 하지 않는다

절대 규칙
- 원문에서 확인되는 사실만 사용한다
- 새로운 남편 친구 가족 회사 구매 사용 경험을 만들지 않는다
- 현재 생성문에 있는 허구 경험도 원문에 없으면 제거한다
- 보통 3~5개의 실제 문장으로 쓴다
- 문단은 2~3개 정도 허용하고 문단 사이에는 빈 줄 하나를 쓴다
- 마침표 쉼표 금지
- ~냐 금지
- 음슴체 금지
- 존댓말 설명체 금지
- 상품 소개서 같은 장점 나열 금지
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

중요: 예시의 문장을 복사하지 말고 감정 강도 줄바꿈 빈 줄 SNS 호흡만 따른다
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`,
        },
        {
          role: 'user',
          content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n광고 카피와 총평 문장을 전부 걷어내고 실제 Threads 사람이 바로 반응해서 쓴 것처럼 다시 써줘. 특징 설명보다 감정과 장면을 우선하고 빈 줄도 자연스럽게 넣어줘`,
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

console.log('[Threads][HUMAN TONE] 실제 Threads 반응형 말투 v6 총평제거+날것반응 강화');
