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
    swap("    authorReplies=Array.isArray(d?.authorReplies)?d.authorReplies.filter(Boolean).join('\\n\\n'):'';","    const detailReplies=Array.isArray(d?.authorReplies)?d.authorReplies.filter(Boolean):[];const detailLinks=Array.isArray(d?.affiliateLinks)?d.affiliateLinks.filter(Boolean):[];const allLinks=[...new Set([...seedLinks,...detailLinks])];authorReplies=[...detailReplies,allLinks.length?`[원게시물 쇼핑링크]\\n${allLinks.join('\\n')}`:''].filter(Boolean).join('\\n\\n');seedLinks=allLinks;");

    // 링크는 있으면 원상품 식별에 우선 사용한다. 없어도 좋은 소재는 버리지 않는다.
    // 이후 기존 V3의 본문/미디어 분석 -> 상품/재료 추정 -> 쿠팡 검색 fallback으로 계속 진행한다.
    swap("  if(!hasAffiliateLink(authorReplies))throw new Error('작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');","  if(!hasAffiliateLink(authorReplies))console.log('[AutopilotV3][AFFILIATE FALLBACK] 작성자 쇼핑링크 없음 → 소재 유지 후 본문/미디어 기반 상품검색');");
    swap("  if(!hasAffiliateLink(`${sourceText}\\n${authorReplies}`))throw new Error('원게시물/작성자 댓글에 쿠팡/네이버 쇼핑 링크가 없는 소재');","  if(!hasAffiliateLink(`${sourceText}\\n${authorReplies}`))console.log('[AutopilotV3][AFFILIATE FALLBACK] 원게시물/댓글 쇼핑링크 없음 → 소재 유지 후 상품검색');");
    swap("  if(!seedLinks.length)throw new Error('원게시물/작성자 댓글의 실제 쇼핑 href를 확보하지 못한 소재');","  if(!seedLinks.length)console.log('[AutopilotV3][AFFILIATE FALLBACK] 실제 쇼핑 href 없음 → 소재 유지');");
    swap("쇼핑링크 확인 source=${material.url}","쇼핑링크 우선/없으면 fallback source=${material.url}");
    swap("본문/댓글 쇼핑링크 확인 source=${material.url}","쇼핑링크 우선/없으면 fallback source=${material.url}");
    swap("실제 쇼핑 href 확인 source=${material.url}","쇼핑 href 우선/없으면 fallback source=${material.url}");

    patched=true;
    console.log(`[Autopilot][AFFILIATE SOURCE PATCH V3] 쇼핑 href 우선 + 링크 없어도 소재 유지 + 상품검색 fallback replacements=${replacements}`);
    mod._compile(src,filename);return;
  }
  return realLoader(mod,filename);
};
