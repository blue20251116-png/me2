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
    const m=u.pathname.match(/\/vp\/products\/(\d+)/i);
    if(!m)return '';
    const out=new URL(`https://www.coupang.com/vp/products/${m[1]}`);
    for(const key of ['itemId','vendorItemId']){
      const v=u.searchParams.get(key);
      if(v)out.searchParams.set(key,v);
    }
    return out.toString();
  }catch{return '';}
}
function productIdFromUrl(raw){
  try{return new URL(raw).pathname.match(/\/vp\/products\/(\d+)/i)?.[1]||'';}catch{return '';}
}
async function resolveOriginalSelectedProduct(link){
  const playwright=require('playwright');
  let browser,context;
  try{
    browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
    context=await browser.newContext({locale:'ko-KR',viewport:{width:1280,height:1800},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'});
    const page=await context.newPage();
    page.setDefaultTimeout(22000);
    const seen=[];
    page.on('request',req=>{
      const u=req.url();
      if(/coupang\.com\/vp\/products\/\d+/i.test(u)&&!seen.includes(u))seen.push(u);
    });
    page.on('response',res=>{
      const u=res.url();
      if(/coupang\.com\/vp\/products\/\d+/i.test(u)&&!seen.includes(u))seen.push(u);
    });
    await page.goto(link,{waitUntil:'domcontentloaded',timeout:22000});
    await page.waitForTimeout(2200);

    // A short-link that redirects directly to a product is the strongest signal.
    let direct=canonicalProductUrl(page.url());
    if(direct){
      const meta=await page.evaluate(()=>({
        title:String(document.querySelector('meta[property="og:title"]')?.content||document.querySelector('h1')?.innerText||document.title||'').replace(/\s+/g,' ').trim().slice(0,240),
        image:document.querySelector('meta[property="og:image"]')?.content||''
      })).catch(()=>({title:'',image:''}));
      console.log(`[ORIGINAL COUPANG] redirect resolve 성공 productId=${productIdFromUrl(direct)} canonical=${direct}`);
      return{url:direct,name:clean(meta.title)||'원본 작성자 선택 상품',image:clean(meta.image),selected:true,direct:true,sourceLink:link};
    }

    // Some affiliate landing pages reveal the selected product after scripts/scroll.
    for(let i=0;i<5;i++){await page.mouse.wheel(0,700);await page.waitForTimeout(350);}
    const data=await page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const anchors=[...document.querySelectorAll('a[href*="/vp/products/"]')];
      const toData=(a,selected=false)=>{
        if(!a)return null;
        const root=a.closest('li,article,[class*="product"],[class*="Product"],[class*="item"],[class*="Item"]')||a.parentElement||a;
        const img=a.querySelector('img')||root?.querySelector?.('img');
        const title=clean(a.getAttribute('title')||img?.alt||root?.innerText||a.innerText||'').slice(0,240);
        return{href:a.href,title,image:img?.currentSrc||img?.src||'',selected};
      };
      const badges=[...document.querySelectorAll('body *')].filter(el=>/^(선택한 상품|추천 상품)$/i.test(clean(el.textContent||el.innerText)));
      for(const badge of badges){
        let node=badge;
        for(let i=0;i<9&&node;i++,node=node.parentElement){
          const a=node.matches?.('a[href*="/vp/products/"]')?node:node.querySelector?.('a[href*="/vp/products/"]');
          if(a)return toData(a,true);
        }
      }
      // Prefer a unique product link. Do not blindly take the first when many products exist.
      const uniq=[];
      const ids=new Set();
      for(const a of anchors){
        const m=a.href.match(/\/vp\/products\/(\d+)/i); if(!m||ids.has(m[1]))continue;
        ids.add(m[1]); uniq.push(a);
      }
      if(uniq.length===1)return toData(uniq[0],true);
      return null;
    }).catch(()=>null);

    if(data?.href){
      const url=canonicalProductUrl(data.href);
      if(url){
        console.log(`[ORIGINAL COUPANG] landing 선택상품 resolve 성공 productId=${productIdFromUrl(url)} canonical=${url}`);
        return{url,name:clean(data.title)||'원본 작성자 선택 상품',image:clean(data.image),selected:true,sourceLink:link};
      }
    }

    // Last reliable signal: exactly one product id observed in network traffic.
    const uniqueNetwork=[...new Map(seen.map(u=>[productIdFromUrl(u),canonicalProductUrl(u)])).entries()].filter(([id,u])=>id&&u);
    if(uniqueNetwork.length===1){
      const url=uniqueNetwork[0][1];
      console.log(`[ORIGINAL COUPANG] network resolve 성공 productId=${uniqueNetwork[0][0]} canonical=${url}`);
      return{url,name:'원본 작성자 선택 상품',image:'',selected:true,network:true,sourceLink:link};
    }
    console.warn(`[ORIGINAL COUPANG] 링크는 열렸지만 단일 상품 식별 실패 final=${page.url()} productCandidates=${uniqueNetwork.length}`);
    return null;
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
      console.log(`[ORIGINAL COUPANG] 작성자 쿠팡 링크 없음 source=${result.sourceUrl}`);
      return result;
    }
    console.log(`[ORIGINAL COUPANG] 작성자 쿠팡 링크 ${links.length}개 발견 source=${result.sourceUrl}`);
    let resolved=null;
    for(const link of links){
      const p=await resolveOriginalSelectedProduct(link);
      if(p){resolved=p;break;}
    }
    if(!resolved){
      console.warn('[ORIGINAL COUPANG] 원작성자 동일상품 식별 실패 → 정확매칭 fallback 사용');
      return result;
    }
    result.product={...(result.product||{}),productId:productIdFromUrl(resolved.url)||result.product?.productId,name:resolved.name,url:resolved.url,image:resolved.image||''};
    result.productSearchTerm=resolved.name;
    result.originalSellerProduct=resolved;
    result.originalSellerProductExact=true;
    console.log(`[ORIGINAL COUPANG] 동일상품 확정 productId=${productIdFromUrl(resolved.url)} product="${resolved.name}" canonical=${resolved.url}`);
  }catch(err){
    console.warn(`[ORIGINAL COUPANG] 원본상품 우선연결 실패 → 정확매칭 fallback reason="${err.message}"`);
  }
  return result;
};

console.log('[ORIGINAL COUPANG PATCH] 작성자 링크 redirect/landing/network 추적 → 동일상품 canonical URL 우선 적용');
