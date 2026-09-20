'use strict';
/**
 * QA 审计 1/2 —— 真实 HTTP 层面的验证（起真服务，用真实 socket 打）
 *
 * 覆盖：
 *   1. /discover.js 真的能被静态路由打到（200 + 正确 content-type + 内容含 TPDiscover）
 *   2. index.html 真的 <script src="/discover.js">
 *   3. 静态资源同样受鉴权保护（未带凭据不得 200）
 *   4. /api/sqmusic/* 五个端点逐个验证：未带 Bearer → 401（不用 /api/health 当判据）
 *   5. SQ_ENABLED 默认 false 时优雅降级：503 + enabled:false，且现有一等公民接口不受影响
 *   6. 目录穿越 / 不存在的静态资源 → 404 JSON
 *
 * 运行：node tests/qa-server-http.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
// 只读自检需要一个「不可写」的音乐目录：用不存在的路径即可（writeFileSync 抛 ENOENT）
process.env.MUSIC_DIR = require('path').join(__dirname, '..', '.tmp-qa-http', 'music-readonly-notexist');
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-qa-http');
process.env.PORT = '18277';
process.env.LOG_LEVEL = 'error';
delete process.env.SQ_ENABLED;   // 关键：默认保持关闭，验证「默认不启用」

// QA_SQ_ON=1 → 模拟「启用了但 SqMusic 不可达」的真实误配置场景
const SQ_ON = process.env.QA_SQ_ON === '1';
if (SQ_ON) {
  process.env.SQ_ENABLED = 'true';
  process.env.SQ_BASE_URL = 'http://127.0.0.1:1';   // 连不上
  process.env.SQ_TIMEOUT_MS = '1500';
}

const fs = require('fs');
const http = require('http');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

/** 原生 HTTP 请求（零依赖） */
function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: 18277,
      path,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON 正常 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => { req.destroy(new Error('QA 请求超时')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const BEARER = { authorization: 'Bearer testtoken', accept: 'application/json' };

(async () => {
  /* =====================================================================
   * 0. 起真服务
   * ===================================================================== */
  console.log('\n== 0. 启动真实服务 ==');
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));
  const root = await request('/', { headers: BEARER });
  ok('GET / → 200', root.status === 200, String(root.status));

  /* =====================================================================
   * 1. 前端资源真的能加载（不看代码，看 wire）
   * ===================================================================== */
  console.log('\n== 1. 静态资源真的能加载 ==');
  const disc = await request('/discover.js', { headers: BEARER });
  ok('GET /discover.js → 200', disc.status === 200, String(disc.status));
  ok('content-type 是 JS',
    /application\/javascript/.test(disc.headers['content-type'] || ''),
    String(disc.headers['content-type']));
  ok('响应体真的实现了 TPDiscover',
    disc.text.includes('window.TPDiscover') && disc.text.includes('render'),
    '长度=' + disc.text.length);
  ok('discover.js 内容非空且非 index.html', disc.text.length > 1000, '长度=' + disc.text.length);
  // 新增四项能力的痕迹必须真的出现在下发到浏览器的文件里（不是只在源码里）
  ok('discover.js 含下载目录展示（/api/sqmusic/dir）',
    /\/api\/sqmusic\/dir/.test(disc.text) && disc.text.includes('下载目录'), '未匹配');
  ok('discover.js 含试听（/api/sqmusic/preview）',
    /\/api\/sqmusic\/preview/.test(disc.text) && disc.text.includes('试听'), '未匹配');
  ok('discover.js 含已下载列表（/api/sqmusic/downloaded）',
    /\/api\/sqmusic\/downloaded/.test(disc.text) && disc.text.includes('已下载'), '未匹配');
  // 诚实性：SqMusic 无真实进度，页面不得画进度条
  ok('discover.js 不含百分比进度条（无真实进度，不撒谎）',
    !/class="progress"/.test(disc.text), '出现了 progress 进度条');

  const appJs = await request('/app.js', { headers: BEARER });
  ok('GET /app.js → 200', appJs.status === 200, String(appJs.status));
  const appCss = await request('/app.css', { headers: BEARER });
  ok('GET /app.css → 200 + text/css',
    appCss.status === 200 && /text\/css/.test(appCss.headers['content-type'] || ''),
    String(appCss.status) + ' ' + appCss.headers['content-type']);

  // 页面本身：确认 script 标签真的写在 HTML 里（防止「文件存在但没引入」）
  const idx = await request('/', { headers: BEARER });
  ok('index.html 含 <script src="/discover.js">',
    /<script\s+src="\/discover\.js"><\/script>/.test(idx.text), '未匹配到 script 标签');
  ok('index.html 里 discover.js 在 app.js 之前加载',
    idx.text.indexOf('/discover.js') > 0 && idx.text.indexOf('/discover.js') < idx.text.indexOf('/app.js'),
    '顺序错误：' + idx.text.indexOf('/discover.js') + ' vs ' + idx.text.indexOf('/app.js'));
  ok('导航含 #/discover 入口', idx.text.includes('#/discover'));

  // 静态资源同样不能匿名访问
  const discAnon = await request('/discover.js', { headers: { accept: 'application/json' } });
  ok('匿名 GET /discover.js → 401（不是 200 泄露）', discAnon.status === 401, String(discAnon.status));
  const discWrongJson = await request('/discover.js', { headers: { accept: 'application/json', cookie: 'tp_token=wrong' } });
  ok('错误 Cookie（非浏览器 Accept）→ 401', discWrongJson.status === 401, String(discWrongJson.status));
  const discWrongHtml = await request('/discover.js', { headers: { accept: 'text/html', cookie: 'tp_token=wrong' } });
  ok('错误 Cookie（浏览器）→ 302 到 /login',
    discWrongHtml.status === 302 && discWrongHtml.headers.location === '/login',
    String(discWrongHtml.status) + ' ' + discWrongHtml.headers.location);

  // 目录穿越 & 不存在的资源
  const trav = await request('/../../package.json', { headers: BEARER });
  ok('目录穿越 ../../package.json 拿不到文件（404）',
    trav.status === 404 && !trav.text.includes('dependencies'), String(trav.status));
  const missing = await request('/nope.js', { headers: BEARER });
  ok('不存在的静态资源 → 404 JSON',
    missing.status === 404 && missing.json && missing.json.ok === false, String(missing.status));

  /* =====================================================================
   * 2. /api/sqmusic/* 逐个鉴权（未带 Bearer 必须 401）
   * ===================================================================== */
  console.log('\n== 2. /api/sqmusic/* 鉴权矩阵（未带 Bearer）==');
  const endpoints = [
    ['GET', '/api/sqmusic/status'],
    ['POST', '/api/sqmusic/search'],
    ['POST', '/api/sqmusic/download'],
    ['GET', '/api/sqmusic/tasks'],
    ['POST', '/api/sqmusic/test'],
    // 新增三项（下载目录 / 试听 / 已下载）：同样必须 Bearer 鉴权
    ['GET', '/api/sqmusic/dir'],
    ['POST', '/api/sqmusic/preview'],
    ['GET', '/api/sqmusic/downloaded'],
  ];
  for (const [m, p] of endpoints) {
    const anon = await request(p, { method: m, headers: { accept: 'application/json' } });
    const bad = await request(p, { method: m, headers: { accept: 'application/json', authorization: 'Bearer wrong-token' } });
    ok(`${m} ${p} 无令牌 → 401`, anon.status === 401, String(anon.status));
    ok(`${m} ${p} 错误令牌 → 401`, bad.status === 401, String(bad.status));
  }
  // 反例哨兵：确认我们没有拿「任何令牌都放行」的端点当判据
  const healthNoToken = await request('/api/health', { headers: {} });
  console.log('     （哨兵）GET /api/health 无令牌 → ' + healthNoToken.status +
    '（该端点免鉴权，不能用作鉴权判据）');

  /* =====================================================================
   * 3. 默认不启用时的优雅降级
   * ===================================================================== */
  console.log(SQ_ON
    ? '\n== 3. SqMusic 启用但不可达（误配置）：优雅降级 =='
    : '\n== 3. SQ_ENABLED 默认 false：优雅降级 + 不影响既有功能 ==');
  const st = await request('/api/sqmusic/status', { headers: BEARER });
  ok('status → 200', st.status === 200, String(st.status));
  ok(`status.enabled === ${SQ_ON}`,
    st.json && st.json.status && st.json.status.enabled === SQ_ON, JSON.stringify(st.json && st.json.status));

  // 只跑原有四项的降级期望；新增三项的降级形态各不相同，单独在 3b 里断言
  const LEGACY_ENDPOINTS = ['/api/sqmusic/search', '/api/sqmusic/download', '/api/sqmusic/tasks', '/api/sqmusic/test'];
  for (const [m, p] of endpoints.filter(([, p2]) => LEGACY_ENDPOINTS.includes(p2))) {
    // download 会先校验本地缓存 key（冷缓存 → 400 cache-miss），
    // 这本就是「不联网也能拒绝非法请求」的正确顺序，期望值单独写
    const isDownload = p === '/api/sqmusic/download';
    const want = isDownload && SQ_ON
      ? { status: 400, code: 'cache-miss' }
      : { status: SQ_ON ? 502 : 503, code: SQ_ON ? 'unreachable' : 'disabled' };
    // GET 不能带 body，否则 Node 的 HTTP parser 会直接 400（与被测代码无关）
    const opts = Object.assign({ 'content-type': 'application/json' }, BEARER);
    const startedAt = Date.now();
    const r = await request(p, {
      method: m,
      headers: opts,
      body: m === 'POST' ? JSON.stringify({ keyword: '晴天', key: 'x' }) : null,
    });
    const ms = Date.now() - startedAt;
    ok(`${m} ${p} → ${want.status} 而非崩溃`, r.status === want.status, String(r.status));
    ok(`${m} ${p} 错误码 ${want.code}`, r.json && r.json.code === want.code, JSON.stringify(r.json));
    ok(`${m} ${p} 快速失败且返回 JSON（无挂起）`,
      ms < 8000 && r.json && typeof r.json.error === 'string', ms + 'ms ' + JSON.stringify(r.json));
    if (!SQ_ON && !isDownload) {
      ok(`${m} ${p} 提示文案含「未启用 SqMusic」`,
        r.json && /未启用 SqMusic/.test(r.json.error || ''), JSON.stringify(r.json && r.json.error));
    }
  }

  /* =====================================================================
   * 3b. 新增三端点的降级形态（各自不同，不能套用统一的 502/503 期望）
   *     dir      ：读不到目录也要 200 + error 文案，绝不崩页面
   *     preview  ：冷缓存先 400 cache-miss（不联网就能拒非法请求）
   *     downloaded：走 task/list，不可达时 502 unreachable
   * ===================================================================== */
  console.log('\n== 3b. 新增端点（dir / preview / downloaded）降级行为 ==');
  const newOnes = [
    ['GET', '/api/sqmusic/dir'],
    ['POST', '/api/sqmusic/preview'],
    ['GET', '/api/sqmusic/downloaded'],
  ];
  for (const [m, p] of newOnes) {
    const r = await request(p, {
      method: m,
      headers: Object.assign({ 'content-type': 'application/json' }, BEARER),
      body: m === 'POST' ? JSON.stringify({ key: 'x' }) : null,
    });
    const brief = String(r.status) + ' ' + (r.text || '').slice(0, 140);
    if (!SQ_ON) {
      ok(`${m} ${p} 未启用 → 503 disabled`,
        r.status === 503 && r.json && r.json.code === 'disabled', brief);
      continue;
    }
    if (p === '/api/sqmusic/dir') {
      ok('dir 不可达 → 仍 200 且带 error 文案（不崩页面）',
        r.status === 200 && r.json && r.json.ok === true && r.json.downloadPath === '' && !!r.json.error, brief);
    } else if (p === '/api/sqmusic/preview') {
      ok('preview 冷缓存 → 400 cache-miss',
        r.status === 400 && r.json && r.json.code === 'cache-miss', brief);
    } else {
      ok('downloaded 不可达 → 502 unreachable',
        r.status === 502 && r.json && r.json.code === 'unreachable', brief);
    }
  }

  console.log('\n== 4. 既有功能回归（同一进程，SqMusic 未启用）==');
  const regression = [
    ['GET', '/api/sources'],
    ['GET', '/api/library?limit=5'],
    ['GET', '/api/albums?limit=5'],
    ['GET', '/api/scan/status'],
    ['GET', '/api/scan/history'],
    ['GET', '/api/facets'],
    ['GET', '/api/stats/coverage'],
    ['GET', '/api/review/queue?limit=5'],
    ['GET', '/api/idmap/status'],
    ['GET', '/api/llm/config'],
    ['GET', '/api/tracks?limit=5'],
    ['GET', '/api/search?keyword=%E6%99%B4%E5%A4%A9'],
  ];
  for (const [m, p] of regression) {
    const r = await request(p, { method: m, headers: BEARER });
    ok(`${m} ${p} → 200`, r.status === 200, String(r.status) + ' ' + (r.text || '').slice(0, 120));
  }
  // 既有外观不应被污染
  const overview = await request('/', { headers: BEARER });
  const navCount = (overview.text.match(/data-nav="/g) || []).length;
  ok('导航项数量 = 9（8 原有 + 1 新增 discover）', navCount === 9, String(navCount));

  /* =====================================================================
   * 5. 既有缺陷（本次改动之前就存在，非本次引入）—— 用真实 ServerResponse 才能发现
   *    假 res（tests/auth-web.test.js 里的 r.end = () => {}）会把这个 bug 掩盖掉
   * ===================================================================== */
  console.log('\n== 5. 既有缺陷回归：router.route() 返回值 ==');
  const webRouter = require('../src/web/router');
  const retVal = await new Promise((resolve) => {
    const probe = http.createServer((req, res) => {
      let ret;
      try { ret = webRouter.route(req, res, '/discover.js'); } catch (e) { ret = 'THROW:' + e.message; }
      res.on('finish', () => resolve(ret));
    });
    probe.listen(0, '127.0.0.1', () => {
      const rq = http.get({ host: '127.0.0.1', port: probe.address().port, path: '/discover.js' }, (res) => res.resume());
      rq.once('error', () => resolve('REQERR'));
    });
  });
  ok('[既有缺陷] web.route() 应返回真值，告知 server.js「已处理」',
    !!retVal, '实际返回 ' + String(retVal) +
    '（Node 22 的 res.end() 返回 undefined → server.js:65 误判未处理 → ' +
    '二次 writeHead(404) 抛 ERR_HTTP_HEADERS_SENT，每个静态资源请求都刷一条 ERROR 日志）');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('QA 脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
