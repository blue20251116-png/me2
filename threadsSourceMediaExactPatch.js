'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');

const originalLoader = Module._extensions['.js'];
let applied = false;

function patchBenchmarkAccounts(source) {
  let out = String(source || '');
  let profilePatched = false;
  let detailPatched = false;
  let profileCallPatched = false;

  const profileRe = /const mediaFromRoot=root=>\{[\s\S]*?return\{images:images\.slice\(0,10\),hasVideo:videos\.length>0,videoCount:videos\.length\};\n      \};/;
  if (profileRe.test(out)) {
    const replacement = [
      "const mediaFromRoot=(root,target)=>{",
      "        if(!root)return{images:[],hasVideo:false,videoCount:0};",
      "        const videos=[...root.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>=180&&r.height>=180;});",
      "        const videoRects=videos.map(v=>v.getBoundingClientRect());",
      "        const images=[];",
      "        for(const img of root.querySelectorAll('img')){",
      "          const r=img.getBoundingClientRect(),src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();",
      "          if(!src||r.width<180||r.height<180)continue;",
      "          if(/profile|프로필|avatar|사용자/.test(alt))continue;",
      "          const nestedArticle=img.closest('article,[role=\"article\"]');",
      "          if(nestedArticle&&nestedArticle!==root)continue;",
      "          const postAnchor=img.closest('a[href*=\"/post/\"]');",
      "          if(postAnchor&&canonical(postAnchor.href||'')!==target)continue;",
      "          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;",
      "          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;",
      "          if(!images.includes(src))images.push(src);",
      "        }",
      "        return{images:images.slice(0,10),hasVideo:videos.length>0,videoCount:videos.length};",
      "      };"
    ].join('\n');
    out = out.replace(profileRe, replacement);
    profilePatched = true;
  }

  if (out.includes('const media=mediaFromRoot(root);')) {
    out = out.replace('const media=mediaFromRoot(root);', 'const media=mediaFromRoot(root,href);');
    profileCallPatched = true;
  }

  const detailRe = /const images=\[\],videos=\[\];\n      if\(main\)\{[\s\S]*?\n      \}\n\n      const authorReplies=/;
  if (detailRe.test(out)) {
    const replacement = [
      "const images=[],videos=[];",
      "      if(main){",
      "        const rectOverlap=(a,b)=>{const x=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));const y=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));const inter=x*y;if(!inter)return 0;return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));};",
      "        const videoEls=[...main.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>=160&&r.height>=160;});",
      "        const videoRects=videoEls.map(v=>v.getBoundingClientRect());",
      "        for(const v of videoEls){const src=v.currentSrc||v.src||'';if(src&&!videos.includes(src))videos.push(src);}",
      "        for(const img of main.querySelectorAll('img')){",
      "          const src=img.currentSrc||img.src||'',alt=(img.alt||'').toLowerCase();",
      "          const r=img.getBoundingClientRect();",
      "          if(!src||r.width<160||r.height<160)continue;",
      "          if(/profile|프로필|avatar|사용자/.test(alt))continue;",
      "          const nestedArticle=img.closest('article,[role=\"article\"]');",
      "          if(nestedArticle&&nestedArticle!==main)continue;",
      "          const postAnchor=img.closest('a[href*=\"/post/\"]');",
      "          if(postAnchor&&canonical(postAnchor.href||'')!==targetUrl)continue;",
      "          if(videoRects.some(vr=>rectOverlap(r,vr)>=0.55))continue;",
      "          if(img.closest('video')||img.parentElement?.querySelector?.('video'))continue;",
      "          if(!images.includes(src))images.push(src);",
      "        }",
      "      }",
      "",
      "      const authorReplies="
    ].join('\n');
    out = out.replace(detailRe, replacement);
    detailPatched = true;
  }

  console.log(`[Threads][SOURCE MEDIA EXACT] benchmarkAccounts profile=${profilePatched?'OK':'MISS'} profileCall=${profileCallPatched?'OK':'MISS'} detail=${detailPatched?'OK':'MISS'} · 원문 post 첨부 미디어만 허용`);
  return out;
}

Module._extensions['.js'] = function sourceMediaExactLoader(mod, filename) {
  if (!applied && path.basename(filename) === 'benchmarkAccounts.js') {
    applied = true;
    const source = fs.readFileSync(filename, 'utf8');
    mod._compile(patchBenchmarkAccounts(source), filename);
    return;
  }
  return originalLoader(mod, filename);
};

console.log('[Threads][SOURCE MEDIA EXACT] patch armed · 댓글/추천글/프로필/영상오버레이 이미지 제외');
