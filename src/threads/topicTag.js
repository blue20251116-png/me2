'use strict';

// Threads topic tags (the `topic_tag` param on POST /me/threads, one tag per post) route a post
// to people who follow/engage with that topic instead of only this account's own followers - the
// single biggest reach lever a text-only change can't provide. Posts here never carried one, and
// the persona policy bans in-body hashtags, so every post went out untagged.
//
// Deterministic keyword mapping, not an AI call: it runs at publish time on the final text, costs
// nothing, and a wrong-but-plausible tag is harmless while a missing tag just means "same as
// before". Order matters - the first matching group wins, most specific first.
const TOPIC_RULES = [
  {
    tag: '육아',
    re: /(아기|애기|유아|이유식|기저귀|신생아|육아|유모차|젖병|분유|카시트|속싸개|어린이집|유치원|개월\s*아기|돌\s*아기)/,
  },
  { tag: '다이어트', re: /(다이어트|체중|살\s*빠|식단|칼로리|저탄고지|단백질\s*쉐이크)/ },
  {
    tag: '운동',
    re: /(운동|헬스|홈트|요가|필라테스|스트레칭|스쿼트|런지|플랭크|폼롤러|덤벨|러닝|PT쌤|피티쌤|트레이너)/i,
  },
  {
    tag: '요리',
    re: /(레시피|재료|만드는\s*법|큰술|작은술|에어프라이어|프라이팬|볶음|찌개|반찬|밑반찬|양념|소스|요리)/,
  },
  { tag: '뷰티', re: /(피부|스킨케어|화장품|쿠션|파운데이션|선크림|토너|세럼|앰플|립스틱|메이크업|모공|각질)/ },
  { tag: '살림', re: /(청소|설거지|빨래|세탁|수납|정리|주방|냉장고|곰팡이|얼룩|살림|자취)/ },
  { tag: '패션', re: /(코디|원피스|청바지|니트|가디건|자켓|코트|운동화|구두|가방|옷장|핏이)/ },
  { tag: '반려동물', re: /(강아지|고양이|댕댕이|냥이|반려견|반려묘|산책\s*줄|사료|간식\s*먹는\s*우리\s*애)/ },
];

const TOPIC_TAG_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.THREADS_TOPIC_TAGS || 'on'));

// Threads rejects topic tags containing "." or "&" and caps them at 50 chars.
function sanitizeTopicTag(tag) {
  const t = String(tag || '')
    .replace(/^#+/, '')
    .replace(/[.&]/g, '')
    .trim()
    .slice(0, 50);
  return t || null;
}

function pickTopicTag(text) {
  if (!TOPIC_TAG_ENABLED) return null;
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const rule of TOPIC_RULES) if (rule.re.test(t)) return sanitizeTopicTag(rule.tag);
  return null;
}

// A topic tag must never be the reason a post fails to publish: if Threads rejects the param
// (API version without topic support, tag policy change), the caller retries once without it.
function isTopicTagRejection(err) {
  const data = err?.response?.data;
  const msg = `${data?.error?.message || ''} ${data?.error?.error_user_msg || ''} ${err?.message || ''}`;
  return Number(err?.response?.status) === 400 && /topic/i.test(msg);
}

module.exports = { pickTopicTag, sanitizeTopicTag, isTopicTagRejection, TOPIC_RULES };
