const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getAccount } = require('./db');

// SaaS 전환: 일반 회원에게 OpenAI 키를 직접 받지 않고, 운영자가 등록한 서버 환경변수(OPENAI_API_KEY)를
// 우선 사용한다. 아직 env가 없는 로컬 개발/과거 계정 호환을 위해 계정별 저장 키로 폴백은 남겨둠.
function resolveOpenAiKey(account) {
  return process.env.OPENAI_API_KEY || account?.openai_api_key || null;
}

// ---- Scene(상황) 생성 ----
// 상품이 실제로 쓰이는 "맥락"만 정해서, 글과 이미지가 서로 어긋나지 않게 맞추는 용도.
// "직접 써봤다"는 식의 허위 체험 증거를 만들려는 게 아니라, 상품이 자연스럽게 등장할
// 생활 배경(카페/집/차 안 등)을 정하는 것뿐이라는 점을 프롬프트에 분명히 못박아둠.
const SCENE_SYSTEM_PROMPT = `너는 쇼핑 콘텐츠의 배경 상황(scene)을 기획하는 사람이다.
주어진 상품이 자연스럽게 어울리는 생활 속 장소와 상황을 하나 정해라.

- 이건 실제 체험 후기를 지어내는 게 아니라, 상품 라이프스타일 사진을 찍을 배경을 정하는 것뿐이다.
- 장소는 한국에서 흔한 곳으로 (카페, 집 거실/화장대/주방, 회사 책상, 차 안, 헬스장 등)
- 상품 카테고리에 맞는 장소를 골라라 (텀블러 → 카페, 스킨케어 → 화장대, 차량용품 → 차 안 등)
- 결과는 아래 JSON 형식으로만 출력. 다른 설명 붙이지 말 것.

{
  "location": "장소 (예: 회사 근처 카페)",
  "context": "이 장소에서의 상황 한 줄 (예: 점심시간에 커피 사서 자리로 돌아가는 길)",
  "imageDescription": "상품이 이 배경에 자연스럽게 놓이거나 사용되는 모습 묘사 한두 줄"
}`;

async function generateScene(accountId, { productName, price, target }) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const apiKey = resolveOpenAiKey(account);
  if (!apiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  }

  const priceText = price ? `${Number(price).toLocaleString('ko-KR')}원` : '';
  const targetText = target && target !== '전체' ? `\n타겟: ${target}` : '';
  const userMessage = `상품명: ${productName}${priceText ? `\n가격: ${priceText}` : ''}${targetText}`;

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SCENE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI에서 상황을 받지 못했습니다');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('상황 데이터 형식이 올바르지 않습니다, 다시 시도해주세요');
  }
}

// ---- 라이프스타일 이미지 생성 ----
// 중요: "실제 유저가 찍은 후기 사진처럼" 위장하는 게 목적이 아니다.
// 어설픈 구도/핸드헬드 흔들림/스마트폰 스냅샷 흉내 같은 "진짜 체험한 척"하는
// 디테일은 절대 넣지 않는다 — 그건 소비자를 속이는 가짜 증거가 되기 때문.
// 대신 브랜드가 만든 라이프스타일 화보라는 게 자연스럽게 느껴지는, 상품이
// 실제 배경 속에 놓인 산뜻한 컷을 만든다.
async function generateLifestyleImage(accountId, { productName, productImageUrl, scene }, publicBaseUrl) {
  const account = getAccount(accountId);
  if (!account) throw new Error('존재하지 않는 계정입니다');
  const apiKey = resolveOpenAiKey(account);
  if (!apiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다 (서비스 운영자에게 문의해주세요)');
  }
  if (!productImageUrl) throw new Error('상품 원본 이미지가 필요합니다');

  // 1) 원본 상품 이미지 다운로드 (레퍼런스로 사용해서 색상/형태를 최대한 유지)
  const imgRes = await axios.get(productImageUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const referenceBuffer = Buffer.from(imgRes.data);

  const prompt =
    `상품명: ${productName}\n` +
    `배경 상황: ${scene?.location || ''} — ${scene?.context || ''}\n` +
    `${scene?.imageDescription || ''}\n\n` +
    '이 상품을 위 배경 속에 자연스럽게 배치한 라이프스타일 사진을 만들어줘.\n' +
    '조건:\n' +
    '- 자연광, 실제 생활 공간처럼 보이는 배경\n' +
    '- 상품의 색상·형태·재질·비율은 원본 레퍼런스와 최대한 동일하게 유지\n' +
    '- 스튜디오 무배경 촬영이나 과도한 상업광고 느낌은 피하고, 생활 속에 자연스럽게 놓인 느낌으로\n' +
    '- 다만 "우연히 찍힌 스마트폰 스냅샷"처럼 일부러 흔들리거나 어설프게 만들지 말 것 — 화질과 구도는 깔끔하게\n' +
    '- 로고나 작은 텍스트를 새로 만들어내지 말 것 (원본에 있는 것 외에 글자 추가 금지)\n' +
    '- 사람 얼굴이 정면으로 나오지 않게, 손이나 실루엣 정도만 필요하면 자연스럽게';

  // 2) OpenAI 이미지 편집 API — 원본 레퍼런스 이미지를 기반으로 배경/맥락을 새로 구성
  const FormData = require('form-data');
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('image', referenceBuffer, { filename: 'product.png', contentType: 'image/png' });
  form.append('prompt', prompt);
  form.append('size', '1024x1024');

  const editRes = await axios.post('https://api.openai.com/v1/images/edits', form, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders(),
    },
    timeout: 60000,
    maxBodyLength: Infinity,
  });

  const b64 = editRes.data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI에서 이미지를 받지 못했습니다');

  const uploadsDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const filename = `lifestyle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(b64, 'base64'));

  // 지금은 1장만 반환하지만, 나중에 여러 장 지원할 때 이 배열에 추가하면 되는 구조
  return {
    images: [{ url: `${publicBaseUrl}/uploads/${filename}`, filename }],
  };
}

module.exports = { generateScene, generateLifestyleImage };
