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
  if (/확실히|공간\s*차지|깔끔해짐|걱정\s*없|장점이야|활용도|효율적|편리하|정리가\s*되고/i.test(t)) return true;
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|(?:먹어|써|사용해|사|해)\s*봐야\s*(?:해|겠다)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|강추|놓치면\s*후회|진짜\s*최고야|완전\s*최고야/i.test(t)) return true;
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length > 5) return true;
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
    ? `이거 알려준 스치니 어딨어ㅜㅠ\n와 이건 진짜 생각도 못했어ㅋㅋ\n이렇게 하면 되는 거였네\n재료는 댓글에 적어둘게\n\n30년 식당하신 이모한테 알아낸 건데\n미역국 끓일 때 이거 반 스푼 넣으면\n국물 느낌 확 달라지네ㅋㅋ\n\n이거 알려준 사람 어디갔어ㅠㅠ\n휴게소 감자 생각나는 비주얼인데\n이건 좀 궁금하다ㅋㅋ`
    : `이거 왜 이제 알았지ㅋㅋ\n새 방석 바꿔줬더니 하루 종일 여기서 안 나옴\n그냥 쏙 들어가서 자는데\n저 다리 나온 거 너무 웃겨ㅋㅋ\n\n이거 누가 생각한 거야ㅋㅋ\n바지 겹쳐놓는 거 은근 짜증났는데\n이렇게 걸어버리면 끝이네\n\n직관 갔다가 이거 보고 빵터짐ㅋㅋ\n우산이 이렇게까지 커질 일이야?\n근데 비 올 때는 좀 탐난다\n\n와 이거 좀 신기한데\n애들 여기 넣어두면 한참 놀 것 같아ㅋㅋ\n이런 게 있었네\n\n이거 알려준 스치니 어디갔어ㅠㅠ\n이런 방법이 있는 줄 처음 알았네ㅋㅋ\n나만 이제 본 건가`;

  try {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0.84,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `한국 Threads 글을 사람이 직접 쓴 것처럼 최종 편집한다
광고 카피라이터처럼 설명하지 말고 친구한테 방금 본 사진이나 영상을 말하듯 쓴다

가장 중요한 방향
- 제품 설명보다 화면에서 제일 먼저 눈에 들어오는 장면을 잡는다
- 사진이나 영상 속 웃긴 모습 이상한 장면 귀여운 행동 의외성을 먼저 쓴다
- 정보 전달문이 아니라 반응글이다
- 첫 줄부터 감정이나 상황으로 바로 들어간다
- 발견 → 짧은 상황 → 화면에서 보이는 행동 → 한마디 반응 순서를 우선한다
- 모든 기능을 설명하지 않는다
- 제품 장점을 설명하는 대신 영상에서 실제로 보이는 한 장면을 말한다
- 문장을 매끈하게 완성하려고 하지 않는다
- 마지막에 결론이나 행동 권유를 붙이지 않는다
- 자연스럽게 말이 끝났으면 거기서 바로 끝낸다
- 조금 덜 정돈돼도 실제 Threads 말투가 우선이다

절대 규칙
- 원문에서 확인되는 사실만 사용한다
- 새로운 남편 친구 가족 회사 구매 사용 경험을 만들지 않는다
- 현재 생성문에 있는 허구 경험도 원문에 없으면 제거한다
- 기본 2~4줄 최대 5줄
- 한 줄에 한 생각만 쓴다
- 빈 줄 금지
- 마침표 쉼표 금지
- ~냐 금지
- 음슴체 금지
- 존댓말 설명체 금지
- 상품 소개서 같은 장점 나열 금지
- 결론형 총평 금지
- 실물 보니까 써보니까 사용해보니까 사봤다 추가 구매 재구매 금지
- 확실히 정리가 되고 공간 차지도 안 하고 활용도가 좋다 효율적이다 편리하다 장점이다 같은 리뷰/AI 문장 금지
- 이거 하나면 걱정 없다 이제 걱정 없겠다 같은 광고 결론 금지
- 한 번 먹어봐야 해 한번 먹어봐 써봐야 해 한번 써봐 사봐야 해 한번 사봐 해봐야 해 같은 행동 권유형 문장 금지
- 꼭 먹어봐 꼭 써봐 꼭 사봐 추천해 강추 놓치면 후회 같은 CTA 금지
- 진짜 최고야 완전 최고야처럼 제품을 총평하면서 끝내는 문장 금지
- 독자에게 구매 사용 섭취 저장 공유를 요구하지 않는다
- 마지막 줄은 반응 궁금증 놀람 관찰 중 하나로 자연스럽게 끝낸다
- 모습이 느낌이 생각이 제품이 장면이 부분이 점이처럼 문장이 덜 끝난 형태로 줄을 끝내지 않는다
- 첫 문장을 매번 와 대박으로 시작하지 않는다
- 스치니를 매번 쓰지 않는다
- ㅋㅋ ㅎㅎ ㅠㅠ ㅜㅜ ㄷㄷ는 글마다 0~2개 정도 자연스럽게 허용한다
- 맞춤법보다 실제 SNS 호흡을 우선하되 일부러 오타를 만들지는 않는다
- 원문에 수치가 핵심이 아니면 숫자와 스펙은 빼도 된다
${isRecipe ? '- 음식/레시피는 자연스러울 때만 마지막에 재료나 레시피를 댓글에 적어둔다고 할 수 있다' : '- 일반 상품은 댓글 유도 문구를 억지로 붙이지 않는다'}

좋은 스타일 예시
${examples}

예시 문장을 그대로 복사하지 말고 말의 길이와 반응 방식만 참고한다
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`,
        },
        {
          role: 'user',
          content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n현재 생성문의 설명체와 행동 권유형 마무리를 버리고 사진이나 영상에서 가장 눈에 띄는 장면을 먼저 잡아 짧은 Threads 반응글로 다시 써줘`,
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

console.log('[Threads][HUMAN TONE] 실제 Threads 반응형 말투 v4 장면우선 활성화');
