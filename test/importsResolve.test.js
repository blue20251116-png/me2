'use strict';
// Every `const { a, b: c } = require('./relative')` in src/ must name something the target module
// actually exports. ESLint can't see this (an absent property is just `undefined`), and a missing
// export only fails later inside some error path - exactly how isAiBudgetOrCreditError went
// missing once while every test still passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ME2_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'me2-imports-'));
process.env.NODE_ENV = 'test';

const SRC = path.join(__dirname, '..', 'src');
const walk = dir =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
// Entry points with side effects (start the server / wait for IPC) are not loaded, only checked as targets.
const NOT_LOADED = new Set(['index.js', 'isolatedBrowserWorker.js']);

test('every destructured relative import names a real export', () => {
  const problems = [];
  for (const file of walk(SRC).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = require.resolve(path.resolve(path.dirname(file), m[2]));
      if (NOT_LOADED.has(path.basename(target))) continue;
      const exported = require(target);
      for (const part of m[1]
        .split(',')
        .map(x => x.trim())
        .filter(Boolean)) {
        const name = part.split(':')[0].trim();
        if (!(name in exported)) problems.push(`${path.relative(SRC, file)}: '${name}' is not exported by ${m[2]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
