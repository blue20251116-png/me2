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
  if (/(?:더라|더라고)(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/(?:함|임|됨|없음|있음|같음|보임|끝임|바뀜|사라짐|좋음|쉬움|편함|귀여움|맛있음)(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;

  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) return true;
  if (/이거\s*없(?:인|이는|으면)\s*못\s*살|없(?:인|이는)\s*못\s*살겠|대박이다(?=$|\s|[!?~ㅋㅎㅠㅜ])/i.test(t)) return true;
  if (/기대\s*안\s*했는데|한입\s*먹자마자|순삭|무조건\s*(?:추천|사|먹|써)|최고(?:야|다)|강추|놓치면\s*후회/i.test(t)) return true;
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|확실히|공간\s*차지|깔끔해짐/i.test(t)) return true;
  if (/여름에\s*(?:완전\s*)?(?:좋겠|좋을)|겨울에\s*(?:완전\s*)?(?:좋겠|좋을)|활용하기\s*좋|사용하기\s*좋|먹기\s*좋|마시기\s*좋/i.test(t)) return true;
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|추천(?:해|한다)|구매(?:해|하자|각)/i.test(t)) return true;
  if (/주말에\s*(?:아이|아이들|애들|가족).{0,12}(?:만들|해|먹).{0,8}(?:좋겠|좋을|추천)|누구나\s*쉽게|초보도\s*쉽게|아이들과\s*함께/i.test(t)) return true;

  const allLines = t.split('\n');
  const lines = allLines.map(x => x.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 10) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;

  return false;
}

function getExamples(isRecipe) {
  return isRecipe
    ? `이거 잘라보는 순간이 제일 떨렸어ㅋㅋ\n\n만들 때는 망한 줄 알았는데\n잘라놓으니까 생각보다 너무 귀엽네\n\n딸기 더 넣을걸`
    : `이거 처음엔 뭐가 다른가 했거든\n\n근데 쓰는 장면 보니까 바로 이해됐어ㅋㅋ\n이런 건 설명 길게 하는 게 더 이상해`;
}

function systemPrompt(isRecipe) {
  return `너는 한국 Threads에서 실제 사람이 폰으로 바로 올리는 글만 만드는 최종 말투 편집기다
잘 쓴 광고문 후기문 블로그문을 만들면 실패다
사람이 순간적으로 떠오른 말 몇 줄만 적고 끝내는 느낌을 우선한다
글을 완성하려고 하지 마라

[가장 중요한 원칙]
- 모든 문장에 역할을 부여하지 않는다
- 후킹 상황설명 장점 활용상황 추천 CTA를 차례대로 채우지 않는다
- 기승전결을 만들지 않는다
- 정보가 조금 빠져 있어도 정상이다
- 한 장면 한 반응 한 생각만 말하고 끝나도 정상이다
- 2~4문장으로 끝나도 정상이다
- 사진이나 영상이 이미 보여주는 내용을 다시 친절하게 설명하지 않는다
- 독자에게 도움이 되도록 억지로 장점 활용법 추천상황을 덧붙이지 않는다
- 좋은 글처럼 매끈하게 정리하지 않는다

[시작 방식]
- 반응형 상황형 실패담형 결과만 말하는 형 사진 한장면형 관찰형 잡담형 중 소재에 자연스러운 방식 하나만 고른다
- 매번 시작 방식을 바꾼다
- 특정 감탄문을 고정 템플릿처럼 반복하지 않는다
- 와 아니 진짜 대박 미쳤다 같은 말을 사람처럼 보이기 위한 장식으로 넣지 않는다
- 원문에 자연스럽고 구체적인 장면이 있으면 그 장면을 우선 살린다
- 상품명을 첫 문장부터 광고처럼 소개하지 않는다

[핵심 문체]
- 음슴체 금지
- ~함 ~임 ~됨 ~없음 ~있음 ~같음 ~보임 ~끝임 같은 종결을 쓰지 않는다
- 반말 평서형 질문형 감탄형을 자연스럽게 섞을 수 있다
- 모든 줄을 같은 종결로 맞추지 않는다
- 문법적으로 완벽하게 다듬기보다 실제 사람이 바로 쓴 듯한 리듬을 우선한다
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ㅜㅠ ;; ?! ㄷㄷ 같은 표현은 문맥에 맞을 때만 사용한다
- SNS 표현이 하나도 없어도 정상이다
- 알겠ㅋㅋ 괜찮겠ㅋㅋ처럼 어간을 억지로 자르지 않는다

[완성형 AI 구조 금지]
- 감탄 → 상황 설명 → 장점 → 추천 → CTA 구조 금지
- 문제 → 해결 → 장점 → 구매권유 구조 금지
- 맛 평가 → 쉬움 강조 → 가족이나 아이들과 활용 추천 구조 금지
- 장점을 2개 이상 친절하게 정리하지 않는다
- 마지막 문장을 억지 교훈 추천 질문 CTA로 만들지 않는다
- 본문에 필요한 말을 이미 했으면 그냥 끝낸다

[마무리]
- 별도 마무리가 없어도 된다
- 갑자기 한마디 하고 끝나도 된다
- 아쉬움 실수 작은 감상 같은 사소한 말로 끝나도 된다
- 매번 댓글을 예고하지 않는다
- 같은 마무리를 반복하지 않는다

[문장과 줄바꿈]
- 글자 수나 한 줄 길이를 숫자로 맞추지 않는다
- 의미가 이어지는 문장은 같은 문단으로 둬도 된다
- 짧은 문장과 조금 긴 문장을 자연스럽게 섞는다
- 글마다 줄 수와 문단 수를 똑같이 맞추지 않는다
- 빈줄을 살려 실제 Threads 호흡으로 쓴다

[절대 금지하는 AI 말투]
- 육즙이 폭발하는 느낌이야
- 풍미가 살아나 풍미가 배가돼
- 완벽한 조화 특별한 메뉴 매력적인 메뉴 한층 더
- 간편하게 활용하기 좋아
- 실용적 효율적 편리하다 활용도 장점이다
- 누구나 쉽게 초보도 쉽게
- 주말에 아이들이랑 만들어봐도 좋겠다
- 아이들과 함께 해보면 좋겠다
- 한 번 먹어봐야 해 꼭 먹어봐 강추
- 무조건 사야 해 놓치면 후회
- 객관적인 상품평 총평 결론

[안전 규칙]
- 마침표 금지
- 쉼표 금지
- ~냐 종결 금지
- 존댓말 금지
- 건강식품은 확인되지 않은 효과 체험을 만들지 않는다
- 확인되지 않은 의학적 효능 안전성 할인율 가격 절감 성과는 단정하지 않는다
- 엄마 친구 남편 아내 같은 구체적인 제3자가 추천해서 샀다 써봤다 먹어봤다는 추천·구매 경위는 입력 근거 없이 만들지 않는다
- 원문에 직접 구매 사용 섭취 경험이 있으면 그 체감은 살려도 된다
- 원문에 직접 경험이 없으면 내가 샀다 써봤다 먹어봤다처럼 사실인 척 만들지 말고 관찰형이나 가정형으로 쓴다
- 가족이나 지인의 짧은 맛 만족 반응도 원문에 근거가 있을 때만 살린다

${isRecipe ? `[레시피 추가 규칙]\n- 레시피라고 해서 본문에 조리 순서를 반드시 설명하지 않는다\n- 사진이나 영상의 결과가 재미있으면 결과나 한 장면만 써도 된다\n- 맛 편의성 쉬움을 세트로 설명하지 않는다\n- 재료나 만드는 법을 댓글에 적는 경우에도 본문에서 매번 예고하지 않는다\n- 정말 자연스러운 경우에만 댓글 언급을 한 줄 사용할 수 있다` : `[일반상품 추가 규칙]\n- 기능을 나열하지 않는다\n- 제품 설명보다 실제 장면이나 한 반응을 우선한다\n- 억지 구매 권유 금지\n- 댓글 유도를 억지로 붙이지 않는다`}

[스타일 기준 예시]
${getExamples(isRecipe)}

예시의 문장이나 순서를 복사하지 마라
예시는 말을 덜 하고 끝내는 밀도와 불완전함만 참고해라
매끄러운 콘텐츠로 완성하려는 순간 실패다
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
}

async function callRewrite(apiKey, source, originals, isRecipe, retry = false) {
  const retryInstruction = retry
    ? `\n\n[재시도 강제 규칙]\n직전 결과는 광고 상투어 정형 구조 또는 부자연스러운 말투 때문에 탈락했다\n글을 완성하려고 하지 마라\n한 장면이나 한 반응만 남기고 불필요한 설명을 버려라\n독자에게 활용상황을 추천하지 마라\n범용 감탄 후킹을 억지로 붙이지 마라\n음슴체를 쓰지 마라\n육즙 폭발 풍미 강력 추천 무조건 추천 같은 광고 상투어는 쓰지 마라\n문장을 글자 수 때문에 억지로 자르지 마라`
    : '';

  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: retry ? 0.95 : 0.88,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt(isRecipe) + retryInstruction },
      {
        role: 'user',
        content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n광고 후기처럼 잘 쓰려고 하지 마\n실제 Threads에서 사람이 폰으로 몇 줄 툭 쓴 것처럼 바꿔\n현재 생성문의 기승전결과 장점 설명을 그대로 보존할 필요 없다\n필요 없는 정보는 과감히 버려도 된다\n한 장면 한 반응 한 생각만 남기고 끝내도 된다\n음슴체는 쓰지 마\nㅋㅋ ㅠㅠ ;; ㄷㄷ는 문맥에 맞을 때만 자유롭게 써\n구체적인 제3자 추천 구매 경위와 직접 구매 사용 섭취 경험 건강 효능은 근거 없이 만들지 마`,
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
      console.log(`[Threads][HUMAN TONE] 1차 탈락 ${rejectedIndexes.length}건 → 기계적 구조 제거 재시도 indexes=${rejectedIndexes.join(',')}`);
      const retryOriginals = rejectedIndexes
        .map(i => `${i}. ${String(items[i - 1]?.text || '').replace(/\n/g, ' / ')}`)
        .join('\n');
      const retried = await callRewrite(apiKey, source, retryOriginals, isRecipe, true);
      retryMap = new Map(retried.map(x => [Number(x.index), clean(x.text)]));
    }

    return items.map((item, idx) => {
      const index = idx + 1;
      const firstCandidate = firstMap.get(index);
      if (firstCandidate && !basicReject(firstCandidate)) return { ...item, text: firstCandidate };

      const retryCandidate = retryMap.get(index);
      if (retryCandidate && !basicReject(retryCandidate)) return { ...item, text: retryCandidate };

      console.warn(`[Threads][HUMAN TONE] ${index}번 재작성 2회 탈락 → 기존 생성문 유지`);
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

  console.log(`[Threads][HUMAN TONE] 최종 비정형 스레드 말투 적용 mode=${result.mode} items=${result.items.length}`);
  return result;
};

console.log('[Threads][HUMAN TONE] v14 unstructured Threads style · 음슴체 금지');
