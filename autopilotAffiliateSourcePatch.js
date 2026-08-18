const fs=require('fs');
const path=require('path');
const Module=require('module');
const realLoader=Module._extensions['.js'];
let patched=false;

Module._extensions['.js']=function affiliateSourceLoader(mod,filename){
  if(!patched && path.basename(filename)==='autopilotMaterialEngine.js'){
    let src=fs.readFileSync(filename,'utf8');
    let replacements=0;
    const swap=(a,b)=>{if(src.includes(a)){src=src.replace(a,b);replacements++;return true;}return false;};

    swap("  if(hasExternalLink(t))s-=30;","  if(hasAffiliateLink(t))s+=8; else if(hasExternalLink(t))s-=10;");
    swap("  const filtered=(m||[]).filter(x=>x?.url&&clean(x.text).length>=12&&!hasExternalLink(x.text)&&!isEngagementBait(x.text));","  const filtered=(m||[]).filter(x=>x?.url&&clean(x.text).length>=12&&!isEngagementBait(x.text));");
    swap("  let sourceText=clean(i?.text),authorReplies='',images=Array.isArray(i?.images)?i.images.filter(Boolean):[],videos=[];","  let sourceText=clean(i?.text),seedLinks=Array.isArray(i?.affiliateLinks)?i.affiliateLinks.filter(Boolean):[],authorReplies=seedLinks.length?`[원게시물 쇼핑링크]\\n${seedLinks.join('\\n')}`:'',images=Array.isArray(i?.images)?i.images.filter(Boolean):[],videos=[];");
    swap("    authorReplies=Array.isArray(d?.authorReplies)?d.authorReplies.filter(Boolean).join('\\n\\n'):'';","    const detailReplies=Array.isArray(d?.authorReplies)?d.authorReplies.filter(Boolean):[];const detailLinks=Array.isArray(d?.affiliateLinks)?d.affiliateLinks.filter(Boolean):[];const allLinks=[...new Set([...seedLinks,...detailLinks])];authorReplies=[...detailReplies,allLinks.length?`[원게시물 쇼핑링크]\\n${allLinks.join('\\n')}`:''].filter(Boolean).join('\\n\\n');");
    swap("  if(!hasAffiliateLink(authorReplies))throw new Error('작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');","  if(!hasAffiliateLink(`${sourceText}\\n${authorReplies}`))throw new Error('원게시물/작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');");
    swap("쇼핑링크 확인 source=${material.url}","본문/댓글 쇼핑링크 확인 source=${material.url}");

    patched=true;
    console.log(`[Autopilot][AFFILIATE SOURCE PATCH] 본문 쇼핑링크 허용 + 실제 href 보존 replacements=${replacements}`);
    mod._compile(src,filename);return;
  }
  return realLoader(mod,filename);
};
