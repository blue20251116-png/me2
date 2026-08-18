const fs = require('fs');
const path = require('path');

function patchFile(name, patches) {
  const file = path.join(__dirname, name);
  let src = fs.readFileSync(file, 'utf8');
  let changed = 0;
  for (const [from, to] of patches) {
    if (src.includes(from)) {
      src = src.replace(from, to);
      changed++;
    }
  }
  if (changed) fs.writeFileSync(file, src);
  return changed;
}

// 1) enrichThreadsMaterial: 풀 스캔 i.images를 선제적으로 신뢰하지 않는다.
// collectPostDetails(root-post-only)가 준 d.images만 사용하고, 비어 있으면 빈 배열 유지.
// 이렇게 해야 댓글의 쿠팡/네이버 링크 프리뷰 썸네일이 i.images 경로로 재유입되지 않는다.
const autopilotChanged = patchFile('autopilotMaterialEngine.js', [[
  "let sourceText=clean(i?.text),authorReplies='',images=Array.isArray(i?.images)?i.images.filter(Boolean):[],videos=[];",
  "let sourceText=clean(i?.text),authorReplies='',images=[],videos=[];"
], [
  "if(Array.isArray(d?.images)&&d.images.length)images=d.images.filter(Boolean);",
  "if(Array.isArray(d?.images))images=d.images.filter(Boolean);"
]]);

// 2) 프로필 풀 스캔: viewport rect가 아니라 실제 리소스 로드 여부로 판정한다.
// lazy-load를 깨우기 위해 스크롤/대기를 늘리고, evaluate 직전 실제 img/video 로드를 기다린다.
const benchmarkChanged = patchFile('benchmarkAccounts.js', [[
  "await page.waitForTimeout(1600);\n    for(let i=0;i<3;i++){await page.mouse.wheel(0,900);await page.waitForTimeout(350);}\n    return await page.evaluate(({username,limit})=>{",
  "await page.waitForTimeout(2200);\n    for(let i=0;i<6;i++){await page.mouse.wheel(0,750);await page.waitForTimeout(550);}\n    try {\n      await page.waitForFunction(() => [...document.images].some(img => img.complete && img.naturalWidth > 0) || [...document.querySelectorAll('video')].some(v => !!(v.currentSrc || v.src || v.querySelector('source')?.src)), null, { timeout: 8000 });\n    } catch {}\n    await page.waitForTimeout(800);\n    return await page.evaluate(({username,limit})=>{"
], [
  "const videos=[...root.querySelectorAll('video')].filter(v=>belongsToPost(v,root,target)).filter(v=>{const r=v.getBoundingClientRect();return r.width>=180&&r.height>=180;});\n        const videoRects=videos.map(v=>v.getBoundingClientRect());",
  "const videos=[...root.querySelectorAll('video')].filter(v=>belongsToPost(v,root,target)).filter(v=>!!(v.currentSrc||v.src||v.querySelector('source')?.src));\n        const videoRects=videos.map(v=>v.getBoundingClientRect());"
], [
  "const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();\n          if(!src||r.width<180||r.height<180)continue;",
  "const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();\n          if(!src||!img.complete||img.naturalWidth<=0)continue;"
], [
  "await page.goto(normalizedUrl,{waitUntil:'domcontentloaded',timeout:16000});await page.waitForTimeout(1800);",
  "await page.goto(normalizedUrl,{waitUntil:'domcontentloaded',timeout:16000});await page.waitForTimeout(2200);\n    try { await page.mouse.wheel(0,500); await page.waitForTimeout(700); await page.mouse.wheel(0,-500); } catch {}\n    try { await page.waitForFunction(() => [...document.images].some(img => img.complete && img.naturalWidth > 0) || [...document.querySelectorAll('video')].some(v => !!(v.currentSrc || v.src || v.querySelector('source')?.src)), null, { timeout: 8000 }); } catch {}\n    await page.waitForTimeout(700);"
], [
  "for(const v of main.querySelectorAll('video')){if(!belongs(v))continue;const r=v.getBoundingClientRect();if(r.width<160||r.height<160)continue;const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';if(src&&!videos.includes(src))videos.push(src);}",
  "for(const v of main.querySelectorAll('video')){if(!belongs(v))continue;const src=v.currentSrc||v.src||v.querySelector('source')?.src||'';if(src&&!videos.includes(src))videos.push(src);}"
], [
  "for(const img of main.querySelectorAll('img')){if(!belongs(img))continue;const src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase(),r=img.getBoundingClientRect();if(!src||r.width<160||r.height<160)continue;if(/profile|프로필|avatar|사용자/.test(alt))continue;if(img.closest('video'))continue;if(!images.includes(src))images.push(src);}",
  "for(const img of main.querySelectorAll('img')){if(!belongs(img))continue;const src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();if(!src||!img.complete||img.naturalWidth<=0)continue;if(/profile|프로필|avatar|사용자/.test(alt))continue;if(/coupang|coupangcdn|shopping\\.naver|smartstore|brand\\.naver|\\/emg1\\//i.test(src))continue;if(img.closest('video'))continue;if(!images.includes(src))images.push(src);}"
]]);

console.log(`[Threads][MEDIA INTEGRITY PATCH] i.images fallback=disabled autopilot=${autopilotChanged}/2 benchmark=${benchmarkChanged}/6 natural-load-check=enabled lazy-wait=enabled`);
