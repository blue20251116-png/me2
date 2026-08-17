(() => {
  const STYLE_ID = 'liveInsightsStyle';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .live-insights-panel{margin-top:16px}
      .live-insights-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
      .live-insights-head h2{margin:0;font-size:18px}
      .live-insights-select{max-width:220px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);color:var(--text)}
      .live-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}
      .live-metric{padding:12px;border:1px solid var(--border);border-radius:14px;background:var(--surface-2)}
      .live-metric span{display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px}
      .live-metric strong{font-size:20px;line-height:1.1}
      .live-chart-wrap{height:230px;position:relative;border:1px solid var(--border);border-radius:14px;background:var(--surface-2);overflow:hidden}
      #liveViewsCanvas{width:100%;height:100%;display:block}
      .live-insights-foot{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--text-dim)}
      .live-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:13px;padding:20px;text-align:center}
      @media(max-width:640px){.live-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.live-insights-head{align-items:flex-start;flex-direction:column}.live-insights-select{max-width:none;width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    let panel = document.getElementById('liveInsightsPanel');
    if (panel) return panel;
    const dashboard = document.getElementById('tab-dashboard');
    if (!dashboard) return null;
    panel = document.createElement('div');
    panel.id = 'liveInsightsPanel';
    panel.className = 'panel live-insights-panel';
    panel.innerHTML = `
      <div class="live-insights-head">
        <h2>📈 조회수 실시간 추이</h2>
        <select id="livePostSelect" class="live-insights-select"><option value="">최근 글</option></select>
      </div>
      <div class="live-metrics">
        <div class="live-metric"><span>현재 조회수</span><strong id="liveCurrentViews">–</strong></div>
        <div class="live-metric"><span>최근 5분</span><strong id="liveFiveMin">–</strong></div>
        <div class="live-metric"><span>분당 평균</span><strong id="livePerMin">–</strong></div>
        <div class="live-metric"><span>발행 후</span><strong id="liveElapsed">–</strong></div>
      </div>
      <div class="live-chart-wrap"><canvas id="liveViewsCanvas"></canvas><div id="liveEmpty" class="live-empty">조회수 데이터를 기다리는 중이에요.</div></div>
      <div class="live-insights-foot"><span id="liveReactions">좋아요 – · 답글 – · 리포스트 –</span><span id="liveUpdatedAt">1분마다 자동 갱신</span></div>`;
    const statGrid = dashboard.querySelector('.stat-grid');
    if (statGrid?.nextSibling) dashboard.insertBefore(panel, statGrid.nextSibling); else dashboard.appendChild(panel);
    document.getElementById('livePostSelect')?.addEventListener('change', renderSelected);
    return panel;
  }

  let payload = null;
  let selectedPostId = null;
  const fmt = n => Number(n || 0).toLocaleString('ko-KR');
  function elapsedText(iso) {
    if (!iso) return '–';
    const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return `${mins}분`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  function deltaFive(history) {
    if (!history?.length) return 0;
    const last = history[history.length - 1];
    const cutoff = new Date(last.captured_at).getTime() - 5 * 60000;
    let base = history[0];
    for (const p of history) { if (new Date(p.captured_at).getTime() <= cutoff) base = p; else break; }
    return Math.max(0, Number(last.views || 0) - Number(base.views || 0));
  }
  function perMinute(history) {
    if (!history || history.length < 2) return 0;
    const first = history[0], last = history[history.length - 1];
    const mins = Math.max(1, (new Date(last.captured_at) - new Date(first.captured_at)) / 60000);
    return Math.max(0, (Number(last.views || 0) - Number(first.views || 0)) / mins);
  }

  function draw(history) {
    const canvas = document.getElementById('liveViewsCanvas');
    const empty = document.getElementById('liveEmpty');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0,0,w,h);
    if (!history || history.length < 2) { if (empty) empty.style.display='flex'; return; }
    if (empty) empty.style.display='none';
    const pad = {l:44,r:14,t:18,b:30};
    const iw=w-pad.l-pad.r, ih=h-pad.t-pad.b;
    const vals=history.map(x=>Number(x.views||0));
    const min=Math.min(...vals), max=Math.max(...vals), span=Math.max(1,max-min);
    const gridColor=getComputedStyle(document.documentElement).getPropertyValue('--border').trim()||'rgba(128,128,128,.2)';
    const textColor=getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim()||'#888';
    const lineColor=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#7c5cff';
    ctx.font='11px sans-serif'; ctx.fillStyle=textColor; ctx.strokeStyle=gridColor; ctx.lineWidth=1;
    for(let i=0;i<=4;i++){const y=pad.t+ih*i/4;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();const v=Math.round(max-span*i/4);ctx.fillText(fmt(v),4,y+4);}
    ctx.strokeStyle=lineColor;ctx.lineWidth=2.5;ctx.beginPath();
    history.forEach((p,i)=>{const x=pad.l+iw*(i/(history.length-1));const y=pad.t+ih*(1-(Number(p.views||0)-min)/span);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
    const first=new Date(history[0].captured_at), last=new Date(history[history.length-1].captured_at);
    ctx.fillStyle=textColor;ctx.fillText(first.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}),pad.l,h-9);
    const label=last.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});const tw=ctx.measureText(label).width;ctx.fillText(label,w-pad.r-tw,h-9);
  }

  function renderSelected() {
    if (!payload?.posts?.length) return;
    const select = document.getElementById('livePostSelect');
    selectedPostId = Number(select?.value || selectedPostId || payload.posts[0].id);
    const post = payload.posts.find(p => Number(p.id) === Number(selectedPostId)) || payload.posts[0];
    if (select && String(select.value) !== String(post.id)) select.value = String(post.id);
    const history = post.history || [];
    document.getElementById('liveCurrentViews').textContent = fmt(post.views);
    document.getElementById('liveFiveMin').textContent = `+${fmt(deltaFive(history))}`;
    document.getElementById('livePerMin').textContent = `+${fmt(Math.round(perMinute(history)))}`;
    document.getElementById('liveElapsed').textContent = elapsedText(post.posted_at);
    document.getElementById('liveReactions').textContent = `좋아요 ${fmt(post.likes)} · 답글 ${fmt(post.replies)} · 리포스트 ${fmt(post.reposts)}`;
    document.getElementById('liveUpdatedAt').textContent = payload.updatedAt ? `마지막 갱신 ${new Date(payload.updatedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}` : '1분마다 자동 갱신';
    draw(history);
  }

  async function loadLiveInsights() {
    if (!ensurePanel()) return;
    const accountId = Number(localStorage.getItem('activeAccountId'));
    if (!accountId) return;
    try {
      const res = await fetch(`/api/live-insights?accountId=${accountId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '조회 실패');
      payload = data;
      const select = document.getElementById('livePostSelect');
      const old = selectedPostId || Number(select?.value) || null;
      if (!data.posts?.length) {
        if(select) select.innerHTML='<option value="">오늘 발행된 글 없음</option>';
        document.getElementById('liveEmpty').style.display='flex';
        return;
      }
      select.innerHTML = data.posts.map((p,i)=>`<option value="${p.id}">${i===0?'최근 · ':''}${new Date(p.posted_at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})} · ${String(p.text||'').replace(/[<>]/g,'').slice(0,22)}</option>`).join('');
      selectedPostId = data.posts.some(p=>Number(p.id)===Number(old)) ? old : data.posts[0].id;
      select.value=String(selectedPostId);
      renderSelected();
    } catch (e) {
      const empty=document.getElementById('liveEmpty'); if(empty){empty.textContent='실시간 조회수를 불러오지 못했어요.';empty.style.display='flex';}
    }
  }

  ensurePanel();
  loadLiveInsights();
  setInterval(loadLiveInsights, 60000);
  window.addEventListener('resize', () => { if(payload) renderSelected(); });
  document.addEventListener('click', e => { if(e.target.closest?.('.account-chip[data-id]')) setTimeout(loadLiveInsights, 500); });
})();