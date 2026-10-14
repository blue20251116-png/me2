'use strict';
// Post-structure frames for the fixed-persona owner accounts' Coupang-linked PRODUCT posts
// (2026-10-13, user request, benchmark: bang100_e). The persona (accountPersonas.js) still decides
// who is talking; the frame decides the shape of the post. Recipe posts and link-free everyday posts
// have no frame. Frames are alternated per account (accountMix.chooseFrameFor) and recorded in
// posts.post_frame.
//
// Guardrails (prompt AND code, groundingProblems below): a physical store is only named when the
// source/product says the item is from there (the link is Coupang), authority/spec claims and prices
// only when the source post or the matched Coupang product data contains them.

const FRAMES = {
  A: {
    id: 'A',
    name: '발견-반전스펙-행동유도',
    block: `[이번 글의 구조 — 프레임 A: 발견 → 반전 스펙 → 행동 유도]
위 인물의 말투 그대로, 아래 3덩어리(각 1~2줄, 빈 줄로 구분)로만 쓴다. 위 정책의 "공통 구조"보다 이 구조가 우선한다.
1) 첫 줄: 이 인물의 일상 장면 속에서 의외의 가성비 물건을 만났다는 한 줄. {{OPENING_HINT}}
   - "쿠팡 뒤지다가/쿠팡 구경하다가 … 발견함"으로 시작하지 않는다(여러 계정에서 같은 첫마디가 반복돼 광고 계정처럼 보인다).
   - 장소는 사실이어야 한다. 링크는 쿠팡이다. 다이소·올리브영·이마트 같은 오프라인 매장 이름은 [Threads 원문]이나 상품 정보에 그 매장이 나올 때만 쓴다. 없으면 이 인물의 일상 루틴(출근길, 등원 후, 재택 중, 자기 전 등)이나 물건을 쓰게 된 상황으로 쓴다.
2) 둘째 덩어리: 권위·스펙 요소와 가격을 대비시켜 "이게 이 가격이라고?" 하는 의문을 만든다. "실화임? ;;", "말이 됨?" 같은 구어체 감정은 써도 된다.
   - 장인, 몇 년 전통, 수상, 1위, 판매량, 인증·등급, 테스트 결과 같은 권위·스펙은 [Threads 원문]·[작성자 추가댓글]·쿠팡 상품명에 있는 것만 쓴다. 없으면 지어내지 말고 눈에 보이는 디테일(크기, 구성, 재질, 개수)로 대비를 만든다.
   - 가격은 [쿠팡 상품 가격]에 적힌 값이나 원문에 있는 값만 쓴다. 없으면 가격을 말하지 않는다.
3) 마지막 줄: 나 자신의 강한 행동으로 끝낸다. 예) "보이면 무조건 쟁여둠!!", "장바구니에 세 개 담아놨음", "떨어지기 전에 하나 더 쟁여야지".
   - 읽는 사람에게 시키는 말("너도 사봐/써봐/해봐", "꼭 사", "쟁여라")과 댓글·저장 요구는 쓰지 않는다. 주어는 언제나 "나"다.
   - "미친 가성비", "실화임?", "무조건 쟁여" 정도의 표현은 이 프레임에서 허용된다. "인생템/필수템/강추/이거 하나면/없으면 못 살아"는 여전히 금지다.`,
  },
  B: {
    id: 'B',
    name: '불편함 먼저',
    block: `[이번 글의 구조 — 프레임 B: 불편함 먼저 → 해결 물건]
위 인물의 말투 그대로 쓴다. 위 정책의 "공통 구조"보다 이 구조가 우선한다.
1) 첫 줄에서는 물건을 절대 말하지 않는다. 누구나 겪는 생활 속 불편 하나를 콕 찌른다. 예) "싱크대 배수구 냄새 올라오는 거 진짜 신경 쓰이지 않았어?", "차 시트 틈에 들어간 과자 부스러기 매번 포기함", "라면 끓이다가 냄비 넘치면 가스레인지 청소가 더 일임".
2) 그 불편이 이 인물의 생활에서 어떻게 반복되는지 한두 줄로 공감을 쌓는다.
3) 그다음에야 그 불편을 해결한 물건을 소품처럼 짧게 연결하고, 달라진 장면 하나로 보여준다. 기능 나열·스펙 나열은 하지 않는다.
4) 마지막 줄은 반응·진행형·누구나 답할 수 있는 질문 중 하나로 끝낸다("다들 이거 어떻게 해결해?").
- 장소·권위·가격은 [Threads 원문]·[작성자 추가댓글]·쿠팡 상품 정보에 있는 것만 쓴다. 링크는 쿠팡이니 원문에 없는 오프라인 매장 이름은 쓰지 않는다.`,
  },
};
const FRAME_IDS = Object.keys(FRAMES);

// 2026-10-14: frame A's first line rotates through several natural openings so the 7 owner
// accounts stop sharing one "쿠팡 뒤지다가 … 발견함ㄷㄷ" opener.
const FRAME_A_OPENINGS = [
  '장바구니에 넣었다 뺐다 세 번 하다가 결국 주문함',
  '택배 뜯자마자 이건 좀 놀람',
  '살까 말까 일주일 고민한 게 아까웠음',
  '써보고 나서 하나 더 주문한 거 처음임',
  '자기 전에 폰 보다가 결국 결제 버튼 누름',
  '이 가격에 이 구성이면 고민할 게 없었음',
  '장 보다가 넣을까 말까 하던 거 결국 삼',
];
// The prompt block for a frame; frame A gets one rotating opening hint (random() for tests).
function frameBlock(id, random = Math.random) {
  const frame = FRAMES[id];
  if (!frame) return '';
  if (id !== 'A') return frame.block;
  const pick = FRAME_A_OPENINGS[Math.floor(random() * FRAME_A_OPENINGS.length) % FRAME_A_OPENINGS.length];
  return frame.block.replace(
    '{{OPENING_HINT}}',
    `이번 글 첫 줄의 결: "${pick}" — 그대로 베끼지 말고 이 인물의 상황과 말투로 바꿔 쓴다.`
  );
}

// Alternate per account: the frame used less in the recent window goes next; a tie is 50:50.
function chooseFrame(counts = {}, random = Math.random) {
  const a = Number(counts.A || 0),
    b = Number(counts.B || 0);
  if (a !== b) return a < b ? 'A' : 'B';
  return random() < 0.5 ? 'A' : 'B';
}

// ---------- grounding checks (code side of the guardrails) ----------
function squash(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

// Physical stores. A Coupang-linked post may name one only when the evidence does.
const STORES = [
  ['다이소'],
  ['올리브영', '올영'],
  ['이마트'],
  ['홈플러스'],
  ['롯데마트'],
  ['코스트코'],
  ['트레이더스'],
  ['노브랜드'],
  ['무인양품'],
  ['이케아'],
  ['편의점', 'cu', 'gs25', '세븐일레븐', '이마트24'],
  ['백화점'],
  ['아울렛'],
  ['시장', '재래시장'],
];
function storeProblems(text, evidence) {
  const t = squash(text),
    ev = squash(evidence);
  for (const names of STORES) {
    const used = names.find(n =>
      /^[a-z0-9]+$/.test(n) ? new RegExp(`(?<![a-z0-9])${n}(?![a-z0-9])`).test(t) : t.includes(n)
    );
    if (!used) continue;
    if (!names.some(n => ev.includes(n))) return [`근거 없는 장소:${used}`];
  }
  return [];
}

// Authority/spec claims. Each pattern's match must appear in the evidence (whitespace-insensitive);
// for "N년 전통"-style numbers the number itself must be there too.
const AUTHORITY_PATTERNS = [
  /장인/g,
  /명장/g,
  /\d+\s*년\s*(?:전통|경력|차\s*장인|넘게\s*만든)/g,
  /전통/g,
  /수상/g,
  /\d+\s*위/g,
  /1등/g,
  /판매\s*(?:량|1위)/g,
  /누적\s*\d[\d,.]*\s*(?:만|천)?\s*(?:개|병|장|팩)?/g,
  /\d[\d,.]*\s*(?:만|천)\s*개\s*(?:팔린|판매|돌파)/g,
  /특허/g,
  /인증(?!샷)/g,
  /등급/g,
  /테스트/g,
  /임상/g,
  /(?:피부과|치과|의사|약사|셰프|전문가)(?:\s*(?:추천|개발|인정))?/g,
  /(?:호텔|미슐랭)/g,
];
function authorityProblems(text, evidence) {
  const ev = squash(evidence);
  const out = [];
  for (const re of AUTHORITY_PATTERNS) {
    for (const m of String(text || '').matchAll(re)) {
      const claim = squash(m[0]);
      if (!ev.includes(claim)) out.push(`근거 없는 권위:${m[0].trim()}`);
    }
  }
  return [...new Set(out)];
}

// Prices in the post must be the Coupang product price (or a band containing it, "7천원대") or
// literally present in the evidence.
const PRICE_RE = /(\d[\d,]*(?:\.\d+)?)\s*(만|천)?\s*(?:원(대)?)|(\d+)\s*(만|천)\s*(?:원)?\s*(대)/g;
function priceValue(numStr, unit) {
  const n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return unit === '만' ? n * 10000 : unit === '천' ? n * 1000 : n;
}
function priceProblems(text, evidence, price) {
  const ev = squash(evidence);
  const actual = Number(price) > 0 ? Number(price) : null;
  const out = [];
  for (const m of String(text || '').matchAll(PRICE_RE)) {
    const literal = squash(m[0]);
    if (ev.includes(literal)) continue;
    const value = priceValue(m[1] || m[4], m[2] || m[5]);
    const band = !!(m[3] || m[6]);
    if (actual != null && value != null) {
      const unitSize = (m[2] || m[5]) === '만' ? 10000 : (m[2] || m[5]) === '천' ? 1000 : 1;
      if (band ? actual >= value && actual < value + unitSize * (unitSize === 1 ? 1000 : 1) : actual === value)
        continue;
      // "2천 원" for a 1,900원/2,000원 item: allow rounding to the stated unit.
      if (!band && unitSize > 1 && Math.abs(actual - value) <= unitSize / 2) continue;
    }
    out.push(`근거 없는 가격:${m[0].trim()}`);
  }
  return [...new Set(out)];
}

// grounding: { evidence: string (source post + author replies + product name), price: number|null }
function groundingProblems(text, grounding) {
  if (!grounding) return [];
  const evidence = String(grounding.evidence || '');
  return [
    ...storeProblems(text, evidence),
    ...authorityProblems(text, evidence),
    ...priceProblems(text, evidence, grounding.price),
  ];
}

// Frame A may use "실화임?", "미친 가성비", "무조건 쟁여" (first person); the shared cliché/hype
// checks then run on the text with only those phrases removed, so everything else stays banned.
const FRAME_A_ALLOWED = [
  /(?:이거\s*|이게\s*)?실화(?:임|냐|야|인가)\s*\??/g,
  /미친\s*가성비/g,
  /무조건\s*쟁(?:여|이|여둠|여놓|여놔|여야|임)/g,
];
function relaxForFrame(text, frame) {
  if (frame !== 'A') return text;
  let out = String(text || '');
  for (const re of FRAME_A_ALLOWED) out = out.replace(re, ' ');
  return out;
}

module.exports = {
  FRAME_A_OPENINGS,
  frameBlock,
  FRAMES,
  FRAME_IDS,
  chooseFrame,
  groundingProblems,
  storeProblems,
  authorityProblems,
  priceProblems,
  relaxForFrame,
};
