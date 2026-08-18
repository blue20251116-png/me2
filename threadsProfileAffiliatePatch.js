const fs=require('fs');
const path=require('path');
const Module=require('module');
const realLoader=Module._extensions['.js'];
let patched=false;

Module._extensions['.js']=function profileAffiliateLoader(mod,filename){
  if(!patched && path.basename(filename)==='benchmarkAccounts.js'){
    let src=fs.readFileSync(filename,'utf8');

    // 1) 프로필 소재 카드에서 보이는 쇼핑 href도 보존한다.
    const oldPush="out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length});";
    const newPush="const affiliateLinks=[...new Set([...root.querySelectorAll('a[href]')].map(x=>x.href||x.getAttribute('href')||'').filter(h=>/(?:link\\.)?coupang\\.com|naver\\.me|shopping\\.naver\\.com|smartstore\\.naver\\.com|brand\\.naver\\.com/i.test(String(h||''))))];out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length,affiliateLinks});";
    if(src.includes(oldPush)) src=src.replace(oldPush,newPush);

    // 2) Threads 답글은 lazy-load라서 댓글/답글 버튼을 여러 방식으로 눌러 펼친다.
    const oldExpand=/async function expandReplies\(page\)\{.*?\}\n\nlet detailQueue=/s;
    const newExpand=`async function expandReplies(page){
  for(let round=0;round<12;round++){
    let clicked=0;
    try{clicked=await page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\\s+/g,' ').trim();
      const re=/(답글|댓글|repl(?:y|ies)|responses?|더\\s*보기|view\\s*more|답글\\s*보기|댓글\\s*보기|개의\\s*답글)/i;
      let n=0;
      for(const el of document.querySelectorAll('button,[role="button"],a,div[role="button"]')){
        if(n>=30)break;
        const t=clean(el.innerText||el.textContent||el.getAttribute('aria-label')||'');
        if(!t||t.length>160||!re.test(t))continue;
        try{el.click();n++;}catch{}
      }
      return n;
    });}catch{}
    await page.mouse.wheel(0,850);
    await page.waitForTimeout(clicked?850:500);
    if(!clicked&&round>=6)break;
  }
}

let detailQueue=`;
    if(oldExpand.test(src)) src=src.replace(oldExpand,newExpand);

    // 3) 가장 중요한 부분: 원글 작성자 댓글의 DOM root를 직접 찾고 그 안의 실제 href를 수집한다.
    const marker="const authorReplies=[],affiliateLinks=[],seen=new Set();";
    if(src.includes(marker)){
      const inject=`const authorReplies=[],affiliateLinks=[],seen=new Set();
 // 작성자 댓글 전용 수집: profile anchor에서 reply/article root를 위로 추적한다.
 for(const profileAnchor of document.querySelectorAll('a[href]')){
   if(!isOwnProfileLink(profileAnchor))continue;
   let node=profileAnchor.closest('article,[role="article"]')||profileAnchor.parentElement;
   let chosen=null;
   for(let depth=0;depth<10&&node;depth++,node=node.parentElement){
     if(node===main)break;
     const txt=clean(node.innerText||'');
     const postLinks=[...new Set([...node.querySelectorAll('a[href*="/post/"]')].map(x=>canonical(x.href)))];
     const shopLinks=[...node.querySelectorAll('a[href]')].map(x=>ext(x.href||x.getAttribute('href')||'')).filter(h=>h&&shop(h));
     if(shopLinks.length){chosen=node;break;}
     if(txt.length>=4&&txt.length<=5000&&postLinks.length<=1)chosen=node;
   }
   if(!chosen)continue;
   const txt=clean(chosen.innerText||'');
   const hrefs=[...chosen.querySelectorAll('a[href]')].map(x=>ext(x.href||x.getAttribute('href')||'')).filter(Boolean);
   const shops=hrefs.filter(shop);
   if(!shops.length)continue;
   const packed=[txt,...shops].filter(Boolean).join('\\n').slice(0,7000);
   if(packed&&!seen.has(packed)){seen.add(packed);authorReplies.push(packed);}
   for(const h of shops)if(!affiliateLinks.includes(h))affiliateLinks.push(h);
 }
`;
      src=src.replace(marker,inject);
    }

    // 4) 상세 페이지 전체 HTML/network에서 발견된 링크는 작성자 링크 보조증거로 넣되,
    // 실제 authorReplies가 있으면 그것을 우선한다.
    const oldLog="if(affiliateLinks.length)console.log(`[Threads affiliate] @${username} 쇼핑링크 감지 count=${affiliateLinks.length} first=${affiliateLinks[0]}`);";
    const newLog="if(affiliateLinks.length)console.log(`[Threads affiliate] @${username} 쇼핑링크 감지 count=${affiliateLinks.length} authorReplies=${authorReplies.length} first=${affiliateLinks[0]}`);";
    if(src.includes(oldLog))src=src.replace(oldLog,newLog);

    patched=true;
    console.log('[Threads][PROFILE LINK PATCH V2] 작성자 답글 펼치기 + 작성자 댓글 실제 쇼핑 href 직접수집 활성화');
    mod._compile(src,filename);return;
  }
  return realLoader(mod,filename);
};
