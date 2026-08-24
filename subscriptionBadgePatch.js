'use strict';

const fs = require('fs');
const path = require('path');

if (!global.__ME2_SUBSCRIPTION_BADGE_PATCH__) {
  global.__ME2_SUBSCRIPTION_BADGE_PATCH__ = true;

  const indexPath = path.join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  const marker = '<div class="user-menu"><span id="myUserEmail" class="my-user-email"></span><a id="adminLink" href="/admin" class="my-admin-link hidden">관리자</a><button type="button" id="logoutBtn" class="my-logout-btn">로그아웃</button></div>';
  const replacement = '<div class="user-menu"><span id="myUserEmail" class="my-user-email"></span><span id="subscriptionRemaining" class="conn-badge conn-loading" style="white-space:nowrap;">이용권 확인 중…</span><a id="adminLink" href="/admin" class="my-admin-link hidden">관리자</a><button type="button" id="logoutBtn" class="my-logout-btn">로그아웃</button></div>';

  if (!html.includes('id="subscriptionRemaining"')) {
    if (!html.includes(marker)) throw new Error('[SUBSCRIPTION BADGE] user-menu marker not found');
    html = html.replace(marker, replacement);
  }

  const scriptMarker = '  <script src="app.js"></script>';
  const inlineScript = `  <script>\n    (async function loadSubscriptionRemaining(){\n      const el=document.getElementById('subscriptionRemaining');\n      if(!el)return;\n      try{\n        const res=await fetch('/api/auth/me');\n        if(!res.ok)throw new Error('me');\n        const me=await res.json();\n        if(me.role==='admin'){el.classList.add('hidden');return;}\n        const plan=String(me.plan||'이용권').toUpperCase();\n        if(!me.expires_at){\n          el.textContent=plan+' · 기간 미설정';\n          el.className='conn-badge conn-loading';\n          return;\n        }\n        const expiry=new Date(me.expires_at);\n        const diff=expiry.getTime()-Date.now();\n        const days=Math.max(0,Math.ceil(diff/86400000));\n        if(diff<=0){\n          el.textContent=plan+' · 만료됨';\n          el.className='conn-badge conn-no';\n        }else if(days<=1){\n          el.textContent=plan+' · 오늘 만료';\n          el.className='conn-badge conn-no';\n        }else{\n          el.textContent=plan+' · '+days+'일 남음';\n          el.className='conn-badge conn-yes';\n        }\n        el.title='이용권 만료일: '+expiry.toLocaleString('ko-KR');\n      }catch(e){\n        el.textContent='이용권 확인 실패';\n        el.className='conn-badge conn-no';\n      }\n    })();\n  </script>\n  <script src="app.js"></script>`;

  if (!html.includes('loadSubscriptionRemaining')) {
    if (!html.includes(scriptMarker)) throw new Error('[SUBSCRIPTION BADGE] app.js marker not found');
    html = html.replace(scriptMarker, inlineScript);
  }

  fs.writeFileSync(indexPath, html, 'utf8');
  console.log('[UI][SUBSCRIPTION BADGE] 상단 이용권 남은기간 표시 활성화');
}
