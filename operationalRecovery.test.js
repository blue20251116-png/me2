'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const { runWorker } = require('./isolatedTask');

const temp = fs.mkdtempSync(path.join(os.tmpdir(),'me2-operations-'));
for (const file of fs.readdirSync(__dirname)) {
  if (/\.(js|json)$/.test(file)) fs.copyFileSync(path.join(__dirname,file),path.join(temp,file));
}
fs.cpSync(path.join(__dirname,'public'),path.join(temp,'public'),{recursive:true});
fs.symlinkSync(path.join(__dirname,'node_modules'),path.join(temp,'node_modules'),'dir');
function node(code, preloads=false) {
  const args = preloads ? JSON.parse(fs.readFileSync(path.join(temp,'package.json'))).scripts.start.split(' ').slice(1,-1) : [];
  const output = execFileSync(process.execPath,[...args,'-e',code],{
    cwd:temp,timeout:20000,encoding:'utf8',env:{...process.env,NODE_ENV:'test'},stdio:['ignore','pipe','pipe'],
  });
  const line=output.trim().split('\n').findLast(l=>l.startsWith('RESULT:'));
  return JSON.parse(line.slice(7));
}

for (const detached of [false, true]) test(`stuck worker stops ${detached ? 'detached' : 'same-group'} descendants before next task`, {skip: detached && !fs.existsSync(`/proc/${process.pid}/stat`) ? 'Requires a real Linux procfs; exercised by Ubuntu CI' : false}, async () => {
  const marker=path.join(temp,`late-write-${detached}`);
  const worker=path.join(temp,'hung-worker.js');
  fs.writeFileSync(worker,`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'late'),700)`)}],{stdio:'ignore',detached:${detached}});setInterval(()=>{},1000);`);
  await assert.rejects(runWorker(worker,{},200),{code:'BROWSER_TASK_TIMEOUT'});
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(fs.existsSync(marker),false,'descendant must not survive timeout');
  const healthy=path.join(temp,'healthy-worker.js');
  fs.writeFileSync(healthy,"process.on('message',()=>process.send({ok:true,value:42}));");
  assert.equal(await runWorker(healthy,{},2000),42);
});

test('AI hourly budget survives process restart and expires naturally', () => {
  assert.equal(node(`const s=require('./automationState');s.reserveRequest();console.log('RESULT:'+JSON.stringify(s.budgetState().used));process.exit();`),1);
  assert.equal(node(`const s=require('./automationState');console.log('RESULT:'+JSON.stringify(s.budgetState().used));process.exit();`),1);
  assert.equal(node(`const s=require('./automationState');require('./db').db.prepare('UPDATE ai_request_budget SET at_ms=?').run(Date.now()-3600001);console.log('RESULT:'+JSON.stringify(s.budgetState().used));process.exit();`),0);
});

test('isolated browser workers are serialized by the parent limiter', async () => {
  const worker=path.join(temp,'serialized-worker.js');
  fs.writeFileSync(worker,"process.on('message',()=>setTimeout(()=>process.send({ok:true,value:1}),150));");
  const started=Date.now();
  assert.deepEqual(await Promise.all([runWorker(worker,{},2000),runWorker(worker,{},2000)]),[1,1]);
  assert.ok(Date.now()-started >= 250,'workers must not overlap at default concurrency=1');
});

test('browser worker loads Railway guard before task modules', () => {
  const source=fs.readFileSync(path.join(__dirname,'isolatedBrowserWorker.js'),'utf8');
  assert.ok(source.indexOf("require('./railwayBrowserGuardPatch')") < source.indexOf("require(`./${moduleName}`)"));
});

test('session survives restart and expired sessions are rejected', () => {
  node(`const Store=require('./sessionStore');new Store().set('test',{userId:7,cookie:{expires:new Date(Date.now()+60000)}},e=>{if(e)throw e;console.log('RESULT:true');process.exit();});`);
  assert.equal(node(`new (require('./sessionStore'))().get('test',(e,s)=>{if(e)throw e;console.log('RESULT:'+JSON.stringify(s.userId));process.exit();});`),7);
  assert.equal(node(`require('./db').db.prepare('UPDATE login_sessions SET expires_ms=0').run();new (require('./sessionStore'))().get('test',(e,s)=>{if(e)throw e;console.log('RESULT:'+JSON.stringify(s));process.exit();});`),null);
});

test('real preload stack uses atomic queue and persists bounded comment retries', () => {
  const result=node(`
    (async()=>{
      const scheduler=require('./scheduler');
      const {db}=require('./db');
      db.prepare("INSERT INTO accounts(id,label,threads_access_token) VALUES(900,'test','token')").run();
      db.prepare("INSERT INTO posts(id,account_id,text,link,scheduled_at) VALUES(900,900,'본문','https://example.com/product',?)").run(new Date().toISOString());
      const api=require('./threadsApi');let sent=0,replies=0,reused=null;
      api.publishPost=async()=>{sent++;await new Promise(r=>setTimeout(r,5));return 'body-id';};
      api.publishReply=async(a,p,t,options)=>{replies++;if(replies===1){options.onCreated('creation-1');throw Object.assign(new Error('temporary'),{response:{status:503}});}reused=options.creationId;return 'reply-id';};
      const tick=scheduler.startPublishJob();
      await Promise.all([tick(),tick()]);
      const first=db.prepare('SELECT status,comment_status FROM posts WHERE id=900').get();
      db.prepare("UPDATE posts SET comment_next_retry_at='2000-01-01' WHERE id=900").run();
      await tick();const retry=db.prepare('SELECT comment_status,comment_retry_count,comment_creation_id FROM posts WHERE id=900').get();
      db.prepare("UPDATE posts SET comment_next_retry_at='2000-01-01' WHERE id=900").run();
      await tick();const final=db.prepare('SELECT status,comment_status,comment_media_id FROM posts WHERE id=900').get();
      console.log('RESULT:'+JSON.stringify({sent,first,retry,reused,final}));process.exit();
    })().catch(e=>{console.error(e);process.exit(1)});
  `,true);
  assert.equal(result.sent,1);
  assert.deepEqual(result.first,{status:'posted',comment_status:'pending'});
  assert.equal(result.retry.comment_retry_count,1);
  assert.equal(result.retry.comment_status,'pending');
  assert.equal(result.reused,'creation-1');
  assert.equal(result.final.comment_media_id,'reply-id');
});

test('unknown outcomes after restart never automatically republish', () => {
  const result=node(`const q=require('./publishQueue');const {db}=require('./db');db.prepare("UPDATE posts SET status='publishing',comment_status='publishing' WHERE id=900").run();q.initializeRecovery();console.log('RESULT:'+JSON.stringify(db.prepare('SELECT status,comment_status,comment_next_retry_at FROM posts WHERE id=900').get()));process.exit();`);
  assert.equal(result.status,'failed');
  assert.equal(result.comment_status,'failed');
  assert.equal(result.comment_next_retry_at,null);
});

test('observed inline style defects are repaired and checked at final boundary', () => {
  const result=node(`const q=require('./finalTextHardGuardPatch');const text=q.fallbackRewrite('주방 살림 고수들은 이런 거 쓰더라 진짜 편함\\n진짜 실화냐?','product');console.log('RESULT:'+JSON.stringify({text,reasons:q.badStyleReasons(text,'product')}));process.exit();`);
  assert.deepEqual(result.reasons,[]);
  assert.match(result.text,/쓰더라/); // Valid conversational ending is preserved; 음슴체/냐체 are still repaired.
  assert.match(result.text,/실화냐/); // Natural situational questions are retained.
});

test('real HTTP startup, admin authentication and health endpoint work', async () => {
  node(`const {db}=require('./db');db.prepare("INSERT INTO users(email,password_hash,name,role,status) VALUES(?,?,?,'admin','active')").run('test@example.invalid',require('./auth').hashPassword('local-test-password'),'test');console.log('RESULT:true');process.exit();`);
  const net=require('node:net');
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const args=JSON.parse(fs.readFileSync(path.join(temp,'package.json'))).scripts.start.split(' ').slice(1);
  const child=spawn(process.execPath,args,{cwd:temp,env:{...process.env,PORT:String(port),NODE_ENV:'test',SESSION_SECRET:'test-only-session-secret'},stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('server startup timeout')),10000);
      child.stdout.on('data',data=>{if(String(data).includes('Threads 스케줄러 서버')){clearTimeout(timer);resolve();}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(`startup exited ${code}`));});
    });
    const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/healthz')).status,200);
    assert.equal((await fetch(base+'/api/admin/automation-health')).status,401);
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'test@example.invalid',password:'local-test-password'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(base+'/api/admin/automation-health',{headers:{cookie}});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(typeof body.budget.used,'number');
    assert.ok(!JSON.stringify(body).includes('local-test-password'));
  } finally {
    child.kill('SIGKILL');
    await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode)resolve();else child.once('exit',resolve);});
  }
});

