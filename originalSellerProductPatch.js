const engine = require('./autopilotMaterialEngine');
const benchmark = require('./benchmarkAccounts');

const previousBuild = engine.buildThreadsFirstAutopilot.bind(engine);

function clean(v){ return String(v||'').replace(/\s+/g,' ').trim(); }
function authorFromThreadsUrl(url){
  try { return decodeURIComponent(new URL(String(url||'')).pathname.match(/^\/@([^/]+)\/post\//i)?.[1]||''); }
  catch { return ''; }
}
function extractCoupangLinks(details){
  const out=[];
  for(const reply of (details?.authorReplies||[])){
    const matches=String(reply||'').match(/https?:\/\/[^\s)\]}>,]+/gi)||[];
    for(const raw of matches){
      const u=raw.replace(/[.,;!?]+$/,'');
      if(/(?:^|\.)coupang\.com|link\.coupang\.com/i.test(u) && !out.includes(u)) out.push(u);
    }
  }
  return out.slice(0,8);
}
function canonicalProductUrl(raw){
  try{
    const u=new URL(raw);
    if(!/(^|\.)coupang\.com$/i.test(u.hostname)) return '';
    if(!/\/vp\/products\/\d+/i.test(u.pathname)) return '';
    const out=new URL(`${u.origin}${u.pathname}`);
    for(const key of ['itemId','vendorItemId']){
      const v=u.searchParams.get(key);
      if(v) out.searchParams.set(key,v);
    }
    return out.toString();
  }catch{return '';}
}
async function resolveOriginalSelectedProduct(link){
  const playwright=require('playwright');
  let browser,context;
  try{
    browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
    context=await browser.newContext({locale:'ko-KR',viewport:{width:1200,height:1600},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
    const page=await context.newPage();
    page.setDefaultTimeout(18000);
    await page.goto(link,{waitUntil:'domcontentloaded',timeout:18000});
    await page.waitForTimeout(1800);
    for(let i=0;i<3;i++){await page.mouse.wheel(0,700);await page.waitForTimeout(250);}
    const finalUrl=page.url();
    const data=await page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const productAnchors=()=>[...document.querySelectorAll('a[href*="/vp/products/"]')];
      const pickFromRoot=root=>{
        if(!root)return null;
        const a=root.matches?.('a[href*="/vp/products/"]')?root:root.querySelector?.('a[href*="/vp/products/"]');
        if(!a)return null;
        const img=a.querySelector?.('img')||root.querySelector?.('img');
        const title=clean(a.getAttribute('title')||a.innerText||root.innerText||img?.alt||'').slice(0,220);
        return{href:a.href,title,image:img?.currentSrc||img?.src||''};
      };
      const all=[...document.querySelectorAll('body *')].filter(el=>clean(el.textContent)==='선택한 상품'||clean(el.innerText)==='선택한 상품');
      for(const badge of all){
        let node=badge;
        for(let i=0;i<7&&node;i++,node=node.parentElement){
          const picked=pickFromRoot(node);
          if(picked)return{...picked,selected:true};
        }
      }
      const direct=/\/vp\/products\/\d+/i.test(location.pathname);
      if(direct){
        const title=clean(document.querySelector('meta[property="og:title"]')?.content||document.querySelector('h1')?.innerText||document.title).slice(0,220);
        const image=document.querySelector('meta[property="og:image"]')?.content||'';
        return{href:location.href,title,image,selected:true,direct:true};
      }
      const first=productAnchors()[0];
      if(first){
        const root=first.closest('li,article,[class*="product"],[class*="Product"]')||first.parentElement||first;
        const picked=pickFromRoot(root)||pickFromRoot(first);
        if(picked)return{...picked,selected:false,fallbackFirst:true};
      }
      return null;
    });
    if(!data?.href)return null;
    const url=canonicalProductUrl(data.href)||canonicalProductUrl(finalUrl);
    if(!url)return null;
    return{url,name:clean(data.title)||'원본 작성자 선택 상품',image:clean(data.image),selected:!!data.selected,fallbackFirst:!!data.fallbackFirst,sourceLink:link};
  }catch(err){
    console.warn(`[ORIGINAL COUPANG] 링크 해석 실패 link=${String(link).slice(0,120)} reason="${err.message}"`);
    return null;
  }finally{
    if(context)try{await context.close();}catch{}
    if(browser)try{await browser.close();}catch{}
  }
}

engine.buildThreadsFirstAutopilot=async function originalSellerProductBuild(accountId,options){
  const result=await previousBuild(accountId,options);
  if(!result?.sourceUrl)return result;
  try{
    const username=authorFromThreadsUrl(result.sourceUrl);
    const details=await benchmark.collectPostDetails(result.sourceUrl,username);
    const links=extractCoupangLinks(details);
    if(!links.length){
      console.log(`[ORIGINAL COUPANG] 작성자 쿠팡 링크 없음 → 기존 정확매칭 유지 source=${result.sourceUrl}`);
      return result;
    }
    console.log(`[ORIGINAL COUPANG] 작성자 쿠팡 링크 ${links.length}개 발견 source=${result.sourceUrl}`);
    let resolved=null;
    for(const link of links){
      const p=await resolveOriginalSelectedProduct(link);
      if(!p)continue;
      resolved=p;
      if(p.selected)break;
    }
    if(!resolved){
      console.warn('[ORIGINAL COUPANG] 상품을 확정하지 못해 기존 정확매칭 유지');
      return result;
    }
    result.product={...(result.product||{}),name:resolved.name,url:resolved.url,image:''};
    result.productSearchTerm=resolved.name;
    result.originalSellerProduct=resolved;
    console.log(`[ORIGINAL COUPANG] ${resolved.selected?'선택한 상품':'첫 상품 fallback'} 확정 product="${resolved.name}" canonical=${resolved.url}`);
  }catch(err){
    console.warn(`[ORIGINAL COUPANG] 원본상품 우선연결 실패 → 기존 정확매칭 유지 reason="${err.message}"`);
  }
  return result;
};

console.log('[ORIGINAL COUPANG PATCH] 작성자 링크 → 선택한 상품 → 사용자 딥링크 재생성 우선 적용');
