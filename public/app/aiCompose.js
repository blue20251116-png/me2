// 대시보드: AI 본문 생성과 쿠팡 상품 검색.
// 화면 스크립트는 index.html에 적힌 순서대로 같은 전역 범위에서 실행된다.
/* global apiFetch, applyPickedProduct, selectedYoutubeSource */

// ---- 현재 상품 컨텍스트 (AI 글 생성에 사용) ----
let currentProduct = { name: '', price: null };

// ---- AI로 본문 자동 생성 (5개 후보 중 선택) ----
async function runAiGenerate() {
  const btn = document.getElementById('aiGenerateBtn');
  const status = document.getElementById('aiGenerateStatus');
  const textArea = document.querySelector('#composeForm textarea[name="text"]');
  const candidatesBox = document.getElementById('aiCandidates');

  const productName = currentProduct.name || textArea.value.trim();
  if (!productName) {
    status.textContent = '먼저 상품을 검색하거나 링크를 넣어주세요';
    status.className = 'ai-status error';
    return false;
  }

  btn.disabled = true;
  status.textContent = '5개 작성 중…';
  status.className = 'ai-status';
  candidatesBox.classList.add('hidden');
  candidatesBox.innerHTML = '';

  try {
    const res = await apiFetch('/api/generate-caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName,
        price: currentProduct.price,
        target: document.getElementById('composeTargetSelect').value,
        youtubeSource: selectedYoutubeSource || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    candidatesBox.innerHTML = data.texts
      .map(
        (t, i) => `
      <div class="ai-candidate" data-idx="${i}">
        <span class="pick-label">버전 ${i + 1} · 클릭하면 본문에 채워짐</span>
        <p>${escapeHtml(t)}</p>
      </div>`
      )
      .join('');
    candidatesBox.classList.remove('hidden');

    candidatesBox.querySelectorAll('.ai-candidate').forEach(card => {
      card.addEventListener('click', () => {
        candidatesBox.querySelectorAll('.ai-candidate').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        textArea.value = data.texts[Number(card.dataset.idx)];
      });
    });

    // 자동완성 흐름에서는 첫 번째 버전을 기본으로 바로 채워줌 (원하면 다른 버전으로 클릭해서 교체 가능)
    textArea.value = data.texts[0];
    candidatesBox.querySelector('.ai-candidate')?.classList.add('selected');

    status.textContent = `${data.texts.length}개 완성 · 마음에 드는 걸 눌러서 본문에 채우세요`;
    status.className = 'ai-status ok';
    return true;
  } catch (err) {
    status.textContent = '실패: ' + err.message;
    status.className = 'ai-status error';
    return false;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('aiGenerateBtn').addEventListener('click', runAiGenerate);

// ---- 쿠팡파트너스 상품 검색 ----
function fmtPrice(n) {
  if (n === null || n === undefined) return '';
  return Number(n).toLocaleString('ko-KR') + '원';
}

async function searchCoupangProducts() {
  const keyword = document.getElementById('productSearchInput').value.trim();
  const msg = document.getElementById('productSearchMsg');
  const resultsBox = document.getElementById('productResults');
  if (!keyword) return;

  msg.textContent = '검색 중…';
  msg.className = 'msg';
  resultsBox.innerHTML = '';

  try {
    const res = await apiFetch(`/api/coupang/search?keyword=${encodeURIComponent(keyword)}&limit=8`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    if (!data.products.length) {
      msg.textContent = '검색 결과가 없어요';
      return;
    }
    msg.textContent = `${data.products.length}개 상품 찾음 · 원하는 상품을 선택하세요`;

    resultsBox.innerHTML = data.products
      .map(
        (p, i) => `
      <div class="product-card">
        <img src="${escapeHtml(safeUrl(p.image))}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="p-info">
          <div class="p-name">${escapeHtml(p.name)}</div>
          <div class="p-price">${fmtPrice(p.price)}</div>
        </div>
        <button type="button" class="pick-btn" data-idx="${i}">이 상품 선택</button>
      </div>`
      )
      .join('');

    resultsBox.querySelectorAll('.pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = data.products[Number(btn.dataset.idx)];
        applyPickedProduct(p);
      });
    });
  } catch (err) {
    msg.textContent = '검색 실패: ' + err.message;
    msg.className = 'msg error';
  }
}
