(() => {
  const anchor=document.getElementById('userList'); if(!anchor)return;
  const section=document.createElement('section');
  section.innerHTML=`<h2 style="font-family:var(--font-display);font-size:15px;margin:28px 0 10px;">Threads 벤치마킹 계정</h2><div class="settings-form"><p style="font-size:12.5px;color:var(--text-dim);margin:0;line-height:1.55;">카테고리 없이 아이디만 등록합니다. 줄바꿈이나 쉼표로 여러 개를 한 번에 붙여넣을 수 있어요. 중복 아이디는 자동으로 제외합니다.</p><label>Threads 아이디 대량등록<textarea id="benchmarkUsernames" rows="7" placeholder="temissue&#10;jjune713&#10;itsmini_00&#10;또는 temissue,jjune713,itsmini_00"></textarea></label><button id="benchmarkAddBtn" type="button" style="padding:9px 14px;border-radius:8px;border:1px solid var(--border);background:var(--amber);font-weight:600;cursor:pointer;">한꺼번에 등록</button><p id="benchmarkMsg" style="font-size:12.5px;margin:0;"></p><div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:8px;"><strong style="font-size:12.5px;">등록된 계정</strong><div style="display:flex;align-items:center;gap:8px;"><span id="benchmarkCount" style="font-size:12px;color:var(--text-dim);"></span><button id="benchmarkToggleAll" type="button" style="font-size:11.5px;padding:5px 9px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;">모두 펼치기</button></div></div><div id="benchmarkList"></div></div>`;
  anchor.insertAdjacentElement('afterend',section);
  const input=document.getElementById('benchmarkUsernames'),list=document.getElementById('benchmarkList'),msg=document.getElementById('benchmarkMsg'),count=document.getElementById('benchmarkCount'),toggleAll=document.getElementById('benchmarkToggleAll');
  let allOpen=false;

  function normalizeUsername(v){return String(v||'').trim().replace(/^@+/,'').toLowerCase();}
  function dedupeAccounts(accounts){
    const seen=new Set(),out=[];
    for(const a of accounts||[]){const key=normalizeUsername(a.username);if(!key||seen.has(key))continue;seen.add(key);out.push(a);}return out;
  }
  function chunks(items,size){const out=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out;}
  function accountRow(a){return `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-top:1px solid var(--border);"><a href="https://www.threads.com/@${a.username}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;font-weight:600;">@${a.username}</a><button type="button" data-delete="${a.id}" style="font-size:11.5px;padding:5px 9px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);">삭제</button></div>`;}
  function renderGroups(accounts){
    if(!accounts.length)return '<p style="font-size:12px;color:var(--text-dim);">아직 등록된 계정이 없습니다.</p>';
    return chunks(accounts,10).map((group,idx)=>{
      const start=idx*10+1,end=start+group.length-1;
      return `<details style="border:1px solid var(--border);border-radius:9px;margin-top:8px;background:var(--surface-2);overflow:hidden;"><summary style="cursor:pointer;list-style:none;padding:10px 12px;font-size:12.5px;font-weight:700;display:flex;justify-content:space-between;align-items:center;"><span>${start}~${end}번</span><span style="font-size:11.5px;color:var(--text-dim);">${group.length}개 · 펼치기/접기</span></summary><div style="padding:0 12px 6px;background:var(--surface);">${group.map(accountRow).join('')}</div></details>`;
    }).join('');
  }
  function setAllGroups(open){allOpen=open;list.querySelectorAll('details').forEach(d=>d.open=open);toggleAll.textContent=open?'모두 접기':'모두 펼치기';}
  toggleAll.onclick=()=>setAllGroups(!allOpen);

  async function load(){
    const r=await fetch('/api/admin/benchmark-accounts'),d=await r.json();
    if(!r.ok){msg.textContent=d.error||'불러오기 실패';return;}
    const raw=d.accounts||[],accounts=dedupeAccounts(raw);
    count.textContent=`${accounts.length}개`;
    list.innerHTML=renderGroups(accounts);
    setAllGroups(false);
    list.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const r=await fetch('/api/admin/benchmark-accounts/'+b.dataset.delete,{method:'DELETE'});if(r.ok)load();});
  }

  document.getElementById('benchmarkAddBtn').onclick=async()=>{
    const raw=input.value.trim();
    if(!raw){msg.textContent='아이디를 붙여넣어주세요.';return;}
    const seen=new Set(),unique=[];
    for(const token of raw.split(/[\s,;]+/)){const v=String(token||'').trim().replace(/^@+/,'');const key=v.toLowerCase();if(!v||seen.has(key))continue;seen.add(key);unique.push(v);}
    if(!unique.length){msg.textContent='등록할 새 아이디가 없습니다.';return;}
    msg.textContent='등록 중…';
    const r=await fetch('/api/admin/benchmark-accounts/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usernames:unique.join('\n')})}),d=await r.json();
    if(!r.ok){msg.textContent=d.error||'등록 실패';msg.style.color='var(--red)';return;}
    input.value='';
    msg.textContent=`등록 완료 · 신규 ${d.added}개 · 기존/중복 ${d.skipped}개`;
    msg.style.color='var(--green)';
    load();
  };
  load();
})();
