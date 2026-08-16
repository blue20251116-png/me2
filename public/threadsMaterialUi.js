(() => {
  function hideComposeClutter() {
    const hide = el => { if (el) el.style.display = 'none'; };
    document.querySelectorAll('#tab-compose .panel').forEach(card => {
      const title = String(card.querySelector('h2')?.textContent || '').trim();
      if (title === 'AI 자동완성' || title.includes('관련 쇼츠 찾기')) hide(card);
    });
    hide(document.getElementById('autopilotYoutubeToggle')?.closest('label'));
    hide(document.getElementById('autopilotYoutubeOrderSelect')?.closest('label'));
    hide(document.getElementById('autopilotFrameMediaToggle')?.closest('label'));
    hide(document.getElementById('lifestylePanel'));
  }

  hideComposeClutter();
  requestAnimationFrame(hideComposeClutter);
  setTimeout(hideComposeClutter, 250);

  const form = document.getElementById('composeForm');
  if (!form) return;
  const panel = document.getElementById('threadsMaterialPanel');
  if (!panel) return;
  const h = panel.querySelector('h2'); if (h) h.textContent = '🔥 소재 찾기';
  const hint = panel.querySelector('.hint'); if (hint) hint.remove();
  const searchBtn = document.getElementById('threadsMaterialSearchBtn');
  const msg = document.getElementById('threadsMaterialMsg');
  const results = document.getElementById('threadsMaterialResults');
  if (!searchBtn || !msg || !results) return;
  searchBtn.textContent = '🔥 소재 찾기';

  let lastItems = [], generatedTexts = [], generatedComments = [], activeRecipeComment = '';
  let activeMaterial = false, activeMediaItems = [];
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const compact = t => { t=String(t||'').replace(/\s+/g,' ').trim(); return t.length>240?t.slice(0,240)+'…':t; };
  const setMsg=(text,type='')=>{msg.textContent=text||'';msg.className=`msg${type?' '+type:''}`;};
  const fetchWithTimeout=async(url,options={},ms=22000)=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),ms);try{return await apiFetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);}};
  function inferMode(item){
    const t=String(item?.text||'').toLowerCase();
    const cookingAction=/(레시피|만드는 법|만드는방법|재료|양념|소스|볶|굽|구이|끓|튀기|튀김|에어프라이어|찜|삶|썰어|섞어|버무|조리)/.test(t);
    const foodContext=/(밥|면|계란|두부|고기|삼겹|닭|대파|야채|채소|샐러드|간식|야식|요리)/.test(t);
    return cookingAction && foodContext ? 'recipe' : 'product';
  }

  function ensureRecipePreview(){
    let box=document.getElementById('threadsRecipeCommentPreview'); if(box)return box;
    box=document.createElement('div'); box.id='threadsRecipeCommentPreview'; box.className='hidden'; box.style.marginTop='14px';
    box.innerHTML=`<label style="display:block;margin:0 0 7px;font-size:14px;font-weight:700;">댓글</label><textarea id="threadsRecipeCommentText" rows="6" placeholder="재료 · 만드는 법 · 추가 설명이 여기에 들어갑니다" style="width:100%;box-sizing:border-box;resize:vertical;line-height:1.55;padding:14px;border-radius:14px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:inherit;"></textarea><p style="margin:6px 0 0;font-size:12px;color:var(--text-dim);">예약 발행하면 본문 다음 댓글로 자동 등록됩니다.</p>`;
    const candidates=document.getElementById('aiCandidates'); if(candidates?.parentNode)candidates.parentNode.insertBefore(box,candidates);else form.appendChild(box);
    box.querySelector('#threadsRecipeCommentText')?.addEventListener('input',e=>{activeRecipeComment=e.target.value.trim();}); return box;
  }
  function showComment(value){activeRecipeComment=String(value||'').trim();const box=ensureRecipePreview();const ta=document.getElementById('threadsRecipeCommentText');if(ta)ta.value=activeRecipeComment;box.classList.toggle('hidden',!activeRecipeComment);}
  function ensureMediaPreview(){let box=document.getElementById('threadsSourceMediaPreview');if(box)return box;box=document.createElement('div');box.id='threadsSourceMediaPreview';box.style.margin='12px 0';const anchor=document.getElementById('imageUrlInput')?.closest('label')||form.querySelector('[name="image_url"]')?.parentElement;if(anchor?.parentNode)anchor.parentNode.insertBefore(box,anchor);else form.appendChild(box);return box;}
  function showMediaPreview(items){const box=ensureMediaPreview();if(!items.length){box.innerHTML='';return;}box.innerHTML=`<div style="font-size:13px;font-weight:700;margin-bottom:7px;">가져온 원본 미디어 ${items.length}개</div><div style="display:flex;gap:7px;overflow-x:auto;padding-bottom:4px;">${items.map(m=>m.type==='IMAGE'?`<img src="${esc(m.url)}" style="width:78px;height:78px;object-fit:cover;border-radius:10px;flex:none;">`:`<div style="width:78px;height:78px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);font-size:12px;flex:none;">🎬 원본 영상</div>`).join('')}</div>`;}

  function render(items){
    lastItems=items||[]; if(!lastItems.length){results.innerHTML='';setMsg('새 소재를 찾지 못했어요.');return;}
    setMsg(`${lastItems.length}개 소재 찾음`);
    results.innerHTML=lastItems.map((x,i)=>`<div class="product-card" style="align-items:flex-start;gap:10px;">${x.thumbnail?`<img src="${esc(x.thumbnail)}" style="width:82px;height:82px;object-fit:cover;border-radius:12px;" onerror="this.style.display='none'">`:''}<div class="p-info" style="min-width:0;flex:1;"><div style="font-size:12px;font-weight:700;margin-bottom:4px;">@${esc(x.username||'threads')}</div><div class="p-name" style="white-space:normal;line-height:1.45;">${esc(compact(x.text)||'소재')}</div><div class="p-price" style="margin-top:5px;">${x.hasVideo?`🎬 영상 ${x.videoCount||1}`:''}${x.hasVideo&&x.imageCount?' · ':''}${x.imageCount?`🖼 사진 ${x.imageCount}`:''}</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;"><button type="button" class="pick-btn threads-material-use" data-idx="${i}">이 소재로 글 만들기</button><a class="btn-secondary" href="${esc(x.url)}" target="_blank" rel="noopener" style="padding:7px 10px;text-decoration:none;font-size:12px;">원문 보기</a></div></div></div>`).join('');
    results.querySelectorAll('.threads-material-use').forEach(b=>b.onclick=()=>prepare(Number(b.dataset.idx),b));
  }

  async function search(){if(searchBtn.disabled)return;searchBtn.disabled=true;results.innerHTML='';setMsg('새 소재를 찾는 중…');try{const r=await fetchWithTimeout('/api/threads/material-search?limit=10',{},22000);const d=await r.json();if(!r.ok)throw new Error(d.error||'소재 찾기 실패');render(d.items||[]);}catch(e){setMsg(e?.name==='AbortError'?'찾는 시간이 너무 길어 중단했어요. 다시 눌러주세요.':'소재를 가져오지 못했어요. 잠시 후 다시 눌러주세요.','error');}finally{searchBtn.disabled=false;}}
  function selectVersion(i){const ta=form.querySelector('textarea[name="text"]');if(generatedTexts[i]&&ta)ta.value=generatedTexts[i];showComment(generatedComments[i]||'');}

  async function prepare(i,btn){
    const item=lastItems[i]; if(!item)return; const mode=inferMode(item),old=btn.textContent; btn.disabled=true;btn.textContent='준비 중…';setMsg('선택한 게시물의 글·댓글·원본 미디어를 확인하는 중…');
    try{
      const writePromise=fetchWithTimeout('/api/threads/material-write',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceText:item.text||'',sourceUrl:item.url||'',username:item.username||'',mode,images:item.images||[],hasVideo:!!item.hasVideo})},35000).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'글 생성 실패');return d;});

      const videoPromise=fetchWithTimeout('/api/threads/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:item.url})},35000).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'영상 없음');return d;});

      const [wr,ir]=await Promise.allSettled([writePromise,videoPromise]);
      if(wr.status!=='fulfilled')throw new Error(wr.reason?.message||'글 생성 실패');
      generatedTexts=wr.value.texts||[];generatedComments=wr.value.comments||[];activeMaterial=true;
      const ta=form.querySelector('textarea[name="text"]');if(generatedTexts[0]&&ta)ta.value=generatedTexts[0];showComment(generatedComments[0]||'');
      const box=document.getElementById('aiCandidates');if(box&&generatedTexts.length){box.innerHTML=generatedTexts.map((t,n)=>`<div class="ai-candidate ${n===0?'selected':''}" data-threads-idx="${n}"><span class="pick-label">버전 ${n+1} · 클릭해서 교체</span><p style="white-space:pre-wrap;">${esc(t)}</p></div>`).join('');box.classList.remove('hidden');box.querySelectorAll('.ai-candidate').forEach(c=>c.onclick=()=>{box.querySelectorAll('.ai-candidate').forEach(z=>z.classList.remove('selected'));c.classList.add('selected');selectVersion(Number(c.dataset.threadsIdx));});}

      const exactImages=(wr.value.sourceMedia?.images||item.images||[]).filter(Boolean);
      const directVideos=(wr.value.sourceMedia?.videos||[]).filter(Boolean);
      const importedVideo=(ir.status==='fulfilled'&&ir.value?.url)?ir.value.url:'';
      const videoUrl=importedVideo||directVideos[0]||'';
      const expectedVideo=!!item.hasVideo||!!wr.value.sourceMedia?.hasVideo||directVideos.length>0;

      // 영상이 있는 원본은 사진이 10장이어도 영상 자리를 반드시 1칸 확보한다.
      const maxImages=videoUrl?9:10;
      const imageItems=exactImages.slice(0,maxImages).map(url=>({type:'IMAGE',url}));
      const videoItems=videoUrl?[{type:'VIDEO',url:videoUrl}]:[];
      activeMediaItems=[...imageItems,...videoItems];

      // 원본에서 영상이 확인됐는데 영상 URL까지 못 얻었으면 사진만으로 성공 처리하지 않는다.
      if(expectedVideo&&!videoUrl){
        const why=ir.status==='rejected'?(ir.reason?.message||'영상 추출 실패'):'영상 URL 확인 실패';
        throw new Error(`원본에 영상이 있는데 영상을 가져오지 못했습니다: ${why}`);
      }

      const im=document.getElementById('imageUrlInput'),ex=document.getElementById('extraImageUrlInput'),v=document.getElementById('videoUrlInput');
      if(im)im.value=exactImages[0]||'';
      if(ex)ex.value=exactImages[1]||'';
      if(v)v.value=videoUrl||'';

      showMediaPreview(activeMediaItems);
      if(!activeMediaItems.length)throw new Error('선택한 게시물의 원본 미디어를 가져오지 못했습니다.');
      const imageCount=activeMediaItems.filter(m=>m.type==='IMAGE').length;
      const videoCount=activeMediaItems.filter(m=>m.type==='VIDEO').length;
      const videoSource=videoCount?(importedVideo?' · 영상 파일 저장 완료':' · 원본 영상 URL 사용'):'';
      setMsg(`완료 · 글 ${generatedTexts.length}개 · 원본 사진 ${imageCount}개${videoCount?` · 원본 영상 ${videoCount}개`:''}${videoSource} 가져왔어요.`);form.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(e){activeMaterial=false;activeMediaItems=[];showMediaPreview([]);setMsg(e.message||'글 준비에 실패했어요. 다시 시도해주세요.','error');}finally{btn.disabled=false;btn.textContent=old;}
  }

  form.addEventListener('submit',async e=>{
    if(!activeMaterial)return;
    e.preventDefault();e.stopImmediatePropagation();const cm=document.getElementById('composeMsg'),sv=form.scheduled_at?.value;if(!sv){if(cm)cm.textContent='발행 예정 시각을 선택해주세요.';return;}
    const body={text:form.text.value,link:form.link.value,image_url:form.image_url.value,extra_image_url:form.extra_image_url.value,video_url:form.video_url.value,media_items:activeMediaItems,scheduled_at:new Date(sv).toISOString(),auto_comment_enabled:form.auto_comment_enabled.checked,recipe_comment_text:activeRecipeComment};
    try{const r=await apiFetch('/api/threads/material-post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw new Error(d.error||'예약 실패');if(cm)cm.textContent='예약 등록 완료 · 원본 미디어와 댓글도 함께 예약됐어요.';form.reset();activeRecipeComment='';activeMaterial=false;activeMediaItems=[];document.getElementById('threadsRecipeCommentPreview')?.classList.add('hidden');showMediaPreview([]);if(typeof loadDashboard==='function')loadDashboard();}catch(err){if(cm)cm.textContent='오류: '+err.message;}
  },true);
  searchBtn.addEventListener('click',search);
})();
