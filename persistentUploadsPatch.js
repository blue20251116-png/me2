'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');
const originalLoader = Module._extensions['.js'];
const targets = new Set(['scheduler.js','server.js','imageCachePatch.js']);

function transform(source, filename) {
  const base = path.basename(filename);
  if (!targets.has(base)) return source;
  const beforeA = "path.join(__dirname, 'uploads')";
  const beforeB = "path.join(__dirname,'uploads')";
  let out = String(source);
  out = out.split(beforeA).join("path.join(__dirname, 'db', 'uploads')");
  out = out.split(beforeB).join("path.join(__dirname,'db','uploads')");
  if (out === source) {
    console.warn(`[Media][PERSIST] ${base} uploads path marker not found`);
  } else {
    console.log(`[Media][PERSIST] ${base} uploads → db/uploads`);
  }
  return out;
}

Module._extensions['.js'] = function persistentUploadsLoader(mod, filename) {
  if (!targets.has(path.basename(filename))) return originalLoader(mod, filename);
  const source = fs.readFileSync(filename, 'utf8');
  mod._compile(transform(source, filename), filename);
};

const persistentDir = path.join(__dirname, 'db', 'uploads');
if (!fs.existsSync(persistentDir)) fs.mkdirSync(persistentDir, { recursive: true });
console.log(`[Media][PERSIST] armed dir=${persistentDir}`);
