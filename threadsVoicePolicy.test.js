'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('./threadsVoicePolicy');

function loadFile(file, deps = {}, extra = '') {
  // These fixtures exercise integration; semantic audit responses are explicitly stubbed.
  if (deps.axios) {
    const original = deps.axios.post;
    deps = {...deps,axios:{...deps.axios,post:async(url,body,...args)=>{
      if(body.messages?.[0]?.content?.includes('사실/편집 검수자')){
        const input=body.messages[1].content;
        const evidence=input.split('[입력 근거]\n')[1].split('\n[검수할')[0];
        const candidate=input.split(/\n\[검수할 (?:본문|댓글)\]\n/)[1];
        return {data:{choices:[{message:{content:JSON.stringify({issues:policy.voiceProblems(candidate),sourceAnchors:[evidence.slice(0,12)]})}}]}};
      }
      return original(url,body,...args);
    }}};
  }
  const module = { exports: {} };
  const context = { module, exports: module.exports, console: {log(){},warn(){}}, process,
    require(name) { if(name==='./threadsVoicePolicy')return policy; if(name in deps)return deps[name]; throw new Error(`Unexpected dependency ${name}`); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,file),'utf8')+extra, context, { filename:file });
  return module.exports;
}
const fixtures = [
  '케이스에서 가사까지 나오네??\n이어폰보다 케이스를 더 보겠어ㅋㅋ',
  '재우는 시간인 줄 알았는데...\n그림자 공연이 시작됐네ㅋㅋ\n\n저러면 잠이 더 깨겠어',
  '노른자에 표정까지 그렸네🌼\n아침밥이 너무 귀여워졌어',
  '작은 파우치는 늘 꽉 차고\n큰 파우치는 안에서 다 사라져;;',
  '0.5cm 차이인데, 느낌이 다르네...\n신기해 👍',
];

test('production body formatter chain preserves reactions, decimals and chosen paragraphs', async () => {
  for(const text of fixtures) {
    const engine={buildThreadsFirstAutopilot:async()=>({text,mode:'product',commentLead:'칸막이가 있어'})};
    const deps={'./autopilotMaterialEngine':engine,'./benchmarkAccounts':{},'./db':{db:{prepare(){throw new Error('no history');}}},'./coupangApi':{}};
    for(const f of ['strongStyleSecretAffiliatePatch.js','finalAutopilotSanityPatch.js','finalTextHardGuardPatch.js'])loadFile(f,deps);
    const out=await engine.buildThreadsFirstAutopilot(1,{});
    assert.equal(out.text,policy.formatVoice(text));
    assert.equal(out.commentLead,'칸막이가 있어');
  }
});

test('manual writer keeps a complete nine-line story and optional empty comment', async()=>{
  const text=Array.from({length:9},(_,i)=>`${i+1}번째 장면이네`).join('\n');
  let prompt='';
  const writer=loadFile('threadsMaterialWriter.js',{'axios':{post:async(url,body)=>{prompt=body.messages[0].content;return {data:{choices:[{message:{content:JSON.stringify({items:[{text,comment:''}]})}}]}}}},'./db':{getAccount:()=>({}),getSystemApiSettings:()=>({openai_api_key:'test'})}});
  const out=await writer.generateFromThreadsMaterial(1,{sourceText:'칸막이 파우치',mode:'product'});
  assert.equal(out.items[0].text,text);
  assert.equal(out.items[0].comment,'');
  assert.match(prompt,/원작성자의/);
  assert.doesNotMatch(prompt,/마침표 금지|빈 줄을 넣지/);
});

test('autopilot preserves natural generated comment instead of replacing it with fact bullets',async()=>{
  const text=fixtures[0];let calls=0;
  const engine=loadFile('autopilotMaterialEngine.js',{'axios':{post:async()=>{calls++;return {data:{choices:[{message:{content:JSON.stringify({text,commentLead:'케이스 화면에서 제목도 볼 수 있어'})}}]}}}},'./db':{getAccount:()=>({}),getSystemApiSettings:()=>({openai_api_key:'test'})},'./benchmarkAccounts':{},'./coupangApi':{}},'\nmodule.exports.testGenerate=generatePost;');
  const out=await engine.testGenerate(1,{material:{sourceText:'케이스 화면에 제목과 가사 표시',authorReplies:''},analysis:{mode:'product',topic:'이어폰',facts:['엉뚱한 목록']},product:{name:'이어폰'}});
  assert.equal(out.text,policy.formatVoice(text));assert.equal(out.commentLead,'케이스 화면에서 제목도 볼 수 있어');assert.equal(calls,1);
});

test('hard guard checks optional comment and does not invent past use to repair a fragment',async()=>{
  let result={text:fixtures[0],mode:'product',commentLead:'여행용으로도 좋음 👍'};
  const engine={buildThreadsFirstAutopilot:async()=>({...result})};
  const guard=loadFile('finalTextHardGuardPatch.js',{'./autopilotMaterialEngine':engine});
  assert.equal((await engine.buildThreadsFirstAutopilot(1,{})).commentLead,'여행용으로도 좋아 👍');
  result.text='직접 써보';
  await assert.rejects(engine.buildThreadsFirstAutopilot(1,{}),{code:'CONTENT_STYLE_REJECTED'});
  assert.equal(guard.fallbackRewrite('직접 써보','product'),'직접 써보');
  result={text:fixtures[0],mode:'product',commentLead:'댓글로 알려줘'};
  assert.equal((await engine.buildThreadsFirstAutopilot(1,{})).commentLead,'');
});

test('scheduler loader preserves body punctuation and existing affiliate link contract',()=>{
  const fakeModule={_extensions:{'.js':()=>{}}};let compiled='';
  loadFile('threadsBodyPreservePatch.js',{'module':fakeModule,'fs':{readFileSync:()=>fs.readFileSync(path.join(__dirname,'scheduler.js'),'utf8')}});
  fakeModule._extensions['.js']({_compile:s=>{compiled=s;}},'/test/scheduler.js');
  const fn=compiled.match(/function formatThreadsBody\(text\)\{[^\n]+/)[0];
  const format=vm.runInNewContext(`(${fn})`,{require:()=>policy});
  assert.equal(format(fixtures[1]),policy.formatVoice(fixtures[1]));
  assert.match(compiled,/const tail=\[l,l,disclosure\]/);
});

test('engagement bait and tangled conditionals are rejected without banning expressive reactions',()=>{
  for(const t of fixtures)assert.deepEqual(policy.voiceProblems(t),[]);
  assert.ok(policy.voiceProblems('이런 게 있었으면 진작에 알았으면 좋았을 듯').length);
  assert.ok(policy.voiceProblems('여러분은 어때?').length);
});



test('approved minimal editing preserves the source situation and adds no invented ending',()=>{
  const source='애 재우라고 아빠 들여보냈더니\n둘이서 그림자놀이 배틀 뜨고 있음ㅋㅋㅋ\n\n재우러 간 사람이 더 신났네.\n잠은 대체 언제 잘 건데 진짜ㅋㅋㅋㅋ';
  const expected='애 재우라고 아빠 들여보냈더니\n둘이서 그림자놀이 배틀 뜨고 있어ㅋㅋㅋ\n\n재우러 간 사람이 더 신났네\n잠은 대체 언제 잘 건데 진짜ㅋㅋㅋㅋ';
  assert.equal(policy.assertVoice(source),expected);
  assert.equal(policy.formatVoice(expected),expected,'formatter must be idempotent');
});

test('period cleanup protects decimals, models, recipe numbers and URLs',()=>{
  const text='0.5cm에 v2.0 모델이야.\nhttps://example.com/a.b?q=1.5\n1. 소금 0.5g을 넣어.\n진짜...\n이것도 좋아!';
  assert.equal(policy.formatVoice(text),'0.5cm에 v2.0 모델이야\nhttps://example.com/a.b?q=1.5\n1. 소금 0.5g을 넣어\n진짜\n이것도 좋아!');
});

test('observed inline endings are fixed without replacing the situation',()=>{
  const text='산책할 때 부담이 전혀 없음. 색깔도 예쁘고 보관하기도 간편해서 자주 사용하게 됨. 진짜 재미있었음ㅋㅋ';
  const fixed=policy.formatVoice(text);
  assert.equal(fixed,'산책할 때 부담이 전혀 없어\n색깔도 예쁘고 보관하기도 간편해서 자주 사용하게 돼\n진짜 재미있었어ㅋㅋ');
  assert.ok(policy.voiceProblems(text).includes('음슴체'));
  assert.deepEqual(policy.voiceProblems(fixed),[]);
  assert.equal(policy.formatVoice('수납함 안에 모음집이 있어'),'수납함 안에 모음집이 있어');
});

test('natural questions and connecting lines survive, canned engagement and reporting do not',()=>{
  assert.equal(policy.assertVoice('이거 진짜 실화냐?\n잠은 언제 잘 건데ㅋㅋ'),'이거 진짜 실화냐?\n잠은 언제 잘 건데ㅋㅋ');
  assert.equal(policy.assertVoice('한번 써보\n라는 말은 안 할게'),'한번 써보\n라는 말은 안 할게');
  for(const text of ['원문에서는 좋다고 하네','여러분은 어때?','직접 써보'])assert.throws(()=>policy.assertVoice(text),{code:'CONTENT_STYLE_REJECTED'});
});

test('autopilot actually rejects a failed rewrite instead of logging and accepting it',async()=>{
  let calls=0;
  const engine=loadFile('autopilotMaterialEngine.js',{'axios':{post:async()=>{calls++;return {data:{choices:[{message:{content:JSON.stringify({text:'원문에서는 좋다고 하네',commentLead:''})}}]}}}},'./db':{getAccount:()=>({}),getSystemApiSettings:()=>({openai_api_key:'test'})},'./benchmarkAccounts':{},'./coupangApi':{}},'\nmodule.exports.testGenerate=generatePost;');
  await assert.rejects(engine.testGenerate(1,{material:{sourceText:'정리함',authorReplies:''},analysis:{mode:'product'},product:{name:'정리함'}}),{code:'CONTENT_STYLE_REJECTED'});
  assert.equal(calls,2);
});

test('manual writer keeps valid candidates and rejects invalid repaired candidates',async()=>{
  let calls=0;
  const writer=loadFile('threadsMaterialWriter.js',{'axios':{post:async()=>{calls++;return {data:{choices:[{message:{content:JSON.stringify(calls===1?{items:[{text:'칸마다 양말을 넣어뒀네.',comment:''},{text:'원문에서는 좋다고 하네',comment:''}]}:{text:'원문에서는 좋다고 하네'})}}]}}}},'./db':{getAccount:()=>({}),getSystemApiSettings:()=>({openai_api_key:'test'})}});
  const out=await writer.generateFromThreadsMaterial(1,{sourceText:'칸마다 양말을 넣어둔 서랍',mode:'product'});
  assert.equal(out.items.length,1);assert.equal(out.items[0].text,'칸마다 양말을 넣어뒀네');assert.equal(calls,2);
});

test('long captions are never silently truncated and ambiguous fragments never acquire past tense',()=>{
  const text='자연스러운 문장인데 '.repeat(45);
  assert.ok(policy.formatVoice(text).length>450);
  assert.throws(()=>policy.assertVoice(text),{code:'CONTENT_STYLE_REJECTED'});
  assert.equal(policy.formatVoice('직접 써보'),'직접 써보');
});

test('start command no longer loads deleted voice-only patches',()=>{
  const start=JSON.parse(fs.readFileSync(path.join(__dirname,'package.json'),'utf8')).scripts.start;
  for(const name of ['threadsHumanTonePatch','humanFinalLocalPatch','autopilotBodyTonePatch','threadsRhythmPatch','threadsStyleProfilePatch','postStyleHumanGuardPatch']){
    assert.ok(!start.includes(name));assert.equal(fs.existsSync(path.join(__dirname,name+'.js')),false);
  }
});

test('source-grounded reactions are not censored by a fixed laugh count or family keyword',()=>{
  const text='애 재우라고 아빠 들여보냈더니\n둘이서 그림자놀이 배틀 뜨고 있어ㅋㅋㅋ\n재우러 간 사람이 더 신났네ㅋㅋ\n잠은 언제 잘 건데 진짜ㅋㅋㅋㅋ';
  assert.equal(policy.assertVoice(text),text);
  assert.equal(policy.assertVoice('눈 저렇게 부었는데\n꿀은 끝까지 먹고 있네ㅋㅋ\n진짜 포기를 모르네'),'눈 저렇게 부었는데\n꿀은 끝까지 먹고 있네ㅋㅋ\n진짜 포기를 모르네');
});

test('source audit keeps a grounded situational reaction without rewriting',async()=>{
  const source='아빠가 아이를 재우러 들어갔다가 같이 그림자놀이를 한다';
  const text='재우러 간 사람이 더 신났네ㅋㅋ';let calls=0;
  const out=await policy.reviewSourceVoice(text,{sourceText:source},async()=>{calls++;return {issues:[],sourceAnchors:['같이 그림자놀이를 한다']};});
  assert.equal(out,text);assert.equal(calls,1);
});

test('source audit repairs a fabricated friend story once and verifies the replacement',async()=>{
  const text='친구들이 다 물어볼 정도야';let calls=0;
  const out=await policy.reviewSourceVoice(text,{sourceText:'수영장에 가져갈 물건을 가방에 담는 모습'},async()=>{
    calls++;
    if(calls===1)return {issues:['친구들이 물어봤다는 사건은 근거에 없음'],sourceAnchors:['가방에 담는 모습']};
    if(calls===2)return {text:'수영장 갈 물건을 한 가방에 담았네'};
    return {issues:[],sourceAnchors:['물건을 가방에 담는 모습']};
  });
  assert.equal(out,'수영장 갈 물건을 한 가방에 담았네');assert.equal(calls,3);
});

test('source audit rejects unsupported repairs, invented citations and malformed approval',async()=>{
  await assert.rejects(policy.reviewSourceVoice('친구들이 샀대',{sourceText:'가방에 수건을 담아'},async()=>({issues:['근거 없는 친구 사건'],sourceAnchors:['가방'],text:'친구들이 샀대'})),{code:'CONTENT_STYLE_REJECTED'});
  await assert.rejects(policy.reviewSourceVoice('편하네',{sourceText:'가방에 수건을 담아'},async()=>({issues:[],sourceAnchors:['존재하지 않는 인용문'],text:'편하네'})),{code:'CONTENT_STYLE_REJECTED'});
  await assert.rejects(policy.reviewSourceVoice('편하네',{sourceText:'가방에 수건을 담아'},async()=>({approved:true})),{code:'CONTENT_STYLE_REJECTED'});
});
