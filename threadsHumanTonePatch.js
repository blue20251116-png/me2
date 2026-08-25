const axios = require('axios');
const writer = require('./threadsMaterialWriter');
const { db, getAccount, getSystemApiSettings } = require('./db');

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

function firstLine(text) {
  return clean(text).split('\n').map(x => x.trim()).find(Boolean) || '';
}

function openingKey(text) {
  return firstLine(text)
    .replace(/[ㅋㅎㅠㅜ!?~;:]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 18)
    .toLowerCase();
}

function openingFamily(text) {
  const line = firstLine(text).replace(/[ㅋㅎㅠㅜ!?~;:]/g, '').trim();
  if (/^이거\s*(?:아이디어|조합|제품|물건)?.{0,12}(?:괜찮|신기|좋|대박|미쳤|뭐지)/.test(line)) return 'igeo-eval';
  if (/^이거\s*(?:처음|첨엔|처음엔)/.test(line)) return 'igeo-first';
  if (/^(?:처음엔|처음에는|첨엔).{0,18}(?:뭐지|별로|의심|몰랐|했는데|싶었)/.test(line)) return 'first-doubt';
  if (/^(?:요즘|최근에).{0,20}(?:하면서|보다가|보니까|쓰다가)/.test(line)) return 'recent-scene';
  if (/^(?:와|아니|진짜).{0,8}(?:이거|이게).{0,12}(?:대박|미쳤|신기|좋)/.test(line)) return 'reaction-hook';
  return '';
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
  if (/(?:한\s*번|한번)\s*(?:먹어|써|사용해|사|해)\s*(?:봐야|봐|보자)|꼭\s*(?:먹어|써|사용해|사|해)\s*봐|추천(?:해|한다)|구매(?:해|하자|각)/i.test(t)) return true;
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 10) return true;
  if (lines.some(x => /(모습이|느낌이|생각이|제품이|장면이|부분이|점이)$/.test(x))) return true;
  return false;
}

function getRecentOpenings(accountId) {
  try {
    const rows = db.prepare(`SELECT text FROM posts WHERE account_id=? AND text IS NOT NULL AND length(trim(text))>=6 ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 30`).all(accountId);
    return rows.map(row => firstLine(row.text)).filter(Boolean).slice(0, 20);
  } catch (e) {
    console.warn(`[Threads][HUMAN TONE] recent openings skipped: ${e.message}`);
    return [];
  }
}

function systemPrompt(isRecipe, recentOpenings = []) {
  const recent = recentOpenings.length
    ? `\n[최근 이 계정에서 이미 사용한 시작]\n${recentOpenings.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n- 위 문장을 바꿔 말하는 것도 금지한다\n- 첫 문장의 문법 골격까지 겹치지 않게 시작점을 바꾼다\n`
    : '';

  return `너는 한국 Threads에서 실제 사람이 폰으로 바로 올리는 글만 만드는 최종 말투 편집기다
광고문 후기문 블로그문처럼 완성하면 실패다
사람이 순간적으로 떠오른 말 몇 줄만 적고 끝내는 느낌을 우선한다

[핵심]
- 한 장면 한 반응 한 생각만 남겨도 된다
- 기승전결을 만들지 않는다
- 후킹 상황설명 장점 추천 CTA를 차례대로 채우지 않는다
- 사진이나 영상이 보여주는 것을 다시 설명하지 않는다
- 상품명 장점 기능부터 시작하지 않는다
- 모든 글을 의심했다가 확인하는 이야기로 만들지 않는다
- '이거 → 처음엔/뭐지 → 근데/보니까 → 생각보다' 골격을 기본값으로 쓰지 않는다
- '이거 아이디어 괜찮다' '이 조합은 신기하다' 같은 대상평가형 첫 문장을 기본값으로 쓰지 않는다
- 시작은 구체적인 상황 행동 결과 실수 관찰 짧은 반응 중 소재가 가진 가장 자연스러운 한 지점에서 바로 시작한다
- 같은 배치의 items는 첫 문장 시작 단어와 문장 골격이 서로 달라야 한다
- 억지로 매끄럽게 마무리하지 말고 필요한 말이 끝나면 끝낸다

[말투]
- 자연스러운 반말
- 음슴체 금지
- ~함 ~임 ~됨 ~없음 ~있음 같은 종결 금지
- ~냐 종결 금지
- 존댓말 금지
- 마침표 금지
- 쉼표 금지
- ㅋㅋ ㅋㅋㅋ ㅠㅠ ;; ㄷㄷ는 감정이 생기는 자리에서만 선택적으로 쓴다
- 모든 글 첫 줄에 ㅋㅋ를 붙이지 않는다
- 모든 문장을 같은 어미로 끝내지 않는다
- 문법적으로 지나치게 매끈하게 정리하지 않는다

[금지되는 AI 상투 구조]
- 감탄 → 상황 설명 → 장점 → 추천
- 문제 → 해결 → 장점 → 구매권유
- 발견 → 의심 → 확인 → 감탄을 매번 반복
- '처음엔 뭐지 싶었는데' '처음엔 별 기대 없었는데'를 습관적으로 사용
- 마지막에 총평 추천 질문 CTA 붙이기
- 활용도 실용적 효율적 간편하게 누구나 쉽게 강추 무조건 추천 놓치면 후회 같은 광고어

[줄바꿈]
- 2~6개의 짧은 행을 우선하되 소재에 따라 달라져도 된다
- 의미가 이어지면 붙이고 장면이나 감정이 바뀔 때만 빈 줄을 사용할 수 있다
- 글마다 줄 수 문단 수 빈 줄 위치를 같게 맞추지 않는다

[사실성]
- 원문에 직접 구매 사용 섭취 경험이 없으면 내가 샀다 써봤다 먹어봤다처럼 만들지 않는다
- 입력 근거 없이 엄마 친구 남편 아내 같은 제3자 추천 구매 경위를 만들지 않는다
- 건강식품은 확인되지 않은 효과 체험을 만들지 않는다
- 확인되지 않은 의학적 효능 가격 할인 성과를 단정하지 않는다

${isRecipe ? `[레시피]\n- 조리 순서를 본문에 다 넣지 않는다\n- 결과나 한 장면만으로 끝나도 된다\n- 맛 편의성 쉬움을 세트로 설명하지 않는다` : `[일반상품]\n- 기능을 나열하지 않는다\n- 제품 설명보다 장면이나 반응을 우선한다\n- 구매 권유와 억지 댓글 유도 금지`}
${recent}
[중요]
구체적인 예문을 흉내내지 말고 입력 소재에서만 말투와 장면을 만든다
JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
}

async function callRewrite(apiKey, source, originals, isRecipe, recentOpenings, retry = false) {
  const retryInstruction = retry
    ? `\n\n[재시도]\n직전 결과는 최근 글과 오프닝이 겹치거나 정형적인 AI 골격이라 탈락했다\n첫 문장의 시작점 자체를 바꿔라\n'이거 + 평가' '처음엔 + 의심' '근데 + 확인' 골격을 피하고 한 장면이나 한 반응만 남겨라`
    : '';

  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: retry ? 1.02 : 0.96,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt(isRecipe, recentOpenings) + retryInstruction },
      { role: 'user', content: `[원문 사실 자료]\n${source}\n\n[현재 생성문]\n${originals}\n\n현재 생성문의 구조를 보존하지 마\n각 item은 서로 다른 시작점과 호흡으로 다시 써\n특히 첫 문장을 같은 표현이나 같은 문법 골격으로 반복하지 마\n음슴체는 쓰지 마` },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 30000,
  });

  const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function duplicateIndexes(items, recentOpenings) {
  const recentKeys = new Set(recentOpenings.map(openingKey).filter(Boolean));
  const recentFamilies = new Set(recentOpenings.map(openingFamily).filter(Boolean));
  const seenKeys = new Set();
  const seenFamilies = new Set();
  const rejected = [];

  items.forEach((item, idx) => {
    const text = item?.text || '';
    const key = openingKey(text);
    const family = openingFamily(text);
    let bad = basicReject(text);
    if (key && (recentKeys.has(key) || seenKeys.has(key))) bad = true;
    if (family && (recentFamilies.has(family) || seenFamilies.has(family))) bad = true;
    if (bad) rejected.push(idx + 1);
    else {
      if (key) seenKeys.add(key);
      if (family) seenFamilies.add(family);
    }
  });
  return rejected;
}

async function rewriteBatch(accountId, sourceText, mode, items) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey || !Array.isArray(items) || !items.length) return items;

  const isRecipe = mode === 'recipe';
  const source = String(sourceText || '').slice(0, 4500);
  const originals = items.map((x, i) => `${i + 1}. ${String(x.text || '').replace(/\n/g, ' / ')}`).join('\n');
  const recentOpenings = getRecentOpenings(accountId);

  try {
    const first = await callRewrite(apiKey, source, originals, isRecipe, recentOpenings, false);
    const firstMap = new Map(first.map(x => [Number(x.index), clean(x.text)]));
    const staged = items.map((item, idx) => ({ ...item, text: firstMap.get(idx + 1) || item.text }));
    const rejectedIndexes = duplicateIndexes(staged, recentOpenings);

    let retryMap = new Map();
    if (rejectedIndexes.length) {
      console.log(`[Threads][HUMAN TONE] 1차 탈락 ${rejectedIndexes.length}건 → 오프닝/골격 중복 재시도 indexes=${rejectedIndexes.join(',')}`);
      const retryOriginals = rejectedIndexes.map(i => `${i}. ${String(staged[i - 1]?.text || '').replace(/\n/g, ' / ')}`).join('\n');
      const retried = await callRewrite(apiKey, source, retryOriginals, isRecipe, recentOpenings, true);
      retryMap = new Map(retried.map(x => [Number(x.index), clean(x.text)]));
    }

    const acceptedKeys = new Set(recentOpenings.map(openingKey).filter(Boolean));
    const acceptedFamilies = new Set(recentOpenings.map(openingFamily).filter(Boolean));

    return items.map((item, idx) => {
      const index = idx + 1;
      const candidates = [firstMap.get(index), retryMap.get(index)].filter(Boolean);
      for (const candidate of candidates) {
        const key = openingKey(candidate);
        const family = openingFamily(candidate);
        if (basicReject(candidate)) continue;
        if (key && acceptedKeys.has(key)) continue;
        if (family && acceptedFamilies.has(family)) continue;
        if (key) acceptedKeys.add(key);
        if (family) acceptedFamilies.add(family);
        return { ...item, text: candidate };
      }
      console.warn(`[Threads][HUMAN TONE] ${index}번 중복/문체 검사 탈락 → 기존 생성문 유지`);
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
  console.log(`[Threads][HUMAN TONE] 최종 다양화 스레드 말투 적용 mode=${result.mode} items=${result.items.length}`);
  return result;
};

console.log('[Threads][HUMAN TONE] v15 recent-opening diversity · 음슴체 금지');
