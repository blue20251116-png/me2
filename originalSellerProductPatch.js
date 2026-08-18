const engine = require('./autopilotMaterialEngine');
const benchmark = require('./benchmarkAccounts');
const axios = require('axios');

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
    const host=u.hostname.toLowerCase();
    if(!(host==='coupang.com'||host==='www.coupang.com'||host.endsWith('.coupang.com'))) return '';
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
  try{
    const u=new URL(raw);
    return u.pathname.match(/\/vp\/products\/(\d+)/i)?.[1]||u.searchParams.get('productId')||'';
  }catch{return '';}
}
function canonicalFromProductId(id){return /^\d+$/.test(String(id||''))?`https://www.coupang.com/vp/products/${id}`:'';}
function extractUniqueProductIds(text){
  const s=String(text||'');
  const ids=new Set();
  const patterns=[
    /\/vp\/products\/(\d{5,})/gi,
    /[?&]productId=(\d{5,})/gi,
    /["']productId["']\s*[:=]\s*["']?(\d{5,})/gi,
    /productId%3D(\d{5,})/gi,
    /coupang:\/\/[^\s"']*productId[=/:](\d{5,})/gi
  ];
  for(const re of patterns){let m;while((m=re.exec(s)))ids.add(m[1]);}
  return [...ids];
}
async function resolveViaHttp(link){
  try{
    const res=await axios.get(link,{
      timeout:18000,
      maxRedirects:10,
      validateStatus:s=>s>=200&&s<400,
      headers:{
        'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language':'ko-KR,ko;q=0.9,en;q=0.7',
        'referer':'https://www.threads.com/'
      }
    });
    const finalUrl=String(res?.request?.res?.responseUrl||res?.request?._redirectable?._currentUrl||link);
    const direct=canonicalProductUrl(finalUrl);
    if(direct){
      console.log(`[ORIGINAL COUPANG] HTTP redirect resolve 성공 productId=${productIdFromUrl(direct)} canonical=${direct}`);
      return{url:direct,name:'원본 작성자 선택 상품',image:'',selected:true,http:true,sourceLink:link};
    }
    const html=typeof res.data==='string'?res.data:JSON.stringify(res.data||{});
    const ids=extractUniqueProductIds(html);
    if(ids.length===1){
      const url=canonicalFromProductId(ids[0]);
      console.log(`[ORIGINAL COUPANG] HTTP body productId resolve 성공 productId=${ids[0]} canonical=${url}`);
      return{url,name:'원본 작성자 선택 상품',image:'',selected:true,httpBody:true,sourceLink:link};
    }
    console.log(`[ORIGINAL COUPANG] HTTP shortlink 분석 final=${finalUrl} productIds=${ids.length}`);
  }catch(err){
    console.warn(`[ORIGINAL COUPANG] HTTP shortlink 분석 실패 reason="${err.message}"`);
  }
  return null;
}
async function resolveOriginalSelectedProduct(link){
  const httpResolved=await resolveViaHttp(link);
  if(httpResolved)return httpResolved;

  const playwright=require('playwright');
  let browser,context;
  try{
    browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
    context=await browser.newContext({
      locale:'ko-KR',
      viewport:{width:390,height:844},
      isMobile:true,
      hasTouch:true,
      userAgent:'Mozilla/5.0 (Linux; Android 15; SM-S938N) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36'
    });
    const page=await context.newPage();
    page.setDefaultTimeout(24000);
    const seenUrls=[];
    const seenIds=new Set();
    const remember=u=>{
      const raw=String(u||'');
      if(raw&&!seenUrls.includes(raw))seenUrls.push(raw);
      for(const id of extractUniqueProductIds(raw))seenIds.add(id);
    };
    page.on('request',req=>remember(req.url()));
    page.on('response',res=>remember(res.url()));
    page.on('framenavigated',frame=>remember(frame.url()));

    await page.goto(link,{waitUntil:'domcontentloaded',timeout:24000});
    await page.waitForTimeout(2500);
    remember(page.url());

    let direct=canonicalProductUrl(page.url());
    if(direct){
      const meta=await page.evaluate(()=>({
        title:String(document.querySelector('meta[property="og:title"]')?.content||document.querySelector('h1')?.innerText||document.title||'').replace(/\s+/g,' ').trim().slice(0,240),
        image:document.querySelector('meta[property="og:image"]')?.content||''
      })).catch(()=>({title:'',image:''}));
      console.log(`[ORIGINAL COUPANG] browser redirect resolve 성공 productId=${productIdFromUrl(direct)} canonical=${direct}`);
      return{url:direct,name:clean(meta.title)||'원본 작성자 선택 상품',image:clean(meta.image),selected:true,direct:true,sourceLink:link};
    }

    // Collect product IDs hidden in HTML/scripts/deep links, not only ordinary anchors.
    const snapshot=await page.evaluate(()=>({
      html:document.documentElement?.innerHTML||'',
      hrefs:[...document.querySelectorAll('a[href]')].map(a=>a.href).filter(Boolean),
      title:String(document.querySelector('meta[property="og:title"]')?.content||document.title||''),
      image:document.querySelector('meta[property="og:image"]')?.content||''
    })).catch(()=>({html:'',hrefs:[],title:'',image:''}));
    for(const id of extractUniqueProductIds(snapshot.html))seenIds.add(id);
    for(const href of snapshot.hrefs){remember(href);}

    // If the short-link page exposes one obvious outbound Coupang button, click it.
    const candidates=await page.locator('a[href],button').evaluateAll(els=>els.map((el,i)=>({
      i,
      tag:el.tagName,
      href:el.href||'',
      text:String(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim().slice(0,100)
    })).filter(x=>/쿠팡|상품|구매|보러|열기|계속/i.test(x.text)||/coupang/i.test(x.href))).catch(()=>[]);
    if(candidates.length===1){
      try{
        const c=candidates[0];
        if(c.href){await page.goto(c.href,{waitUntil:'domcontentloaded',timeout:18000});}
        else{await page.locator('a[href],button').nth(c.i).click({timeout:5000});await page.waitForTimeout(1800);}
        remember(page.url());
        direct=canonicalProductUrl(page.url());
        if(direct){
          console.log(`[ORIGINAL COUPANG] CTA click resolve 성공 productId=${productIdFromUrl(direct)} canonical=${direct}`);
          return{url:direct,name:clean(snapshot.title)||'원본 작성자 선택 상품',image:clean(snapshot.image),selected:true,clicked:true,sourceLink:link};
        }
      }catch(err){console.warn(`[ORIGINAL COUPANG] CTA click 실패 reason="${err.message}"`);}
    }

    for(let i=0;i<4;i++){await page.mouse.wheel(0,650);await page.waitForTimeout(300);}
    const data=await page.evaluate(()=>{
      const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
      const anchors=[...document.querySelectorAll('a[href*="/vp/products/"]')];
      const toData=(a)=>{
        if(!a)return null;
        const root=a.closest('li,article,[class*="product"],[class*="Product"],[class*="item"],[class*="Item"]')||a.parentElement||a;
        const img=a.querySelector('img')||root?.querySelector?.('img');
        const title=clean(a.getAttribute('title')||img?.alt||root?.innerText||a.innerText||'').slice(0,240);
        return{href:a.href,title,image:img?.currentSrc||img?.src||''};
      };
      const uniq=[];const ids=new Set();
      for(const a of anchors){const m=a.href.match(/\/vp\/products\/(\d+)/i);if(!m||ids.has(m[1]))continue;ids.add(m[1]);uniq.push(a);}
      if(uniq.length===1)return toData(uniq[0]);
      return null;
    }).catch(()=>null);
    if(data?.href){
      const url=canonicalProductUrl(data.href);
      if(url){
        console.log(`[ORIGINAL COUPANG] DOM 단일상품 resolve 성공 productId=${productIdFromUrl(url)} canonical=${url}`);
        return{url,name:clean(data.title)||'원본 작성자 선택 상품',image:clean(data.image),selected:true,sourceLink:link};
      }
    }

    // Combine URL/network/HTML evidence. Only accept exactly one productId.
    for(const u of seenUrls)for(const id of extractUniqueProductIds(u))seenIds.add(id);
    if(seenIds.size===1){
      const id=[...seenIds][0];
      const url=canonicalFromProductId(id);
      console.log(`[ORIGINAL COUPANG] 통합 productId resolve 성공 productId=${id} canonical=${url}`);
      return{url,name:clean(snapshot.title)||'원본 작성자 선택 상품',image:clean(snapshot.image),selected:true,evidence:true,sourceLink:link};
    }
    console.warn(`[ORIGINAL COUPANG] 링크는 열렸지만 단일 상품 식별 실패 final=${page.url()} productCandidates=${seenIds.size}`);
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

console.log('[ORIGINAL COUPANG PATCH] shortlink HTTP+모바일브라우저+DOM+network productId 추적 → 동일상품 우선');
