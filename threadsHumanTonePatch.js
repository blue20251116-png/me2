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
  if (/추천(?:해|함|한다|하고|할)|구매(?:해|하자|각)|써보면|먹어보면|사용하면\s*좋/i.test(t)) return true;
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 6) return true;
  if (lines.some(x => x.length > 38)) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;
  return false;
}

function getExamples(isRecipe) {
  return isRecipe
    ? `이거 진짜 미쳤다ㅋㅋ\n자몽허니블랙티 만들어봤는데\n스벅에서 먹던 그 맛이랑 거의 똑같아\n\n얼음 왕창 넣으니까 개맛있네ㅋㅋ\n비밀 재료는 댓글에 적어둘게\n\n이거 알려준 스치니 어딨어ㅜㅠ\n와 대박 집에서 호텔 냄새 나!!\n\n이거 하나면 비싼 디퓨저 필요 없어\n신기해 재료는 댓글에 적어둘게\n\n30년 식당하신 이모한테 알아낸 건데\n미역국 끓일 때 이거 반 스푼 넣으면\n\n국물 느낌 확 달라지네ㅋㅋ`
    : `이거 왜 이제 알았지ㅋㅋ\n새 방석 바꿔줬더니 하루 종일 여기서 안 나옴\n\n그냥 쏙 들어가서 자는데\n저 다리 나온 거 너무 웃겨ㅋㅋ\n\n이거 진짜 대박이야ㅋㅋ\n아몬드랑 헤이즐넛이 이렇게 들어있어\n\n너무 맛있어\n견과류 좋아하는 사람한테 완전 뿅 가는 맛이지\n\n직관 갔다가 이거 보고 빵터짐ㅋㅋ\n우산이 이렇게까지 커질 일이야?\n\n근데 비 오니까 갑자기 개탐남ㅋㅋ`;
}

function systemPrompt(isRecipe) {
  return `한국 Threads 글을 실제 사람이 즉흥적으로 쓴 것처럼 최종 편집한다
목표는 광고문이나 상품평이 아니라 친구가 방금 보고 먹고 발견한 걸 툭 올린 듯한 반응글이다

가장 중요한 기준
- 설명보다 반응을 먼저 쓴다
- 상황 또는 발견 → 즉각적인 감정 → 구체적인 한 장면 → 짧은 반응 순서를 선호한다
- 이거 진짜 미쳤다ㅋㅋ / 이거 왜 이제 알았지ㅋㅋ / 와 대박 / 너무 맛있어 / 저거 너무 웃겨ㅋㅋ 같은 직접 반응을 자연스럽게 쓴다
- ㅋㅋ ㅎㅎ ㅠㅠ ㅜㅠ ㄷㄷ 같은 SNS 표현을 자연스럽게 허용한다
- 제품을 객관적으로 평가하거나 총평하지 않는다
- 특징을 전부 설명하지 말고 눈앞의 장면 맛 냄새 행동 중 강한 것 1~2개만 쓴다
- 1~2줄 뒤 빈 줄 하나를 넣는 식으로 문단을 나눈다
- 짧은 문장과 조금 긴 문장을 섞는다
- 잘 쓴 문장보다 실제 사람이 급하게 올린 자연스러운 호흡을 우선한다

절대 금지
- 간편하게 활용도 실용적 효율적 편리하다 장점이다 추천한다 같은 리뷰 문체
- 여름에 좋겠다 활용하기 좋다 사용하기 좋다 먹기 좋다 마시기 좋다 같은 총평
- 한 번 먹어봐야 해 한번 먹어봐 써봐야 해 한번 써봐 사봐야 해 같은 행동 권유
- 꼭 먹어봐 꼭 써봐 꼭 사봐 추천해 강추 놓치면 후회 같은 CTA
- 독자에게 구매 사용 섭취 저장 공유를 요구하는 문장
- 원문에 없는 남편 친구 가족 회사 구매 사용 경험을 새로 만드는 것
- 마침표 쉼표
- ~냐
- 음슴체
- 존댓말 설명체
- 상품 소개서 같은 장점 나열
- 문장을 모습이 느낌이 생각이 제품이 장면이 부분이 점이로 어색하게 끝내는 것

작성 규칙
- 원문에서 확인되는 사실만 사용한다
- 현재 생성문에 허구 경험이 있으면 제거한다
- 보통 실제 문장 3~5개
- 보통 2~3문단
- 문단 사이 빈 줄 하나
- 첫 문장을 매번 같은 표현으로 시작하지 않는다
- 모든 글에 억지로 ㅋㅋ를 넣지는 않지만 감정이 살아나는 소재에는 과감하게 쓴다
- 맞춤법보다 자연스러운 SNS 호흡을 우선하되 일부러 오타를 만들지 않는다
- 수치와 스펙이 핵심이 아니면 빼도 된다
${isRecipe ? '- 음식이나 레시피는 자연스러울 때 마지막에 비밀 재료는 댓글에 적어둘게 또는 재료는 댓글에 적어둘게처럼 끝낼 수 있다' : '- 일반 상품은 댓글 유도 문구를 억지로 붙이지 않는다'}

좋은 스타일 예시
${getExamples(isRecipe)}

예시 문장을 복사하지 말고 감정 강도 줄바꿈 빈 줄 SNS 호흡만 따른다
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
}

async function callRewrite(apiKey, source, originals, isRecipe, retry = false) {
  const retryInstruction = retry
    ? `\n\n[중요 재시도]\n직전 결과가 광고문 리뷰문체 행동권유 또는 기계적인 총평 때문에 탈락했다\n이번에는 설명을 더 줄이고 실제 사람이 스레드에 툭 쓰는 반응형 문장으로 다시 작성한다\n좋겠다 추천한다 활용하기 좋다 한 번 해봐야 해 같은 표현은 절대 쓰지 않는다`
    : '';

  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: retry ? 1.0 : 0.95,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt(isRecipe) + retryInstruction },
      {
        role: 'user',
        content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n광고 카피와 총평을 전부 걷어내고 실제 Threads 사람이 바로 반응해서 쓴 것처럼 다시 써줘\n특징 설명보다 감정과 장면을 우선하고 문단 사이 빈 줄도 자연스럽게 넣어줘`,
      },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 30000,
  });

  const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
  return Array.isArray(parsed.items) ? parsed.items : [];
}

async function rewriteBatch(accountId, sourceText, mode, items) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey || !Array.isArray(items) || !items.length) return items;

  const isRecipe = mode === 'recipe';
  const source = String(sourceText || '').slice(0, 4500);
  const originals = items.map((x, i) => `${i + 1}. ${String(x.text || '').replace(/\n/g, ' / ')}`).join('\n');

  try {
    const first = await callRewrite(apiKey, source, originals, isRecipe, false);
    const firstMap = new Map(first.map(x => [Number(x.index), clean(x.text)]));
    const rejectedIndexes = [];

    items.forEach((item, idx) => {
      const candidate = firstMap.get(idx + 1);
      if (!candidate || basicReject(candidate)) rejectedIndexes.push(idx + 1);
    });

    let retryMap = new Map();
    if (rejectedIndexes.length) {
      console.log(`[Threads][HUMAN TONE] 1차 탈락 ${rejectedIndexes.length}건 → 사람말투 재시도 indexes=${rejectedIndexes.join(',')}`);
      const retryOriginals = rejectedIndexes
        .map(i => `${i}. ${String(items[i - 1]?.text || '').replace(/\n/g, ' / ')}`)
        .join('\n');
      const retried = await callRewrite(apiKey, source, retryOriginals, isRecipe, true);
      retryMap = new Map(retried.map(x => [Number(x.index), clean(x.text)]));
    }

    return items.map((item, idx) => {
      const index = idx + 1;
      const firstCandidate = firstMap.get(index);
      if (firstCandidate && !basicReject(firstCandidate)) {
        return { ...item, text: firstCandidate };
      }

      const retryCandidate = retryMap.get(index);
      if (retryCandidate && !basicReject(retryCandidate)) {
        return { ...item, text: retryCandidate };
      }

      console.warn(`[Threads][HUMAN TONE] ${index}번 재작성 2회 탈락 → 원문 생성문 유지`);
      return item;
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

console.log('[Threads][HUMAN TONE] 실제 Threads 반응형 말투 v7 재시도+기계문체 차단 강화');
