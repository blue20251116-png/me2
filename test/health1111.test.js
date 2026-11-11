'use strict';
// 2026-11-11 (dev 111def91, 5077c0fb, a9b0a750): /healthz says this is the real me2 with its jobs on and when the publish
// tick, the autopilot and live insights last ran, the newest post and the newest generation error; a Claude CLI limit is
// tagged and falls through to OpenAI only when AI_FALLBACK_PROVIDER=openai.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-health-'));

test('healthz reports app, jobs and the last run of each job', async () => {
  const express = require('express');
  const { setState } = require('../src/infra/automationState');
  setState(-1, 'idle', 'publish tick complete');
  setState(0, 'idle', 'refill complete');
  setState(-2, 'error', '#3 CLAUDE_CLI_LIMIT: usage limit');
  const app = express();
  app.use(require('../src/web/routes/system'));
  const server = app.listen(0);
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
    assert.equal(r.ok, true); assert.equal(r.app, 'me2'); assert.equal(r.jobs, 'on');
    assert.ok(Date.now() - Date.parse(r.publish_tick_at) < 60000);
    assert.equal(r.autopilot.detail, 'refill complete');
    assert.match(r.last_generation_error.detail, /CLAUDE_CLI_LIMIT/);
    assert.ok('last_posted_at' in r);
  } finally { server.close(); }
});

test('a Claude CLI limit goes to OpenAI only when the owner turns the fallback on', async () => {
  const cli = require('../src/integrations/claudeCliClient');
  const guard = require('../src/integrations/aiRequestGuard');
  const origCli = cli.callClaudeCli; const origPost = guard.guardedPost;
  const lim = Object.assign(new Error('Claude CLI 오류: You have hit your usage limit'), { code: 'CLAUDE_CLI_LIMIT' });
  delete require.cache[require.resolve('../src/integrations/aiClient')];
  cli.callClaudeCli = async () => { throw lim; };
  guard.guardedPost = async () => ({ data: { choices: [{ message: { content: 'from openai' } }] } });
  const ai = require('../src/integrations/aiClient');
  const env = { ...process.env };
  try {
    Object.assign(process.env, { AI_PROVIDER: 'claude-cli', OPENAI_API_KEY: 'k' });
    delete process.env.AI_FALLBACK_PROVIDER;
    await assert.rejects(ai.callAI(null, { userContent: 'x' }), /usage limit/);
    process.env.AI_FALLBACK_PROVIDER = 'openai';
    assert.equal(await ai.callAI(null, { userContent: 'x' }), 'from openai');
  } finally {
    cli.callClaudeCli = origCli; guard.guardedPost = origPost;
    for (const k of ['AI_PROVIDER', 'OPENAI_API_KEY', 'AI_FALLBACK_PROVIDER']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  }
});
