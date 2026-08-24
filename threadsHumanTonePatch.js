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

  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) return true;
  if (/이거\s*없(?:인|이는|으면)\s*못\s*살|없(?:인|이는)\s*못\s*살겠|대박이다(?=$|\s|[!?~ㅋㅎㅠㅜ])/i.test(t)) return true;
  if (/기대\s*안\s*했는데|한입\s*먹자마자|순삭|무조건\s*(?:추천|사|먹|써)|최고(?:야|다)|강추|놓치면\s*후회/i.test(t)) return true;
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|확실히|공간\s*차지|깔끔해짐/i.test(t)) return true;
  if (/여름에\s*(?:완전\s*)?(?:좋겠|좋을)|겨울에\s*(?:완전\s*)?(?:좋겠|좋을)|활용하기\s*좋|사용하기\s*좋|먹기\s*좋|마시기\s*좋/i.test(t)) return true;
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|추천(?:해|한다)|구매(?:해|하자|각)/i.test(t)) return true;

  const allLines = t.split('\n');
  const lines = allLines.map(x => x.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 10) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;

  return false;
}

function getExamples(isRecipe) {
  return isRecipe
    ? `이건 진짜 알려준 사람 표창장 줘야함;;\n\n아침마다 뭐 해먹을지 고민하는 사람 이 조합 알아두면 진짜 편하겠음 ㅠㅠ\n\n식빵 대신 슬라이스 햄 딱 깔고 그 위에 계란이랑 치즈 올리고 밥 한 숟갈 얹어서 그냥 돌돌 말면 끝임\n\n불 앞에 오래 서있을 필요도 없고 설거지거리도 거의 없어서 개편해 보임ㄷㄷ\n\n바쁜 아침에 이런 조합 하나 알아두면 꽤 든든할 듯`
    : `옷에 뭐 묻을 때마다 세탁기 돌리기는 애매했는데\n이거 얼룩 난 부분에 그냥 슥슥 문지르면 끝임\n\n영상 보니까 사용법도 별거 없고 생각보다 간단함;;\n흰옷 자주 입는 사람은 이런 거 하나 있으면 은근 잘 쓰게 될 듯\n\n이런 건 괜히 기능 길게 설명하는 것보다 쓰는 장면 보면 바로 이해됨`;
}

function systemPrompt(isRecipe) {
  return `너는 한국 Threads에서 실제 사람이 폰으로 바로 올리는 글만 만드는 최종 말투 편집기다
잘 쓴 광고문 후기문 블로그문을 만들면 실패다
친구한테 말하듯 자연스럽고 조금 거칠어도 된다

[최우선 스타일]
- 생활 상황 불편 발견 행동 결과 중 하나에서 바로 시작한다
- 반응형 상황형 목격형 문제형 실패형 결과선공개형 우연발견형 의외성형 등 소재에 맞는 시작을 자유롭게 고른다
- 특정 감탄문을 고정 템플릿처럼 반복해서 재사용하지 않는다
- 와 아니 진짜 대박 미쳤다 같은 말 자체는 금지하지 않지만 매 글의 기본 후킹으로 쓰지 않는다
- 원문에 자연스럽고 구체적인 시작이 있으면 그 흐름을 최대한 살린다
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ㅜㅠ ;; ;;;; ?! ㄷㄷ 같은 실제 SNS 표현을 소재에 맞게 자유롭게 허용한다
- SNS 표현은 사람처럼 보이기 위한 장식으로 억지 삽입하지 않는다 하나도 없어도 정상이다
- 제품 장점을 정리해서 설명하기보다 생활 장면 맛 행동 결과를 중심으로 쓴다
- 상품명을 첫 문장부터 광고처럼 소개하지 않는다

[핵심 문체]
- 음슴체는 금지하지 않는다 실제 Threads에서 자연스럽게 쓰이는 ~함 ~임 ~됨 ~없음 ~바뀜 ~사라짐 ~끝임 같은 종결을 허용한다
- 음슴체와 평서형을 자연스럽게 섞어 쓴다 모든 줄을 같은 종결로 통일하지 않는다
- 개편함 최고임 끝임 사라짐 같은 거친 축약도 문맥상 자연스러우면 허용한다
- 문법적으로 완벽한 문장보다 실제 사람이 급하게 쓴 듯한 리듬을 우선한다
- 다만 문장 어간을 억지로 잘라 알겠ㅋㅋ 괜찮겠ㅋㅋ 같은 부자연스러운 형태는 만들지 않는다

[마무리]
- 모든 글을 감탄이나 질문으로 끝낼 필요 없다
- 체감 한마디 짧은 결론 음슴체 종결 감정기호 또는 별도 마무리 없음 모두 가능하다
- 같은 마무리를 반복하지 않는다

[문장과 줄바꿈]
- 글자 수나 한 줄 길이를 숫자로 맞추지 않는다
- 의미가 이어지는 1~2문장은 같은 문단으로 둔다
- 짧은 문장과 조금 긴 문장을 자연스럽게 섞는다
- 글마다 줄 수와 문단 수를 똑같이 맞추지 않는다
- 빈줄을 살려 실제 Threads 호흡으로 쓴다

[절대 금지하는 AI 말투]
- 육즙이 폭발하는 느낌이야
- 풍미가 살아나 풍미가 배가돼
- 완벽한 조화 특별한 메뉴 매력적인 메뉴 한층 더
- 간편하게 활용하기 좋아
- 실용적 효율적 편리하다 활용도 장점이다
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
- 가족이나 지인의 짧은 맛 만족 반응도 원문에 근거가 있을 때 우선 살리고 구체적인 추천 구매 경위는 지어내지 않는다

[좋은 구조]
생활 불편 → 발견 → 사용/조리 장면 → 체감 한마디
또는
결과 → 만드는 법/쓰는 법 → 짧은 반응
또는
상황 → 해결 장면 → 거친 한마디
구조는 소재에 맞게 바꾸고 같은 후킹을 반복하지 않는다

${isRecipe ? `[레시피 추가 규칙]\n- 만드는 법이 핵심이면 실제 순서를 짧고 쉽게 보여준다\n- 맛과 편의 체감은 짧고 세게 써도 된다\n- 자연스러울 때 마지막에 '비밀 재료는 댓글에 적어둘게' 또는 '재료는 댓글에 적어둘게' 사용 가능` : `[일반상품 추가 규칙]\n- 기능을 3개씩 나열하지 않는다\n- 억지 구매 권유 금지\n- 댓글 유도를 억지로 붙이지 않는다`}

[스타일 기준 예시]
${getExamples(isRecipe)}

예시 문장을 그대로 복사하지 말고 거친 호흡 음슴체와 평서형의 섞임 생활 상황 중심 흐름만 참고해라
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
}

async function callRewrite(apiKey, source, originals, isRecipe, retry = false) {
  const retryInstruction = retry
    ? `\n\n[재시도 강제 규칙]\n직전 결과는 광고 상투어나 부자연스러운 말투 때문에 탈락했다\n생활 상황이나 장면부터 자연스럽게 다시 써라\n범용 감탄 후킹을 억지로 붙이지 마라\n음슴체는 자연스러우면 그대로 사용해도 된다\n육즙 폭발 풍미 강력 추천 무조건 추천 같은 광고 상투어는 쓰지 마라\n문장을 글자 수 때문에 억지로 자르지 마라`
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
        content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n광고 후기처럼 잘 쓰려고 하지 마\n실제 Threads에서 사람이 폰으로 툭 쓴 것처럼 바꿔\n생활 상황과 사용 또는 조리 장면이 자연스럽게 이어지게 해\n음슴체와 평서형을 섞어도 된다\nㅋㅋ ㅠㅠ ;; ㄷㄷ는 문맥에 맞을 때만 자유롭게 써\n구체적인 제3자 추천 구매 경위와 직접 구매 사용 섭취 경험 건강 효능은 근거 없이 만들지 마`,
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
      console.log(`[Threads][HUMAN TONE] 1차 탈락 ${rejectedIndexes.length}건 → 금지말투만 재시도 indexes=${rejectedIndexes.join(',')}`);
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

  console.log(`[Threads][HUMAN TONE] 최종 실제 스레드 말투 적용 mode=${result.mode} items=${result.items.length}`);
  return result;
};

console.log('[Threads][HUMAN TONE] v13 raw Threads style · 음슴체 허용');
