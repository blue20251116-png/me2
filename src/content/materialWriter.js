'use strict';
const { voiceGuide, formatVoice, assertVoice, reviewSourceVoice } = require('./voicePolicy');
const { pickPersona } = require('./personas');
const { getAccount, getSystemApiSettings } = require('../infra/db');
const { callAIJson } = require('../integrations/aiClient');

function getAiKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.anthropic_api_key || process.env.ANTHROPIC_API_KEY || account?.anthropic_api_key || null;
}

function stripAffiliateNoise(value, { preserveLines = true } = {}) {
  let s = String(value || '');
  if (!s.trim()) return '';
  s = s
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:link\.coupang\.com|naver\.me|brandconnect\.naver\.com|m\.site\.naver\.com)\/\S*/gi, ' ')
    .replace(/\[?광고\]?\s*/gi, ' ')
    .replace(
      /(?:이\s*포스팅은|본\s*포스팅은)?\s*쿠팡\s*파트너스[^\n.!?]*(?:제공받습니다|받습니다|발생합니다)\.?/gi,
      ' '
    )
    .replace(/네이버\s*쇼핑\s*커넥트[^\n.!?]*(?:제공받을\s*수\s*있습니다|받습니다)?\.?/gi, ' ')
    .replace(/^\s*스레드\s*조회\s*[\d.,천만억]+회\s*/gim, '')
    .replace(/^(?:인기순|최신순|전체)\s*/gim, '')
    // Scraped Threads action-button row: 2+ of 좋아요/답글/리포스트/공유 back-to-back (with counts) and not
    // attached to other Hangul. Single words stay, since they are ordinary words in real sentences.
    .replace(/(?<![가-힣])(?:(?:좋아요|답글|리포스트|공유)[\s,·|0-9]*){2,}(?![가-힣])/g, ' ');
  if (preserveLines)
    return s
      .split(/\r?\n/)
      .map(x => x.replace(/[ \t]{2,}/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  return s.replace(/\s+/g, ' ').trim();
}

function sanitizeAuthorReplies(value) {
  const raw = stripAffiliateNoise(value, { preserveLines: true });
  return raw
    .split(/\n\n+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2)
    .slice(0, 8)
    .join('\n\n');
}
function sanitizeGeneratedComment(value) {
  return stripAffiliateNoise(value, { preserveLines: true }).trim();
}
// Recipe detection needs cooking-process verbs or measurements; "썰" alone is excluded because
// knife/cutting-board reviews use it too.
function detectRecipe(sourceText, authorReplies, requestedMode) {
  if (requestedMode === 'recipe') return true;
  const t = `${sourceText}\n${authorReplies}`.toLowerCase();
  return (
    /(레시피|재료|양념|소스|계란|두부|고기|밥|면|요리)/.test(t) &&
    /(볶|굽|끓|튀기|찜|삶|섞|큰술|작은술|스푼|ml|\bg\b)/i.test(t)
  );
}

async function generateFromThreadsMaterial(
  accountId,
  {
    keyword,
    sourceText,
    authorReplies = '',
    mode = 'product',
    visualEvidence = '',
    imageSummary = '',
    videoSummary = '',
  }
) {
  const apiKey = getAiKey(accountId);
  if (!apiKey) throw new Error('관리자 Anthropic API 키가 설정되어 있지 않습니다.');
  const cleanedSource = stripAffiliateNoise(sourceText, { preserveLines: true });
  const cleanedReplies = sanitizeAuthorReplies(authorReplies);
  const isRecipe = detectRecipe(cleanedSource, cleanedReplies, mode);
  const multimodal = [visualEvidence, imageSummary, videoSummary].filter(Boolean).join('\n').slice(0, 6000);
  const persona = pickPersona({
    mode: isRecipe ? 'recipe' : mode,
    text: `${keyword || ''} ${cleanedSource} ${cleanedReplies}`,
  });
  console.log(
    `[Threads][VIRAL WRITER] persona picked="${persona.name}"(${persona.id}) mode=${isRecipe ? 'recipe' : mode}`
  );

  const system = `${voiceGuide(persona.block)}
[작업]
- 원문·작성자 추가설명·사진/영상 분석을 하나의 소재로 먼저 이해한다.
- 가장 바이럴 가능성이 높은 각도 하나를 고른다.
- 원문 요약이 아니라 그 각도를 중심으로 새 Threads 글처럼 쓴다.
- 저위험 리액션, 비유, 상황 연출, 후킹 장치는 자유롭게 추가할 수 있다.
- text는 빈 줄 포함 최대 14줄이다. 줄은 글자수가 아니라 완결된 문장/절 단위로 나눈다. 짧으면 더 짧게 끝낸다.
- URL/광고 UI 텍스트는 출력하지 않는다.
${isRecipe ? '- 레시피에서 핵심 재료를 숨기는 편이 자연스러울 때만 본문에서 숨기고 comment에 실제 정보를 공개한다.' : '- 댓글 공개 장치를 억지로 넣지 않는다.'}
후보 5개는 서로 다른 바이럴 각도나 훅을 시험한다.
JSON만 출력: {"items":[{"text":"본문","comment":"댓글"}]}`;

  const user = `키워드:${String(keyword || '').trim()}\n[원문]\n${cleanedSource.slice(0, 6000)}\n[작성자 추가설명]\n${cleanedReplies.slice(0, 4000)}\n[사진/영상 이해]\n${multimodal || '(별도 분석 없음)'}\n전체 입력을 이해한 뒤 가장 강한 바이럴 포인트로 써라.`;
  const parsed = await callAIJson(apiKey, {
    system,
    userContent: user,
    maxTokens: 3000,
    temperature: 0.82,
    timeout: 45000,
  });
  const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 5) : [];
  const accepted = [];
  for (const x of items) {
    try {
      let text = formatVoice(x?.text || '');
      text = await reviewSourceVoice(
        text,
        {
          mode: isRecipe ? 'recipe' : 'product',
          sourceText: cleanedSource,
          authorReplies: cleanedReplies,
          visualEvidence: multimodal,
        },
        async (system, user) => {
          return callAIJson(apiKey, { system, userContent: user, maxTokens: 900, temperature: 0.15, timeout: 30000 });
        }
      );
      text = assertVoice(text, { mode: isRecipe ? 'recipe' : 'product' });
      const comment = sanitizeGeneratedComment(x?.comment || '');
      accepted.push({ text, comment });
    } catch (e) {
      if (e.code !== 'CONTENT_STYLE_REJECTED') throw e;
      console.warn(`[Threads][VIRAL WRITER] candidate omitted: ${e.message}`);
    }
  }
  if (!accepted.length) {
    const e = new Error('Threads 바이럴 글쓰기 검증을 통과한 후보가 없습니다');
    e.code = 'CONTENT_STYLE_REJECTED';
    throw e;
  }
  return {
    mode: isRecipe ? 'recipe' : 'product',
    persona: persona.id,
    items: accepted,
    texts: accepted.map(x => x.text),
    comments: accepted.map(x => x.comment),
  };
}

module.exports = { generateFromThreadsMaterial, detectRecipe, stripAffiliateNoise };
