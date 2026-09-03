const { normalizeVoice, voiceGuide, voiceProblems } = require('./threadsVoicePolicy');
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
    .split('\n')
    .map(x => x.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
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
  const t = clean(text);
  return voiceProblems(t).length > 0 || /(?:좋음|있음|없음|했음|대박임|미쳤음|편함)(?=$|[\s.!?~ㅋㅎㅠㅜ])/m.test(t);
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

  return `너는 한국 Threads 최종 말투 편집기다.
${voiceGuide()}
${isRecipe ? '레시피 본문에 조리 순서를 모두 나열하지 않는다.' : '일반상품은 특징 목록보다 구체적인 장면과 반응을 우선한다.'}
${recent}
같은 배치에서 첫 문장과 감정의 위치를 다양하게 쓴다. 예문을 복사하지 않는다.
JSON만 출력: {"items":[{"index":1,"text":""}]}`;
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
    // A shared reaction word is not a duplicate; exact opening keys remain checked.
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
        // Do not reject a distinct scene just because it uses a reaction opening.
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
  result.items = await rewriteBatch(accountId, [args.sourceText, args.authorReplies].filter(Boolean).join('\n'), result.mode, result.items);
  result.texts = result.items.map(x => x.text);
  result.comments = result.items.map(x => x.comment);
  console.log(`[Threads][HUMAN TONE] 말투 편집 종료(실패 항목은 원문 유지, 최종 검사 대상) mode=${result.mode} items=${result.items.length}`);
  return result;
};

console.log('[Threads][HUMAN TONE] v15 recent-opening diversity · 음슴체 금지');

