'use strict';
/**
 * QA 审计 2/2 —— SqMusic 服务的边界与「不可观测状态」防御
 *
 * 重点（本项目血泪教训）：
 *   传输层不能把「无法观测的状态」当成功 —— 必须同时校验 HTTP 状态码 + body 的 code/error，
 *   不能只凭「JSON 能解析」就判定成功。
 *
 * 覆盖：
 *   A. 非 2xx + JSON 错误体          → 必须报错，不得当成功
 *   B. HTTP 200 + body.code != 200   → 必须报错（最容易踩的坑）
 *   C. HTTP 200 + 非 JSON / 空 body  → 必须报错
 *   D. 基址不可达 / 挂起             → 必须超时报错，不得永久挂起
 *   E. token 失效自动重登（含二次失败不无限重试）
 *   F. 并发去重登录
 *   G. 搜索结果为空 / 脏数据
 *   H. 下载失败状态如实上报（不得谎报成功）
 *   I. 登录凭据错误
 *   J. net.rawRequest 的 noProxy 是纯增量（旧调用签名行为不变）
 *
 * 运行：node tests/qa-sqmusic-edge.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-qa-edge');
process.env.MUSIC_DIR = require('path').join(__dirname, '..', 'tests', 'fixtures', 'music');
process.env.SOURCE_KIND = 'localfs';
process.env.LOG_LEVEL = 'error';

const fs = require('fs');
const http = require('http');
const net = require('net');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const netUtil = require('../src/util/net');
const config = require('../src/config');
const sq = require('../src/service/sqmusic');

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

/** 可编程 mock SqMusic：state.mode 决定每个接口的行为 */
function mockServer() {
  const state = {
    mode: 'normal',        // normal | http500 | biz500 | html | empty | success | fail401 | failStay401 | emptyRecords
    loginCount: 0,
    token: 'tok-fixed',
    lastDownloadBody: null,
    reqCount: 0,
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.reqCount++;
      const send = (obj, status = 200) => {
        const s = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
        res.end(s);
      };

      if (u.pathname === '/api/config/login') {
        let p = {};
        try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { p = {}; }
        if (p.username !== 'admin' || p.password !== 'admin') return send({ code: 500, msg: '账号或密码错误' });
        if (state.mode === 'loginNoToken') { state.mode = 'normal'; return send({ code: 200, data: {} }); }
        state.loginCount++;
        state.token = 'tok-' + state.loginCount;
        return send({ code: 200, data: { tokenValue: state.token } });
      }

      const need401 = state.mode === 'failStay401'
        || (state.mode === 'fail401' && req.headers.sqmusic === state.staleToken);
      if (need401 || req.headers.sqmusic !== state.token) return send({ code: 401, msg: '未登录' }, 401);

      const song = {
        id: '1001', name: '晴天', artistName: ['周杰伦'], albumName: '叶惠美',
        duration: '269000', brTypes: ['KW_MP3_128', 'KW_FLAC_2000'], pic: '', lyric: '',
      };

      if (u.pathname === '/api/music/searchSong') {
        if (state.mode === 'http500') { state.mode = 'normal'; return send({ code: 500, msg: '服务端炸了' }, 503); }
        if (state.mode === 'biz500') { state.mode = 'normal'; return send({ code: 500, msg: '操作频繁' }, 200); }
        if (state.mode === 'html') { state.mode = 'normal'; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>504 Gateway</body></html>'); }
        if (state.mode === 'empty') { state.mode = 'normal'; res.writeHead(200, { 'Content-Length': 0 }); return res.end(); }
        if (state.mode === 'fail401') { state.mode = 'normal'; }
        if (state.mode === 'emptyRecords') return send({ code: 200, data: { searchTotal: 0, records: [] } });
        return send({ code: 200, data: { searchTotal: 1, records: [song] } });
      }
      if (u.pathname === '/api/download/downloadSong') {
        let p = {};
        try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { p = {}; }
        state.lastDownloadBody = p;
        if (state.mode === 'dlError') return send({ code: 200, data: { downloadStatus: 'error', message: '音源无版权' } });
        if (state.mode === 'biz500') { state.mode = 'normal'; return send({ code: 500, msg: '下载失败' }, 200); }
        return send({ code: 200, data: { downloadStatus: 'waiting' } });
      }
      if (u.pathname === '/api/task/list') {
        // 真实服务契约：只接受 POST，且 body 必须带 pageIndex
        if (req.method !== 'POST') return send({ code: 500, msg: "Request method 'GET' not supported" });
        let tp = {};
        try { tp = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { tp = {}; }
        if (tp.pageIndex == null) return send({ code: 500, msg: 'getPageIndex() is null' });
        if (state.mode === 'tasksArray') return send({ code: 200, data: [{ id: 't1', name: '晴天', downloadStatus: 'success' }] });
        if (state.mode === 'tasksError') {
          // 字段名用真实服务的 download* 前缀
          return send({
            code: 200,
            data: {
              total: 1,
              records: [{
                id: 't9', downloadGid: '96765037', downloadMusicname: '坏歌',
                downloadArtistname: '未知', downloadBrType: 'kw_mp3_320',
                downloadStatus: 'error', downloadMsg: '无版权',
              }],
            },
          });
        }
        return send({ code: 200, data: { total: 0, records: [] } });
      }
      return send({ code: 404, msg: 'nf' }, 404);
    });
  });
  return { server, state };
}

function mkClient(port, extra = {}) {
  return new sq.SqMusicClient(Object.assign({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'admin', timeoutMs: 1500 }, extra));
}

/** 期望抛错并取回 SqError */
async function expectThrow(fn, label) {
  try {
    const r = await fn();
    return { threw: false, detail: '返回了 ' + JSON.stringify(r).slice(0, 160) };
  } catch (e) {
    return { threw: true, err: e, detail: e.name + '/' + e.code + '/' + e.status + ': ' + e.message };
  }
}

/** 取一个已经关闭的端口（真正不可达） */
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

(async () => {
  const { server, state } = mockServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  config.SQ_ENABLED = true;

  /* =====================================================================
   * A/B/C. 传输层不得把「观测不到的状态」当成功
   * ===================================================================== */
  console.log('\n== A/B/C. HTTP 状态码 + 业务码双重校验 ==');

  // 对照：正常路径必须成功（防止「一律报错」也能通过上面的断言）
  {
    const c = mkClient(port);
    const r = await c.search('晴天');
    ok('[对照] 正常 200 + code:200 → 成功返回 1 条', r.items.length === 1, JSON.stringify(r).slice(0, 120));
  }

  {
    const c = mkClient(port);
    state.mode = 'http500';
    const t = await expectThrow(() => c.search('晴天'));
    ok('非 2xx(503) + JSON 错误体 → 抛错（不得当成功）', t.threw, t.detail);
    ok('  错误来自 HTTP 层或业务层，且带 502', t.threw && t.err.status === 502, t.detail);
  }

  {
    const c = mkClient(port);
    state.mode = 'biz500';
    const t = await expectThrow(() => c.search('晴天'));
    ok('HTTP 200 + body.code=500 → 抛错（关键陷阱点）', t.threw, t.detail);
    ok('  错误码标记为 business/http', t.threw && ['business', 'http'].includes(t.err.code), t.detail);
  }

  {
    const c = mkClient(port);
    state.mode = 'html';
    const t = await expectThrow(() => c.search('晴天'));
    ok('HTTP 200 + 非 JSON(HTML) → 抛 parse 错误', t.threw && t.err.code === 'parse', t.detail);
  }

  {
    const c = mkClient(port);
    state.mode = 'empty';
    const t = await expectThrow(() => c.search('晴天'));
    ok('HTTP 200 + 空 body → 抛错（不得当成功）', t.threw, t.detail);
  }

  // 静默加聒噪检查：Search Relation 返回值必须是对象而不是 undefined
  {
    const c = mkClient(port);
    state.mode = 'emptyRecords';
    const r = await c.search('不存在的歌名xyz');
    ok('搜索结果为空 → items=[] 且不崩溃', Array.isArray(r.items) && r.items.length === 0, JSON.stringify(r));
    ok('搜索结果为空 → total=0', r.total === 0, String(r.total));
    state.mode = 'normal';
  }

  /* =====================================================================
   * D. 不可达 / 挂起
   * ===================================================================== */
  console.log('\n== D. 基址不可达 / 挂起超时 ==');
  {
    const deadPort = await freePort();
    const c = mkClient(deadPort);
    const started = Date.now();
    const t = await expectThrow(() => c.search('晴天'));
    const ms = Date.now() - started;
    ok('目标端口不可达 → 抛 unreachable', t.threw && t.err.code === 'unreachable', t.detail);
    ok('  且快速失败（<5s，未永久挂起）', ms < 5000, ms + 'ms');
  }

  {
    // 挂起服务：accept 但永不响应，验证 timeoutMs 真的生效
    const hangSrv = net.createServer((sock) => { sock.on('error', () => {}); /* 永不写回 */ });
    await new Promise((r) => hangSrv.listen(0, '127.0.0.1', r));
    const hangPort = hangSrv.address().port;
    const c = mkClient(hangPort, { timeoutMs: 1200 });
    const started = Date.now();
    const t = await expectThrow(() => c.search('晴天'));
    const ms = Date.now() - started;
    ok('服务挂起 → 在超时窗口内抛错（不永久挂起）', t.threw, t.detail);
    ok('  实际耗时约等于 timeoutMs 且 <5s', ms < 5000 && ms >= 1000, ms + 'ms');
    hangSrv.close();
  }

  /* =====================================================================
   * E. token 失效自动重登
   * ===================================================================== */
  console.log('\n== E. token 失效自动重登 ==');
  {
    const c = mkClient(port);
    await c.search('晴天');
    const before = state.loginCount;
    state.staleToken = c.token;         // 让当前 token 失效，重登后新 token 有效
    state.mode = 'fail401';
    const r = await c.search('晴天');
    ok('401 后自动重登并重试成功', Array.isArray(r.items), JSON.stringify(r).slice(0, 120));
    ok('  登录次数 +1', state.loginCount === before + 1, `${before} → ${state.loginCount}`);
    ok('  token 已刷新', c.token === 'tok-' + state.loginCount, c.token);
    state.mode = 'normal';
  }
  {
    // 二次失败（重登后依然 401）不能无限重试
    const c = mkClient(port);
    state.mode = 'failStay401';
    const before = state.loginCount;
    const t = await expectThrow(() => c.search('晴天'));
    ok('重登后仍 401 → 抛错而非无限重试', t.threw, t.detail);
    ok('  登录次数被限制（≤ 3 次）', state.loginCount - before <= 3, String(state.loginCount - before));
    state.mode = 'normal';
  }

  /* =====================================================================
   * F. 并发去重登录
   * ===================================================================== */
  console.log('\n== F. 并发去重登录 ==');
  {
    const c = mkClient(port);
    const before = state.loginCount;
    await Promise.all([1, 2, 3, 4, 5].map(() => c.search('晴天')));
    ok('5 个并发请求只登录 1 次', state.loginCount === before + 1, `${before} → ${state.loginCount}`);
  }

  /* =====================================================================
   * G/H. 任务列表 / 下载失败状态
   * ===================================================================== */
  console.log('\n== G/H. 任务列表与下载失败状态 ==');
  {
    const c = mkClient(port);
    state.mode = 'tasksArray';
    const t1 = await c.tasks();
    ok('data 为裸数组也能解析', t1.items.length === 1 && t1.items[0].id === 't1', JSON.stringify(t1.items));

    state.mode = 'tasksError';
    const t2 = await c.tasks();
    ok('失败任务状态归一为 error（不得谎报 success）',
      t2.items[0].status === 'error', JSON.stringify(t2.items[0]));
    ok('失败原因透传', /无版权/.test(t2.items[0].message), t2.items[0].message);
    ok('counts.error = 1', t2.counts.error === 1, JSON.stringify(t2.counts));

    state.mode = 'normal';
    const c2 = mkClient(port);
    await c2.search('晴天');   // 填充搜索缓存 key '':1001 → 实际 key 形如 ':1001'
    const key = (await c2.search('晴天')).items[0].key;
    state.mode = 'dlError';
    const dl = await c2.download({ key });
    ok('上游返回 error 状态时 status 如实为 error', dl.status === 'error', JSON.stringify(dl));
    state.mode = 'normal';
  }

  /* =====================================================================
   * I. 参数校验 / 凭据错误
   * ===================================================================== */
  console.log('\n== I. 参数校验与凭据错误 ==');
  {
    const c = mkClient(port);
    const t1 = await expectThrow(() => c.search('   '));
    ok('空关键词 → 400 bad-request', t1.threw && t1.err.status === 400, t1.detail);
    const t2 = await expectThrow(() => c.download({}));
    ok('缺 key/song → 400', t2.threw && t2.err.status === 400, t2.detail);
    const t3 = await expectThrow(() => c.download({ key: '不存在的key' }));
    ok('未知缓存 key → 400 cache-miss', t3.threw && t3.err.code === 'cache-miss', t3.detail);
    const t4 = await expectThrow(() => c.search('晴天', { pageSize: 9999, pageIndex: -5 }));
    ok('超大 pageSize/负值 pageIndex 被夹紧（不崩溃）', !t4.threw, t4.detail);

    // 1) 上游返回业务错误码：必须失败（不得把 code:500 当成功）
    const bad = new sq.SqMusicClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'wrong', password: 'wrong' });
    const t5 = await expectThrow(() => bad.search('晴天'));
    ok('错误凭据 → 抛 502（business 或 no-token 都对，关键是不得成功）',
      t5.threw && t5.err.status === 502 && ['business', 'no-token'].includes(t5.err.code), t5.detail);

    // 2) 上游 HTTP 200 但不给 token：必须走 no-token 分支
    state.mode = 'loginNoToken';
    const nonTok = new sq.SqMusicClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'admin' });
    const t5b = await expectThrow(() => nonTok.search('晴天'));
    ok('登录成功但无 token → no-token（不得静默继续）',
      t5b.threw && t5b.err.code === 'no-token', t5b.detail);
    state.mode = 'normal';

    // 3) 未配置基址（含 config 兜底一并清空）→ 503 not-configured
    const savedBase = config.SQ_BASE_URL;
    config.SQ_BASE_URL = '';
    const nobase = new sq.SqMusicClient({ baseUrl: '', username: 'admin', password: 'admin' });
    const t6 = await expectThrow(() => nobase.search('晴天'));
    ok('未配置 baseUrl → 503 not-configured', t6.threw && t6.err.status === 503 && t6.err.code === 'not-configured', t6.detail);
    config.SQ_BASE_URL = savedBase;
  }

  /* =====================================================================
   * J. noProxy 是纯增量（旧调用签名行为不变）
   * ===================================================================== */
  console.log('\n== J. net.rawRequest 的 noProxy 改动是纯增量 ==');
  {
    const ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
    const savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // ⚠️ Windows 上 process.env 大小写不敏感：必须先删干净再赋值，
    //    否则 delete http_proxy 会把刚写的 HTTP_PROXY 一起删掉（Node 的 Windows 行为）
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';   // 必连不上的假代理

    const url = `http://127.0.0.1:${port}/api/config/login`;
    ok('  proxyForUrl 已识别到假代理', netUtil.proxyForUrl(url) !== null, String(netUtil.proxyForUrl(url)));

    const tOld = await new Promise((resolve) => {
      netUtil.rawRequest(url, { method: 'GET', headers: {} })   // 旧签名：不带 noProxy
        .then((r) => resolve({ threw: false, status: r.status, text: r.text.slice(0, 40) }))
        .catch((e) => resolve({ threw: true, code: e.code || e.message }));
    });
    ok('[不变] 旧签名不带 noProxy → 仍走代理（被假代理拦下）',
      tOld.threw, JSON.stringify(tOld));

    const tNew = await new Promise((resolve) => {
      netUtil.rawRequest(url, { method: 'GET', headers: {}, noProxy: true })
        .then((r) => resolve({ threw: false, status: r.status }))
        .catch((e) => resolve({ threw: true, code: e.code || e.message }));
    });
    ok('[增量] 带 noProxy:true → 绕过代理直连成功',
      !tNew.threw && tNew.status > 0, JSON.stringify(tNew));

    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }

  /* =====================================================================
   * K. protectExisting 默认必须关闭（回归）
   * ===================================================================== */
  console.log('\n== K. scan/task.js protectExisting 默认关闭 ==');
  {
    const raw = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'scan', 'task.js'), 'utf8');
    // 摘掉注释行再判定，避免把 JSDoc 里的 protectExisting=true 当成代码默认值
    const src = raw.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
    const reads = src.match(/opts\.protectExisting/g) || [];
    const writesTrue = src.match(/protectExisting\s*[:=]\s*true/g) || [];
    ok('protectExisting 仅以 opts.protectExisting 形式读取（opt-in）',
      reads.length >= 1 && writesTrue.length === 0,
      'reads=' + reads.length + ' writesTrue=' + JSON.stringify(writesTrue));
    const { ScanTask } = require('../src/scan/task');
    const inst = new ScanTask();
    ok('ScanTask 实例默认无 _protect 条目', inst._protect instanceof Map && inst._protect.size === 0, String(inst._protect.size));
    // _processOne 在未传 protectExisting 时不得产生保护集合
    const freshAbove = src.indexOf('if (opts.protectExisting) protect = collectProtected(track);');
    ok('保护集合只在 opts.protectExisting 为真时生成', freshAbove > -1, '未找到 opt-in 判定行');
  }

  server.close();
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
