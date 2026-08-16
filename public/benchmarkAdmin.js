(() => {
  const anchor = document.getElementById('userList');
  if (!anchor) return;
  const section = document.createElement('section');
  section.innerHTML = `
    <h2 style="font-family:var(--font-display);font-size:15px;margin:28px 0 10px;">Threads 벤치마킹 계정</h2>
    <div class="settings-form">
      <p style="font-size:12.5px;color:var(--text-dim);margin:0;line-height:1.55;">카테고리 없이 Threads 아이디만 등록합니다. 일반 사용자의 소재 찾기는 이 계정들의 최근 공개 게시물에서 가져옵니다.</p>
      <div style="display:flex;gap:8px;align-items:end;">
        <label style="flex:1;">Threads 아이디<input id="benchmarkUsername" type="text" placeholder="예: 90resettt 또는 @90resettt" /></label>
        <button id="benchmarkAddBtn" type="button" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--amber);font-weight:600;cursor:pointer;">추가</button>
      </div>
      <p id="benchmarkMsg" style="font-size:12.5px;margin:0;"></p>
      <div id="benchmarkList"></div>
    </div>`;
  anchor.insertAdjacentElement('afterend', section);
  const input=document.getElementById('benchmarkUsername'), list=document.getElementById('benchmarkList'), msg=document.getElementById('benchmarkMsg');
  async function load(){
    const r=await fetch('/api/admin/benchmark-accounts'); const d=await r.json();
    if(!r.ok){msg.textContent=d.error||'불러오기 실패';return;}
    const accounts=d.accounts||[];
    list.innerHTML=accounts.length?accounts.map(a=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-top:1px solid var(--border);"><a href="https://www.threads.com/@${a.username}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;font-weight:600;">@${a.username}</a><button type="button" data-delete="${a.id}" style="font-size:11.5px;padding:5px 9px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);">삭제</button></div>`).join(''):'<p style="font-size:12px;color:var(--text-dim);">아직 등록된 계정이 없습니다.</p>';
    list.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{await fetch('/api/admin/benchmark-accounts/'+b.dataset.delete,{method:'DELETE'});load();});
  }
  document.getElementById('benchmarkAddBtn').onclick=async()=>{
    const username=input.value.trim(); if(!username){msg.textContent='아이디를 입력해주세요.';return;}
    const r=await fetch('/api/admin/benchmark-accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})}); const d=await r.json();
    if(!r.ok){msg.textContent=d.error||'추가 실패';msg.style.color='var(--red)';return;}
    input.value='';msg.textContent='추가 완료';msg.style.color='var(--green)';load();
  };
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();document.getElementById('benchmarkAddBtn').click();}});
  load();
})();
