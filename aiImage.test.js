'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('./aiImage'), 'utf8');

test('generateLifestyleImage saves to the persistent db/uploads directory, not the ephemeral one', () => {
  // Regression: this was the one file that write uploaded files to
  // path.join(__dirname, 'uploads') while server.js only serves static
  // files from path.join(__dirname, 'db', 'uploads') (server.js, scheduler.js,
  // and imageCachePatch.js all migrated to the persistent path together;
  // aiImage.js was missed). Every AI-generated lifestyle image 404'd
  // immediately since the file it wrote was never reachable at the URL
  // it returned to the caller - not just "lost on redeploy", broken right away.
  assert.match(source, /uploadsDir\s*=\s*path\.join\(__dirname,\s*'db',\s*'uploads'\)/);
  assert.doesNotMatch(source, /uploadsDir\s*=\s*path\.join\(__dirname,\s*'uploads'\)/);
});
