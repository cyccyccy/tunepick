'use strict';
/**
 * SqMusic 集成测试（零依赖）
 *
 * 用 Node 内置 http 起一个本地 mock 服务，模拟 SqMusic 的
 *   POST /api/config/login
 *   GET  /api/music/searchSong
 *   POST /api/download/downloadSong
 *   GET  /api/task/list
 * 覆盖：登录取 token / 搜索归一化 / 下载入队 / token 过期自动重登 / 未启用时优雅降级。
 *
 * 运行：node tests/sqmusic.test.js
 */

// ⚠️ 必须在 require 配置之前设置：config.js 在加载时读取环境变量
process.env.SKIP_DOT_ENV = '1';           // 不读仓库根的 .env，避免污染
process.env.AUTH_TOKEN = 'testtoken';
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-sqmusic-test');
process.env.MUSIC_DIR = require('path').join(__dirname, '..', 'tests', 'fixtures', 'music');
process.env.SOURCE_KIND = 'localfs';

const http = require('http');
const fs = require('fs');
const { EventEmitter } = require('events');

fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const config = require('../src/config');
const db = require('../src/store/db');
const sq = require('../src/service/sqmusic');
const sqApi = require('../src/api/sqmusic');

/* ==========================================================================
 * Mock SqMusic 服务
 * ========================================================================== */

function createMockServer() {
  const state = {
    loginCount: 0,
    tokenSeq: 0,
    /** 置 true 后，下一个带鉴权的请求返回 401（模拟 token 失效） */
    expireOnce: false,
    lastDownloadBody: null,
    lastTaskListBody: null,
    taskListMethod: '',
    taskStatus: 'waiting',
    searchCalls: [],
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (obj, status = 200) => {
        const s = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
        res.end(s);
      };

      // ---- 登录 ----
      if (u.pathname === '/api/config/login') {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
        if (parsed.username !== 'admin' || parsed.password !== 'admin') {
          return send({ code: 500, msg: '账号或密码错误' });
        }
        state.loginCount++;
        state.tokenSeq++;
        return send({
          code: 200,
          data: { tokenName: 'sqmusic', tokenValue: `tok-${state.tokenSeq}`, isLogin: true },
        });
      }

      // ---- 其余接口需要 sqmusic 头 ----
      const token = req.headers.sqmusic || '';
      if (state.expireOnce || token !== `tok-${state.tokenSeq}`) {
        // 只失效一次：下次请求带上新 token 就能通过
        if (state.expireOnce) state.expireOnce = false;
        return send({ code: 401, msg: '未登录' }, 401);
      }

      // ---- 搜索 ----
      if (u.pathname === '/api/music/searchSong') {
        state.searchCalls.push({ plugName: u.searchParams.get('plugName'), keyword: u.searchParams.get('keyword') });
        return send({
          code: 200,
          data: {
            searchTotal: 2,
            searchIndex: 1,
            searchSize: 20,
            records: [
              {
                id: '1001',
                name: '晴天',
                artistName: ['周杰伦'],
                artistids: ['1'],
                pic: 'https://img.example.com/1001.jpg',
                albumName: '叶惠美',
                albumid: '2001',
                lyric: '[00:00.00] 晴天',
                lyricId: '3001',
                plugName: u.searchParams.get('plugName'),
                duration: '269000',
                brTypes: ['KW_MP3_128', 'KW_FLAC_2000', 'KW_MP3_320'],
                dataInfo: { ARTIST: '周杰伦', ALBUM: '叶惠美', DURATION: '269000' },
              },
              {
                id: '1002',
                name: 'Mojito',
                artistName: ['周杰伦'],
                pic: '',
                albumName: 'Mojito',
                duration: '185000',
                brTypes: ['KW_MP3_320'],
                // 缺 name / id 的脏数据用于验证过滤
              },
              { id: '', name: '无 id 应被丢弃' },
            ],
          },
        });
      }

      // ---- 下载 ----
      if (u.pathname === '/api/download/downloadSong' && req.method === 'POST') {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
        state.lastDownloadBody = parsed;
        return send({ code: 200, data: { downloadStatus: state.taskStatus } });
      }

      // ---- 版本探针（ping 用）----
      if (u.pathname === '/api/config/version') {
        return send({ code: 200, data: { version: '1.0.0' } });
      }

      // ---- 任务列表 ----
      // ⚠️ 真实服务只接受 POST；GET 返回 HTTP 200 + 业务码 500（实测行为，必须复刻）
      if (u.pathname === '/api/task/list') {
        if (req.method !== 'POST') {
          state.taskListMethod = req.method;
          return send({ code: 500, msg: "Request method 'GET' not supported" });
        }
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = {}; }
        state.lastTaskListBody = parsed;
        if (parsed.pageIndex == null) {
          return send({ code: 500, msg: 'getPageIndex() is null' });
        }
        // 字段名一律用真实服务的 download* 前缀，确保归一化逻辑真被测到
        return send({
          code: 200,
          data: {
            total: 4,
            size: 3,
            current: 1,
            pages: 1,
            records: [
              {
                id: 4, downloadGid: '96765035', downloadTime: '2026-09-20 00:26:59',
                downloadFile: '后来 - 刘若英', downloadMusicId: '96765035', downloadPlugName: 'kw',
                downloadBrType: 'kw_flac_2000', downloadMusicname: '后来', downloadArtistname: '刘若英',
                downloadAlbumname: '2020 刘若英陪你 献上录音专辑', downloadMsg: null,
                downloadStatus: state.taskStatus === 'error' ? 'error' : state.taskStatus,
                downloadUpdateTime: '2026-09-20 00:27:01', downloadBits: '2000,320,128',
                downloadBrTypes: 'kw_flac_2000,kw_mp3_320,kw_mp3_128',
              },
              {
                id: 5, downloadGid: '96765036', downloadMusicname: 'Mojito',
                downloadArtistname: '周杰伦', downloadBrType: 'kw_mp3_320',
                downloadAlbumname: 'Mojito', downloadStatus: 'success',
              },
              {
                id: 6, downloadGid: '96765037', downloadMusicname: '坏歌',
                downloadArtistname: '未知', downloadStatus: 'error', downloadMsg: '音源无版权',
              },
            ],
          },
        });
      }

      return send({ code: 404, msg: 'not found' }, 404);
    });
  });

  return { server, state };
}

/* ==========================================================================
 * 断言工具
 * ========================================================================== */

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('✅ ' + name);
  } else {
    fail++;
    console.log('❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

/** 构造带 JSON body 的假 req（readBody 依赖 data/end 事件） */
function reqWithBody(obj) {
  const r = new EventEmitter();
  r.method = 'POST';
  r.headers = { 'content-type': 'application/json' };
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  setImmediate(() => { r.emit('data', buf); r.emit('end'); });
  return r;
}

function fakeRes() {
  const r = { status: 0, headers: {}, body: '' };
  r.writeHead = (s, h) => { r.status = s; if (h) Object.assign(r.headers, h); };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b || ''; };
  return r;
}

function jsonOf(res) {
  try { return JSON.parse(res.body); } catch (_) { return null; }
}

/* ==========================================================================
 * 主流程
 * ========================================================================== */

(async () => {
  const { server, state } = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  config.SQ_ENABLED = true;
  config.SQ_BASE_URL = `http://127.0.0.1:${port}`;
  config.SQ_USERNAME = 'admin';
  config.SQ_PASSWORD = 'admin';
  config.SQ_TIMEOUT_MS = 8000;
  config.SQ_PLUGINS = ['kw', 'kg', 'qq', 'netease'];
  config.SQ_BR_TYPE = '';
  // 自动增量扫描会真实跑起来；关掉外网源与 L3，避免测试依赖网络、并保证扫描秒级完成
  config.ONLINE_ENABLED = false;
  config.LLM_ENABLED = false;
  // 复刻 server.js 的启动顺序：先建目录再 load，否则扫描写分片会 ENOENT、db.meta 为 null
  config.ensureDirs();
  db.load();
  sq.resetClient();

  console.log('== 1. 登录取 token ==');
  const r1 = await sq.search('晴天', { plugName: 'kw' });
  eq('登录只发生一次', state.loginCount, 1);
  check('token 已缓存', sq.getClient().token === 'tok-1', sq.getClient().token);

  console.log('\n== 2. 搜索结果归一化 ==');
  eq('命中条数（脏数据已过滤）', r1.items.length, 2);
  eq('曲名', r1.items[0].name, '晴天');
  eq('歌手数组合并', r1.items[0].artist, '周杰伦');
  eq('专辑', r1.items[0].albumName, '叶惠美');
  eq('时长 ms → 秒', r1.items[0].durationSec, 269);
  eq('封面 URL', r1.items[0].picUrl, 'https://img.example.com/1001.jpg');
  eq('最高码率自动挑选', r1.items[0].defaultBrType, 'KW_FLAC_2000');
  eq('有歌词标记', r1.items[0].hasLyric, true);
  eq('缓存键', r1.items[0].key, 'kw:1001');
  eq('总数透传', r1.total, 2);
  eq('搜索参数带 plugName', state.searchCalls[0].plugName, 'kw');
  eq('搜索参数带 keyword', state.searchCalls[0].keyword, '晴天');

  console.log('\n== 3. 下载入队 ==');
  const dl = await sq.download({ key: 'kw:1001', brType: 'KW_FLAC_2000' });
  eq('入队状态', dl.status, 'waiting');
  eq('回传码率', dl.brType, 'KW_FLAC_2000');
  check('请求体是整条 record + brType',
    state.lastDownloadBody && state.lastDownloadBody.id === '1001' && state.lastDownloadBody.brType === 'KW_FLAC_2000',
    JSON.stringify(state.lastDownloadBody));
  check('record 原始字段透传（name/artistName/pic）',
    state.lastDownloadBody && state.lastDownloadBody.name === '晴天' &&
    Array.isArray(state.lastDownloadBody.artistName) && state.lastDownloadBody.pic !== undefined,
    JSON.stringify(state.lastDownloadBody));
  let cacheMiss = null;
  try { await sq.download({ key: 'kw:9999' }); } catch (e) { cacheMiss = e; }
  check('未知 key 报 400 而非崩溃', cacheMiss && cacheMiss.status === 400, cacheMiss && cacheMiss.message);

  console.log('\n== 4. 任务列表与进度（真实服务契约：POST + download* 字段）==');
  const tl = await sq.tasks();
  eq('用 POST 请求任务列表', state.taskListMethod, '');   // mock 仅在非 POST 时记录
  eq('请求体带 pageIndex', state.lastTaskListBody && state.lastTaskListBody.pageIndex, 1);
  eq('请求体带 pageSize', state.lastTaskListBody && state.lastTaskListBody.pageSize, 50);
  eq('任务条数', tl.items.length, 3);
  eq('服务端 total 透传（非 items.length）', tl.total, 4);
  eq('waiting 归一', tl.items[0].status, 'waiting');
  eq('success 归一', tl.items[1].status, 'success');
  eq('error 归一', tl.items[2].status, 'error');
  eq('统计 waiting', tl.counts.waiting, 1);
  eq('统计 success', tl.counts.success, 1);
  eq('统计 error', tl.counts.error, 1);

  // 字段名映射：真实服务是 download* 前缀
  eq('downloadMusicname → name', tl.items[0].name, '后来');
  eq('downloadArtistname → artist', tl.items[0].artist, '刘若英');
  eq('downloadAlbumname → album', tl.items[0].album, '2020 刘若英陪你 献上录音专辑');
  eq('downloadBrType → brType', tl.items[0].brType, 'kw_flac_2000');
  eq('失败原因透传（downloadMsg）', tl.items[2].message, '音源无版权');

  // GET 打 /api/task/list：HTTP 200 包业务码 500，客户端必须如实抛错
  let getErr = null;
  try { await sq.getClient()._request('GET', '/api/task/list'); } catch (e) { getErr = e; }
  check('GET 任务列表被识别为业务错误', !!getErr && getErr.code === 'business', getErr && getErr.message);
  check('错误信息含服务端原文', !!getErr && /not supported/.test(getErr.message), getErr && getErr.message);

  console.log('\n== 5. token 过期自动重登 ==');
  state.expireOnce = true;
  const r2 = await sq.search('Mojito', { plugName: 'kg' });
  eq('自动重登后登录次数 +1', state.loginCount, 2);
  eq('重登后搜索成功', r2.items.length, 2);
  check('token 已刷新', sq.getClient().token === 'tok-2', sq.getClient().token);
  const before = state.loginCount;
  await sq.tasks();
  eq('token 复用，不再重复登录', state.loginCount, before);

  console.log('\n== 6. 未启用时优雅降级（SQ_ENABLED=false）==');
  config.SQ_ENABLED = false;
  let disabledErr = null;
  try { await sq.search('晴天'); } catch (e) { disabledErr = e; }
  check('search 抛 disabled', disabledErr && disabledErr.code === 'disabled', disabledErr && disabledErr.message);
  eq('disabled 状态码 503', disabledErr && disabledErr.status, 503);

  const resStatus = fakeRes();
  sqApi.status(resStatus);
  const stBody = jsonOf(resStatus);
  eq('status 接口仍 200', resStatus.status, 200);
  eq('status.enabled=false', stBody && stBody.status && stBody.status.enabled, false);

  const resSearch = fakeRes();
  await sqApi.search(reqWithBody({ keyword: '晴天' }), resSearch);
  const sBody = jsonOf(resSearch);
  eq('search 接口返回 503', resSearch.status, 503);
  eq('search 接口错误码', sBody && sBody.code, 'disabled');
  check('提示文案明确', sBody && /未启用 SqMusic/.test(sBody.error || ''), sBody && sBody.error);

  const resDl = fakeRes();
  await sqApi.download(reqWithBody({ key: 'kw:1001' }), resDl);
  eq('download 接口返回 503', resDl.status, 503);

  const resTasks = fakeRes();
  await sqApi.tasks(resTasks);
  eq('tasks 接口返回 503', resTasks.status, 503);

  console.log('\n== 7. 路由层：/api/sqmusic/* 必须 Bearer 鉴权 ==');
  config.SQ_ENABLED = true;
  const { route } = require('../src/api/index');
  const noAuth = { headers: { accept: 'application/json' }, method: 'GET', socket: { remoteAddress: '192.168.2.1' }, url: '/api/sqmusic/status' };
  const outNoAuth = fakeRes();
  await route(noAuth, outNoAuth, 'GET', '/api/sqmusic/status', new URL('http://x/api/sqmusic/status'));
  eq('无 token → 401', outNoAuth.status, 401);

  const withAuth = { headers: { authorization: 'Bearer testtoken' }, method: 'GET', socket: { remoteAddress: '192.168.2.1' }, url: '/api/sqmusic/status' };
  const outOk = fakeRes();
  await route(withAuth, outOk, 'GET', '/api/sqmusic/status', new URL('http://x/api/sqmusic/status'));
  eq('有 token → 200', outOk.status, 200);
  const okBody = jsonOf(outOk);
  eq('status.enabled=true', okBody && okBody.status && okBody.status.enabled, true);

  console.log('\n== 8. 下载完成后自动增量扫描（触发判定）==');
  config.SQ_AUTO_SCAN = true;
  state.taskStatus = 'success';
  const first = await sq.tasks();
  eq('首次轮询只登记基线，不触发扫描', sqApi.maybeAutoScan(first.items), '');
  // 新增一个成功任务 → 应触发（返回 'pending'，表示异步启动中）
  const second = (await sq.tasks()).items.concat([{ id: 't-new', status: 'success' }]);
  const triggered = sqApi.maybeAutoScan(second);
  check('新完成任务触发扫描', triggered === 'pending' || /^run_/.test(String(triggered)), String(triggered));
  eq('冷却期内不重复触发', sqApi.maybeAutoScan([{ id: 't-new2', status: 'success' }]), '');

  console.log('\n== 9. seenSuccess 有界（超上限淘汰最早的一半）==');
  // 等上一节触发的扫描收尾，避免 st.running 干扰本次触发判定
  const scanTaskRef = require('../src/scan/task');
  for (let i = 0; i < 60 && scanTaskRef.status().running; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // 重新加载模块：拿到全新的 primed / lastAutoScanAt / seenSuccess
  delete require.cache[require.resolve('../src/api/sqmusic')];
  const sqApi2 = require('../src/api/sqmusic');

  const many = [];
  for (let i = 0; i < 6000; i++) many.push({ id: 'x' + i, status: 'success' });

  eq('基线登记不触发扫描', sqApi2.maybeAutoScan([]), '');
  config.SQ_AUTO_SCAN = false;               // 先关触发，只做登记 + 淘汰
  eq('灌入 6000 条成功任务时仍不触发', sqApi2.maybeAutoScan(many), '');
  config.SQ_AUTO_SCAN = true;
  // 若淘汰生效：最早加入的一半已被丢弃 → 再次喂入会重新判为「新完成」→ 触发
  // 若集合无界：全部 id 仍在集合内 → fresh 为空 → 返回 ''
  const again = sqApi2.maybeAutoScan(many);
  check('超出上限后淘汰最早的一半（集合有界）',
    again === 'pending' || /^run_/.test(String(again)), '实际=' + String(again));

  server.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常终止：', e && e.stack ? e.stack : e);
  process.exit(1);
});
