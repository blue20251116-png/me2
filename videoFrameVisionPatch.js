'use strict';

const Module = require('module');
const path = require('path');

const originalCompile = Module.prototype._compile;
let applied = false;

const helperSource = String.raw`
const __videoFrameVisionCache=new Map();
const __VIDEO_FRAME_CACHE_TTL=6*60*60*1000;
const __VIDEO_FRAME_CACHE_MAX=80;
function __videoFrameExec(cmd,args,timeout=15000){
  return new Promise((resolve,reject)=>{
    require('child_process').execFile(cmd,args,{timeout,maxBuffer:2*1024*1024},(err,stdout,stderr)=>{
      if(err){err.stderr=stderr;reject(err);return;}
      resolve(String(stdout||''));
    });
  });
}
function __videoFrameCachePrune(){
  const now=Date.now();
  for(const [k,v] of __videoFrameVisionCache){if(now-v.at>__VIDEO_FRAME_CACHE_TTL)__videoFrameVisionCache.delete(k);}
  while(__videoFrameVisionCache.size>__VIDEO_FRAME_CACHE_MAX)__videoFrameVisionCache.delete(__videoFrameVisionCache.keys().next().value);
}
async function __extractVisionFrames(videoUrl,count){
  const url=String(videoUrl||'').trim();
  if(!/^https?:\/\//i.test(url)||count<1)return[];
  __videoFrameCachePrune();
  const key=url+'|'+count;
  const cached=__videoFrameVisionCache.get(key);
  if(cached&&Date.now()-cached.at<=__VIDEO_FRAME_CACHE_TTL){
    console.log('[AutopilotV3][VIDEO VISION CACHE HIT] frames='+cached.frames.length);
    return cached.frames;
  }
  const fs=require('fs');
  const os=require('os');
  const p=require('path');
  const crypto=require('crypto');
  const id=process.pid+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const videoFile=p.join(os.tmpdir(),'threads-vision-'+id+'.mp4');
  const frameFiles=[];
  try{
    const r=await axios.get(url,{responseType:'arraybuffer',timeout:20000,maxRedirects:5,maxContentLength:30*1024*1024,maxBodyLength:30*1024*1024,headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',referer:'https://www.threads.com/',accept:'video/mp4,video/*,*/*;q=0.8'},validateStatus:s=>s>=200&&s<400});
    const body=Buffer.from(r.data||[]);
    if(body.length<4096)throw new Error('video body too small');
    fs.writeFileSync(videoFile,body);
    const durationRaw=await __videoFrameExec('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',videoFile],10000);
    const duration=Number.parseFloat(durationRaw);
    if(!Number.isFinite(duration)||duration<=0)throw new Error('ffprobe duration unavailable');
    const ratios=count>=3?[0.20,0.50,0.80]:[0.30,0.70];
    const frames=[];
    for(let i=0;i<Math.min(count,ratios.length);i++){
      const at=Math.max(0.05,Math.min(Math.max(0.05,duration-0.05),duration*ratios[i]));
      const out=p.join(os.tmpdir(),'threads-vision-'+id+'-'+i+'.jpg');
      frameFiles.push(out);
      await __videoFrameExec('ffmpeg',['-hide_banner','-loglevel','error','-ss',at.toFixed(3),'-i',videoFile,'-frames:v','1','-vf','scale=720:-2','-q:v','5','-y',out],15000);
      const img=fs.readFileSync(out);
      if(img.length>=1024)frames.push('data:image/jpeg;base64,'+img.toString('base64'));
    }
    if(frames.length){
      __videoFrameVisionCache.set(key,{at:Date.now(),frames});
      __videoFrameCachePrune();
      console.log('[AutopilotV3][VIDEO VISION] source='+new URL(url).hostname+' duration='+duration.toFixed(1)+'s frames='+frames.length+' bytes='+body.length);
    }
    return frames;
  }catch(e){
    console.warn('[AutopilotV3][VIDEO VISION] 프레임 추출 실패 → 기존 이미지 Vision 유지: '+(e.response?.status||'-')+' '+e.message);
    return[];
  }finally{
    for(const f of [videoFile,...frameFiles]){try{fs.unlinkSync(f);}catch{}}
  }
}
async function __buildVideoVisionMedia(m){
  const originals=(Array.isArray(m?.images)?m.images:[]).filter(Boolean);
  const videos=(Array.isArray(m?.videos)?m.videos:[]).filter(v=>/^https?:\/\//i.test(String(v||'')));
  if(!videos.length)return{images:originals.slice(0,3),frameCount:0};
  const wanted=originals.length?2:3;
  const frames=await __extractVisionFrames(videos[0],wanted);
  if(!frames.length)return{images:originals.slice(0,3),frameCount:0};
  const images=originals.length?[originals[0],...frames]:frames;
  console.log('[AutopilotV3][VIDEO VISION MIX] originals='+(originals.length?1:0)+' frames='+frames.length+' total='+Math.min(3,images.length));
  return{images:images.slice(0,3),frameCount:frames.length};
}
`;

Module.prototype._compile = function videoFrameVisionCompile(content, filename) {
  if (applied || path.basename(filename) !== 'autopilotMaterialEngine.js') {
    return originalCompile.call(this, content, filename);
  }

  let source = String(content || '');
  const marker = "async function identifyCommerceTarget(accountId,m){\n  const images=(Array.isArray(m.images)?m.images:[]).filter(Boolean).slice(0,3);\n  const system=commerceTargetPrompt();\n  const text=commerceTargetText(m);";
  if (!source.includes(marker)) {
    console.error('[Autopilot][VIDEO FRAME VISION] identifyCommerceTarget marker MISS → 원본 엔진 유지');
    applied = true;
    return originalCompile.call(this, source, filename);
  }

  source = source.replace(marker,
    helperSource + "\nasync function identifyCommerceTarget(accountId,m){\n  const visionMedia=await __buildVideoVisionMedia(m);\n  const images=visionMedia.images;\n  const system=commerceTargetPrompt();\n  const text=commerceTargetText(m)+(visionMedia.frameCount?'\\n\\n[영상 분석] 동일 원본 영상에서 시간차로 추출한 대표 프레임 '+visionMedia.frameCount+'장을 포함했다. 여러 프레임에서 반복되거나 실제 사용·시연되는 대상을 우선하고 배경 소품은 제외하라.':'');"
  );

  const twoImageCap = "for(const raw of (imageUrls||[]).filter(Boolean).slice(0,2)){";
  if (source.includes(twoImageCap)) {
    source = source.replace(twoImageCap, "for(const raw of (imageUrls||[]).filter(Boolean).slice(0,3)){" );
  }

  applied = true;
  console.log('[Autopilot][VIDEO FRAME VISION] engine patched · 기존 이미지1 + 영상대표프레임2 · ffmpeg fail-safe · max3 detail-low');
  return originalCompile.call(this, source, filename);
};

console.log('[Autopilot][VIDEO FRAME VISION] patch armed');
