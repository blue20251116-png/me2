const path=require('path');
const targetPath=path.join(__dirname,'autopilotMaterialEngine.js');
const original=require(targetPath);

const MODE_SEQUENCE=['product','recipe','lifestyle','product','recipe','lifestyle','product','recipe','lifestyle','product'];
const state=new Map();
function nextPreferredMode(accountId){
  const idx=Number(state.get(accountId)||0)%MODE_SEQUENCE.length;
  return MODE_SEQUENCE[idx];
}
function advance(accountId){state.set(accountId,(Number(state.get(accountId)||0)+1)%MODE_SEQUENCE.length);}
function normalizeEscapedNewlines(v){
  return String(v||'')
    .replace(/\\r\\n/g,'\n')
    .replace(/\\n/g,'\n')
    .replace(/\\r/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

if(original&&typeof original.buildThreadsFirstAutopilot==='function'){
  const raw=original.buildThreadsFirstAutopilot;
  original.buildThreadsFirstAutopilot=async function(accountId,opts){
    const preferred=nextPreferredMode(accountId);
    let best=null;
    for(let attempt=1;attempt<=3;attempt++){
      const result=await raw(accountId,opts);
      result.text=normalizeEscapedNewlines(result.text);
      result.commentLead=normalizeEscapedNewlines(result.commentLead);
      if(!best)best=result;
      if(result.mode===preferred){
        advance(accountId);
        console.log(`[Autopilot][CONTENT MIX 40/30/30] account=${accountId} preferred=${preferred} matched=yes attempt=${attempt}`);
        return result;
      }
      console.log(`[Autopilot][CONTENT MIX 40/30/30] account=${accountId} preferred=${preferred} got=${result.mode} attempt=${attempt}/3`);
      best=result;
    }
    advance(accountId);
    console.log(`[Autopilot][CONTENT MIX 40/30/30] account=${accountId} preferred=${preferred} matched=no fallback=${best?.mode||'-'}`);
    return best;
  };
  require.cache[require.resolve(targetPath)].exports=original;
  console.log('[Autopilot][CONTENT MIX 40/30/30 + NEWLINE PATCH] 활성화');
}
