// 대시보드: 사진/영상 업로드, 영상 프레임 추출과 AI 베스트컷, 이미지 조합.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global apiFetch, originalProductImage */

// ---- 내 사진/영상 직접 업로드 ----
let uploadedFilename = null; // 삭제 API 호출용
let uploadedVideoUrl = ''; // "영상 그대로 게시" 모드로 되돌아갈 때 복원할 원본 영상 URL

document.getElementById('mediaUploadInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  const status = document.getElementById('uploadStatus');
  status.textContent = '업로드 중…';
  status.className = 'scrape-status loading';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/api/upload-media', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    uploadedFilename = data.filename;
    const form = document.getElementById('composeForm');

    if (data.mediaType === 'video') {
      form.video_url.value = data.url;
      form.image_url.value = '';
      uploadedVideoUrl = data.url;
      document.getElementById('imagePreviewBox').classList.add('hidden');
      document.getElementById('videoPreviewEl').src = data.url;
      document.getElementById('videoPreviewBox').classList.remove('hidden');
      // 새 영상을 올리면 이전 영상의 프레임 추출 상태는 전부 초기화
      resetVideoFrameUI();
      document.getElementById('videoUsageRow').classList.remove('hidden');
      document.getElementById('videoUsageAsIs').checked = true;
      document.getElementById('extractFramesBtn').classList.add('hidden');
    } else {
      form.image_url.value = data.url;
      form.video_url.value = '';
      uploadedVideoUrl = '';
      document.getElementById('videoPreviewBox').classList.add('hidden');
      document.getElementById('imagePreviewImg').src = data.url;
      document.getElementById('imagePreviewBox').classList.remove('hidden');
      document.getElementById('videoUsageRow').classList.add('hidden');
      resetVideoFrameUI();
    }

    status.textContent = '업로드 완료';
    status.className = 'scrape-status ok';
  } catch (err) {
    status.textContent = '업로드 실패: ' + err.message;
    status.className = 'scrape-status error';
  } finally {
    e.target.value = ''; // 같은 파일 다시 선택 가능하도록
  }
});

async function removeUploadedMedia() {
  const form = document.getElementById('composeForm');
  if (uploadedFilename) {
    try {
      await apiFetch(`/api/upload-media/${encodeURIComponent(uploadedFilename)}`, { method: 'DELETE' });
    } catch {
      /* 서버에서 이미 지워졌어도 무시 */
    }
    uploadedFilename = null;
  }
  form.image_url.value = '';
  form.video_url.value = '';
  document.getElementById('imagePreviewBox').classList.add('hidden');
  document.getElementById('videoPreviewBox').classList.add('hidden');
  document.getElementById('imagePreviewImg').src = '';
  document.getElementById('videoPreviewEl').src = '';
  document.getElementById('uploadStatus').className = 'scrape-status hidden';
  document.getElementById('videoUsageRow').classList.add('hidden');
  await resetVideoFrameUI();
}

document.getElementById('removeMediaBtn').addEventListener('click', removeUploadedMedia);
document.getElementById('removeVideoBtn').addEventListener('click', removeUploadedMedia);

// ---- 영상에서 사진 추출 (선택적 기능 — 안 써도 기존 "영상 그대로 게시"는 그대로 동작) ----
let currentFrameJobId = null;
let currentFrames = []; // [{id, time, url}]
let selectedFrameUrls = []; // 최대 2장 (기존 Threads 게시 로직이 image_url+extra_image_url 2장까지만 지원)
let frameRecommendations = {}; // frameId -> {category, score, reason} (AI 분석 성공 시에만 채워짐)
let recommendedFrameIds = []; // AI가 우선순위대로 추천한 frameId 목록 (최대 2개)
const MAX_SELECTED_FRAMES = 2;

const CATEGORY_LABELS = {
  person_hook: '인물/후킹',
  product_usage: '제품 사용',
  product_closeup: '제품 클로즈업',
  general: '기타',
  bad: '사용 부적합',
};

// 아직 게시물에 쓰이지 않은(선택 확정 전) 추출 작업 폴더를 정리. 이미 예약글로 제출된 프레임은
// 여기서 지우지 않는다 — 이 함수는 영상 교체/삭제 시점에만 호출된다.
async function resetVideoFrameUI() {
  if (currentFrameJobId) {
    try {
      await apiFetch(`/api/video/frames/${currentFrameJobId}`, { method: 'DELETE' });
    } catch {
      /* 정리 실패해도 새 영상 작업을 막을 이유는 없음 */
    }
  }
  currentFrameJobId = null;
  currentFrames = [];
  selectedFrameUrls = [];
  frameRecommendations = {};
  recommendedFrameIds = [];
  document.getElementById('frameCandidatesBox').classList.add('hidden');
  document.getElementById('frameCandidatesGrid').innerHTML = '';
  document.getElementById('aiVisionStatus').textContent = '';
  document.getElementById('imageCompositionRow').classList.add('hidden');
  document.getElementById('extractFramesStatus').textContent = '';
  document.getElementById('compositionFramesOnly').checked = true;
  document.getElementById('compositionFramesOnlyLabel').textContent = '추출한 사진만 게시';
  document.getElementById('compositionFramesPlusProductLabel').textContent = '추출한 사진 + 상품 이미지';
  applyImageComposition();
}

document.querySelectorAll('input[name="videoUsageMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const btn = document.getElementById('extractFramesBtn');
    const toggleRow = document.getElementById('aiVisionToggleRow');
    const form = document.getElementById('composeForm');
    if (document.getElementById('videoUsageExtract').checked) {
      btn.classList.remove('hidden');
      toggleRow.classList.remove('hidden');
      // 이미지(추출 프레임)로 게시할 것이므로 영상 URL은 비운다 — 발행 로직이 videoUrl을
      // 우선하므로, 비워두지 않으면 프레임을 골라도 영상으로 그대로 게시돼버린다.
      form.video_url.value = '';
      applyImageComposition();
    } else {
      btn.classList.add('hidden');
      toggleRow.classList.add('hidden');
      // "영상 그대로 게시"로 되돌리면 지금까지 고른 프레임/상품 이미지는 게시에 쓰이지 않으므로 비운다
      form.video_url.value = uploadedVideoUrl;
      form.image_url.value = '';
      form.extra_image_url.value = '';
      document.getElementById('imagePreviewBox').classList.add('hidden');
    }
  });
});

document.getElementById('extractFramesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('extractFramesBtn');
  const status = document.getElementById('extractFramesStatus');
  if (btn.disabled) return; // 연타 방지
  if (!uploadedFilename) {
    status.textContent = '먼저 영상을 업로드해주세요';
    status.className = 'ai-status error';
    return;
  }

  btn.disabled = true;
  status.textContent = '영상 분석 중… 사진을 추출하고 있습니다…';
  status.className = 'ai-status';

  try {
    const res = await apiFetch('/api/video/frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: uploadedFilename }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentFrameJobId = data.jobId;
    currentFrames = data.frames || [];
    selectedFrameUrls = [];
    frameRecommendations = {};
    recommendedFrameIds = [];
    renderFrameCandidates();

    status.textContent = `${currentFrames.length}장의 장면을 찾았어요 · 최대 ${MAX_SELECTED_FRAMES}장까지 선택하세요`;
    status.className = 'ai-status ok';

    // "AI 베스트컷 자동 추천"이 켜져 있으면 이어서 자동으로 분석을 시도한다. 실패해도 이미
    // 위에서 프레임 후보는 정상적으로 표시된 상태라 수동 선택은 그대로 가능하다.
    if (document.getElementById('aiVisionToggle').checked) {
      await runAiFrameRecommendation();
    }
  } catch (err) {
    status.textContent = '추출 실패: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

// AI 베스트컷 추천 — 실패해도 예외를 던지지 않고 "수동 선택 가능" 상태로 조용히 남는다
async function runAiFrameRecommendation() {
  if (!currentFrameJobId) return;
  const visionStatus = document.getElementById('aiVisionStatus');
  visionStatus.textContent = 'AI가 베스트컷을 고르는 중…';
  visionStatus.className = 'ai-status';

  try {
    const res = await apiFetch(`/api/video/frames/${currentFrameJobId}/recommend`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    frameRecommendations = {};
    (data.recommendations || []).forEach(r => {
      frameRecommendations[r.frameId] = r;
    });
    recommendedFrameIds = data.recommended || [];

    // 추천 결과를 기본 선택으로 반영 (사용자가 이후 자유롭게 바꿀 수 있음)
    selectedFrameUrls = recommendedFrameIds
      .map(id => currentFrames.find(f => f.id === id)?.url)
      .filter(Boolean)
      .slice(0, MAX_SELECTED_FRAMES);

    // 추천 성공 시 조합 옵션 문구를 "AI 추천 프레임" 기준으로 바꿔서 어떤 걸 쓰는지 명확히 함
    document.getElementById('compositionFramesOnlyLabel').textContent = 'AI 추천 프레임만';
    document.getElementById('compositionFramesPlusProductLabel').textContent = 'AI 추천 프레임 + 상품 이미지';
    // 기본값은 "AI 추천 프레임 + 상품 이미지" 권장 — 상품 이미지가 있을 때만 그 옵션을 기본으로 선택
    if (originalProductImage && document.getElementById('compositionFramesPlusProduct')) {
      document.getElementById('compositionFramesPlusProduct').checked = true;
    }

    renderFrameCandidates();
    applyImageComposition();

    visionStatus.textContent = recommendedFrameIds.length
      ? `AI가 ${recommendedFrameIds.length}개 장면을 추천했어요 · 마음에 안 들면 직접 바꿔도 됩니다`
      : 'AI가 추천할 만한 장면을 찾지 못했어요 · 직접 선택해주세요';
    visionStatus.className = 'ai-status ok';
  } catch (err) {
    visionStatus.textContent = 'AI 추천 없이 수동 선택 가능 (' + err.message + ')';
    visionStatus.className = 'ai-status';
  }
}

function fmtFrameTime(t) {
  return `${Number(t).toFixed(1)}초`;
}

function frameBadgeHtml(frameId) {
  const rec = frameRecommendations[frameId];
  if (!rec) return '';
  const rank = recommendedFrameIds.indexOf(frameId);
  const label = CATEGORY_LABELS[rec.category] || rec.category;
  const star = rank >= 0 ? '⭐'.repeat(1) + (rank + 1) + '순위 ' : '';
  return `<span class="frame-badge">${star}${escapeHtml(label)} ${Number(rec.score) || 0}점</span>`;
}

function renderFrameCandidates() {
  const grid = document.getElementById('frameCandidatesGrid');
  const box = document.getElementById('frameCandidatesBox');

  grid.innerHTML = currentFrames
    .map(f => {
      const rec = frameRecommendations[f.id];
      const isBad = rec && rec.category === 'bad';
      const isRecommended = recommendedFrameIds.includes(f.id);
      const classes = [
        'frame-thumb',
        selectedFrameUrls.includes(f.url) ? 'selected' : '',
        isRecommended ? 'ai-recommended' : '',
        isBad ? 'ai-excluded' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
    <div class="${classes}" data-url="${escapeHtml(f.url)}" data-id="${escapeHtml(f.id)}">
      <img src="${escapeHtml(safeUrl(f.url))}" alt="" />
      ${frameBadgeHtml(f.id)}
      <span class="frame-time">${fmtFrameTime(f.time)}</span>
      <span class="frame-check"></span>
    </div>`;
    })
    .join('');
  box.classList.remove('hidden');

  grid.querySelectorAll('.frame-thumb').forEach(thumb => {
    thumb.addEventListener('click', () => {
      const url = thumb.dataset.url;
      const status = document.getElementById('extractFramesStatus');
      const idx = selectedFrameUrls.indexOf(url);
      if (idx >= 0) {
        selectedFrameUrls.splice(idx, 1);
      } else {
        if (selectedFrameUrls.length >= MAX_SELECTED_FRAMES) {
          status.textContent = `Threads 게시 이미지로 최대 ${MAX_SELECTED_FRAMES}장까지 선택할 수 있습니다.`;
          status.className = 'ai-status error';
          return;
        }
        selectedFrameUrls.push(url);
      }
      renderFrameCandidates();
      applyImageComposition();
    });
  });

  document.getElementById('imageCompositionRow').classList.toggle('hidden', selectedFrameUrls.length === 0);
  // 상품 이미지가 아예 없으면(쿠팡 검색 없이 영상만 올린 경우) 상품 이미지 조합 옵션은 숨긴다
  const hasProductImage = !!originalProductImage;
  document.getElementById('compositionFramesPlusProductRow').classList.toggle('hidden', !hasProductImage);
  document.getElementById('compositionProductOnlyRow').classList.toggle('hidden', !hasProductImage);
}

// 선택한 프레임(+상품 이미지) 조합을 실제로 composeForm의 image_url/extra_image_url에 반영.
// 현재 Threads 발행 로직이 이미지 2장(image_url + extra_image_url)까지만 지원하므로 그 범위 안에서 조합한다.
function applyImageComposition() {
  const form = document.getElementById('composeForm');
  const mode = document.querySelector('input[name="imageComposition"]:checked')?.value || 'frames_only';
  const previewImg = document.getElementById('imagePreviewImg');
  const previewBox = document.getElementById('imagePreviewBox');

  let imageUrl = '';
  let extraImageUrl = '';

  if (mode === 'product_only') {
    imageUrl = originalProductImage || '';
  } else if (mode === 'frames_plus_product') {
    imageUrl = selectedFrameUrls[0] || originalProductImage || '';
    extraImageUrl = selectedFrameUrls[0] ? originalProductImage || '' : '';
  } else {
    // frames_only
    imageUrl = selectedFrameUrls[0] || '';
    extraImageUrl = selectedFrameUrls[1] || '';
  }

  form.image_url.value = imageUrl;
  form.extra_image_url.value = extraImageUrl;

  if (imageUrl) {
    previewImg.src = imageUrl;
    previewBox.classList.remove('hidden');
  } else {
    previewBox.classList.add('hidden');
  }
}

document.querySelectorAll('input[name="imageComposition"]').forEach(radio => {
  radio.addEventListener('change', applyImageComposition);
});
