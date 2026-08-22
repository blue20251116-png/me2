const axios = require('axios');
const engine = require('./autopilotMaterialEngine');
const { getAccount, getSystemApiSettings } = require('./db');

const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function getOpenAIKey(accountId) {
  const account = getAccount(accountId);
  const shared = getSystemApiSettings();
  return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .split('\n')
    .map(x => x.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mergeAwkwardLineBreaks(text) {
  const raw = clean(text);
  if (!raw) return raw;
  const source = raw.split('\n');
  const out = [];
  const danglingEnd = /(은|는|이|가|을|를|도|만|에|의|와|과|로|으로|부터|까지|해서|하고|는데|니까|면|지만|다가|거나|처럼|보다|정도|기분도|생각도|마음도|때문에|보니까|하면서|쓰면|먹으면)$/;
  const fragmentStart = /^(같아|같네|같아서|같으니까|좋고|좋아|있어|없어|했어|돼|되고|해서|하고|보여|보이고|느껴|느낌이|때문에|정도라|정도고)/;
  const shortBridge = /^(매일|매번|요즘|그냥|진짜|이거|그래서|근데|그런데|그리고|오히려|때문에|보니까)$/;

  for (let i = 0; i < source.length; i++) {
    const line = source[i].trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    let prevIndex = out.length - 1;
    while (prevIndex >= 0 && out[prevIndex] === '') prevIndex--;
    const prev = prevIndex >= 0 ? out[prevIndex] : '';
    if (prev && (danglingEnd.test(prev) || shortBridge.test(prev) || fragmentStart.test(line))) {
      out[prevIndex] = `${prev} ${line}`.trim();
      out.splice(prevIndex + 1);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeParagraphs(text) {
  const t = mergeAwkwardLineBreaks(text);
  if (!t) return t;
  const lines = t.split('\n').map(x => x.trim());
  const content = lines.filter(Boolean);
  if (content.length <= 3) return content.join('\n');
  if (/\n\s*\n/.test(t)) return t;
  // 고정 2줄 단위 분할 금지: 짧은 글은 1+나머지 또는 2+나머지로만 자연스럽게 호흡을 준다
  if (content.length === 4) return `${content[0]}\n${content[1]}\n\n${content[2]}\n${content[3]}`;
  if (content.length === 5) return `${content[0]}\n${content[1]}\n\n${content.slice(2).join('\n')}`;
  return content.join('\n');
}

function hasHook(text, mode) {
  const lines = mergeAwkwardLineBreaks(text).split('\n').map(x => x.trim()).filter(Boolean);
  if (!lines.length) return false;
  const first = lines.slice(0, 2).join(' ');
  const hookSignals = /(?:ㅋㅋ+|ㅎㅎ+|ㅁㅊ|ㄷㄷ+|;;+|존맛탱|미쳤|골\s*때리|뭐야|왜\s*이제|왜\s*몰랐|처음엔|아니|와\s|헐|신박|반칙|못\s*참|궁금|놀랐|이걸\s*이렇게|이런\s*게|대박|선\s*넘|생각한\s*사람)/i;
  const curiosity = /(?:알고\s*보니|봤는데|보니까|열어봤|성분표|정체|비밀|핵심|문제|결과|이유|조합)/i;
  const dryStart = /^(?:가방에|버튼을?|뚜껑|제품은|이 제품|사용하면|재료는|만드는 법|특징은|기능은|들고 다니|보관|설거지|식단 관리|와인 안주로)/;
  if (hookSignals.test(first) || curiosity.test(first)) return true;
  if (dryStart.test(first)) return false;
  // 레시피/상품 모두 첫 두 줄에 반응·의외성·궁금증이 없으면 약한 후킹으로 본다
  return first.length <= 32 && /[!?~]/.test(first);
}

function rejectReasons(text, mode) {
  const t = mergeAwkwardLineBreaks(text);
  const reasons = [];
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);

  if (!t) reasons.push('empty');
  if (lines.length < 3 || lines.length > 10) reasons.push('line-count');
  if (lines.some(x => x.length > 52)) reasons.push('long-line');
  if (!hasHook(t, mode)) reasons.push('weak-hook');
  if (lines.some(x => /^(?:같아|같네|같음|ㅋㅋ+|ㅎㅎ+|ㅠ+|ㅜ+|ㄷㄷ+|추천해|적을게|남길게)$/i.test(x))) reasons.push('orphan-fragment');
  if (lines.some(x => /^(?:매일|매번|요즘|그냥|진짜|그래서|근데|그런데|그리고|오히려|때문에|보니까)$/i.test(x))) reasons.push('orphan-bridge');

  if (/(?:입니다|합니다|됩니다|하세요|해보세요|추천드립니다|수 있습니다)/.test(t)) reasons.push('formal-tone');
  if (/완전\s*짱|육즙(?:이)?\s*폭발|풍미|완벽한\s*조화|한층\s*더|매력적인|특별한\s*(?:메뉴|식사|한\s*끼)|입맛을\s*사로잡|감칠맛을\s*더해/i.test(t)) reasons.push('ai-review');
  if (/이거\s*없(?:인|으면).*못\s*살|없으면\s*안\s*될|놓치면\s*후회|강추|무조건\s*(?:사|먹|써|추천)|꼭\s*(?:사|먹|써).*봐/i.test(t)) reasons.push('cta-review');
  if (/간편하게|활용도|실용적|효율적|편리하|장점(?:이야|이다)|포인트인\s*듯|이런\s*거\s*찾던\s*사람|한번\s*(?:써|먹|사용)보면\s*좋을\s*것\s*같/i.test(t)) reasons.push('product-copy');
  if (/세정력\s*미쳤|통증이\s*사라|수술\s*없이.*관리|이게\s*실화야/i.test(t)) reasons.push('template-hype');
  if (/(?:애들|엄마들|친구|남편|언니|주변\s*사람|다들).{0,45}(?:난리|바로\s*주문|사달|계속\s*해달|맛있다고|추천해줬|물어보)/i.test(t)) reasons.push('social-proof-story');
  if (/[가-힣]+냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('nya-ending');
  if (/(?:했|됐|왔|갔|봤|먹었|썼|샀|좋았|괜찮았|편했|있었|없었|겠|있|없|좋|편)음(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('generic-eumseum');
  if (/[가-힣]+더라(?:고|구|니까|며|면)?(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(t)) reasons.push('deora-experience');
  if (/눈여겨보는\s*중|두고\s*쓰는\s*중|계속\s*쓰는\s*중|요즘\s*이것만|매일\s*쓰는\s*중|먹는\s*중/i.test(t)) reasons.push('invented-observer-experience');

  return [...new Set(reasons)];
}

function promptFor(mode) {
  const recipe = mode === 'recipe';
  return `너는 한국 Threads에서 실제 사람이 스크롤하다 바로 적은 것 같은 글을 만드는 최종 편집기다
광고 카피 블로그 후기 상품 설명문처럼 쓰면 실패다

[가장 중요: 첫 1~2줄 후킹]
- 첫 줄부터 기능 설명으로 시작하지 마라
- 첫 1~2줄에는 반드시 스크롤을 멈출 이유가 있어야 한다
- 발견 반응 의외성 문제 궁금증 결과 중 하나로 시작해라
- 예: 와 이걸 왜 이제 알았지ㅋㅋ / 아니 이 조합 뭐야ㅋㅋ / 성분표 보다가 좀 놀람 / 처음엔 별거 아닌 줄 알았는데;;
- 위 예문을 그대로 반복하지 말고 소재 사실에 맞게 변형해라
- 근거 없는 충격 과장이나 경험은 만들지 마라

[말투]
- 현재 입력의 사실은 유지하고 문체 문제만 고쳐라
- 입력이 이미 자연스러우면 살아 있는 표현을 최대한 보존해라
- ㅋㅋ ㅋㅋㅋ ㅁㅊ ;; ㄷㄷ 존맛탱 같은 반응어는 소재에 맞을 때 0~2개만 자연스럽게 사용 가능하다
- 모든 글에 같은 반응어를 반복하지 마라
- 직접 써봤다 먹어봤다 샀다 며칠 썼다 같은 경험을 새로 만들지 마라
- ~더라 ~더라고 ~낫더라 ~좋더라 ~편하더라 금지
- 눈여겨보는 중 두고 쓰는 중 요즘 이것만 같은 허구 경험 금지

[줄바꿈]
- 줄바꿈은 글자 수가 아니라 의미 단위로만 한다
- 하나의 문장을 중간에서 억지로 자르지 마라
- 조사 연결어 부사만 다음 줄에 혼자 남기지 마라
- 매일 매번 요즘 그냥 진짜 그래서 근데 그런데 그리고 오히려 때문에 보니까 같은 말이 혼자 한 줄이면 실패다
- 3~6줄을 우선하고 짧은 글은 빈 줄 없이 3줄도 가능하다
- 문단이 필요하면 1+2 2+1 2+2 1+3 등 내용에 맞춰 선택한다
- 매번 똑같은 2줄+빈줄+2줄 패턴을 만들지 마라
- 한 줄은 자연스러우면 52자까지 허용한다

[금지]
- 존댓말
- ~냐
- 일반 음슴체 좋음 편함 했음 됐음 있음 없음
- ~더라 계열
- 문장 끝 마침표와 쉼표
- 간편하게 활용도 실용적 효율적 편리하다 장점 포인트
- 진짜 맛있는 다이어트식 같은 광고식 정의
- ~하는 법 ~찾는다면 이거지 같은 제목형 광고문
- 생각보다 훨씬 괜찮다 같은 AI 후기 상투어
- 허구의 주변인 반응과 허구의 사용 경험
${recipe ? '- 레시피는 원문 핵심 재료와 조리 사실을 보존하고 비밀 재료를 임의로 만들지 마라\n- 재료나 만드는 법은 필요할 때 댓글로 짧게 연결할 수 있다' : '- 일반 상품은 구매 권유나 억지 댓글 유도 없이 자연스럽게 끝낸다'}

JSON만 출력
{"text":""}`;
}

async function rewriteOnce(apiKey, currentText, mode, reasons) {
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    temperature: 0.9,
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: promptFor(mode) },
      { role: 'user', content: `[현재 AutopilotV3 생성문]\n${currentText}\n\n[검수 실패 이유]\n${reasons.join(', ')}\n\n검수에 걸린 부분만 자연스럽게 고쳐라\n특히 weak-hook이면 첫 1~2줄만 더 강하게 만들고 사실은 추가하지 마라\n줄바꿈은 의미 단위로 다시 정리해라\n이미 살아 있는 반응형 말투는 보존해라` },
    ],
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    timeout: 30000,
  });
  const raw = r.data?.choices?.[0]?.message?.content;
  const parsed = raw ? JSON.parse(raw) : {};
  return normalizeParagraphs(parsed.text || '');
}

engine.buildThreadsFirstAutopilot = async function patchedBuildThreadsFirstAutopilot(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;

  const current = normalizeParagraphs(result.text);
  const reasons = rejectReasons(current, result.mode);

  if (reasons.length === 0) {
    console.log(`[AutopilotV3][HUMAN FINAL] v7 PASS-NO-REWRITE preview="${current.slice(0,160).replace(/\n/g,' / ')}"`);
    return { ...result, text: current };
  }

  const apiKey = getOpenAIKey(accountId);
  if (!apiKey) throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] OpenAI key 없음 reasons=${reasons.join(',')}`);

  try {
    const rewritten = await rewriteOnce(apiKey, current, result.mode, reasons);
    const fixed = normalizeParagraphs(rewritten);
    const nextReasons = rejectReasons(fixed, result.mode);
    console.log(`[AutopilotV3][HUMAN FINAL] v7 ONE-REWRITE reasons=${nextReasons.join(',') || 'PASS'} preview="${fixed.slice(0,160).replace(/\n/g,' / ')}"`);
    if (fixed && nextReasons.length === 0) return { ...result, text: fixed };
    throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 1회 교정 후에도 실패 reasons=${nextReasons.join(',') || 'unknown'}`);
  } catch (e) {
    if (/AUTOPILOT HUMAN TONE HARD REJECT/.test(String(e.message || ''))) throw e;
    console.warn(`[AutopilotV3][HUMAN FINAL] v7 rewrite error=${e.response?.data?.error?.message || e.message}`);
    throw new Error(`[AUTOPILOT HUMAN TONE HARD REJECT] 최종 말투 교정 호출 실패 reasons=${reasons.join(',')}`);
  }
};

console.log('[AutopilotV3][HUMAN FINAL] v7 hook+semantic-linebreak loaded');