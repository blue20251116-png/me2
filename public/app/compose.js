// 대시보드: 링크 상품 정보 가져오기, 댓글 미리보기, 글 예약 폼.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global apiFetch, currentFrameJobId:writable, currentFrames:writable, currentProduct:writable, frameRecommendations:writable, loadDashboard, recommendedFrameIds:writable, renderSelectedYoutubeSource, selectedFrameUrls:writable, selectedYoutubeSource:writable, uploadedFilename:writable, uploadedVideoUrl:writable */

// ---- 링크 입력 시 상품 이미지/제목 자동 가져오기 ----
let scrapeTimer = null;
let lastScrapedLink = '';
let currentDetailImages = [];
let originalProductImage = '';

// ---- 상세페이지 사진 더 보기 (갤러리에서 골라서 대표 이미지로 교체) ----
document.getElementById('showDetailImagesBtn').addEventListener('click', async () => {
  const btn = document.getElementById('showDetailImagesBtn');
  const gallery = document.getElementById('detailImagesGallery');
  const status = document.getElementById('retouchStatus');
  const link = document.getElementById('composeForm').link.value.trim();
  if (!link) {
    status.textContent = '먼저 상품 링크가 있어야 상세 사진을 가져올 수 있어요';
    status.className = 'ai-status error';
    return;
  }

  btn.disabled = true;
  status.textContent = '상세페이지 사진 불러오는 중…';
  status.className = 'ai-status';
  try {
    // 이미 스크래핑해둔 후보가 있으면 재사용, 없으면 다시 가져옴
    if (!currentDetailImages.length) {
      const res = await fetch('/api/scrape-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentDetailImages = data.images || [data.imageUrl];
    }

    const currentImg = document.getElementById('composeForm').image_url.value;
    gallery.innerHTML = currentDetailImages
      .map(
        (src, i) => `
      <div class="detail-img-thumb ${src === currentImg ? 'selected' : ''}" data-idx="${i}">
        <img src="${escapeHtml(safeUrl(src))}" alt="" onerror="this.parentElement.style.display='none'" />
      </div>`
      )
      .join('');
    gallery.classList.remove('hidden');

    gallery.querySelectorAll('.detail-img-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const src = currentDetailImages[Number(thumb.dataset.idx)];
        const form = document.getElementById('composeForm');
        form.image_url.value = src;
        document.getElementById('imagePreviewImg').src = src;
        gallery.querySelectorAll('.detail-img-thumb').forEach(t => t.classList.remove('selected'));
        thumb.classList.add('selected');
      });
    });

    status.textContent = `${currentDetailImages.length}장 찾았어요 · 마음에 드는 사진을 눌러서 대표 이미지로 바꾸세요`;
    status.className = 'ai-status ok';
  } catch (err) {
    status.textContent = '상세 사진을 못 가져왔어요: ' + err.message;
    status.className = 'ai-status error';
  } finally {
    btn.disabled = false;
  }
});

async function runScrape(link) {
  const statusEl = document.getElementById('scrapeStatus');
  const imageInput = document.getElementById('imageUrlInput');
  const previewBox = document.getElementById('imagePreviewBox');
  const previewImg = document.getElementById('imagePreviewImg');

  statusEl.textContent = '상품 정보 가져오는 중…';
  statusEl.className = 'scrape-status loading';

  try {
    const res = await fetch('/api/scrape-product', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    imageInput.value = data.imageUrl;
    previewImg.src = data.imageUrl;
    previewBox.classList.remove('hidden');
    document.getElementById('imageToolsRow').classList.remove('hidden');
    document.getElementById('detailImagesGallery').classList.add('hidden');
    currentDetailImages = data.images || [data.imageUrl];
    originalProductImage = data.imageUrl;

    if (data.title) {
      currentProduct = { name: data.title, price: null };
    }

    statusEl.textContent = '상품 이미지를 자동으로 채웠어요' + (data.title ? ` · "AI로 글 써주기"를 눌러보세요` : '');
    statusEl.className = 'scrape-status ok';
  } catch (err) {
    statusEl.textContent = '자동으로 못 가져왔어요: ' + err.message;
    statusEl.className = 'scrape-status error';
  }
}

document.getElementById('linkInput').addEventListener('input', () => {
  updateCommentPreview();
  clearTimeout(scrapeTimer);
  const link = document.getElementById('linkInput').value.trim();
  if (!link || link === lastScrapedLink) return;
  scrapeTimer = setTimeout(() => {
    lastScrapedLink = link;
    runScrape(link);
  }, 900); // 타이핑 멈추고 0.9초 후 자동 실행
});

// ---- 댓글 미리보기 ----
let disclosureTemplate = '';

function updateCommentPreview() {
  const link = document.getElementById('linkInput').value.trim();
  const enabled = document.getElementById('autoCommentToggle').checked;
  const box = document.getElementById('commentPreview');
  const textEl = document.getElementById('commentPreviewText');
  if (link && enabled) {
    box.classList.remove('hidden');
    textEl.textContent = (disclosureTemplate || '{link}').replace('{link}', link);
  } else {
    box.classList.add('hidden');
  }
}
document.getElementById('autoCommentToggle').addEventListener('change', updateCommentPreview);

// ---- 글 예약 폼 ----
document.getElementById('composeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('composeMsg');
  const body = {
    text: form.text.value,
    link: form.link.value,
    image_url: form.image_url.value,
    extra_image_url: form.extra_image_url.value,
    video_url: form.video_url.value,
    scheduled_at: new Date(form.scheduled_at.value).toISOString(),
    auto_comment_enabled: form.auto_comment_enabled.checked,
    // 영상 프레임을 실제로 골라서 쓴 경우에만 채워짐 — 완전자동화가 나중에 비슷한 상품을 고를 때
    // 이 조합을 재사용할 수 있도록 media_sources에 저장하는 용도(선택 사항)
    product_name: currentFrameJobId ? currentProduct.name || '' : undefined,
    frame_job_id: currentFrameJobId || undefined,
  };
  try {
    const res = await apiFetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    msg.textContent = '예약 등록 완료';
    msg.className = 'msg';
    form.reset();
    updateCommentPreview();
    document.getElementById('imagePreviewBox').classList.add('hidden');
    document.getElementById('videoPreviewBox').classList.add('hidden');
    document.getElementById('uploadStatus').className = 'scrape-status hidden';
    document.getElementById('scrapeStatus').className = 'scrape-status hidden';
    document.getElementById('aiGenerateStatus').textContent = '';
    document.getElementById('aiCandidates').classList.add('hidden');
    document.getElementById('aiCandidates').innerHTML = '';
    document.getElementById('imageToolsRow').classList.add('hidden');
    document.getElementById('detailImagesGallery').classList.add('hidden');
    document.getElementById('retouchStatus').textContent = '';
    document.getElementById('videoUsageRow').classList.add('hidden');
    // 선택된 프레임 이미지는 방금 등록한 예약글이 계속 참조하므로 여기서 파일을 지우지 않는다 —
    // 상태 변수만 초기화한다 (실제 정리는 영상 교체/삭제 시 resetVideoFrameUI에서 처리됨).
    currentFrameJobId = null;
    currentFrames = [];
    selectedFrameUrls = [];
    frameRecommendations = {};
    recommendedFrameIds = [];
    document.getElementById('frameCandidatesBox').classList.add('hidden');
    document.getElementById('frameCandidatesGrid').innerHTML = '';
    document.getElementById('aiVisionStatus').textContent = '';
    document.getElementById('imageCompositionRow').classList.add('hidden');
    document.getElementById('compositionFramesOnlyLabel').textContent = '추출한 사진만 게시';
    document.getElementById('compositionFramesPlusProductLabel').textContent = '추출한 사진 + 상품 이미지';
    uploadedVideoUrl = '';
    currentDetailImages = [];
    originalProductImage = '';
    lastScrapedLink = '';
    uploadedFilename = null;
    currentProduct = { name: '', price: null };
    selectedYoutubeSource = null;
    renderSelectedYoutubeSource();
    document.getElementById('youtubeSearchInput').value = '';
    document.getElementById('youtubeResults').innerHTML = '';
    document.getElementById('youtubeSearchMsg').textContent = '';
    loadDashboard();
  } catch (err) {
    msg.textContent = '오류: ' + err.message;
    msg.className = 'msg error';
  }
});
