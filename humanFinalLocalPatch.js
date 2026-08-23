'use strict';

const engine = require('./autopilotMaterialEngine');
const originalBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/,/g, '')
    .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function localFix(text) {
  let s = clean(text);

  s = s
    .replace(/하더라고/g, '해')
    .replace(/했더라고/g, '했어')
    .replace(/더라고/g, '')
    .replace(/하더라/g, '해')
    .replace(/했더라/g, '했어')
    .replace(/좋더라/g, '좋아')
    .replace(/편하더라/g, '편해')
    .replace(/더라/g, '')
    .replace(/했음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '했어')
    .replace(/됐음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '됐어')
    .replace(/있음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '있어')
    .replace(/없음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '없어')
    .replace(/좋음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '좋아')
    .replace(/편함(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '편해')
    .replace(/개맛있음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '개맛있어')
    .replace(/미쳤음(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '미쳤어')
    .replace(/대박임(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '대박이야')
    .replace(/거임(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '거야')
    .replace(/뭐냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '뭐지')
    .replace(/거냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '건가')
    .replace(/없냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '없나')
    .replace(/맞냐(?=$|\s|[!?~ㅋㅎㅠㅜ])/g, '맞나');

  // AI가 원문 근거 없이 만들기 쉬운 관계/성과 문구를 로컬에서 제거한다.
  s = s
    .replace(/(?:남자친구|남편|아내|친구|언니|엄마|아빠|지인|주변 사람들?|다들).{0,35}(?:맛있다고|좋다고|난리(?:가 났어|났어|나더라|야)?|바로 주문|사달라고|추천해줬어)/g, '')
    .replace(/(?:나도\s*)?\d+(?:\.\d+)?\s*(?:주|일|개월)째\s*(?:먹고|쓰고|사용하고)[^\n]{0,45}?\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량|뺐)[^\n]*/gi, '')
    .replace(/\d+(?:\.\d+)?\s*kg\s*(?:빠졌|감량|뺐)[^\n]*/gi, '');

  const lines = s.split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^(?:ㅋㅋ+|ㅎㅎ+|ㄷㄷ+|ㅠ+|ㅜ+|ㅁㅊ)[!?~]*$/i.test(line)) {
      if (out.length) out[out.length - 1] += ` ${line}`;
      continue;
    }
    out.push(line);
  }

  return out.slice(0, 7).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

engine.buildThreadsFirstAutopilot = async function humanFinalLocalBuild(accountId, args = {}) {
  const result = await originalBuild(accountId, args);
  if (!result?.text) return result;
  const fixed = localFix(result.text);
  console.log(`[AutopilotV3][HUMAN FINAL] v9 LOCAL-ONLY non-blocking preview="${fixed.slice(0,160).replace(/\n/g,' / ')}"`);
  return { ...result, text: fixed || clean(result.text) };
};

console.log('[AutopilotV3][HUMAN FINAL] v9 local-only · AI 재호출/HARD REJECT 비활성화');
module.exports = { localFix, clean };
