const fs=require('fs');
const path=require('path');
const Module=require('module');
const realLoader=Module._extensions['.js'];
let patched=false;

Module._extensions['.js']=function profileAffiliateLoader(mod,filename){
  if(!patched && path.basename(filename)==='benchmarkAccounts.js'){
    let src=fs.readFileSync(filename,'utf8');
    const old="out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length});";
    const replacement="const affiliateLinks=[...new Set([...root.querySelectorAll('a[href]')].map(x=>x.href||x.getAttribute('href')||'').filter(h=>/(?:link\\.)?coupang\\.com|naver\\.me|shopping\\.naver\\.com|smartstore\\.naver\\.com|brand\\.naver\\.com/i.test(String(h||''))))];out.push({url:href,text,username,images:[...new Set(images)].slice(0,10),thumbnail:images[0]||'',imageCount:images.length,hasVideo:videos.length>0,videoCount:videos.length,affiliateLinks});";
    if(src.includes(old)){
      src=src.replace(old,replacement);
      patched=true;
      console.log('[Threads][PROFILE LINK PATCH] 동일 post 카드의 실제 쇼핑 href 수집 활성화 patchApplied=yes');
    }else{
      console.warn('[Threads][PROFILE LINK PATCH] profile post 패턴을 찾지 못했습니다 patchApplied=no');
    }
    mod._compile(src,filename);return;
  }
  return realLoader(mod,filename);
};
