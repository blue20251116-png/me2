const axios = require('axios');
const { getAccount } = require('./db');

const SYSTEM_PROMPT = `너는 한국 스레드(Threads)에서 반응 좋은 짧은 후킹형 글을 쓰는 사람이다.
아래 규칙을 반드시 지켜서, 주어진 상품을 자연스럽게 등장시키는 스레드 글을 서로 다른 버전으로 5개 써라.

- 전체 5줄 이내로 짧게 쓸 것 (줄바꿈 기준)
- 첫 줄은 반드시 읽는 사람에게 직접 묻는 후킹 질문으로 시작 ("~한 사람 있어?", "~해본 적 있어?" 같은 형태)
- 이어서 자신도 그 문제를 겪었다는 공감/디테일 한 줄
- 마지막은 그 문제가 해결됐다는 짧은 한 줄로 마무리
- 반말, 캐주얼한 구어체
- "추천합니다", "이 제품은", "~하세요", "강추", "꿀템", "필수템" 같은 광고성 표현 금지
- 상품명이나 브랜드명을 대놓고 반복하지 말 것
- 광고나 협찬처럼 읽히지 않게 자연스럽게 쓸 것
- 링크, 이모티콘, 해시태그는 절대 포함하지 말 것
- 결과는 "---" 한 줄로 구분한 5개 버전으로 출력할 것
- 번호, 설명, 따옴표는 붙이지 말 것

예시 구조:
집에들어오면 반려동물 냄새때문에 고민한 사람 있어?
나 진짜 냄새 민감한데
이거 쓰고 걱정1도안해`;

async function generateCaption(accountId, { productName, price }) {
  const account = getAccount(accountId);

  if (!account) {
    throw new Error('존재하지 않는 계정입니다');
  }

  if (!account.openai_api_key) {
    throw new Error(
      '이 계정에 OpenAI API 키가 설정되지 않았습니다 (연결 설정에서 입력)'
    );
  }

  const priceText = price
    ? `${Number(price).toLocaleString('ko-KR')}원`
    : '';

  const userMessage =
    `상품명: ${productName}` +
    `${priceText ? `\n가격: ${priceText}` : ''}`;

  return generateWithOpenAI(
    account.openai_api_key,
    userMessage
  );
}

function splitVariants(text) {
  const variants = text
    .split(/\n\s*---\s*\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  return variants.length
    ? variants
    : [text.trim()];
}

async function generateWithOpenAI(apiKey, userMessage) {
  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 25000,
      }
    );

    const text =
      res.data?.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error(
        'OpenAI에서 생성 결과를 받지 못했습니다'
      );
    }

    return splitVariants(text);

  } catch (err) {
    const apiErr =
      err.response?.data?.error;

    console.error(
      '[OpenAI 생성 실패]',
      JSON.stringify(
        {
          status: err.response?.status,
          type: apiErr?.type,
          code: apiErr?.code,
          message:
            apiErr?.message || err.message,
        },
        null,
        2
      )
    );

    throw new Error(
      apiErr?.message ||
      err.message ||
      'OpenAI 글 생성에 실패했습니다'
    );
  }
}

module.exports = {
  generateCaption,
};
