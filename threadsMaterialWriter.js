const { normalizeVoice, voiceGuide, formatVoice, assertVoice, reviewSourceVoice } = require('./threadsVoicePolicy');
const axios = require('axios');
const { getAccount, getSystemApiSettings } = require('./db');

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function stripAffiliateNoise(value, { preserveLines = true } = {}) {
  let s = String(value || '');
  if (!s.trim()) return '';
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/\b(?:link\.coupang\.com|naver\.me|brandconnect\.naver\.com|m\.site\.naver\.com)\/\S*/gi, ' ');
  s = s.replace(/\[?광고\]?\s*/gi, ' ');
  s = s.replace(/(?:이\s*포스팅은|본\s*포스팅은)?\s*쿠팡\s*파트너스\s*활동의\s*일환으로\s*,?\s*이에\s*따른\s*일정액의\s*수수료를\s*(?:제공받습니다|받습니다)\.?/gi, ' ');
  s = s.replace(/(?:이\s*포스팅은|본\s*포스팅은)?\s*쿠팡\s*파트너스[^\n.!?]*(?:제공받습니다|받습니다|발생합니다)\.?/gi, ' ');
  s = s.replace(/네이버\s*쇼핑\s*커넥트[^\n.!?]*(?:제공받을\s*수\s*있습니다|받습니다)?\.?/gi, ' ');
  s = s.replace(/^\s*스레드\s*조회\s*[\d.,천만억]+회\s*/gim, '');
  s = s.replace(/^(?:인기순|최신순|전체)\s*/gim, '');
  s = s.replace(/(?:^|\s)@?[A-Za-z0-9._]{2,64}\s+(?:방금|\d+\s*(?:분|시간|일))\s*[·•]?\s*/g, ' ');
  s = s.replace(/\b(?:좋아요|답글|리포스트|공유)\b/g, ' ');
  if (preserveLines) {
    s = s.split(/\r?\n/).map(line => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

function cleanThreadsReplyBlock(value) {
  let s = stripAffiliateNoise(value, { preserveLines: false });
  if (!s) return '';
  const authorMatches = [...s.matchAll(/\b작성자\b\s*/g)];
  if (authorMatches.length) {
    const last = authorMatches[authorMatches.length - 1];
    s = s.slice(last.index + last[0].length).trim();
  }
  s = s.replace(/\s(?:\d+\s+){2,5}(?=@?[A-Za-z0-9._]{2,64}\s+(?:방금|\d+\s*(?:분|시간|일)))/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function sanitizeAuthorReplies(authorReplies) {
  const raw = String(authorReplies || '').trim();
  if (!raw) return '';
  const blocks = raw.split(/\n\n+/).map(cleanThreadsReplyBlock).filter(Boolean);
  const unique = [];
  for (const block of blocks) {
    if (block.length < 6) continue;
    if (!unique.includes(block)) unique.push(block);
  }
  return unique.slice(0, 8).join('\n\n');
}

function sanitizeGeneratedComment(value) {
  let s = stripAffiliateNoise(value, { preserveLines: true });
  if (!s) return '';
  s = s
    .replace(/\b(?:쿠파스|쿠팡)\s*링크\b\s*:?/gi, '')
    .replace(/^\s*✅\s*핵심만\s*$/gim, '')
    .split('\n')
    .map(line => line.replace(/(^|[^\d])\.(?=\s|$)/g, '$1').trim())
    .filter(Boolean)
    .join('\n');
  return s.replace(/\n{2,}/g, '\n').trim();
}

function cleanBodyPunctuation(value) { return formatVoice(value); }

function formatThreadsBody(value) {
  return formatVoice(stripAffiliateNoise(value, { preserveLines: true }));
}

function detectRecipe(sourceText, authorReplies, requestedMode) {
  if (requestedMode === 'recipe') return true;
  const t = `${String(sourceText || '')}\n${String(authorReplies || '')}`.toLowerCase();
  const food = /(레시피|재료|양념|소스|계란|두부|고기|삼겹|닭|버섯|밥|면|파스타|샌드위치|아보카도|채소|야채|국|찌개|볶음|구이|간식|요리)/.test(t);
  const action = /(만드는\s*법|만드는방법|볶|굽|끓|튀기|찜|삶|썰|섞|버무|에어프라이어|전자레인지|중약불|약불|강불|분\s*정도|큰술|작은술|\d+\s*(?:t|ml|g|개|스푼|큰술|작은술))/i.test(t);
  return food && action;
}

async function generateFromThreadsMaterial(accountId, { keyword, sourceText, authorReplies = '', mode = 'product' }) {
  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error('관리자 OpenAI API 키가 설정되어 있지 않습니다.');
  const cleanedSource = stripAffiliateNoise(sourceText, { preserveLines: true });
  const cleanedReplies = sanitizeAuthorReplies(authorReplies);
  const isRecipe = detectRecipe(cleanedSource, cleanedReplies, mode);

  const styleRules = `${voiceGuide()}
- 입력의 광고 고지 링크 작성자 UI 정보는 출력하지 않는다.
- text와 comment 어디에도 URL을 출력하지 않는다.`;

  const system = `${styleRules}
${isRecipe ? `[레시피 댓글]
🥘 재료 다음에 원문에서 확인된 재료와 계량을 쓴다
🍳 만드는 법 다음에 확인된 조리 순서를 쓴다
재료/단계 수를 채우려고 내용을 만들지 않는다` : '[일반상품 댓글] 추가 정보가 있으면 같은 말투로 짧게 보충하고 없으면 빈 문자열로 둔다'}
같은 원문으로 선택할 후보 5개를 만든다. 후보마다 시작 구조를 억지로 바꾸지 않는다. 표현과 선택적인 상황 한마디만 조금 다르게 한다.
JSON만 출력: {"items":[{"text":"본문","comment":"댓글"}]}`;
  const user = `키워드:${String(keyword||'').trim()}\n[원 게시물]\n${cleanedSource.slice(0,5000)}\n[작성자 추가 설명]\n${cleanedReplies.slice(0,5000)}\n원문 흐름을 살리고 필요한 상황 표현만 보태라. 새로운 사건이나 사용 경험은 만들지 마.`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini', temperature: isRecipe ? 0.32 : 0.72, max_tokens: isRecipe ? 4200 : 2600,
    response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, timeout: 45000 });

  const raw = res.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('AI 글 생성 결과가 비어 있습니다.');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed.items)
    ? parsed.items.map(x => ({ text: formatThreadsBody(x?.text || '', { isRecipe }), comment: sanitizeGeneratedComment(x?.comment) })).filter(x => x.text).slice(0, 5)
    : [];
  if (!items.length) throw new Error('AI 글 생성 결과를 읽지 못했습니다.');

  const accepted = [];
  for (const item of items) {
    try {
      item.text = await reviewSourceVoice(item.text,{mode:isRecipe?'recipe':'product',sourceText:cleanedSource,authorReplies:cleanedReplies},async(system,user)=>{
        const r=await axios.post('https://api.openai.com/v1/chat/completions',{
          model:'gpt-4o-mini',temperature:.15,max_tokens:1000,response_format:{type:'json_object'},
          messages:[{role:'system',content:system},{role:'user',content:user}]
        },{headers:{Authorization:`Bearer ${apiKey}`,'content-type':'application/json'},timeout:30000});
        return JSON.parse(r.data?.choices?.[0]?.message?.content||'{}');
      });
      item.comment = formatVoice(sanitizeGeneratedComment(item.comment));
      if (!isRecipe) {
        try{item.comment=assertVoice(item.comment,{comment:true,mode:'product'});}
        catch(e){if(e.code!=='CONTENT_STYLE_REJECTED')throw e;item.comment='';}
      }
      accepted.push(item);
    } catch(e) {
      if(e.code!=='CONTENT_STYLE_REJECTED')throw e;
      console.warn(`[Threads][SOURCE VOICE v2] candidate omitted: ${e.message}`);
    }
  }
  if(!accepted.length){const e=new Error('원문 기반 말투 검증을 통과한 후보가 없습니다');e.code='CONTENT_STYLE_REJECTED';throw e;}

  return { mode: isRecipe ? 'recipe' : 'product', items: accepted, texts: accepted.map(x => x.text), comments: accepted.map(x => x.comment) };
}

module.exports = { generateFromThreadsMaterial };


