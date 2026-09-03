'use strict';
(() => {
  const panel=document.createElement('section');
  panel.className='settings-form';
  const title=document.createElement('h2');title.textContent='자동발행 상태';title.className='settings-title';
  const summary=document.createElement('p');
  const rows=document.createElement('div');
  const button=document.createElement('button');button.type='button';button.className='admin-btn';button.textContent='상태 새로고침';
  panel.append(title,summary,rows,button);
  document.querySelector('.admin-top')?.after(panel);
  const status={running:'처리 중',idle:'대기',waiting:'한도 회복 대기',ready:'예약 완료',blocked:'설정 확인 필요',retry:'재시도 예정'};
  const detail={THREADS_TOKEN_MISSING:'Threads 계정을 다시 연결해주세요',COUPANG_CREDENTIALS_INVALID:'쿠팡 API 키를 확인해주세요',SUBSCRIPTION_INACTIVE:'이용기간 또는 승인 상태를 확인해주세요',AI_HOURLY_BUDGET:'AI 시간당 사용 한도 도달'};
  let loading=false;
  async function load(){
    if(loading)return;loading=true;
    try{
      const response=await fetch('/api/admin/automation-health');
      if(!response.ok)throw new Error('상태를 불러오지 못했습니다');
      const data=await response.json();
      summary.textContent=`AI 요청 ${data.budget.used}/${data.budget.limit}회 · 서버 가동 ${Math.floor(data.uptimeSec/60)}분 · 결과 확인 필요 ${data.review.length}건`;
      rows.replaceChildren();
      for(const item of data.states){
        const row=document.createElement('p');
        const name=item.account_id===0?'예약글 보충':item.account_id===-1?'발행 처리':`계정 #${item.account_id}`;
        const updated=new Date(item.updated_at).toLocaleTimeString('ko-KR');
        const retry=item.retry_at?` · 다음 확인 ${new Date(item.retry_at).toLocaleTimeString('ko-KR')}`:'';
        row.textContent=`${name}: ${status[item.status]||item.status}${detail[item.detail]?' · '+detail[item.detail]:''}${retry} · 갱신 ${updated}`;
        rows.append(row);
      }
      for(const post of data.review){const row=document.createElement('p');row.textContent=`게시물 #${post.id} · 계정 #${post.account_id}: 발행 결과를 확인해주세요`;rows.append(row);}
    }catch(err){summary.textContent=err.message;}finally{loading=false;}
  }
  button.addEventListener('click',load);load();
  setInterval(()=>{if(!document.hidden)load();},30000);
})();
