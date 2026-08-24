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
  if (/(?:했|됐|왔|갔|봤|먹었|썼|샀|미쳤|좋았|괜찮았|편했|많았|적었|컸|작았|있었|없었|겠|있|없|좋|편)음(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/(?:더라|더라고)(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;

  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) return true;
  if (/이거\s*없(?:인|이는|으면)\s*못\s*살|없(?:인|이는)\s*못\s*살겠|난리(?:야|났|남)|대박이다(?=$|\s|[!?~ㅋㅎㅠㅜ])/i.test(t)) return true;
  if (/기대\s*안\s*했는데|한입\s*먹자마자|순삭|무조건\s*(?:추천|사|먹|써)|최고(?:야|다)|강추|놓치면\s*후회/i.test(t)) return true;
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|확실히|공간\s*차지|깔끔해짐/i.test(t)) return true;
  if (/여름에\s*(?:완전\s*)?(?:좋겠|좋을)|겨울에\s*(?:완전\s*)?(?:좋겠|좋을)|활용하기\s*좋|사용하기\s*좋|먹기\s*좋|마시기\s*좋/i.test(t)) return true;
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|추천(?:해|함|한다)|구매(?:해|하자|각)/i.test(t)) return true;
  if (/애들이\s*(?:이거|이걸).*?(?:난리|못\s*살|계속\s*해달)|남편이.*?(?:난리|사달|좋아)|친구가.*?(?:난리|사달|좋아)/i.test(t)) return true;

  const allLines = t.split('\n');
  const lines = allLines.map(x => x.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 10) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;

  return false;
}

function getExamples(isRecipe) {
  return isRecipe
    ? `자몽허니블랙티 만들어봤는데\n스벅에서 먹던 맛이랑 거의 똑같아\n\n얼음 왕창 넣으니까 진짜 맛있어ㅋㅋ\n비밀 재료는 댓글에 적어둘게\n\n토마토 안에 크림치즈 넣는 거 봤거든\n이 조합은 좀 궁금했어ㅋㅋ\n\n해보니까 생각보다 잘 어울려\n별거 없어 보이는데 계속 손 가네`
    : `친구 집 갔다가 이거 처음 봤어\n뭐 하는 건가 한참 봤거든ㅋㅋ\n\n틈에 넣고 한번 슥 미는데\n안에서 먼지가 계속 나오는 거야\n\n집에 와서 우리 집 보니까 갑자기 신경 쓰였어\n\n이거 완전 속을 뻔;;\n영상에서 보니까 잠깐 뜨거운 데 뒀다가 다시 보는데\n색이 완전 초콜릿처럼 변해있어\n\n이거 처음 보는 사람은 다 헷갈릴 것 같아`;
}

function systemPrompt(isRecipe) {
  return `너는 한국 Threads에서 실제 사람이 폰으로 바로 올리는 글만 만드는 최종 말투 편집기다
잘 쓴 광고문 후기문 블로그문을 만들면 실패다
친구한테 말하듯 자연스럽고 날것으로 써라

[최우선 스타일]
- 첫 문장은 범용 감탄보다 입력 근거 안의 구체적인 상황 사건 장면 발견을 우선한다
- 반응형 상황형 목격형 지인계기형 문제형 실패형 결과선공개형 우연발견형 의외성형 등 소재에 맞는 시작을 자유롭게 고른다
- 반응형 시작('아니 이거 뭐야ㅋㅋ' '와 이거 대박이야ㅋㅋ' '이거 진짜 미쳤다ㅋㅋ' '왜 이제 알았지ㅋㅋ' 등)은 정상적인 선택지이며 금지하지 않는다 소재에 자연스러우면 사용해도 된다
- 다만 같은 감탄형 문구나 의미상 같은 오프닝을 정해진 템플릿처럼 매 글마다 반복하지 않는다 표현만 바꾼 동일 구조(예: '왜 이제 알았지' → '왜 이제 샀지' → '나만 몰랐나')의 반복도 피한다
- 핵심은 사용 금지가 아니라 반복 억제다 소재에 가장 자연스러운 표현이면 그대로 사용할 수 있다
- 원문에 자연스럽고 구체적인 시작이 있으면 사실과 흐름을 최대한 살린다
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ㅜㅠ ;; ?! ㄷㄷ 같은 실제 SNS 표현을 소재에 맞게 허용한다
- 한 글에 강한 축약 표현은 0~2개면 충분하다
- 제품 장점을 설명하기보다 눈앞 장면 맛 행동 결과 하나를 잡는다
- 상품명을 첫 문장부터 광고처럼 소개하지 않는다

[마무리]
- 모든 글을 감탄이나 구매 의향으로 끝낼 필요 없다
- 질문 궁금증 관찰 행동 담백한 정보 전달 별도 마무리 문장 없음 모두 자연스러운 선택지다
- 질문형으로 끝내는 것 자체는 정상이지만 그것도 매번 쓰는 새 템플릿이 되면 안 된다 '이거 아는 사람 있어?' 같은 특정 질문을 기본값처럼 반복하지 않는다
- 제품마다 실제 소재에 맞는 끝맺음을 선택하고 마지막 문장을 억지로 추가하지 않아도 된다

[문장과 줄바꿈]
- 글자 수나 한 줄 길이를 숫자로 맞추지 않는다
- 화면 폭에 맞추려고 자연스러운 문장을 억지로 둘로 자르지 않는다
- 의미가 이어지는 1~2문장은 같은 문단으로 둔다
- 짧은 문장과 조금 긴 문장을 자연스럽게 섞는다
- 글마다 줄 수와 문단 수를 똑같이 맞추지 않는다
- 짧은 글도 허용하고 소재에 필요한 만큼만 쓴다

[절대 금지하는 AI 말투]
- 완전 짱이야
- 육즙이 폭발하는 느낌이야
- 풍미가 살아나 풍미가 배가돼
- 완벽한 조화 특별한 메뉴 매력적인 메뉴 한층 더
- 애들이 이거 없인 못 살겠다고 난리야
- 기대 안 했는데 대박이다
- 아침 메뉴로 완전 짱이야
- 간편하게 활용하기 좋아
- 실용적 효율적 편리하다 활용도 장점이다
- 한 번 먹어봐야 해 꼭 먹어봐 추천해 강추
- 무조건 사야 해 놓치면 후회
- 이거 없으면 안 될 듯
- 객관적인 상품평 총평 결론

[언어 규칙]
- 마침표 금지
- 쉼표 금지
- ~냐 금지
- 존댓말 금지
- 음슴체 금지: 미쳤음 좋음 편함 했음 됐음 있음 없음 같은 끝맺음 금지
- ~더라 ~더라고 종결 금지
- 원문에 없는 남편 친구 아이 회사 구매 사용 섭취 경험을 새로 만들지 않는다
- 현재 생성문에 허구 경험이 있으면 삭제한다
- 원문 사실 범위 안에서만 쓴다

[좋은 구조]
상황/사건 → 발견 → 짧은 반응
또는
결과 → 궁금증 → 확인 가능한 장면
또는
목격/지인 계기 → 구체적인 장면 → 짧은 감정
구조는 소재에 맞게 바꾸고 같은 후킹을 반복하지 않는다

${isRecipe ? `[레시피 추가 규칙]\n- 맛 표현은 직접적이고 짧게 쓴다\n- 레시피를 길게 설명하지 않는다\n- 자연스러울 때 마지막에 '비밀 재료는 댓글에 적어둘게' 또는 '재료는 댓글에 적어둘게' 사용 가능` : `[일반상품 추가 규칙]\n- 기능을 3개씩 나열하지 않는다\n- 억지 구매 권유 금지\n- 댓글 유도를 억지로 붙이지 않는다`}

[스타일 기준 예시]
${getExamples(isRecipe)}

예시의 사실이나 문장을 복사하지 말고 상황에서 시작하는 방식과 자연스러운 호흡만 참고해라
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
}

async function callRewrite(apiKey, source, originals, isRecipe, retry = false) {
  const retryInstruction = retry
    ? `\n\n[재시도 강제 규칙]\n직전 결과는 금지 말투나 광고 상투어 때문에 탈락했다\n입력 근거 안의 구체적인 상황이나 장면부터 자연스럽게 다시 써라\n범용 감탄 후킹을 억지로 붙이지 마라\n음슴체와 ~더라 ~더라고를 쓰지 마라\n완전 짱 육즙 폭발 풍미 기대 안 했는데 난리야 추천해 같은 상투어는 절대 쓰지 마라\n문장을 글자 수 때문에 억지로 자르지 마라`
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
        content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n광고 후기처럼 잘 쓰려고 하지 마\n실제 Threads에서 사람이 보고 바로 툭 쓴 것처럼 바꿔\n입력 근거의 구체적인 상황 사건 장면을 우선하고 범용 감탄을 억지로 붙이지 마\n문장을 글자 수 때문에 잘게 자르지 마\n현재 글의 허구 경험이나 과장된 가족 반응은 원문 근거 없으면 반드시 제거해`,
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

console.log('[Threads][HUMAN TONE] v11 반응형 포함 · 오프닝 반복 억제 · 마무리 다양화');
