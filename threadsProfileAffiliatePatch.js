const fs=require('fs');
const path=require('path');
const Module=require('module');
const realLoader=Module._extensions['.js'];
let patched=false;

Module._extensions['.js']=function profileAffiliateLoader(mod,filename){
  if(!patched && path.basename(filename)==='benchmarkAccounts.js'){
    let src=fs.readFileSync(filename,'utf8');

    // Threads/Instagram 외부링크는 l.threads.net / l.instagram.com redirect로 감싸지는 경우가 많다.
    // u/url/target/q 쿼리값을 풀어서 실제 link.coupang.com 주소를 복원한다.
    const oldExt="const ext=h=>{try{const u=new URL(h,location.origin),host=u.hostname.toLowerCase();if(host.includes('threads.com')||host.includes('threads.net')||host.includes('instagram.com'))return'';return u.href;}catch{return'';}};";
    const newExt="const ext=h=>{try{let u=new URL(h,location.origin);const host=u.hostname.toLowerCase();if(/^(?:l\\.)?(?:threads\\.net|threads\\.com|instagram\\.com)$/i.test(host)||host==='l.instagram.com'){for(const key of ['u','url','target','q']){const raw=u.searchParams.get(key);if(!raw)continue;try{let decoded=raw;for(let i=0;i<3;i++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}const inner=new URL(decoded,location.origin);u=inner;break;}catch{}}}const finalHost=u.hostname.toLowerCase();if(finalHost.includes('threads.com')||finalHost.includes('threads.net')||finalHost.includes('instagram.com'))return'';return u.href;}catch{return'';}};";
    if(src.includes(oldExt)) src=src.replace(oldExt,newExt);

    // 프로필 카드의 링크도 redirect를 풀어 실제 쇼핑 href를 저장한다.
    const oldPush="out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length});";
    const newPush="const unwrapShop=h=>{try{let u=new URL(h,location.origin);if(/(?:^|\\.)threads\\.(?:com|net)$|(?:^|\\.)instagram\\.com$/i.test(u.hostname)){for(const k of ['u','url','target','q']){const v=u.searchParams.get(k);if(!v)continue;try{let d=v;for(let i=0;i<3;i++){const n=decodeURIComponent(d);if(n===d)break;d=n;}u=new URL(d,location.origin);break;}catch{}}}return u.href;}catch{return String(h||'');}};const affiliateLinks=[...new Set([...root.querySelectorAll('a[href]')].map(x=>unwrapShop(x.href||x.getAttribute('href')||'')).filter(h=>/(?:link\\.)?coupang\\.com|naver\\.me|shopping\\.naver\\.com|smartstore\\.naver\\.com|brand\\.naver\\.com/i.test(String(h||''))))];out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length,affiliateLinks});";
    if(src.includes(oldPush)) src=src.replace(oldPush,newPush);

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

    const marker="const authorReplies=[],affiliateLinks=[],seen=new Set();";
    if(src.includes(marker)){
      const inject=`const authorReplies=[],affiliateLinks=[],seen=new Set();
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

    const oldLog="if(affiliateLinks.length)console.log(`[Threads affiliate] @${username} 쇼핑링크 감지 count=${affiliateLinks.length} first=${affiliateLinks[0]}`);";
    const newLog="if(affiliateLinks.length)console.log(`[Threads affiliate] @${username} 쇼핑링크 감지 count=${affiliateLinks.length} authorReplies=${authorReplies.length} first=${affiliateLinks[0]}`);";
    if(src.includes(oldLog))src=src.replace(oldLog,newLog);

    patched=true;
    console.log('[Threads][PROFILE LINK PATCH V3] redirect 해제 + 작성자 댓글 실제 쇼핑 href 수집 활성화');
    mod._compile(src,filename);return;
  }
  return realLoader(mod,filename);
};
