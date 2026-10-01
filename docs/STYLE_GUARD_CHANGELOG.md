# Post Style Human Guard

`threadsStyleProfilePatch.js` 뒤에서 최종 본문을 다시 검사하는 최소 안전장치입니다.

## 잡는 패턴
- 의미 없는 AI 감상문: `없는 삶은 상상 못`, `중독될 수밖에`, `그냥 ~이 아닌 듯`, `정답이지` 등
- 입력 근거 없는 친구/가족 관계 반응
- 한 게시물의 과도한 반응표현 및 `ㅋㅋ/ㅎㅎ/ㅁㅊ/이모지` 혼합

## 처리
1. Style Profile 결과 검사
2. 문제 없으면 그대로 통과
3. 문제 있으면 GPT-4o-mini로 1회만 낮은 temperature 재작성
4. 재검사
5. 여전히 문제면 재작성 결과를 채택하지 않고 기존 Style Profile 결과 유지

## 비상 비활성화
`POST_STYLE_HUMAN_GUARD_ENABLED=0`
