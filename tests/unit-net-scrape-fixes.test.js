'use strict';
/**
 * 单元：代码评审发现项回归（net.js / encoding.js / scrape 层 / navidrome）
 *
 * 覆盖范围（评审发现 #1~#13，误报项见文件末尾说明）：
 *   A. #2  RateLimiter.acquire() 并发占坑（放行时刻 0/300/600/900）
 *   B. #1  rawRequest / httpGetJson 响应中断必须 reject（旧实现永不结算）
 *   C. #1  响应体大小上限 maxBytes
 *   D. #3  webGet / webPost 单次调用 = 单个请求（含 500 / 404 / 重定向）
 *   E. #4  cookie jar：兼容 WHATWG Headers + host 隔离
 *   F. #5  代理隧道：CONNECT 403 / 断连 / 超时都必须结算且只结算一次
 *   G. #6  GBK 乱码判定不得误伤拉丁文本，真实乱码仍要还原
 *   H. #7  文件名标题的来源标识与置信度（online / llm 必须能覆盖）
 *   I. #8  L3 confidence 默认值（NaN 不再穿透 ?? ）
 *   J. #10 L2 的 CAA 兜底尊重 opts.sources
 *   K. #12 CAA stats 区分 empty / failed
 *
 * 约定：全部用本地 stub HTTP 服务器（127.0.0.1 随机端口），不访问外网、不读写 data/。
 */

const http = require('http');
const nodeNet = require('net');

const net = require('../src/util/net');
const enc = require('../src/util/encoding');
const l1 = require('../src/scrape/l1');
const l2 = require('../src/scrape/l2');
const l3 = require('../src/scrape/l3');
const merge = require('../src/scrape/merge');
const caa = require('../src/scrape/sources/caa');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? ' — ' + extra : ''));
  }
}

/** 起一个本地 stub 服务器；handler 可自定义 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 给 promise 套一个超时壳：超时判为「挂死」而不是让整个测试卡住 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：${ms}ms 内未结算（挂死）`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 反向断言：期望 promise 被 reject */
async function rejectsAsync(promise, ms, label) {
  try {
    const v = await withTimeout(promise, ms, label);
    return { rejected: false, value: v, error: null };
  } catch (e) {
    return { rejected: true, value: null, error: e };
  }
}

/* ========================================================================== */
async function testRateLimiter() {
  console.log('\n== A. #2 RateLimiter 并发占坑 ==');
  const rl = new net.RateLimiter(300);
  const t0 = Date.now();
  const marks = [];
  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      await rl.acquire();
      marks.push(Date.now() - t0);
    })
  );
  marks.sort((a, b) => a - b);
  console.log('   放行时刻(ms)=' + JSON.stringify(marks));
  // 期望 ~0/300/600/900（±50ms 抖动）
  const expected = [0, 300, 600, 900];
  let within = true;
  for (let i = 0; i < expected.length; i += 1) {
    if (Math.abs(marks[i] - expected[i]) > 50) within = false;
  }
  ok('[A1] 4 并发放行时刻接近 0/300/600/900（±50ms）', within, JSON.stringify(marks));
  ok('[A2] 相邻放行间隔 >= 300ms（旧实现会齐发：0/1013/1013/1013）',
    marks[1] - marks[0] >= 280 && marks[2] - marks[1] >= 280 && marks[3] - marks[2] >= 280,
    JSON.stringify(marks));
  ok('[A3] requests 计数正确', rl.requests === 4, String(rl.requests));

  // 串行场景不受影响：连续 acquire 也应保持间隔
  const rl2 = new net.RateLimiter(100);
  const s0 = Date.now();
  await rl2.acquire();
  await rl2.acquire();
  const dt = Date.now() - s0;
  ok('[A4] 串行两次 acquire 间隔 >= 100ms（语义未回退）', dt >= 95, dt + 'ms');
}

/* ========================================================================== */
async function testTruncatedResponse() {
  console.log('\n== B. #1 响应中断必须 reject（旧实现永不结算）==');
  // 声明 Content-Length=1000，实际只发 10 字节后掐断连接
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '1000', 'Content-Type': 'text/plain' });
    res.write('0123456789');
    setTimeout(() => { try { res.socket.destroy(); } catch (_) { /* ignore */ } }, 20);
  });
  const url = `http://127.0.0.1:${port}/trunc`;

  // —— before 复现：旧实现只监听 data/end（外加 req error，对响应中断不生效）
  const beforeState = await new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve('settled'));
    });
    req.on('error', () => resolve('settled'));
    setTimeout(() => resolve('pending'), 900);
  });
  ok('[B0] before 复现：只监听 data/end 时 Promise 永不结算', beforeState === 'pending', '实际=' + beforeState);

  const rRaw = await rejectsAsync(net.rawRequest(url, { timeoutMs: 3000 }), 3000, 'rawRequest');
  ok('[B1] after：rawRequest 响应中断 → reject', rRaw.rejected, rRaw.value && JSON.stringify(rRaw.value));
  ok('[B2] 错误信息可读', !!rRaw.error && /响应中断|ECONNRESET|socket hang up|aborted/i.test(rRaw.error.message), rRaw.error && rRaw.error.message);

  const rJson = await rejectsAsync(net.httpGetJson(url, { timeoutMs: 3000 }), 3000, 'httpGetJson');
  ok('[B3] after：httpGetJson 响应中断 → reject', rJson.rejected, rJson.value && JSON.stringify(rJson.value));

  await closeServer(server);
}

/* ========================================================================== */
async function testMaxBytes() {
  console.log('\n== C. #1 响应体大小上限 ==');
  const big = 'x'.repeat(64 * 1024);
  const { server, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pad: big }));
  });
  const url = `http://127.0.0.1:${port}/big`;

  const okRun = await net.rawRequest(url, { timeoutMs: 5000 });
  ok('[C1] 未超限时正常返回（默认 32MB）', okRun.ok && okRun.text.length > 60000, String(okRun.text.length));

  const limited = await rejectsAsync(net.rawRequest(url, { timeoutMs: 5000, maxBytes: 1024 }), 5000, 'rawRequest maxBytes');
  ok('[C2] 超过 maxBytes → reject', limited.rejected, limited.value && JSON.stringify(limited.value).slice(0, 80));
  ok('[C3] 错误信息含上限值', !!limited.error && limited.error.message.includes('1024'), limited.error && limited.error.message);

  const limitedJson = await rejectsAsync(net.httpGetJson(url, { timeoutMs: 5000, maxBytes: 2048 }), 5000, 'httpGetJson maxBytes');
  ok('[C4] httpGetJson 同样受 maxBytes 约束', limitedJson.rejected, limitedJson.value && 'no-reject');
  ok('[C5] httpGetJson 错误信息含上限值', !!limitedJson.error && limitedJson.error.message.includes('2048'), limitedJson.error && limitedJson.error.message);

  await closeServer(server);
}

/* ========================================================================== */
async function testSingleRequest() {
  console.log('\n== D. #3 单次调用 = 单个请求（不再 fetch→curl 双发）==');
  let hits = 0;
  const seen = [];
  const { server, port } = await startServer((req, res) => {
    hits += 1;
    seen.push(req.method + ' ' + req.url);
    if (req.url.startsWith('/500')) { res.writeHead(500); res.end('boom'); return; }
    if (req.url.startsWith('/404')) { res.writeHead(404); res.end('not found'); return; }
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: `/final?${encodeURIComponent('x')}` }); res.end(); return; }
    if (req.url.startsWith('/biz')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 405, msg: '操作频繁' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, result: { songs: [] } }));
  });
  const base = `http://127.0.0.1:${port}`;

  // D1: 200 正常
  hits = 0; seen.length = 0;
  const r1 = await net.webPost(`${base}/ok`, { s: '晴天', type: '1' }, { timeoutMs: 5000 });
  ok('[D1] webPost 200：1 次请求', hits === 1, 'hits=' + hits + ' seen=' + JSON.stringify(seen));
  ok('[D2] webPost 200：ok=true 且 body 已解析', r1.ok === true && r1.body && r1.body.code === 200, JSON.stringify(r1).slice(0, 120));
  ok('[D3] 返回结构保留 via/status/bytes/elapsedMs',
    typeof r1.via === 'string' && r1.status === 200 && typeof r1.bytes === 'number' && typeof r1.elapsedMs === 'number',
    JSON.stringify({ via: r1.via, status: r1.status, bytes: r1.bytes }));

  // D2: 500 —— 旧实现会再发一次 curl（共 2 次）
  hits = 0; seen.length = 0;
  const r2 = await net.webPost(`${base}/500`, { s: 'x' }, { timeoutMs: 5000 });
  ok('[D4] webPost 500：仍是 1 次请求（旧实现会 2 次）', hits === 1, 'hits=' + hits);
  ok('[D5] webPost 500：ok=false 且 httpError=true', r2.ok === false && r2.httpError === true && r2.status === 500, JSON.stringify({ ok: r2.ok, status: r2.status }));

  // D3: 404 —— 明确否定，不重试
  hits = 0; seen.length = 0;
  const r3 = await net.webGet(`${base}/404`, { timeoutMs: 5000 });
  ok('[D6] webGet 404：1 次请求且不重试', hits === 1, 'hits=' + hits);
  ok('[D7] webGet 404：status=404 / ok=false', r3.status === 404 && r3.ok === false, JSON.stringify({ status: r3.status, ok: r3.ok }));

  // D4: 业务错误（HTTP 200 + code 405）
  hits = 0; seen.length = 0;
  const r4 = await net.webGet(`${base}/biz`, { timeoutMs: 5000 });
  ok('[D8] 业务错误识别保留（HTTP 200 + code 405）', r4.ok === false && /business code 405/.test(String(r4.businessError || r4.error)), JSON.stringify({ businessError: r4.businessError, error: r4.error }));
  ok('[D9] 业务错误也只发 1 次请求', hits === 1, 'hits=' + hits);

  // D5: 重定向跟随（原 fetch redirect:'follow' 的等价行为）
  hits = 0; seen.length = 0;
  const r5 = await net.webGet(`${base}/redirect`, { timeoutMs: 5000 });
  ok('[D10] 跟随 302 重定向拿到最终 200', r5.status === 200, 'status=' + r5.status + ' seen=' + JSON.stringify(seen));

  // D6: 网络不可达 → dead 结构（不抛、不挂）
  const r6 = await withTimeout(net.webGet('http://127.0.0.1:1/nope', { timeoutMs: 3000 }), 5000, 'webGet ECONNREFUSED');
  ok('[D11] 连接失败返回 dead 结构（ok=false/via=none/status=0）',
    r6 && r6.ok === false && r6.via === 'none' && r6.status === 0 && typeof r6.error === 'string',
    JSON.stringify({ ok: r6 && r6.ok, via: r6 && r6.via, status: r6 && r6.status }));

  await closeServer(server);
}

/* ========================================================================== */
async function testCookieJar() {
  console.log('\n== E. #4 cookie jar 吸收 + host 隔离 ==');
  net.resetCookieJar();

  // E1: WHATWG Headers（旧实现用 res.headers['set-cookie'] 恒为 undefined）
  const headers = new Headers();
  headers.append('set-cookie', 'appver=1.0; Path=/');
  headers.append('set-cookie', 'NMTID=abc123; Path=/; HttpOnly');
  const listed = net.setCookieList({ headers });
  ok('[E1] 能从 WHATWG Headers 取出 Set-Cookie（旧实现恒空）', listed.length === 2, JSON.stringify(listed));

  net.absorbCookies('https://music.163.com/api/search', { headers });
  const neHeader = net.cookieHeader('https://music.163.com/api/cloudsearch/pc');
  ok('[E2] 同 host 能取到 cookie', neHeader.includes('appver=1.0') && neHeader.includes('NMTID=abc123'), neHeader);

  const mbHeader = net.cookieHeader('https://musicbrainz.org/ws/2/recording');
  ok('[E3] 跨 host 不泄漏 cookie（musicbrainz.org 为空）', mbHeader === '', JSON.stringify(mbHeader));

  // E2: node http 原生数组
  net.absorbCookies('https://coverartarchive.org/release/x', { headers: { 'set-cookie': 'caa=1; Path=/' } });
  ok('[E4] 兼容 node http 原生数组形态', net.cookieHeader('https://coverartarchive.org/release/y') === 'caa=1', net.cookieHeader('https://coverartarchive.org/release/y'));
  ok('[E5] 网易云 cookie 不会出现在 CAA 请求里', !net.cookieHeader('https://coverartarchive.org/release/y').includes('NMTID'), net.cookieHeader('https://coverartarchive.org/release/y'));

  // E3: 旧签名兼容 + 空值删除
  net.absorbCookies({ headers: { 'set-cookie': ['legacy=1'] } });
  ok('[E6] 旧签名 absorbCookies(res) 不抛异常且无 host 上下文时不入库', net.cookieHeader('https://music.163.com/') !== null);
  net.absorbCookies('https://music.163.com/x', { headers: { 'set-cookie': ['appver=; Max-Age=0'] } });
  ok('[E7] 空值 cookie 视为删除', !net.cookieHeader('https://music.163.com/').includes('appver'), net.cookieHeader('https://music.163.com/'));

  net.resetCookieJar();
}

/* ========================================================================== */
async function testProxyTunnel() {
  console.log('\n== F. #5 代理隧道健壮性（不挂死、不双触发）==');
  const modes = ['deny', 'drop'];
  const results = {};

  for (const mode of modes) {
    const proxy = http.createServer((req, res) => { res.writeHead(500); res.end(); });
    proxy.on('connect', (req, clientSocket) => {
      if (mode === 'deny') {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
      } else {
        clientSocket.destroy();          // 连上后立刻掐断，既不 200 也不报错
      }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const port = proxy.address().port;

    const savedHttps = process.env.HTTPS_PROXY;
    const savedNo = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    delete process.env.NO_PROXY;
    let r;
    try {
      r = await rejectsAsync(net.rawRequest('https://example.test/probe', { timeoutMs: 4000 }), 6000, 'proxy ' + mode);
    } finally {
      if (savedHttps === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = savedHttps;
      if (savedNo === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedNo;
    }
    results[mode] = r;
    await new Promise((res) => proxy.close(res));
  }

  ok('[F1] CONNECT 被拒（403）→ reject 而非挂死', results.deny.rejected, JSON.stringify(results.deny.value));
  ok('[F2] CONNECT 403 错误信息含失败原因',
    !!results.deny.error && /CONNECT|403|socket|ECONNRESET/i.test(results.deny.error.message),
    results.deny.error && results.deny.error.message);
  ok('[F3] 隧道建好后被掐断 → reject 而非挂死', results.drop.rejected, JSON.stringify(results.drop.value));

  // 超时路径：代理连上后什么都不回
  const hangProxy = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  hangProxy.on('connect', () => { /* 故意不响应，制造超时 */ });
  await new Promise((r) => hangProxy.listen(0, '127.0.0.1', r));
  const hp = hangProxy.address().port;
  const savedHttps2 = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${hp}`;
  let timeoutRes;
  try {
    timeoutRes = await rejectsAsync(net.rawRequest('https://example.test/probe', { timeoutMs: 400 }), 4000, 'proxy timeout');
  } finally {
    if (savedHttps2 === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = savedHttps2;
  }
  // CONNECT 悬挂的 socket 会让 server.close() 永远等不到排空 —— 先强制断干净再关
  hangProxy.closeAllConnections && hangProxy.closeAllConnections();
  await new Promise((res) => { hangProxy.close(res); setTimeout(res, 2000).unref(); });
  ok('[F4] 代理超时 → reject（错误信息含「超时」）',
    timeoutRes.rejected && /超时|timeout/i.test(String(timeoutRes.error && timeoutRes.error.message)),
    timeoutRes.error && timeoutRes.error.message);

  // socket 直连级别的守卫：确认没有遗留 removeAllListeners 导致 error 无人处理
  const sock = nodeNet.connect({ host: '127.0.0.1', port: 1 });
  let unhandled = false;
  const onErr = () => { unhandled = true; };
  process.once('uncaughtException', onErr);
  await new Promise((resolve) => {
    sock.once('error', () => resolve());
    setTimeout(resolve, 500);
  });
  process.removeListener('uncaughtException', onErr);
  ok('[F5] 裸 socket 错误仍可被监听（无 uncaughtException 泄漏）', unhandled === false);
}

/* ========================================================================== */
function testEncoding() {
  console.log('\n== G. #6 GBK 乱码判定：不误伤拉丁、仍还原真乱码 ==');

  // 评审给的 6 个必须原样保留的用例
  const latin = [
    'Mötley Crüe', 'Björk Guðmundsdóttir', 'Håkon Øvreås',
    'Plácido Domingo', 'Céline Dion', 'Motörhead',
  ];
  for (const s of latin) {
    const out = enc.fixGarbled(s);
    ok(`[G] 拉丁文本原样保留：${s}`, out === s && enc.looksGarbled(s) === false, 'got=' + JSON.stringify(out));
  }

  // 额外密集重音词（占比容易过线，靠「相邻高位字节对」门槛挡住）
  const stress = ['Þórðurinn', 'Ágætis byrjun', 'Björn Þórðarson', 'Hjördís Guðrúnardóttir', 'Ærø Øst'];
  for (const s of stress) {
    ok(`[G+] 密集重音词原样保留：${s}`, enc.fixGarbled(s) === s, 'got=' + JSON.stringify(enc.fixGarbled(s)));
  }

  // 真实 GBK 乱码（latin1 存的双字节序列）必须仍能还原
  const gbkCases = [
    ['周杰伦', 'd6dcbddcc2d7'],
    ['晴天', 'c7e7ccec'],
    ['林俊杰', 'c1d6bfa1bddc'],
    ['律动车载音乐', 'c2c9b6afb3b5d4d8d2f4c0d6'],
    ['江智民', 'bdadd6c7c3f1'],
  ];
  for (const [zh, hex] of gbkCases) {
    const mojibake = Buffer.from(hex, 'hex').toString('latin1');
    const out = enc.fixGarbled(mojibake);
    ok(`[G*] 真乱码还原：${JSON.stringify(mojibake)} → ${zh}`, out === zh, 'got=' + JSON.stringify(out));
  }

  // 文件头注释里的历史 fixture 继续有效
  const fixtures = [
    ['ÂÉ¶¯³µÔØÒôÀÖ', '律动车载音乐'],
    ['½­ÖÇÃñ', '江智民'],
    ['Í«ÀÖ-Ê°Èþ', '瞳乐-拾叁'],
    ['¹«ÖÚºÅ£ºÐ¡²ÝÐÂ¾çÉç', '公众号：小草新剧社'],
  ];
  for (const [input, want] of fixtures) {
    ok(`[G#] 历史 fixture：${input} → ${want}`, enc.fixGarbled(input) === want, 'got=' + JSON.stringify(enc.fixGarbled(input)));
  }

  // 中英混排（尾部大段 ASCII 会稀释整串占比，必须仍能还原）
  const mixed = 'ÖÐ¡¾3D»·ÈÆ¡¿I Need a Good One';
  ok('[G~] 中英混排乱码仍能还原', enc.fixGarbled(mixed) === '中【3D环绕】I Need a Good One', JSON.stringify(enc.fixGarbled(mixed)));

  // 纯 ASCII / 纯中文均不应被改动
  ok('[G-] 纯 ASCII 不受影响', enc.fixGarbled('Qing Tian') === 'Qing Tian');
  ok('[G=] 已是中文的文本不受影响', enc.fixGarbled('晴天') === '晴天');
}

/* ========================================================================== */
function testFilenameTitleSource() {
  console.log('\n== H. #7 文件名标题的来源标识与置信度 ==');

  const entry = {
    filePath: '周杰伦/魔杰座/晴天.mp3',
    fileName: '晴天.mp3',
    fileExt: 'mp3',
    fileSizeBytes: 12345,
    fileMtime: '2024-01-01T00:00:00.000Z',
    dirDepth: 2,
  };

  // H1: 无内嵌标题 → 来源必须是 filename 且置信度 < 0.7
  const t1 = l1.process({ ...entry }, { title: '', artist: '', album: '' });
  ok('[H1] 无内嵌标题：sourceMap.cleanTitle = filename', t1.sourceMap.cleanTitle === 'filename', JSON.stringify(t1.sourceMap.cleanTitle));
  ok('[H2] 无内嵌标题：置信度落在 0.4~0.5', t1.fieldConfidence.cleanTitle >= 0.4 && t1.fieldConfidence.cleanTitle <= 0.5, String(t1.fieldConfidence.cleanTitle));

  // H2: L2 在线源必须能覆盖
  const r1 = merge.applyField(t1, 'cleanTitle', '晴天（Live）', 'online:netease', 0.75);
  ok('[H3] L2 在线 cleanTitle 能覆盖文件名推断（旧实现 100% 被丢弃）', r1 === 'accepted' && t1.cleanTitle === '晴天（Live）', r1 + ' / ' + t1.cleanTitle);

  // H3: L3 LLM 也必须能覆盖
  const t1b = l1.process({ ...entry }, { title: '', artist: '', album: '' });
  const r1b = merge.applyField(t1b, 'cleanTitle', '晴天', 'llm', 0.7);
  ok('[H4] L3 LLM cleanTitle 能覆盖文件名推断', r1b === 'accepted' && t1b.cleanTitle === '晴天', r1b + ' / ' + t1b.cleanTitle);

  // H4: 真内嵌标签的行为必须保持不变
  const t2 = l1.process({ ...entry }, { title: '晴天', artist: '周杰伦', album: '魔杰座' });
  ok('[H5] 有内嵌标题：sourceMap.cleanTitle 仍是 embed', t2.sourceMap.cleanTitle === 'embed', JSON.stringify(t2.sourceMap.cleanTitle));
  ok('[H6] 有内嵌标题：置信度仍是 0.7', t2.fieldConfidence.cleanTitle === 0.7, String(t2.fieldConfidence.cleanTitle));
  const r2 = merge.applyField(t2, 'cleanTitle', '晴天（Live）', 'online:netease', 0.75);
  ok('[H7] 真内嵌标签不被在线源覆盖（既有优先级行为不变）', r2 === 'lower-priority' && t2.cleanTitle !== '晴天（Live）', r2 + ' / ' + t2.cleanTitle);
  ok('[H8] 内嵌 artist/album 优先级未受影响',
    t2.sourceMap.cleanArtist === 'embed' && t2.sourceMap.album === 'embed',
    JSON.stringify({ a: t2.sourceMap.cleanArtist, al: t2.sourceMap.album }));
  const r3 = merge.applyField(t2, 'cleanArtist', '周杰伦', 'path', 0.6);
  ok('[H9] R-FB-09 仍成立：path 不得覆盖 embed', r3 === 'lower-priority', r3);
}

/* ========================================================================== */
function testL3Confidence() {
  console.log('\n== I. #8 L3 confidence 默认值 ==');
  const { newTrack } = require('../src/store/schema');

  const mk = () => newTrack({ id: 't1', filePath: 'a/b.mp3', fileName: 'b.mp3' });

  // I1: 缺 confidence → NaN，旧实现 ?? 拦不住，会把 NaN 传下去
  const t1 = mk();
  l3.apply(t1, { id: 't1', cleanTitle: '晴天', cleanArtist: '周杰伦', genre: '流行', mood: ['欢快'] });
  ok('[I1] 缺 confidence 时落到默认 0.7（旧实现得到 NaN/0.5）', t1.fieldConfidence.cleanTitle === 0.7, String(t1.fieldConfidence.cleanTitle));

  // I2: 非法字符串 → 同样是 NaN
  const t2 = mk();
  l3.apply(t2, { id: 't1', cleanTitle: '晴天', cleanArtist: '周杰伦', genre: '流行', mood: ['欢快'], confidence: 'abc' });
  ok('[I2] confidence 非法字符串 → 默认 0.7', t2.fieldConfidence.cleanTitle === 0.7, String(t2.fieldConfidence.cleanTitle));

  // I3: 正常值仍然生效并被 clamp
  const t3 = mk();
  l3.apply(t3, { id: 't1', cleanTitle: '晴天', cleanArtist: '周杰伦', genre: '流行', mood: ['欢快'], confidence: 0.9 });
  ok('[I3] confidence=0.9 生效', t3.fieldConfidence.cleanTitle === 0.9, String(t3.fieldConfidence.cleanTitle));

  const t4 = mk();
  l3.apply(t4, { id: 't1', cleanTitle: '晴天', cleanArtist: '周杰伦', genre: '流行', mood: ['欢快'], confidence: 5 });
  ok('[I4] confidence 超界仍被 clamp 到 1', t4.fieldConfidence.cleanTitle === 1, String(t4.fieldConfidence.cleanTitle));
}

/* ========================================================================== */
async function testL2SourcesAndCaa() {
  console.log('\n== J. #10 L2 尊重 opts.sources（CAA 兜底）==');

  const realMb = l2.REGISTRY.musicbrainz;
  const realNe = l2.REGISTRY.netease;
  const realLookup = caa.lookup;

  let caaCalls = 0;
  caa.lookup = async () => { caaCalls += 1; return { url: 'http://img.test/front.jpg', thumb500: 'http://img.test/500.jpg' }; };

  // 造一个能被 pickBest 选中的 MusicBrainz 候选（带 mbReleaseId）
  const mbRow = {
    source: 'musicbrainz',
    id: 'rec-1',
    title: '晴天',
    artists: ['周杰伦'],
    artist: '周杰伦',
    album: '魔杰座',
    albumId: 'rel-1',
    year: 2008,
    durationSec: 269,
    picUrl: '',
    mbReleaseId: 'rel-1',
    _raw: {
      id: 'rec-1',
      title: '晴天',
      'artist-credit': [{ name: '周杰伦' }],
      releases: [{ id: 'rel-1', title: '魔杰座', date: '2008-10-15' }],
      length: 269000,
      score: 100,
    },
  };
  l2.REGISTRY.musicbrainz = () => ({ NAME: 'musicbrainz', search: async () => [mbRow], getStats: () => ({}) });
  l2.REGISTRY.netease = () => ({ NAME: 'netease', search: async () => [], getStats: () => ({}) });

  const track = l1.process(
    { filePath: '周杰伦/魔杰座/晴天.mp3', fileName: '晴天.mp3', fileExt: 'mp3', fileSizeBytes: 1, fileMtime: '', dirDepth: 2 },
    { title: '', artist: '', album: '' }
  );
  track.durationSec = 269;

  try {
    caaCalls = 0;
    await l2.scrape(track, { sources: ['musicbrainz'] });     // 调用方没开 caa
    ok('[J1] opts.sources 不含 caa → 不查 CAA', caaCalls === 0, 'calls=' + caaCalls);

    caaCalls = 0;
    const out2 = await l2.scrape(track, {});                   // 回落 config.ONLINE_SOURCES（含 caa）
    ok('[J2] 未传 sources 时回落 config（含 caa）→ 查 CAA', caaCalls === 1, 'calls=' + caaCalls);
    ok('[J3] CAA 封面被写入 cover', !!(out2 && out2.cover && out2.cover.url), JSON.stringify(out2 && out2.cover));
  } finally {
    l2.REGISTRY.musicbrainz = realMb;
    l2.REGISTRY.netease = realNe;
    caa.lookup = realLookup;
  }

  console.log('\n== K. #12 CAA stats 区分 empty / failed ==');
  const netMod = require('../src/util/net');
  const realWebGet = netMod.webGet;
  const realRawRequest = netMod.rawRequest;
  const before = caa.getStats();

  async function runWith(stub) {
    netMod.webGet = stub;
    try {
      return await caa.lookup('rel-1');
    } finally {
      netMod.webGet = realWebGet;
    }
  }
  const s0 = caa.getStats();

  await runWith(async () => ({ ok: false, via: 'raw', status: 500, body: null, httpError: true, error: 'HTTP 500' }));
  const s1 = caa.getStats();
  ok('[K1] HTTP 500 记为 failed（旧实现记 empty）', s1.failed === s0.failed + 1 && s1.empty === s0.empty, JSON.stringify(s1));

  await runWith(async () => ({ ok: false, via: 'none', status: 0, body: null, httpError: true, error: '连接超时' }));
  const s2 = caa.getStats();
  ok('[K2] 网络失败记为 failed', s2.failed === s1.failed + 1 && s2.empty === s1.empty, JSON.stringify(s2));

  await runWith(async () => ({ ok: true, via: 'raw', status: 200, body: { error: 'not found' } }));
  const s3 = caa.getStats();
  ok('[K3] 业务上「没有封面」记为 empty', s3.empty === s2.empty + 1 && s3.failed === s2.failed, JSON.stringify(s3));

  await runWith(async () => ({ ok: true, via: 'raw', status: 200, body: { images: [] } }));
  const s4 = caa.getStats();
  ok('[K4] images 为空记为 empty', s4.empty === s3.empty + 1 && s4.failed === s3.failed, JSON.stringify(s4));

  const pic = await runWith(async () => ({ ok: true, via: 'raw', status: 200, body: { images: [{ front: true, image: 'http://x/1.jpg', thumbnails: { '500': 'http://x/500.jpg' } }] } }));
  const s5 = caa.getStats();
  ok('[K5] 有封面记为 ok', s5.ok === s4.ok + 1 && pic && pic.url === 'http://x/1.jpg', JSON.stringify(s5));
  ok('[K6] stats 结构带 failed 字段', typeof s5.failed === 'number' && typeof s5.empty === 'number', JSON.stringify(s5));

  // test()：任何 HTTP 响应（含 404）都算连通
  netMod.rawRequest = async () => ({ ok: false, status: 404, headers: {}, text: '', bytes: 0, elapsedMs: 1 });
  let t;
  try { t = await caa.test(); } finally { netMod.rawRequest = realRawRequest; }
  ok('[K7] test()：收到 404 也算连通（旧实现用虚构 mbid 恒失败）', t && t.ok === true, JSON.stringify(t));

  netMod.rawRequest = async () => { throw new Error('connect ECONNREFUSED'); };
  let t2;
  try { t2 = await caa.test(); } finally { netMod.rawRequest = realRawRequest; }
  ok('[K8] test()：连不上时 ok=false', t2 && t2.ok === false && /ECONNREFUSED/.test(t2.error), JSON.stringify(t2));

  console.log('   （before stats=' + JSON.stringify(before) + ' → after=' + JSON.stringify(caa.getStats()) + '）');
}

/* ========================================================================== */
async function main() {
  await testRateLimiter();
  await testTruncatedResponse();
  await testMaxBytes();
  await testSingleRequest();
  await testCookieJar();
  await testProxyTunnel();
  testEncoding();
  testFilenameTitleSource();
  testL3Confidence();
  await testL2SourcesAndCaa();
}

const watchdog = setTimeout(() => {
  console.error('\nunit-net-scrape-fixes: 超时退出（可能有测试挂死）');
  process.exit(1);
}, 120000);

main()
  .then(() => {
    clearTimeout(watchdog);
    console.log('\n' + '─'.repeat(60));
    console.log(`unit-net-scrape-fixes: ${pass} 通过 / ${fail} 失败`);
    if (fail) {
      console.log('\n失败明细：');
      for (const f of failures) console.log('  · ' + f);
    }
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    clearTimeout(watchdog);
    console.error('\n测试自身异常：', e && e.stack ? e.stack : e);
    process.exit(1);
  });
