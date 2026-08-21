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

  // 사용자가 싫어하는 말투
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;
  if (/(?:했|됐|왔|갔|봤|먹었|썼|샀|미쳤|좋았|괜찮았|편했|많았|적었|컸|작았|있었|없었|겠|있|없|좋|편)음(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) return true;

  // AI 후기/광고 상투어 강제 탈락
  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) return true;
  if (/이거\s*없(?:인|이는|으면)\s*못\s*살|없(?:인|이는)\s*못\s*살겠|난리(?:야|났|남)|대박이다(?=$|\s|[!?~ㅋㅎㅠㅜ])/i.test(t)) return true;
  if (/기대\s*안\s*했는데|한입\s*먹자마자|순삭|무조건\s*(?:추천|사|먹|써)|최고(?:야|다)|강추|놓치면\s*후회/i.test(t)) return true;
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|확실히|공간\s*차지|깔끔해짐/i.test(t)) return true;
  if (/여름에\s*(?:완전\s*)?(?:좋겠|좋을)|겨울에\s*(?:완전\s*)?(?:좋겠|좋을)|활용하기\s*좋|사용하기\s*좋|먹기\s*좋|마시기\s*좋/i.test(t)) return true;
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|추천(?:해|함|한다)|구매(?:해|하자|각)/i.test(t)) return true;

  // 허구 경험 유도에 자주 붙는 문구도 차단
  if (/애들이\s*(?:이거|이걸).*?(?:난리|못\s*살|계속\s*해달)|남편이.*?(?:난리|사달|좋아)|친구가.*?(?:난리|사달|좋아)/i.test(t)) return true;

  const allLines = t.split('\n');
  const lines = allLines.map(x => x.trim()).filter(Boolean);
  const blankLines = allLines.filter(x => !x.trim()).length;

  if (lines.length < 3 || lines.length > 7) return true;
  if (lines.some(x => x.length > 28)) return true;
  if (lines.length >= 4 && blankLines < 1) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;

  return false;
}

function getExamples(isRecipe) {
  return isRecipe
    ? `와 ㅁㅊ 이거 뭐야ㅋㅋ\n토마토 안에 크림치즈 넣었는데\n이게 왜 이렇게 맛있어ㅠㅠ\n\n간식으로 먹기 시작했는데\n계속 손 가네ㅋㅋ\n\n이거 진짜 미쳤다ㅋㅋ\n자몽허니블랙티 만들어봤는데\n스벅에서 먹던 맛이랑 거의 똑같아\n\n얼음 왕창 넣으니까 개맛있네ㅋㅋ\n비밀 재료는 댓글에 적어둘게\n\n이거 알려준 스치니 어딨어ㅜㅠ\n이 조합 생각한 사람 누구야ㅋㅋ\n\n별거 없어 보이는데\n왜 이렇게 맛있어ㅠㅠ`
    : `이거 왜 이제 알았지ㅋㅋ\n새 방석 바꿔줬더니 여기서 안 나와\n\n그냥 쏙 들어가서 자는데\n저 다리 나온 거 너무 웃겨ㅋㅋ\n\n아니 이거 뭐야ㅋㅋ\n크로스백이랑 백팩 둘 다 된다는데\n\n사진 보니까 은근 탐나네\n수납칸 왜 이렇게 많아ㅋㅋ\n\n직관 갔다가 이거 보고 빵터짐ㅋㅋ\n우산이 이렇게까지 커질 일이야?\n\n근데 비 오니까 좀 탐난다ㅋㅋ`;
}

function systemPrompt(isRecipe) {
  return `너는 한국 Threads에서 실제 사람이 폰으로 바로 올리는 글만 만드는 최종 말투 편집기다
잘 쓴 광고문 후기문 블로그문을 만들면 실패다
친구한테 카톡하듯 짧고 날것으로 써라

[최우선 스타일]
- 첫 반응이 먼저 튀어나와야 한다
- '와 ㅁㅊ 이거 뭐야ㅋㅋ' '아니 이거 뭐야ㅋㅋ' '이거 왜 이제 알았지ㅋㅋ' 같은 강한 실제 반응을 자연스럽게 허용한다
- '미친'보다 자연스러우면 'ㅁㅊ'을 우선 허용한다
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ㅜㅠ ;; ?! ㄷㄷ 같은 실제 SNS 표현을 허용한다
- 단 한 글에 강한 축약 표현은 1~2개 정도면 충분하다
- 모든 글을 같은 후킹으로 시작하지 않는다
- 제품 장점을 설명하지 말고 눈앞 장면이나 맛이나 행동 하나만 잡는다
- 정보 전달보다 반응이 먼저다

[문장과 줄바꿈]
- 3~6개 실제 문장
- 한 줄은 보통 8~22자
- 최대 28자를 넘지 않는다
- 한 줄에 한 생각만 쓴다
- 1~2줄 쓴 뒤 빈 줄 하나
- 보통 2~3문단
- 긴 문장을 화면 폭에 맞춰 억지로 자르지 말고 처음부터 짧은 문장으로 다시 쓴다

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
- 'ㅁㅊ'은 음슴체가 아니라 인터넷 축약어이므로 허용
- 원문에 없는 남편 친구 아이 회사 구매 사용 섭취 경험을 새로 만들지 않는다
- 현재 생성문에 허구 경험이 있으면 삭제한다
- 원문 사실 범위 안에서만 쓴다

[좋은 구조]
반응 → 구체적인 장면 하나 → 다시 반응
또는
상황 → 발견 → 짧은 감정

${isRecipe ? `[레시피 추가 규칙]\n- 맛 표현은 '너무 맛있어' '개맛있네ㅋㅋ'처럼 직접적으로 가능하다\n- 레시피를 길게 설명하지 않는다\n- 자연스러울 때 마지막에 '비밀 재료는 댓글에 적어둘게' 또는 '재료는 댓글에 적어둘게' 사용 가능` : `[일반상품 추가 규칙]\n- 기능을 3개씩 나열하지 않는다\n- 억지 구매 권유 금지\n- 댓글 유도를 억지로 붙이지 않는다`}

[스타일 기준 예시]
${getExamples(isRecipe)}

예시의 사실이나 문장을 복사하지 말고 말투 강도 호흡 줄바꿈 방식만 따라라
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
}

async function callRewrite(apiKey, source, originals, isRecipe, retry = false) {
  const retryInstruction = retry
    ? `\n\n[재시도 강제 규칙]\n직전 결과는 AI 후기 말투라 탈락했다\n설명과 총평을 전부 버려라\n실제 Threads 사람이 바로 반응한 말투로 다시 써라\n필요하면 ㅁㅊ ㅋㅋ ㅠㅠ 같은 표현을 자연스럽게 사용해라\n완전 짱 육즙 폭발 풍미 기대 안 했는데 난리야 추천해 같은 상투어는 절대 쓰지 마라\n각 줄 최대 28자\n1~2줄 뒤 빈 줄 하나`
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
        content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n광고 후기처럼 잘 쓰려고 하지 마\n실제 Threads에서 사람이 보고 바로 툭 쓴 것처럼 바꿔\n설명보다 반응을 먼저 쓰고 1~2줄마다 빈 줄을 넣어\n현재 글의 허구 경험이나 과장된 가족 반응은 원문 근거 없으면 반드시 제거해`,
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
      console.log(`[Threads][HUMAN TONE] 1차 탈락 ${rejectedIndexes.length}건 → 실제 스레드 말투 강제 재시도 indexes=${rejectedIndexes.join(',')}`);
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

console.log('[Threads][HUMAN TONE] v9 실제스레드축약어+AI후기상투어 강력차단');
