const { getSystemApiSettings } = require('./db');
const youtubeApi = require('./youtubeApi');
const { suggestYoutubeSearchKeywords } = require('./aiCaption');

// 완전자동화(오토파일럿)가 쿠팡 상품을 하나 고른 뒤, 그 상품과 관련된 YouTube 콘텐츠를
// 자동으로 찾아서 AI 글 생성에 넘길 소재 1개를 골라주는 레이어.
//
// 매우 중요: 이 함수는 절대 예외를 던지지 않는다. Key 없음/검색 실패/quota 초과/네트워크
// 오류 등 무엇이 일어나도 여기서 잡아서 null을 반환하고 로그만 남긴다 — 완전자동화 전체가
// YouTube 단계 때문에 실패하면 안 되기 때문이다. 호출하는 쪽(scheduler.js)은 반환값이
// null이면 그냥