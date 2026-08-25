'use strict';

const axios = require('axios');
const writer = require('./threadsMaterialWriter');
const { getAccount, getSystemApiSettings } = require('./db');

if (!global.__ME2_LIFESTYLE_STORY_TONE__) {
  global.__ME2_LIFESTYLE_STORY_TONE__ = true;

  const originalGenerate = writer.generateFromThreadsMaterial.bind(writer);

  function getOpenAIKey(accountId) {
    const account = getAccount(accountId);
    const shared = getSystemApiSettings();
    return shared.openai_api_key || process.env.OPENAI_API_KEY || account?.openai_api_key || null;
  }

  function clean(v) {
    return String(v || '')
      .replace(/\r/g, '')
      .replace(/,/g, '')
      .replace(/(^|[^0-9])\.(?![0-9])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function badEnding(text) {
    return /(?:함|임|됨|없음|있음|같음|보임|살아남|끝남|바뀜|사라짐|좋음|쉬움|편함|겠)(?=$|\s|[!?~ㅋㅎㅠㅜ])/m.test(String(text || ''));
  }

  function storyPrompt(specialStory) {
    return `너는 한국 Threads의 일상 썰을 쓰는 사람이다
이 글은 상품소개가 아니라 일상 이야기여야 한다
성과가 좋았던 위프형 글의 원칙만 사용한다: 구체적인 생활 상황이나 강한 반응이 먼저 나오고 상품은 이야기 중후반에 자연스럽게 끼어들며 마지막은 사람의 반응이나 여운으로 끝난다
위프 글의 문장이나 소재를 복제하지 말고 현재 입력 사실만 사용한다

[절대 규칙]
- 사진이나 영상이 없어도 글만 읽어서 상황과 대상이 이해되어야 한다
- 첫 문장부터 상품명 기능 장점으로 시작하지 않는다
- '와 이거 진짜 신기해' '이거 아이디어 괜찮다' 같은 상품평가형 시작 금지
- 상품 설명 → 기능 → 장점 순서 금지
- 편하다 유용하다 간편하다 분위기가 살아난다 추천한다 같은 광고식 총평 금지
- 제품 스펙과 장점을 나열하지 않는다
- 본문의 중심은 사람의 상황 반응 생각이다
- 상품은 필요한 만큼만 등장시키고 특징은 이야기와 직접 연결되는 1개 정도만 사용한다
- 원문에 없는 구매 사용 섭취 경험을 만들지 않는다
- 원문에 없는 남편 아내 아이 엄마 친구 직장동료 반려동물 같은 인물을 만들지 않는다
- 원문에 없는 퇴근 출근 육아 집들이 며칠 사용 같은 사건을 만들지 않는다
- 사실이 부족하면 가짜 사건을 채우지 말고 '보고 알게 된 것/눈에 들어온 장면/그에 대한 생각'만으로 자연스럽게 전개한다
- 음슴체 금지: ~함 ~임 ~됨 ~없음 ~있음 ~같음 ~살아남 같은 종결 금지
- '~냐' 종결 금지
- 마침표와 쉼표 금지
- ㅋㅋ는 자연스러운 곳에만 사용한다
- 같은 말을 표현만 바꿔 반복하지 않는다
- CTA 구매권유 질문으로 끝내지 않는다

[길이와 호흡]
- ${specialStory ? '특수상품 일상썰은 7~12개의 짧은 문장으로 충분한 서사를 만든다' : '순수 일상형은 6~10개의 짧은 문장으로 쓴다'}
- 2~3문장마다 의미가 바뀌면 빈 줄을 둘 수 있다
- 억지 기승전결이나 소설을 만들지 않는다
- 짧은 Threads 썰 여러 문장이 자연스럽게 이어지는 느낌으로 쓴다

[목표]
독자가 첫 부분을 읽을 때 광고나 상품소개라고 느끼지 않아야 한다
끝까지 읽고 나면 무슨 물건/상황인지 알 수 있어야 하지만 판매문처럼 보이면 실패다

JSON만 출력한다
{"items":[{"index":1,"text":""}]}`;
  }

  async function rewriteLifestyle(accountId, args, result) {
    const apiKey = getOpenAIKey(accountId);
    if (!apiKey || !Array.isArray(result?.items) || !result.items.length) return result;
    const specialStory = args?.analysis?.specialStory === true;
    const source = String(args?.sourceText || '').slice(0, 5000);
    const current = result.items.map((x, i) => `${i + 1}. ${String(x?.text || '').replace(/\n/g, ' / ')}`).join('\n');

    try {
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        temperature: 0.92,
        max_tokens: 2200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: storyPrompt(specialStory) },
          { role: 'user', content: `[원문 사실 자료]\n${source}\n\n[현재 생성문 - 사실 참고만 하고 구조는 버릴 것]\n${current}\n\n현재 생성문의 상품소개 구조를 보존하지 마라\n원문에서 확인되는 사실만으로 사진 없이도 읽히는 일상 썰로 다시 써라` }
        ]
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        timeout: 30000
      });

      const parsed = JSON.parse(r.data?.choices?.[0]?.message?.content || '{}');
      const map = new Map((Array.isArray(parsed.items) ? parsed.items : []).map(x => [Number(x.index), clean(x.text)]));
      result.items = result.items.map((item, i) => {
        const candidate = map.get(i + 1);
        if (!candidate || badEnding(candidate)) return item;
        const lines = candidate.split('\n').map(x => x.trim()).filter(Boolean);
        if (lines.length < 6 || lines.length > 12) return item;
        return { ...item, text: candidate };
      });
      result.texts = result.items.map(x => x.text);
      console.log(`[Threads][LIFESTYLE STORY] 위프형 사람중심 서사 적용 specialStory=${specialStory ? 'ON' : 'OFF'} items=${result.items.length}`);
      return result;
    } catch (e) {
      console.warn(`[Threads][LIFESTYLE STORY] 재작성 실패 → 기존 본문 유지 reason="${e.response?.data?.error?.message || e.message}"`);
      return result;
    }
  }

  writer.generateFromThreadsMaterial = async function lifestyleStoryGenerate(accountId, args = {}) {
    const result = await originalGenerate(accountId, args);
    if (result?.mode !== 'lifestyle') return result;
    return rewriteLifestyle(accountId, args, result);
  };

  console.log('[Threads][LIFESTYLE STORY] v1 위프형 · 사진없이 완결 · 상품소개 금지 · 6~12문장');
}
