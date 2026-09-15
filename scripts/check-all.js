'use strict';
/**
 * 全量语法检查 —— 零依赖，遍历 src 下所有 .js 做 node --check
 * 用法：npm run check
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(root).sort();
let fail = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail++;
    console.error(`FAIL  ${path.relative(root, f)}\n      ${String(e.stderr || e.message).split('\n').slice(0, 3).join('\n      ')}`);
  }
}
console.log(`语法检查：${files.length - fail}/${files.length} 通过`);
process.exit(fail ? 1 : 0);
