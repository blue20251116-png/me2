'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('./threadsVoicePolicy');

function loadFile(file, deps = {}, extra = '') {
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
    for(const f of ['strongStyleSecretAffiliatePatch.js','finalAutopilotSanityPatch.js','humanFinalLocalPatch.js','autopilotBodyTonePatch.js','threadsRhythmPatch.js','threadsStyleProfilePatch.js','finalTextHardGuardPatch.js'])loadFile(f,deps);
    const out=await engine.buildThreadsFirstAutopilot(1,{});
    assert.equal(out.text,text);
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
  assert.equal(out.text,text);assert.equal(out.commentLead,'케이스 화면에서 제목도 볼 수 있어');assert.equal(calls,1);
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
  const format=vm.runInNewContext(`(${fn})`);
  assert.equal(format(fixtures[1]),fixtures[1]);
  assert.match(compiled,/const tail=\[l,l,disclosure\]/);
});

test('engagement bait and tangled conditionals are rejected without banning expressive reactions',()=>{
  for(const t of fixtures)assert.deepEqual(policy.voiceProblems(t),[]);
  assert.ok(policy.voiceProblems('이런 게 있었으면 진작에 알았으면 좋았을 듯').length);
  assert.ok(policy.voiceProblems('여러분은 어때?').length);
});
