'use strict';
/**
 * QA 专项：/api/stream/* 鉴权放宽的**边界穿透审计**
 *
 * 背景：为了让浏览器 <audio src="/api/stream/xxx">（只带同域 Cookie、不带
 *       Authorization）能播放，`src/api/index.js` 在统一 checkApi 之前新增了一段
 *       「Cookie 或 Bearer 任一有效即放行」的分支。
 *
 * 要证明的事（工程师点名要求）：
 *   放宽**仅限** /api/stream/ 前缀；其余 /api/* 的行为与改动前完全一致，
 *   且不能通过**路径变形 / 编码绕过**把这段放宽扩展到别的接口上。
 *
 * 为什么必须用真 socket：src/server.js 在交给 route() 前会先做
 *   `decodeURIComponent(url.pathname)`——只有在真实 HTTP 层才有这一步，
 *   进程内直接调用 route()（现有 sqmusic.test.js §14 的做法）完全测不到编码绕过。
 *
 * 运行：node tests/qa-stream-audit.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
process.env.MUSIC_DIR = require('path').join(__dirname, '..', '.tmp-qa-http', 'music-readonly-notexist');
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-qa-http');
process.env.PORT = '18278';
process.env.LOG_LEVEL = 'error';
delete process.env.SQ_ENABLED;

const fs = require('fs');
const http = require('http');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: 18278, path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('QA 请求超时')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const BEARER = { authorization: 'Bearer testtoken', accept: 'application/json' };
/** 只有 Cookie（浏览器 <audio> 的真实形态） */
const COOKIE = { cookie: 'tp_token=testtoken', accept: 'application/json' };
const BAD_COOKIE = { cookie: 'tp_token=wrong', accept: 'application/json' };
const NONE = { accept: 'application/json' };

(async () => {
  console.log('\n== 0. 启动真实服务 ==');
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));
  ok('GET / → 200', (await request('/', { headers: BEARER })).status === 200);

  /* =====================================================================
   * 1. 放宽本身确实生效（不是死代码）——工程师这次修的就是这个
   * ===================================================================== */
  console.log('\n== 1. /api/stream/<id>：Cookie 或 Bearer 任一放行 ==');
  const none = await request('/api/stream/T1', { headers: NONE });
  ok('无凭据 → 401', none.status === 401, String(none.status));
  const bad = await request('/api/stream/T1', { headers: BAD_COOKIE });
  ok('错误 Cookie → 401', bad.status === 401, String(bad.status));
  const ck = await request('/api/stream/T1', { headers: COOKIE });
  ok('有效 Cookie → 不再 401（<audio> 只能带 Cookie）', ck.status !== 401, String(ck.status));
  const bk = await request('/api/stream/T1', { headers: BEARER });
  ok('有效 Bearer → 不再 401', bk.status !== 401, String(bk.status));

  /* =====================================================================
   * 2. 路径变形 / 编码绕过 —— 不得把放宽扩展到 /api/stream/ 之外
   *    判据：响应里绝不能出现 SqMusic 的状态 JSON（含 status.enabled）
   * ===================================================================== */
  console.log('\n== 2. 路径变形：不得穿透到 /api/sqmusic/status ==');
  const attackTargets = [
    ['明文上级目录', '/api/stream/../sqmusic/status'],
    ['二次 ../', '/api/stream/../stream/../../sqmusic/status'],
    ['%2f 编码斜杠', '/api/stream/..%2fsqmusic%2fstatus'],
    ['%2e%2e 编码点', '/api/stream/%2e%2e/sqmusic/status'],
    ['%2f + 明文混合', '/api/stream/..%2F..%2Fapi%2Fsqmusic%2Fstatus'],
    ['当前目录 ./', '/api/stream/./../sqmusic/status'],
    ['双编码 %252f', '/api/stream%252f..%252fsqmusic%252fstatus'],
    ['反斜杠', '/api/stream/..\\sqmusic\\status'],
    ['缺 id 的裸前缀', '/api/stream/'],
    ['无尾斜杠', '/api/stream'],
    ['大写变形', '/API/STREAM/../sqmusic/status'],
    ['双斜杠前缀', '/api//stream/../sqmusic/status'],
    ['前缀伪装 streamxxx', '/api/streamXXX/../sqmusic/status'],
  ];

  const LEAK_MARK = ['"enabled"', 'pluginLabels', 'sqmusic'];
  for (const [label, p] of attackTargets) {
    const r = await request(p, { headers: COOKIE });
    const leaked = r.text && LEAK_MARK.some((m) => r.text.indexOf(m) >= 0);
    ok(`Cookie-only ${label}（${p}）不得泄露 /api/sqmusic/status`,
      r.status !== 200 || !leaked,
      `status=${r.status} body=${(r.text || '').slice(0, 80)}`);
  }

  /* =====================================================================
   * 3. 放宽仅限该前缀 —— 其余 /api/* 必须仍只认 Bearer
   *    重点挑「有数据外泄价值」的端点
   * ===================================================================== */
  console.log('\n== 3. 其余 /api/*：Cookie 必须仍然顶替不了 Bearer ==');
  const others = [
    ['GET', '/api/sqmusic/status'],
    ['POST', '/api/sqmusic/search'],
    ['POST', '/api/sqmusic/download'],
    ['GET', '/api/sqmusic/tasks'],
    ['GET', '/api/sqmusic/dir'],
    ['GET', '/api/sqmusic/downloaded'],
    ['POST', '/api/sqmusic/preview'],
    ['POST', '/api/sqmusic/test'],
    ['GET', '/api/export'],
    ['GET', '/api/library'],
    ['GET', '/api/tracks'],
    ['GET', '/api/sources'],
    ['GET', '/api/idmap/status'],
    ['GET', '/api/llm/config'],
    ['POST', '/api/scan/start'],
    ['POST', '/api/tracks/batch'],
    ['GET', '/api/facets'],
    ['GET', '/api/review/queue'],
  ];
  for (const [m, p] of others) {
    const body = m === 'POST' ? JSON.stringify({ keyword: 'x', ids: [], pint: {} }) : null;
    const r = await request(p, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, COOKIE), body });
    ok(`Cookie-only ${m} ${p} → 401（不得被放宽）`, r.status === 401, String(r.status));
  }

  /* =====================================================================
   * 4. 反向对照：同样这些端点，Bearer 必须仍然非 401
   *    （确保上面的 401 是「鉴权生效」而不是「接口挂了」）
   * ===================================================================== */
  console.log('\n== 4. 反向哨兵：Bearer 访问同一批端点不得是 401 ==');
  for (const [m, p] of others) {
    const body = m === 'POST' ? JSON.stringify({ keyword: 'x', ids: [], pint: {} }) : null;
    const r = await request(p, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, BEARER), body });
    ok(`Bearer ${m} ${p} → 非 401（接口仍在，只是 Cookie 被拒）`, r.status !== 401, String(r.status));
  }

  /* =====================================================================
   * 5. /api/health 免鉴权哨兵（提醒：不能拿它当鉴权判据）
   * ===================================================================== */
  console.log('\n== 5. 哨兵 ==');
  const health = await request('/api/health', { headers: {} });
  console.log('     /api/health 无凭据 → ' + health.status + '（免鉴权端点，不可作判据）');
  ok('/api/health 确实免鉴权（说明上面的 401 不是网络问题）', health.status === 200, String(health.status));

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('\n失败清单：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('QA 脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
