(()=>{
  const PAGE_SIZE=10;
  let page=1;
  let planFilter='all';
  let query='';
  let applying=false;

  function ensureUi(){
    const list=document.getElementById('userList');
    if(!list||document.getElementById('memberEnhanceBar'))return;
    const wrap=document.createElement('div');
    wrap.id='memberEnhanceBar';
    wrap.innerHTML=`
      <style>
        #memberEnhanceBar{margin:0 0 12px;display:flex;flex-direction:column;gap:8px}
        .member-search{width:100%;box-sizing:border-box;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:10px;padding:10px 12px;font-size:13px}
        .member-filter-row{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}
        .member-filter-btn{white-space:nowrap;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:6px 10px;font-size:11.5px;cursor:pointer}
        .member-filter-btn.active{border-color:#ff4f87;background:#fff7fb;font-weight:700}
        .user-card{cursor:pointer;transition:.15s ease}
        .user-card.member-collapsed .user-plan,.user-card.member-collapsed .user-actions{display:none!important}
        .user-card.member-collapsed{padding-bottom:10px}
        .user-card.member-hidden{display:none!important}
        .member-summary{font-size:11.5px;color:var(--text-dim);margin-top:5px;line-height:1.5}
        #memberPager{display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0 4px}
        #memberPager button{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:7px 11px;font-size:11.5px;cursor:pointer}
        #memberPager button:disabled{opacity:.35;cursor:default}
        #memberPageInfo{font-size:11.5px;color:var(--text-dim);min-width:72px;text-align:center}
      </style>
      <input class="member-search" id="memberSearch" placeholder="이메일 · 이름 · Threads ID 검색" autocomplete="off" />
      <div class="member-filter-row">
        <button type="button" class="member-filter-btn active" data-plan-filter="all">전체 플랜</button>
        <button type="button" class="member-filter-btn" data-plan-filter="basic">베이직</button>
        <button type="button" class="member-filter-btn" data-plan-filter="pro">프로</button>
        <button type="button" class="member-filter-btn" data-plan-filter="admin">관리자</button>
      </div>`;
    list.parentNode.insertBefore(wrap,list);
    const pager=document.createElement('div');
    pager.id='memberPager';
    pager.innerHTML='<button type="button" id="memberPrev">이전</button><span id="memberPageInfo">1 / 1</span><button type="button" id="memberNext">다음</button>';
    list.parentNode.insertBefore(pager,list.nextSibling);

    document.getElementById('memberSearch').addEventListener('input',e=>{query=String(e.target.value||'').trim().toLowerCase();page=1;apply();});
    wrap.querySelectorAll('[data-plan-filter]').forEach(btn=>btn.addEventListener('click',()=>{planFilter=btn.dataset.planFilter;page=1;wrap.querySelectorAll('[data-plan-filter]').forEach(b=>b.classList.toggle('active',b===btn));apply();}));
    document.getElementById('memberPrev').onclick=()=>{if(page>1){page--;apply();}};
    document.getElementById('memberNext').onclick=()=>{page++;apply();};
  }

  function cardPlan(card){
    const text=(card.innerText||'').toLowerCase();
    if(/관리자|admin/.test(text)&&!/현재 권한/.test(text))return'admin';
    if(/현재 권한:\s*프로|프로 권한/.test(text))return'pro';
    if(/현재 권한:\s*베이직|베이직 권한/.test(text))return'basic';
    return text.includes('프로')?'pro':text.includes('베이직')?'basic':'admin';
  }

  function decorate(card){
    if(card.dataset.memberEnhanced==='1')return;
    card.dataset.memberEnhanced='1';
    card.classList.add('member-collapsed');
    const top=card.querySelector('.user-top');
    const meta=card.querySelector('.user-meta');
    const plan=cardPlan(card);
    if(top&&meta){
      const summary=document.createElement('div');
      summary.className='member-summary';
      const threads=((card.innerText||'').match(/자동화 Threads ID\s*[·:]?\s*([^\n]+)/i)||[])[1]||'';
      summary.textContent=`${threads?`Threads ${threads.trim()} · `:''}${plan==='admin'?'관리자':plan==='pro'?'프로':'베이직'} · 눌러서 관리`;
      meta.insertAdjacentElement('afterend',summary);
    }
    card.addEventListener('click',e=>{
      if(e.target.closest('button,input,a,select,textarea'))return;
      card.classList.toggle('member-collapsed');
    });
  }

  function apply(){
    if(applying)return;
    applying=true;
    try{
      ensureUi();
      const list=document.getElementById('userList');
      if(!list)return;
      const cards=[...list.querySelectorAll('.user-card')];
      cards.forEach(decorate);
      const matched=cards.filter(card=>{
        const text=(card.innerText||'').toLowerCase();
        const p=cardPlan(card);
        return (!query||text.includes(query))&&(planFilter==='all'||p===planFilter);
      });
      const pages=Math.max(1,Math.ceil(matched.length/PAGE_SIZE));
      if(page>pages)page=pages;
      const start=(page-1)*PAGE_SIZE,end=start+PAGE_SIZE;
      cards.forEach(c=>c.classList.add('member-hidden'));
      matched.slice(start,end).forEach(c=>c.classList.remove('member-hidden'));
      const info=document.getElementById('memberPageInfo');
      const prev=document.getElementById('memberPrev');
      const next=document.getElementById('memberNext');
      if(info)info.textContent=`${page} / ${pages} · ${matched.length}명`;
      if(prev)prev.disabled=page<=1;
      if(next)next.disabled=page>=pages;
    }finally{applying=false;}
  }

  function boot(){
    ensureUi();
    apply();
    const list=document.getElementById('userList');
    if(list)new MutationObserver(()=>setTimeout(apply,0)).observe(list,{childList:true,subtree:false});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(boot,50));else setTimeout(boot,50);
})();
