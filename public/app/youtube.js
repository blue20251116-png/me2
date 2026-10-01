// 대시보드: 관련 쇼츠 찾기 (YouTube 소재 탐색, 다운로드 아님).
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global apiFetch */

// ---- 🔥 관련 쇼츠 찾기 (YouTube 콘텐츠 소싱 — 다운로드 아님, 소재 탐색용) ----
let selectedYoutubeSource = null;
// 같은 키워드+정렬로 짧은 시간 내 반복 검색하면 API 쿼터를 아끼기 위해 프론트 메모리에만 잠깐 캐시
const youtubeSearchCache = new Map();
const YOUTUBE_CACHE_TTL_MS = 2 * 60 * 1000;

function fmtViews(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${Math.round(num / 10000)}만`;
  if (num >= 10000) return `${(num / 10000).toFixed(1)}만`;
  return num.toLocaleString('ko-KR');
}

function fmtYoutubeDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function renderSelectedYoutubeSource() {
  const box = document.getElementById('youtubeSourceBox');
  if (!selectedYoutubeSource) {
    box.classList.add('hidden');
    return;
  }
  document.getElementById('youtubeSourceTitle').textContent = selectedYoutubeSource.title || '';
  document.getElementById('youtubeSourceChannel').textContent = selectedYoutubeSource.channelTitle || '';
  box.classList.remove('hidden');
}

function renderYoutubeResults(videos) {
  const msg = document.getElementById('youtubeSearchMsg');
  const resultsBox = document.getElementById('youtubeResults');

  msg.textContent = `${videos.length}개 영상 찾음 · 참고할 영상을 골라주세요`;
  msg.className = 'msg';

  resultsBox.innerHTML = videos
    .map(
      (v, i) => `
    <div class="youtube-card">
      <img src="${escapeHtml(safeUrl(v.thumbnail))}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="yt-info">
        <div class="yt-title">${escapeHtml(v.title)}</div>
        <div class="yt-meta">${escapeHtml(v.channelTitle)} · 조회수 ${fmtViews(v.views)} · ${escapeHtml(v.duration)} · ${fmtYoutubeDate(v.publishedAt)}</div>
        <div class="yt-actions">
          <a href="${escapeHtml(safeUrl(v.url) || '#')}" target="_blank" rel="noopener noreferrer">YouTube에서 보기</a>
          <button type="button" class="use-btn" data-idx="${i}">이 소재 사용</button>
        </div>
      </div>
    </div>`
    )
    .join('');

  resultsBox.querySelectorAll('.use-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = videos[Number(btn.dataset.idx)];
      selectedYoutubeSource = {
        id: v.id,
        title: v.title,
        description: v.description,
        channelTitle: v.channelTitle,
        url: v.url,
      };
      renderSelectedYoutubeSource();
    });
  });
}

async function searchYoutubeVideos() {
  const btn = document.getElementById('youtubeSearchBtn');
  if (btn.disabled) return; // 검색 버튼 연타 방지

  const keyword = document.getElementById('youtubeSearchInput').value.trim();
  const order = document.getElementById('youtubeOrderSelect').value;
  const msg = document.getElementById('youtubeSearchMsg');
  const resultsBox = document.getElementById('youtubeResults');

  if (!keyword) {
    msg.textContent = '상품명을 먼저 입력해주세요';
    msg.className = 'msg error';
    return;
  }

  const cacheKey = `${keyword}::${order}`;
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < YOUTUBE_CACHE_TTL_MS) {
    renderYoutubeResults(cached.videos);
    return;
  }

  btn.disabled = true;
  msg.textContent = '검색 중…';
  msg.className = 'msg';
  resultsBox.innerHTML = '';

  try {
    const res = await apiFetch(
      `/api/youtube/search?keyword=${encodeURIComponent(keyword)}&order=${encodeURIComponent(order)}&limit=10`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const videos = (data.videos || []).slice(0, 6);
    youtubeSearchCache.set(cacheKey, { videos, at: Date.now() });

    if (!videos.length) {
      msg.textContent = data.message || '관련 영상을 찾지 못했습니다. 검색어를 조금 다르게 입력해보세요.';
      msg.className = 'msg error';
      return;
    }
    renderYoutubeResults(videos);
  } catch (err) {
    msg.textContent = err.message || 'YouTube 검색 중 오류가 발생했습니다.';
    msg.className = 'msg error';
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('youtubeSearchBtn').addEventListener('click', searchYoutubeVideos);
document.getElementById('youtubeSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    searchYoutubeVideos();
  }
});
document.getElementById('clearYoutubeSourceBtn').addEventListener('click', () => {
  selectedYoutubeSource = null;
  renderSelectedYoutubeSource();
});
