const fs=require('fs');
const path=require('path');
const Module=require('module');
const realLoader=Module._extensions['.js'];
let patched=false;

Module._extensions['.js']=function benchmarkMediaOnlyLoader(mod,filename){
  if(!patched && path.basename(filename)==='scheduler.js'){
    let src=fs.readFileSync(filename,'utf8');
    let replacements=0;
    const swap=(a,b)=>{if(src.includes(a)){src=src.replace(a,b);replacements++;return true;}return false;};

    // 원 Threads 게시물 이미지가 없을 때 쿠팡 상품 이미지/TEXT로 대체하지 않는다.
    swap(
`async function chooseImageFallback(result,localizedImages=null){
  const images=Array.isArray(localizedImages)?localizedImages:await cacheRemoteImages(Array.isArray(result?.sourceImages)?result.sourceImages:[],{limit:2});
  if(images.length>=2)return{videoUrl:null,imageUrl:images[0],extraImageUrl:images[1],imageSourceLabel:'Threads 소재 원본 이미지 2장(로컬 캐시)'};
  if(images.length===1)return{videoUrl:null,imageUrl:images[0],extraImageUrl:null,imageSourceLabel:'Threads 소재 원본 이미지 1장(로컬 캐시)'};
  const productImage=String(result?.product?.image||'').trim();
  if(productImage){
    try{
      const cached=await cacheRemoteImage(productImage);
      if(cached)return{videoUrl:null,imageUrl:cached,extraImageUrl:null,imageSourceLabel:'Threads 미디어 없음 → 쿠팡 상품 이미지 1장(로컬 캐시)'};
    }catch(err){console.warn(\`[Autopilot][PRODUCT IMAGE CACHE] 실패 → TEXT 발행 준비 reason="\${err.message}"\`);}
  }
  return{videoUrl:null,imageUrl:null,extraImageUrl:null,imageSourceLabel:'미디어 없음 → TEXT'};
}`,
`async function chooseImageFallback(result,localizedImages=null){
  const sourceImages=Array.isArray(result?.sourceImages)?result.sourceImages.filter(Boolean):[];
  const images=Array.isArray(localizedImages)?localizedImages:await cacheRemoteImages(sourceImages,{limit:10});
  if(!sourceImages.length||!images.length)throw new Error('벤치마킹 원게시물 이미지/영상을 확보하지 못했습니다. 쿠팡/외부/TEXT fallback 금지');
  if(images.length===1)return{videoUrl:null,imageUrl:images[0],extraImageUrl:null,imageSourceLabel:'벤치마킹 원게시물 이미지 1장'};
  const bundle=encodeMediaBundle(images.slice(0,10).map(url=>({type:'IMAGE',url})));
  if(!bundle)throw new Error('벤치마킹 원게시물 이미지 bundle 생성 실패');
  return{videoUrl:null,imageUrl:bundle,extraImageUrl:null,imageSourceLabel:\`벤치마킹 원게시물 이미지 \${Math.min(images.length,10)}장 전체\`};
}`);

    // 이미지+영상 혼합 게시물은 원게시물 미디어를 가능한 한 전부 묶어서 발행한다.
    swap(
"  const images=await cacheRemoteImages(sourceImages,{limit:9});",
"  const images=await cacheRemoteImages(sourceImages,{limit:10});"
    );
    swap(
"      const items=[{type:'VIDEO',url:videoUrl},...images.slice(0,9).map(url=>({type:'IMAGE',url}))];",
"      const items=[{type:'VIDEO',url:videoUrl},...images.slice(0,9).map(url=>({type:'IMAGE',url}))]; // Threads API carousel 최대 10개: 영상+원본 이미지 전부(최대치)"
    );
    swap(
"      console.warn(`[Autopilot][VIDEO IMPORT] 실패 → 로컬 이미지 fallback source=${result.sourceUrl} reason=\"${err.message}\"`);",
"      console.warn(`[Autopilot][VIDEO IMPORT] 실패 → 벤치마킹 원게시물 이미지가 있으면 그것만 사용 source=${result.sourceUrl} reason=\"${err.message}\"`); if(!images.length)throw new Error(`벤치마킹 원게시물 영상 다운로드 실패: ${err.message}`);"
    );

    patched=true;
    console.log(`[Autopilot][BENCHMARK MEDIA ONLY PATCH] 원게시물 사진/영상만 사용 · 혼합 전부 · 쿠팡/외부/TEXT fallback 금지 replacements=${replacements}`);
    mod._compile(src,filename);return;
  }
  return realLoader(mod,filename);
};
