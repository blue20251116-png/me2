'use strict';

// Local-PC AI backend: runs the Claude Code CLI (`claude -p`) on the operator's own Claude login
// instead of calling the OpenAI API. Enabled with AI_PROVIDER=claude-cli (see aiClient.callAI).
// Accepts the same OpenAI-shaped userContent the rest of the app builds (string, or an array of
// {type:'text'} / {type:'image_url'} parts) and converts it to Claude content blocks.
const os = require('os');
const { spawn } = require('child_process');
const axios = require('axios');

const CLI_PATH = process.env.CLAUDE_CLI_PATH || 'claude';
const CLI_MODEL = process.env.CLAUDE_CLI_MODEL || 'sonnet';
const CONCURRENCY = Math.max(1, Number(process.env.CLAUDE_CLI_CONCURRENCY) || 2);
const MIN_TIMEOUT_MS = 180000; // CLI startup + generation; callers' 30-45s budgets were sized for OpenAI
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

async function toImageBlock(url) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: 8 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
  });
  let mediaType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType)) mediaType = 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: Buffer.from(res.data).toString('base64') } };
}

async function toClaudeContent(userContent) {
  if (typeof userContent === 'string') return [{ type: 'text', text: userContent }];
  const blocks = [];
  for (const part of userContent || []) {
    if (part?.type === 'text') blocks.push({ type: 'text', text: part.text });
    else if (part?.type === 'image_url') {
      try {
        blocks.push(await toImageBlock(part.image_url?.url || ''));
      } catch (e) {
        console.warn('[AI][claude-cli] 이미지 불러오기 실패 - 건너뜀:', e.message);
      }
    }
  }
  return blocks;
}

function runCli({ system, content, timeout }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    args.push('--tools', '', '--model', CLI_MODEL, '--no-session-persistence');
    args.push('--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands');
    if (system) args.push('--system-prompt', system);
    // Drop API-key env so the CLI uses the operator's Claude login, not a (possibly unrelated) key.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(CLI_PATH, args, { cwd: os.tmpdir(), env, windowsHide: true });
    let out = '',
      err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude CLI 응답 시간 초과 (${Math.round(timeout / 1000)}초)`));
    }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI 실행 실패 (${CLI_PATH}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = out
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((x) => x?.type === 'result');
      if (!result) return reject(new Error(`Claude CLI 결과 없음 (exit ${code}): ${err.trim().slice(0, 300)}`));
      if (result.is_error) return reject(new Error(`Claude CLI 오류: ${String(result.result || result.subtype).slice(0, 300)}`));
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

async function callClaudeCli({ system, userContent, timeout = 0 }) {
  const content = await toClaudeContent(userContent);
  const images = content.filter((b) => b.type === 'image').length;
  return withSlot(async () => {
    const started = Date.now();
    const result = await runCli({ system, content, timeout: Math.max(timeout, MIN_TIMEOUT_MS) });
    const u = result.usage || {};
    console.log(
      `[AI][USAGE] provider=claude-cli model=${CLI_MODEL} ms=${Date.now() - started} input=${u.input_tokens || 0} output=${u.output_tokens || 0} images=${images}`
    );
    return String(result.result || '');
  });
}

module.exports = { callClaudeCli };
