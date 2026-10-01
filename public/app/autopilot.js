// 대시보드: 완전 자동발행(오토파일럿) 상태·설정과 AI 완전 자동완성.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global activeAccountId, apiFetch, currentProduct:writable, lastScrapedLink:writable, originalProductImage:writable, resetVideoFrameUI, runAiGenerate, searchCoupangProducts, updateCommentPreview, uploadedFilename:writable */

// ---- 완전 자동발행(오토파일럿) ----
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadAutopilotStatus() {
  if (!activeAccountId) return;
  const textEl = document.getElementById('autopilotStatusText');
  const btn = document.getElementById('autopilotToggleBtn');
  const detail = document.getElementById('autopilotDetail');
  try {
    const res = await apiFetch(`/api/accounts/${activeAccountId}/autopilot`);
    const data = await res.json();
    const lastInfo = data.lastKeyword
      ? ` · 직전 키워드: "${data.lastKeyword}"${data.lastTarget ? ` (타겟: ${data.lastTarget})` : ''}`
      : '';
    if (data.enabled) {
      textEl.textContent = '켜짐';
      textEl.className = 'autopilot-status-text on';
      btn.textContent = '중지';
      btn.className = 'btn-secondary on';
      detail.textContent = data.nextAt ? `다음 자동 발행: ${fmtDateTime(data.nextAt)}${lastInfo}` : '';
    } else {
      textEl.textContent = '꺼짐';
      textEl.className = 'autopilot-status-text off';
      btn.textContent = '시작';
      btn.className = 'btn-secondary off';
      detail.textContent = data.lastKeyword ? `마지막으로 썼던${lastInfo}` : '';
    }
    // "관련 쇼츠 콘텐츠 참고" 옵션 — 서버 값으로 화면 동기화 (저장 이벤트가 다시 발생하지 않도록 change 리스너 붙이기 전에 값만 세팅)
    document.getElementById('autopilotYoutubeToggle').checked = data.youtubeSourceEnabled !== false;
    document.getElementById('autopilotYoutubeOrderSelect').value = data.youtubeOrder || 'relevance';
    document.getElementById('autopilotFrameMediaToggle').checked = !!data.frameMediaEnabled;
  } catch {
    textEl.textContent = '상태를 불러오지 못했어요';
    textEl.className = 'autopilot-status-text off';
  }
}

// 완전자동화 "관련 쇼츠 콘텐츠 참고" ON/OFF + 탐색 방식은 시작/중지 버튼과 별개로 바로 저장
async function saveAutopilotYoutubeSettings() {
  if (!activeAccountId) return;
  const enabled = document.getElementById('autopilotYoutubeToggle').checked;
  const order = document.getElementById('autopilotYoutubeOrderSelect').value;
  try {
    await apiFetch(`/api/accounts/${activeAccountId}/autopilot/youtube-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, order }),
    });
  } catch {
    // 저장에 실패해도 완전자동화 자체는 계속 정상 동작하므로 조용히 무시
  }
}
document.getElementById('autopilotYoutubeToggle').addEventListener('change', saveAutopilotYoutubeSettings);
document.getElementById('autopilotYoutubeOrderSelect').addEventListener('change', saveAutopilotYoutubeSettings);

// 완전자동화 "업로드 영상 프레임 자동 사용" ON/OFF 저장
document.getElementById('autopilotFrameMediaToggle').addEventListener('change', async () => {
  if (!activeAccountId) return;
  const enabled = document.getElementById('autopilotFrameMediaToggle').checked;
  try {
    await apiFetch(`/api/accounts/${activeAccountId}/autopilot/frame-media-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  } catch {
    // 저장 실패해도 완전자동화 자체는 계속 정상 동작하므로 조용히 무시
  }
});

document.getElementById('autopilotToggleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('autopilotToggleBtn');
  const isOn = btn.classList.contains('on');
  btn.disabled = true;
  try {
    if (isOn) {
      if (!confirm('자동발행을 중지할까요? 이미 예약된 글은 그대로 발행됩니다.')) {
        btn.disabled = false;
        return;
      }
      await apiFetch(`/api/accounts/${activeAccountId}/autopilot/stop`, { method: 'POST' });
    } else {
      if (
        !confirm('자동발행을 켜면 앞으로 60~75분마다 AI가 알아서 상품을 고르고 글을 써서 예약·발행합니다. 계속할까요?')
      ) {
        btn.disabled = false;
        return;
      }
      await apiFetch(`/api/accounts/${activeAccountId}/autopilot/start`, { method: 'POST' });
    }
    await loadAutopilotStatus();
  } finally {
    btn.disabled = false;
  }
});

// ---- AI 완전 자동완성: 키워드 제안 → 상품 검색 → 랜덤 픽 → 글쓰기까지 한번에 ----
document.getElementById('aiAutoCompleteBtn').addEventListener('click', async () => {
  const btn = document.getElementById('aiAutoCompleteBtn');
  const status = document.getElementById('aiAutoCompleteStatus');
  const target = document.getElementById('autoCompleteTargetSelect').value;

  btn.disabled = true;
  try {
    status.textContent = 'AI가 검색 키워드 정하는 중…';
    status.className = 'ai-status';
    const kwRes = await apiFetch('/api/suggest-keyword', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const kwData = await kwRes.json();
    if (!kwRes.ok) throw new Error(kwData.error);
    const keyword = kwData.keyword;
    const trendNote = kwData.trendUsed ? ' (네이버 데이터랩 트렌드 1위)' : '';

    status.textContent = `"${keyword}"${trendNote} 검색 중…`;
    const searchRes = await apiFetch(`/api/coupang/search?keyword=${encodeURIComponent(keyword)}&limit=8`);
    const searchData = await searchRes.json();
    if (!searchRes.ok) throw new Error(searchData.error);
    if (!searchData.products.length) throw new Error(`"${keyword}" 검색 결과가 없어요, 다시 눌러보세요`);

    // 상위 결과 중 랜덤으로 하나 선택 (매번 같은 것만 고르지 않도록)
    const pickPool = searchData.products.slice(0, Math.min(5, searchData.products.length));
    const picked = pickPool[Math.floor(Math.random() * pickPool.length)];
    applyPickedProduct(picked);

    // 검색창/결과 목록에도 반영해서 뭘 골랐는지 보이게
    document.getElementById('productSearchInput').value = keyword;
    document.getElementById('productSearchMsg').textContent =
      `AI가 "${keyword}"${trendNote}로 검색해서 이 상품을 골랐어요: ${picked.name}`;
    document.getElementById('productSearchMsg').className = 'msg';
    // 본문 작성 폼의 타겟도 자동완성에서 고른 타겟과 맞춰줌
    document.getElementById('composeTargetSelect').value = target;

    status.textContent = '글 쓰는 중…';
    const ok = await runAiGenerate();
    status.textContent = ok
      ? `완료! "${keyword}" → "${picked.name}" 상품으로 글 5개 준비됐어요, 마음에 드는 버전 골라주세요`
      : '상품은 골랐는데 글쓰기에서 오류가 났어요, 아래에서 다시 시도해보세요';
    status.className = ok ? 'ai-status ok' : 'ai-status error';
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

function applyPickedProduct(p) {
  const form = document.getElementById('composeForm');
  form.link.value = p.url;
  form.image_url.value = p.image;
  form.video_url.value = '';
  uploadedFilename = null; // 검색 결과 이미지로 교체되므로 이전 직접 업로드 참조는 해제
  lastScrapedLink = p.url; // 자동 스크래핑이 이 링크로 또 돌지 않도록 표시
  currentProduct = { name: p.name, price: p.price };
  originalProductImage = p.image; // 이미지 구성 선택 시 레퍼런스로 사용
  // 쇼츠 찾기 입력창에도 상품명을 자동으로 채워준다 (직접 수정도 가능)
  const youtubeInput = document.getElementById('youtubeSearchInput');
  if (youtubeInput) youtubeInput.value = p.name || '';

  document.getElementById('videoPreviewBox').classList.add('hidden');
  document.getElementById('videoUsageRow').classList.add('hidden');
  resetVideoFrameUI();
  document.getElementById('imagePreviewImg').src = p.image;
  document.getElementById('imagePreviewBox').classList.remove('hidden');
  document.getElementById('imageToolsRow').classList.remove('hidden');
  document.getElementById('detailImagesGallery').classList.add('hidden');
  const scrapeStatus = document.getElementById('scrapeStatus');
  scrapeStatus.textContent = '상품 검색 결과에서 링크·사진을 채웠어요 · 이제 "AI로 글 써주기"를 눌러보세요';
  scrapeStatus.className = 'scrape-status ok';
  updateCommentPreview();
}

document.getElementById('productSearchBtn').addEventListener('click', searchCoupangProducts);
document.getElementById('productSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchCoupangProducts();
  }
});
