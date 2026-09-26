'use strict';
/**
 * QA 审计 —— 对外开放 API v1 SqMusic 子集（/api/v1/sqmusic/*）独立验收
 *
 * 方法：起真 TunePick 服务 + 起一个「假 SqMusic 上游」，两个进程件走真实 socket。
 *   之所以要假上游：环境里没有真实 SqMusic 实例，但要验的是 **v1-sq 的协议转换**，
 *   业务由 src/service/sqmusic.js 真实执行，只把最外层 HTTP 换成可控桩。
 *   这样能验到「pagination manual / 状态翻译 / 错误码映射 / 曲库配对」这些真逻辑，
 *   而不是对着假 res 自欺欺人。
 *
 * 覆盖：
 *   A. 鉴权：8 端点 ×（无令牌 / 错误令牌）→ 401
 *   B. status：启用态字段 + 下载目录
 *   C. search：q 校验、服务端分页不二次切片、pageSize/pageIndex 正确下发、plugName 透传
 *   D. preview：凭搜索缓存 key 取直链；缺 key / 脏 JSON / 过期 key
 *   E. download：凭 key 下发；过期 key → CACHE_EXPIRED（不是 500）
 *   F. tasks：counts 词汇（running 而非 downloading）、两个名字都收、派生值、筛选不影响角标
 *   G. downloaded：all=1 翻页拉全、all=0 单页、counts 口径、曲库配对回填
 *   H. test（ping）
 *   I. rescan：未跑 → started:true；已在跑 → 200 started:false（不报错）
 *   J. 错误映射：no-url → 502；http/business/parse → 500（pending lead 是否统一 502）
 *   K. 降级：SQ_ENABLED=false → status 仍 200，其余一律 503 SQMUSIC_DISABLED（含未知路径）
 *   L. not-configured（缺 SQ_BASE_URL）也必须 503，不许漏成 500
 *   M. 回归 + 零依赖
 *
 * 运行：node tests/qa-v1-sqmusic.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
process.env.MUSIC_DIR = require('path').join(__dirname, '..', '.tmp-qa-v1sq', 'music-notexist');
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-qa-v1sq');
process.env.PORT = '18312';
process.env.LOG_LEVEL = 'error';

const UPSTREAM_PORT = 18421;
process.env.SQ_ENABLED = 'true';
process.env.SQ_BASE_URL = 'http://127.0.0.1:' + UPSTREAM_PORT;
process.env.SQ_USERNAME = 'admin';
process.env.SQ_PASSWORD = 'admin';
process.env.SQ_TIMEOUT_MS = '5000';

const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_DIR = process.env.DATA_DIR;
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}

/* ==========================================================================
 * 假 SqMusic 上游
 * ========================================================================== */
const state = {
  mode: 'ok',              // ok | http500 | biz | html | noUrl
  searchCalls: [],
  taskListCalls: [],
  cfgCalls: 0,
  versionCalls: 0,
  downloadCalls: 0,
  lastAuth: '',
};

function upstreamBodyHandler(u, body) {
  switch (body) {
    case 'biz': return { s: 200, j: { code: 500, msg: '上游业务炸了' } };
    case 'html': return { s: 200, t: '<html><body>not json</body></html>' };
    case 'http500': return { s: 500, j: { code: 500, msg: 'boom' } };
    default: return null;
  }
}

const SONGS = [];
for (let i = 1; i <= 25; i++) {
  SONGS.push({
    id: 'sg' + i,
    name: '搜索歌曲' + i,
    artistName: ['歌手' + i],
    albumName: '专辑' + i,
    albumId: 'al' + i,
    pic: 'http://mock/pic/' + i + '.jpg',
    duration: 240000 + i * 1000,
    brTypes: ['KW_MP3_128', 'KW_MP3_320', 'KW_FLAC_2000'],
    lyric: 'lrc' + i,
  });
}

/** 混合任务：waiting 1 / downloading 2 / success 2 / error 1 */
const TASKS_MIXED = [
  { id: '1', downloadStatus: 'waiting', downloadMusicname: '等待曲目', downloadArtistname: '等待歌手', downloadAlbumname: '等待专辑', downloadBrType: 'KW_MP3_320', downloadMsg: '', downloadTime: '2026-01-01T00:00:00.000Z', downloadUpdateTime: '2026-01-01T00:00:00.000Z' },
  { id: '2', downloadStatus: 'downloading', downloadMusicname: '下载中曲目', downloadArtistname: '下载中歌手', downloadAlbumname: '', downloadBrType: 'KW_MP3_320', progress: 42, downloadTime: '2026-01-01T00:00:00.000Z', downloadUpdateTime: '2026-01-01T00:00:10.000Z' },
  { id: '4', downloadStatus: 'success', downloadMusicname: '后来', downloadArtistname: '刘若英', downloadAlbumname: '后来', downloadBrType: 'KW_MP3_320', downloadMusicInfo: JSON.stringify({ duration: 300 }), downloadTime: '2026-01-01T00:00:00.000Z', downloadUpdateTime: '2026-01-01T00:00:30.000Z' },
  { id: '5', downloadStatus: 'success', downloadMusicname: '天空', downloadArtistname: '王菲', downloadAlbumname: '唱游', downloadBrType: 'KW_MP3_320', downloadMusicInfo: JSON.stringify({ duration: 200 }), downloadTime: '1767225600', downloadUpdateTime: '1767225645' },
  { id: '6', downloadStatus: 'error', downloadMusicname: '失败曲目', downloadArtistname: '失败歌手', downloadAlbumname: '', downloadBrType: 'KW_MP3_128', downloadMsg: '下载失败：版权限制', downloadTime: '2026-01-01T00:00:00.000Z', downloadUpdateTime: '2026-01-01T00:00:05.000Z' },
  { id: '7', downloadStatus: 'downloading', downloadMusicname: '第二个下载中', downloadArtistname: '', downloadAlbumname: '', downloadBrType: 'KW_FLAC_2000', downloadTime: '2026-01-01T00:00:00.000Z', downloadUpdateTime: '2026-01-01T00:00:20.000Z' },
];

/** 成功任务 120 条（供 downloaded 翻页拉全）：前两条刻意与本地曲库同名可配对 */
const TASKS_SUCCESS = [];
for (let i = 1; i <= 120; i++) {
  TASKS_SUCCESS.push({
    id: 'dl' + i,
    downloadStatus: 'success',
    downloadMusicname: i === 1 ? '天空' : (i === 2 ? '后来' : '下载曲目' + i),
    downloadArtistname: i === 1 ? '王菲' : (i === 2 ? '刘若英' : 'Mock歌手'),
    downloadAlbumname: 'Mock专辑',
    downloadBrType: 'KW_MP3_128',
    downloadTime: '2026-01-0' + (i % 9 + 1) + 'T00:00:00.000Z',
    downloadUpdateTime: '2026-01-0' + (i % 9 + 1) + 'T00:00:15.000Z',
  });
}

function readJsonReq(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { resolve({}); }
    });
  });
}

function sendUp(res, status, obj, text) {
  const t = text !== undefined ? text : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(t) });
  res.end(t);
}

const upstream = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://upstream');
  if (req.headers.sqmusic) state.lastAuth = String(req.headers.sqmusic);

  if (u.pathname === '/api/config/login') {
    return sendUp(res, 200, { code: 200, msg: 'ok', data: { tokenValue: 'mock-token', tokenName: 'sqmusic' } });
  }
  if (u.pathname === '/api/config/version') {
    state.versionCalls++;
    const bad = upstreamBodyHandler(u, state.mode);
    if (bad) return sendUp(res, bad.s, bad.j, bad.t);
    return sendUp(res, 200, { code: 200, data: { version: '9.9.9' } });
  }
  if (u.pathname === '/api/config/getConfigList') {
    state.cfgCalls++;
    const bad = upstreamBodyHandler(u, state.mode);
    if (bad) return sendUp(res, bad.s, bad.j, bad.t);
    return sendUp(res, 200, {
      code: 200,
      data: { records: [{ configKey: 'system.download.path', configValue: '/mnt/music/downloads' }] },
    });
  }
  if (u.pathname === '/api/music/searchSong') {
    const bad = upstreamBodyHandler(u, state.mode);
    if (bad) return sendUp(res, bad.s, bad.j, bad.t);
    const pageSize = parseInt(u.searchParams.get('pageSize'), 10) || 20;
    const pageIndex = parseInt(u.searchParams.get('pageIndex'), 10) || 1;
    state.searchCalls.push({
      plugName: u.searchParams.get('plugName'),
      keyword: u.searchParams.get('keyword'),
      pageSize, pageIndex,
    });
    const pool = u.searchParams.get('keyword') === 'nomatch' ? [] : SONGS;
    const slice = pool.slice((pageIndex - 1) * pageSize, (pageIndex - 1) * pageSize + pageSize);
    return sendUp(res, 200, { code: 200, data: { searchTotal: pool.length, records: slice } });
  }
  if (u.pathname === '/api/download/downloadSong') {
    state.downloadCalls++;
    const bad = upstreamBodyHandler(u, state.mode);
    if (bad) return sendUp(res, bad.s, bad.j, bad.t);
    return sendUp(res, 200, { code: 200, data: { downloadStatus: 'waiting' } });
  }
  if (u.pathname === '/api/task/list') {
    if (req.method !== 'POST') return sendUp(res, 200, { code: 500, msg: "Request method 'GET' not supported" });
    const body = await readJsonReq(req);
    const bad = upstreamBodyHandler(u, state.mode);
    if (bad) return sendUp(res, bad.s, bad.j, bad.t);
    const pageIndex = parseInt(body.pageIndex, 10) || 1;
    const pageSize = parseInt(body.pageSize, 10) || 50;
    state.taskListCalls.push({ pageIndex, pageSize, downloadStatus: body.downloadStatus || '' });
    const pool = body.downloadStatus === 'success' ? TASKS_SUCCESS : TASKS_MIXED;
    const slice = pool.slice((pageIndex - 1) * pageSize, (pageIndex - 1) * pageSize + pageSize);
    return sendUp(res, 200, { code: 200, data: { records: slice, total: pool.length } });
  }
  if (u.pathname === '/api/music/getDownloadUrl') {
    const bad = upstreamBodyHandler(u, state.mode);
    if (bad) return sendUp(res, bad.s, bad.j, bad.t);
    if (state.mode === 'noUrl') return sendUp(res, 200, { code: 200, data: {} });
    return sendUp(res, 200, { code: 200, data: { url: 'http://mock/play.mp3', plugBrTypeId: 'KW_MP3_320', bit: '320' } });
  }
  return sendUp(res, 404, { code: 404, msg: 'no such upstream api' });
});

/* ==========================================================================
 * TunePick 侧请求helper
 * ========================================================================== */
const PORT = 18312;
function request(p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
    if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p,
      method: opts.method || 'GET', headers, timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* ignore */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('QA 请求超时')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const BEARER = { authorization: 'Bearer testtoken' };
const get = (p) => request(p, { headers: BEARER });
const post = (p, body) => request(p, { method: 'POST', headers: BEARER, body });

const isOkEnv = (r) => !!r.json && r.json.ok === true && 'data' in r.json && r.json.error === undefined;
const isErrEnv = (r, code) => !!r.json && r.json.ok === false && !!r.json.error
  && (!code || r.json.error.code === code) && typeof r.json.error.message === 'string';

(async () => {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));
  console.log('\n== 0. 起服务（假 SqMusic 上游 :' + UPSTREAM_PORT + '）==');
  const config = require('../src/config');
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));
  const db = require('../src/store/db');
  const sq = require('../src/service/sqmusic');

  const mkTrack = (id, o) => Object.assign({
    id, filePath: '/music/' + id + '.mp3', fileName: id + '.mp3', fileSizeBytes: 5 * 1024 * 1024,
    title: id, cleanTitle: id, artist: '未知歌手', cleanArtist: '未知歌手', album: '',
    albumGroup: 'unknown', albumIsPlaceholder: true, year: 0, durationSec: 240, trackNo: 1,
    format: 'mp3', bitrate: 320, sampleRate: 44100, genre: '其他', mood: [], scene: [],
    lang: '国语', era: '未知', qualityLevel: 'high', confidence: 90, coverId: '', needReview: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }, o);
  db.upsert(mkTrack('tp_sq1', { title: '天空', cleanTitle: '天空', artist: '王菲', cleanArtist: '王菲', album: '唱游', albumGroup: 'real', albumIsPlaceholder: false, coverId: 'cv_sq1' }));
  db.upsert(mkTrack('tp_sq2', { title: '后来', cleanTitle: '后来', artist: '刘若英', cleanArtist: '刘若英', album: '后来', albumGroup: 'real', albumIsPlaceholder: false }));
  db.upsert(mkTrack('tp_sq3', { title: '无关曲目', cleanTitle: '无关曲目', artist: '无关歌手', cleanArtist: '无关歌手' }));
  ok('本地曲库播种 3 首（用于配对验证）', db.size() === 3, 'size=' + db.size());

  /* =====================================================================
   * A. 鉴权矩阵
   * ===================================================================== */
  console.log('\n== A. 鉴权矩阵（8 端点）==');
  const EPS = [
    ['GET', '/api/v1/sqmusic/status'],
    ['POST', '/api/v1/sqmusic/search'],
    ['POST', '/api/v1/sqmusic/preview'],
    ['POST', '/api/v1/sqmusic/download'],
    ['GET', '/api/v1/sqmusic/tasks'],
    ['GET', '/api/v1/sqmusic/downloaded'],
    ['POST', '/api/v1/sqmusic/test'],
    ['POST', '/api/v1/sqmusic/rescan'],
  ];
  for (const [m, p] of EPS) {
    const anon = await request(p, { method: m, body: m === 'POST' ? '{}' : null });
    const bad = await request(p, { method: m, headers: { authorization: 'Bearer wrong' }, body: m === 'POST' ? '{}' : null });
    ok(`${m} ${p} 无令牌 → 401`, anon.status === 401, String(anon.status));
    ok(`${m} ${p} 错误令牌 → 401`, bad.status === 401, String(bad.status));
    ok(`${m} ${p} 401 体不含 ok:true`,
      !(anon.json && anon.json.ok === true) && !(bad.json && bad.json.ok === true), JSON.stringify(anon.json));
  }
  const cookieOnly = await request('/api/v1/sqmusic/status', { headers: { cookie: 'tp_token=testtoken' } });
  ok('仅 Cookie（无 Bearer）→ 401', cookieOnly.status === 401, String(cookieOnly.status));

  /* =====================================================================
   * B. status
   * ===================================================================== */
  console.log('\n== B. GET /status ==');
  const st = await get('/api/v1/sqmusic/status');
  ok('status → 200 + 成功信封', st.status === 200 && isOkEnv(st), String(st.status) + ' ' + st.text.slice(0, 140));
  const S = st.json.data;
  ok('enabled=true（已启用）', S.enabled === true, JSON.stringify(S));
  ok('baseUrl 回显配置值', String(S.baseUrl).includes('18421'), String(S.baseUrl));
  ok('downloadPath 取自上游 getConfigList', S.downloadPath === '/mnt/music/downloads', JSON.stringify(S));
  ok('downloadPathError 为空', S.downloadPathError === '', JSON.stringify(S));
  ok('plugins 是数组、pluginLabels 是对象',
    Array.isArray(S.plugins) && S.plugins.length > 0 && !!S.pluginLabels && typeof S.pluginLabels === 'object',
    JSON.stringify({ plugins: S.plugins, labels: S.pluginLabels }));
  ok('autoScan / loggedIn 是布尔', typeof S.autoScan === 'boolean' && typeof S.loggedIn === 'boolean',
    JSON.stringify({ autoScan: S.autoScan, loggedIn: S.loggedIn }));

  /* =====================================================================
   * C. search
   * ===================================================================== */
  console.log('\n== C. POST /search ==');
  const s1 = await post('/api/v1/sqmusic/search', '{"q":"晴天"}');
  ok('search → 200 + 成功信封', s1.status === 200 && isOkEnv(s1), String(s1.status) + ' ' + s1.text.slice(0, 160));
  ok('默认 pageSize=20', s1.json.data.pagination.limit === 20, String(s1.json.data.pagination.limit));
  ok('items 20 条 / total 25（上游 searchTotal）',
    s1.json.data.items.length === 20 && s1.json.data.pagination.total === 25,
    JSON.stringify(s1.json.data.pagination));
  ok('hasMore=true（25 > 20）', s1.json.data.pagination.hasMore === true, String(s1.json.data.pagination.hasMore));
  ok('**服务端分页不二次切片**：page=1&limit=2 → items 2 条且 total 仍是 25',
    (await post('/api/v1/sqmusic/search', '{"q":"晴天","limit":2}')).json.data.items.length === 2
    && (await post('/api/v1/sqmusic/search', '{"q":"晴天","limit":2}')).json.data.pagination.total === 25,
    'items 被二次切没了 / total 不对');
  const s2 = await post('/api/v1/sqmusic/search', '{"q":"晴天","limit":2,"page":2}');
  ok('page=2&limit=2 → pageIndex 2 / offset 2 / items 2',
    s2.json.data.pagination.page === 2 && s2.json.data.pagination.offset === 2 && s2.json.data.items.length === 2,
    JSON.stringify(s2.json.data.pagination));
  const s3 = await post('/api/v1/sqmusic/search', '{"q":"晴天","limit":2,"offset":4}');
  ok('offset=4&limit=2 → 换算成 pageIndex 3', s3.json.data.pagination.page === 3 && s3.json.data.pagination.offset === 4,
    JSON.stringify(s3.json.data.pagination));
  ok('page 覆盖 offset：page=3&offset=0&limit=2 → pageIndex 3',
    (await post('/api/v1/sqmusic/search', '{"q":"晴天","limit":2,"page":3,"offset":0}')).json.data.pagination.page === 3,
    'page 未覆盖 offset');
  const lastSearch = state.searchCalls[state.searchCalls.length - 1];
  ok('pageSize / pageIndex 真的下发到上游',
    lastSearch.pageSize === 2 && lastSearch.pageIndex === 3, JSON.stringify(lastSearch));
  const limTests = [
    ['{"q":"晴天","limit":999}', 50, 'limit=999 → 夹到 50'],
    ['{"q":"晴天","limit":0}', 1, 'limit=0 → 夹到 1'],
    ['{"q":"晴天","limit":-3}', 1, 'limit=-3 → 夹到 1'],
  ];
  for (const [body, want, name] of limTests) {
    const r = await post('/api/v1/sqmusic/search', body);
    ok(name, r.json && r.json.data && r.json.data.pagination.limit === want, String(r.json && r.json.data && r.json.data.pagination.limit));
  }
  const plug = await post('/api/v1/sqmusic/search', '{"q":"晴天","limit":2,"plugName":"kg"}');
  ok('plugName 透传 + pluginLabel 用统一词典',
    plug.json.data.plugName === 'kg' && plug.json.data.pluginLabel === sq.PLUGIN_LABELS.kg,
    JSON.stringify({ plugName: plug.json.data.plugName, label: plug.json.data.pluginLabel }));
  const song = s1.json.data.items[0];
  ok('songLite 含 key（后续试听/下载的凭据）', !!song.key, JSON.stringify(song));
  ok('songLite 字段齐全',
    ['key', 'songId', 'title', 'name', 'artist', 'artists', 'album', 'albumId', 'coverUrl', 'durationSec', 'brTypes', 'defaultBrType', 'plugName', 'hasLyric']
      .every((k) => k in song), JSON.stringify(Object.keys(song)));
  ok('durationSec 由毫秒换算（240000 → 240）', song.durationSec === 241, String(song.durationSec));
  const noQ = await post('/api/v1/sqmusic/search', '{"foo":1}');
  ok('缺 q → 400 MISSING_QUERY', noQ.status === 400 && isErrEnv(noQ, 'MISSING_QUERY'), String(noQ.status) + ' ' + noQ.text.slice(0, 140));
  const blankQ = await post('/api/v1/sqmusic/search', '{"q":"   "}');
  ok('q 纯空格 → 400 MISSING_QUERY', blankQ.status === 400 && isErrEnv(blankQ, 'MISSING_QUERY'), String(blankQ.status));
  const kwAlias = await post('/api/v1/sqmusic/search', '{"keyword":"晴天","limit":1}');
  ok('keyword 作为 q 的别名也能用', kwAlias.status === 200 && kwAlias.json.data.items.length === 1, String(kwAlias.status));
  const badJson = await post('/api/v1/sqmusic/search', '这不是 JSON');
  ok('非 JSON 体 → 400 INVALID_PARAM（不是 500）',
    badJson.status === 400 && isErrEnv(badJson, 'INVALID_PARAM'), String(badJson.status));
  const emptyBody = await post('/api/v1/sqmusic/search', '');
  ok('空体 → 400 INVALID_PARAM', emptyBody.status === 400 && isErrEnv(emptyBody, 'INVALID_PARAM'), String(emptyBody.status));
  const zero = await post('/api/v1/sqmusic/search', '{"q":"nomatch","limit":5}');
  ok('0 命中 → 200 + items:[] + total 0（不是 404）',
    zero.status === 200 && zero.json.data.items.length === 0 && zero.json.data.pagination.total === 0,
    JSON.stringify(zero.json.data.pagination));

  /* =====================================================================
   * D. preview
   * ===================================================================== */
  console.log('\n== D. POST /preview ==');
  const key = s1.json.data.items[0].key;
  const pv = await post('/api/v1/sqmusic/preview', JSON.stringify({ key }));
  ok('preview（搜索缓存 key）→ 200 + url', pv.status === 200 && isOkEnv(pv) && !!pv.json.data.url,
    String(pv.status) + ' ' + pv.text.slice(0, 160));
  ok('返回 brType / bit / key 回显 / ttlHint',
    !!pv.json.data.brType && typeof pv.json.data.ttlHint === 'string' && pv.json.data.key === key,
    JSON.stringify(pv.json.data));
  const pvNoKey = await post('/api/v1/sqmusic/preview', '{"brType":"KW_MP3_320"}');
  ok('缺 key → 400 INVALID_PARAM', pvNoKey.status === 400 && isErrEnv(pvNoKey, 'INVALID_PARAM'), String(pvNoKey.status));
  const pvBad = await post('/api/v1/sqmusic/preview', 'not-json{{');
  ok('非 JSON 体 → 400 INVALID_PARAM', pvBad.status === 400 && isErrEnv(pvBad, 'INVALID_PARAM'), String(pvBad.status));
  const pvStale = await post('/api/v1/sqmusic/preview', '{"key":"no-such:999999"}');
  ok('过期/未知 key → 400 CACHE_EXPIRED（不是 500）',
    pvStale.status === 400 && isErrEnv(pvStale, 'CACHE_EXPIRED'), String(pvStale.status) + ' ' + pvStale.text.slice(0, 160));

  /* =====================================================================
   * E. download
   * ===================================================================== */
  console.log('\n== E. POST /download ==');
  const before = state.downloadCalls;
  const dl = await post('/api/v1/sqmusic/download', JSON.stringify({ key }));
  ok('download（有效 key）→ 200 + accepted:true', dl.status === 200 && isOkEnv(dl) && dl.json.data.accepted === true,
    String(dl.status) + ' ' + dl.text.slice(0, 160));
  ok('download 真的打到上游 downloadSong', state.downloadCalls === before + 1, String(state.downloadCalls));
  ok('download 回显 key + 提示语',
    dl.json.data.key === key && typeof dl.json.data.hint === 'string' && dl.json.data.hint.length > 0,
    JSON.stringify(dl.json.data));
  const dlNoKey = await post('/api/v1/sqmusic/download', '{}');
  ok('缺 key → 400 INVALID_PARAM', dlNoKey.status === 400 && isErrEnv(dlNoKey, 'INVALID_PARAM'), String(dlNoKey.status));
  const dlStale = await post('/api/v1/sqmusic/download', '{"key":"ghost:1"}');
  ok('过期 key → 400 CACHE_EXPIRED（不会白打上游）',
    dlStale.status === 400 && isErrEnv(dlStale, 'CACHE_EXPIRED') && state.downloadCalls === before + 1,
    String(dlStale.status));

  /* =====================================================================
   * F. tasks
   * ===================================================================== */
  console.log('\n== F. GET /tasks ==');
  const tk = await get('/api/v1/sqmusic/tasks');
  ok('tasks → 200 + 列表信封', tk.status === 200 && isOkEnv(tk) && Array.isArray(tk.json.data.items),
    String(tk.status) + ' ' + tk.text.slice(0, 160));
  const T = tk.json.data;
  ok('counts 用 v1 词汇 {waiting,running,success,error}',
    ['waiting', 'running', 'success', 'error'].every((k) => k in T.counts) && !('downloading' in T.counts),
    JSON.stringify(T.counts));
  ok('counts 数值正确（1/2/2/1）',
    T.counts.waiting === 1 && T.counts.running === 2 && T.counts.success === 2 && T.counts.error === 1,
    JSON.stringify(T.counts));
  ok('服务层的 downloading 被翻译成 running（不再对外暴露 downloading）',
    T.items.filter((x) => x.status === 'downloading').length === 0
    && T.items.filter((x) => x.status === 'running').length === 2,
    JSON.stringify(T.items.map((x) => x.status)));
  ok('autoScan 字段存在且是布尔', !!T.autoScan && typeof T.autoScan.enabled === 'boolean', JSON.stringify(T.autoScan));
  ok('默认 limit=50', T.pagination.limit === 50, String(T.pagination.limit));
  ok('items 6 条 / total 6', T.items.length === 6 && T.pagination.total === 6, JSON.stringify(T.pagination));

  const succ = T.items.find((x) => x.title === '后来');
  ok('派生值 sizeBytesEst：320kbps × 300s = 12,000,000', succ && succ.sizeBytesEst === 12000000,
    succ ? String(succ.sizeBytesEst) : '未找到');
  ok('派生值 elapsedSec：ISO 时间相差 30s', succ && succ.elapsedSec === 30, succ ? String(succ.elapsedSec) : '未找到');
  ok('派生值 speedBpsEst：12,000,000 / 30 = 400,000', succ && succ.speedBpsEst === 400000,
    succ ? String(succ.speedBpsEst) : '未找到');
  const numTs = T.items.find((x) => x.title === '天空');
  ok('秒级时间戳也能算出耗时（45s）', numTs && numTs.elapsedSec === 45, numTs ? String(numTs.elapsedSec) : '未找到');
  const err = T.items.find((x) => x.status === 'error');
  ok('失败任务带回 message（downloadMsg）', err && err.message === '下载失败：版权限制', err ? err.message : '未找到');
  const running2 = T.items.find((x) => x.status === 'running' && x.title === '下载中曲目');
  ok('running 任务带回 progress', running2 && running2.progress === 42, running2 ? String(running2.progress) : '未找到');
  ok('未完成任务不给 speedBpsEst（避免编造速度）',
    T.items.filter((x) => x.status !== 'success').every((x) => x.speedBpsEst === 0),
    JSON.stringify(T.items.map((x) => ({ s: x.status, v: x.speedBpsEst }))));
  ok('**成功任务 elapsedSec 必须 > 0**（时间格式一旦解析失败会静默退化成 0，只有这条能抓到）',
    T.items.filter((x) => x.status === 'success').length === 2
    && T.items.filter((x) => x.status === 'success').every((x) => x.elapsedSec > 0),
    JSON.stringify(T.items.filter((x) => x.status === 'success').map((x) => ({ t: x.title, e: x.elapsedSec }))));

  const fRun = await get('/api/v1/sqmusic/tasks?status=running');
  ok('?status=running → 2 条', fRun.json.data.items.length === 2, String(fRun.json.data.items.length));
  const fDl = await get('/api/v1/sqmusic/tasks?status=downloading');
  ok('?status=downloading（服务层旧名）等价 → 2 条',
    fDl.json.data.items.length === 2, String(fDl.json.data.items.length));
  ok('**counts 按过滤前统计**：筛选后角标不变',
    JSON.stringify(fRun.json.data.counts) === JSON.stringify(T.counts),
    JSON.stringify(fRun.json.data.counts) + ' vs ' + JSON.stringify(T.counts));
  const fOk = await get('/api/v1/sqmusic/tasks?status=success');
  ok('?status=success → 2 条', fOk.json.data.items.length === 2, String(fOk.json.data.items.length));
  const fBad = await get('/api/v1/sqmusic/tasks?status=no-such-status');
  ok('非法 status → 200 + items 空（不是 500）',
    fBad.status === 200 && fBad.json.data.items.length === 0, String(fBad.status));

  /* =====================================================================
   * G. downloaded
   * ===================================================================== */
  console.log('\n== G. GET /downloaded ==');
  state.taskListCalls.length = 0;
  const d1 = await get('/api/v1/sqmusic/downloaded');
  ok('downloaded（默认 all=1）→ 200 + 列表信封', d1.status === 200 && isOkEnv(d1), String(d1.status) + ' ' + d1.text.slice(0, 160));
  const D = d1.json.data;
  ok('all=1 翻页拉全：上游被调 3 次（50+50+20=120）',
    state.taskListCalls.length === 3, String(state.taskListCalls.length));
  // all=1 的意义是「把全量拉回来，好把 counts 算准」；响应本身仍按 limit=50 分页
  ok('all=1：响应仍按 limit=50 分页（items 50 / total 120 / hasMore true）',
    D.items.length === 50 && D.pagination.total === 120 && D.pagination.hasMore === true,
    JSON.stringify(D.pagination) + ' items=' + D.items.length);
  ok('counts.total = 120（上游口径）', D.counts.total === 120, String(D.counts.total));
  ok('曲库配对：2 条命中 / 118 条未入库',
    D.counts.inLibrary === 2 && D.counts.notInLibrary === 118, JSON.stringify(D.counts));
  const inLib = D.items.find((x) => x.inLibrary);
  ok('命中项回填 trackId / filePath / streamUrl / coverUrl',
    inLib && inLib.inLibrary === true && !!inLib.trackId && !!inLib.filePath
    && inLib.streamUrl === '/api/stream/' + inLib.trackId && inLib.coverUrl !== '',
    JSON.stringify(inLib));
  ok('未入库项不编造 trackId（空串）',
    D.items.filter((x) => !x.inLibrary).every((x) => x.trackId === '' && x.filePath === '' && x.streamUrl === ''),
    '出现了非空 trackId');
  ok('downloadPath 一并返回', D.downloadPath === '/mnt/music/downloads', String(D.downloadPath));

  state.taskListCalls.length = 0;
  const d0 = await get('/api/v1/sqmusic/downloaded?all=0');
  ok('all=0 → 只调上游 1 次', state.taskListCalls.length === 1, String(state.taskListCalls.length));
  ok('all=0 → 本页 50 条', d0.json.data.items.length === 50 && d0.json.data.pagination.total === 50,
    JSON.stringify(d0.json.data.pagination));
  ok('all=0 时 pagination.total(50) 与 counts.total(120) 口径不同 —— 按现状钉死（文档已声明）',
    d0.json.data.pagination.total === 50 && d0.json.data.counts.total === 120,
    JSON.stringify({ p: d0.json.data.pagination.total, c: d0.json.data.counts.total }));
  const dq = await get('/api/v1/sqmusic/downloaded?q=' + encodeURIComponent('天空'));
  ok('q 过滤生效 → 1 条', dq.json.data.items.length === 1, String(dq.json.data.items.length));
  ok('q 过滤后 counts 仍按过滤前统计', dq.json.data.counts.total === 120, JSON.stringify(dq.json.data.counts));

  /* =====================================================================
   * H. test（ping）
   * ===================================================================== */
  console.log('\n== H. POST /test ==');
  const beforeV = state.versionCalls;
  const te = await post('/api/v1/sqmusic/test', '');
  ok('test → 200 + ok:true', te.status === 200 && isOkEnv(te) && te.json.data.ok === true,
    String(te.status) + ' ' + te.text.slice(0, 160));
  ok('真的探了 /api/config/version', state.versionCalls === beforeV + 1, String(state.versionCalls));
  ok('回显 baseUrl + latencyMs 数值',
    String(te.json.data.baseUrl).includes('18421') && typeof te.json.data.latencyMs === 'number',
    JSON.stringify(te.json.data));

  /* =====================================================================
   * I. rescan
   * ===================================================================== */
  console.log('\n== I. POST /rescan ==');
  const scanTask = require('../src/scan/task');
  // 白盒注入「已有扫描在跑」：必须同时给 state 和一个 run 快照，
  // 因为 task.status() 在 run 为空时会直接返回 running:false（见 scan/task.js:45）
  const realState = scanTask.state;
  const realRun = scanTask.run;
  scanTask.state = 'running';
  scanTask.run = {
    taskId: 'run_qa_inject', startedAt: Date.now(), done: 0, total: 0,
    failed: 0, mode: 'incremental', stage: 'reading', counters: {},
  };
  const rs2 = await post('/api/v1/sqmusic/rescan', '');
  scanTask.state = realState;
  scanTask.run = realRun;
  ok('已有扫描在跑 → 200 + started:false（不报错、不重复启动）',
    rs2.status === 200 && isOkEnv(rs2) && rs2.json.data.started === false && !!rs2.json.data.reason,
    String(rs2.status) + ' ' + rs2.text.slice(0, 160));
  ok('重复调用没有真的启动扫描（state/run 仍是原值）',
    scanTask.state === realState && scanTask.run === realRun, scanTask.state);

  const rs1 = await post('/api/v1/sqmusic/rescan', '');
  ok('无扫描在跑 → 200 + started:true + taskId',
    rs1.status === 200 && isOkEnv(rs1) && rs1.json.data.started === true && !!rs1.json.data.taskId,
    String(rs1.status) + ' ' + rs1.text.slice(0, 160));
  try { scanTask.cancel(); } catch (_) { /* 收尾，避免后台任务拖着 */ }
  await new Promise((r) => setTimeout(r, 200));
  ok('rescan 不改动既有曲库（保护已入库数据）', db.size() === 3, 'size=' + db.size());

  /* =====================================================================
   * J. 错误映射
   * ===================================================================== */
  console.log('\n== J. 上游故障 → v1 错误码（lead 裁决：统一 502 UPSTREAM_ERROR）==');
  // ⚠️ preview 有 30s 缓存：必须换一个没取过直链的 key，否则打不到上游、复现不了故障
  const freshKey = s1.json.data.items[1].key;
  state.mode = 'noUrl';
  const mNoUrl = await post('/api/v1/sqmusic/preview', JSON.stringify({ key: freshKey }));
  ok('no-url（上游没给直链）→ 502 UPSTREAM_ERROR',
    mNoUrl.status === 502 && isErrEnv(mNoUrl, 'UPSTREAM_ERROR'), String(mNoUrl.status) + ' ' + mNoUrl.text.slice(0, 160));
  state.mode = 'ok';

  state.mode = 'http500';
  const mHttp = await get('/api/v1/sqmusic/tasks');
  ok('上游 HTTP 500 → 502 UPSTREAM_ERROR（不是伪装成我们的 500）',
    mHttp.status === 502 && isErrEnv(mHttp, 'UPSTREAM_ERROR'), String(mHttp.status) + ' ' + mHttp.text.slice(0, 160));
  state.mode = 'ok';

  state.mode = 'biz';
  const mBiz = await get('/api/v1/sqmusic/tasks');
  ok('上游业务错误体（code:500）→ 502 UPSTREAM_ERROR',
    mBiz.status === 502 && isErrEnv(mBiz, 'UPSTREAM_ERROR'), String(mBiz.status) + ' ' + mBiz.text.slice(0, 160));
  state.mode = 'ok';

  state.mode = 'html';
  const mParse = await get('/api/v1/sqmusic/tasks');
  ok('上游返回非 JSON → 502 UPSTREAM_ERROR（没有把 HTML 当成功）',
    mParse.status === 502 && isErrEnv(mParse, 'UPSTREAM_ERROR') && !/not json/.test(mParse.text),
    String(mParse.status) + ' ' + mParse.text.slice(0, 160));
  state.mode = 'ok';

  const afterFail = await get('/api/v1/sqmusic/tasks');
  ok('故障模式关掉后立刻自愈（不是持久污染）',
    afterFail.status === 200 && afterFail.json.data.items.length === 6, String(afterFail.status));

  /* =====================================================================
   * J2. 路由兜底：启用态才是 404，未启用态被降级闸门抢成 503（按状态分叉）
   * ===================================================================== */
  console.log('\n== J2. 启用态路由兜底：未知路径 / 方法不匹配 → 404 NOT_FOUND ==');
  for (const [m, p, label] of [
    ['GET', '/api/v1/sqmusic/no-such-api', '未知子路径'],
    ['GET', '/api/v1/sqmusic/search', 'POST-only 端点用 GET（方法不匹配）'],
    ['DELETE', '/api/v1/sqmusic/tasks', 'GET-only 端点用 DELETE'],
    ['PUT', '/api/v1/sqmusic/download', 'POST-only 端点用 PUT'],
  ]) {
    const r = await request(p, { method: m, headers: BEARER });
    ok(`启用态 ${label} → 404 NOT_FOUND 信封（不是 503 / 不是裸字符串）`,
      r.status === 404 && isErrEnv(r, 'NOT_FOUND'), String(r.status) + ' ' + r.text.slice(0, 140));
  }

  /* =====================================================================
   * J3. rescan 受理判定（P3 补丁）：不许谎报 started
   *
   * 白盒桩：直接替掉 scanTask.start 的返回值，模拟「被拒绝」的各种形状。
   * 之所以必须打桩：start() 被拒的状态今天靠自然时序几乎造不出来，
   * 而「换形状就又撒谎」恰恰是这条补丁要防的事，不打桩等于没测。
   * ===================================================================== */
  console.log('\n== J3. rescan 受理判定：被拒时不许报 started:true ==');
  const scanMod = require('../src/scan/task');
  const realStart = scanMod.start;
  const realSt = scanMod.state;

  /** 用桩替换 start 的返回形状，跑一次 rescan（跑完必还） */
  async function rescanWith(fakeRet) {
    scanMod.state = 'idle';                 // 保证先过 status() 闸门（running:false）
    scanMod.start = async () => fakeRet;
    try {
      return await post('/api/v1/sqmusic/rescan', '');
    } finally {
      scanMod.start = realStart;
      scanMod.state = realSt;
    }
  }

  const rReject = await rescanWith({ accepted: false, reason: '已有任务在运行中' });
  ok('① start() 明确拒绝（accepted:false）→ 200 + started:false + reason 非空',
    rReject.status === 200 && isOkEnv(rReject) && rReject.json.data.started === false
    && typeof rReject.json.data.reason === 'string' && rReject.json.data.reason.length > 0,
    String(rReject.status) + ' ' + rReject.text.slice(0, 160));
  ok('① 且不返回 taskId（不给客户端空 id 去轮询）',
    rReject.json.data.taskId === undefined || rReject.json.data.taskId === '',
    JSON.stringify(rReject.json.data));

  const rShape1 = await rescanWith({});
  const rShape2 = await rescanWith({ accepted: true, taskId: '' });
  ok('② start() 没给 taskId（换形状 {} / {accepted:true,taskId:""}）→ started:false + 兜底 reason',
    [rShape1, rShape2].every((r) => r.status === 200 && isOkEnv(r)
      && r.json.data.started === false && !!r.json.data.reason),
    JSON.stringify([rShape1.json.data, rShape2.json.data]));

  const rReal = await rescanWith({ accepted: true, taskId: 'run_qa_fake_123' });
  ok('③ 正常受理 → 200 + started:true + taskId 原样透出（未被改写）',
    rReal.status === 200 && isOkEnv(rReal) && rReal.json.data.started === true
    && rReal.json.data.taskId === 'run_qa_fake_123',
    String(rReal.status) + ' ' + rReal.text.slice(0, 160));
  ok('③ 受理成功时不返回 reason（成功态不夹带原因字段）',
    rReal.json.data.reason === undefined, JSON.stringify(rReal.json.data));
  ok('④ 打桩期间没有真的启动扫描（state/run 未被污染）',
    scanMod.state === realSt, scanMod.state);

  /* =====================================================================
   * K. 降级：SQ_ENABLED=false
   * ===================================================================== */
  console.log('\n== K. 未启用时的优雅降级 ==');
  config.SQ_ENABLED = false;
  const stOff = await get('/api/v1/sqmusic/status');
  ok('未启用 GET /status → 200 + enabled:false（预期状态，不是故障）',
    stOff.status === 200 && isOkEnv(stOff) && stOff.json.data.enabled === false,
    String(stOff.status) + ' ' + stOff.text.slice(0, 160));
  for (const [m, p] of EPS.filter(([, p2]) => p2 !== '/api/v1/sqmusic/status')) {
    const r = await request(p, { method: m, headers: BEARER, body: m === 'POST' ? '{}' : null });
    ok(`未启用 ${m} ${p} → 503 SQMUSIC_DISABLED（不是 500/崩溃）`,
      r.status === 503 && isErrEnv(r, 'SQMUSIC_DISABLED'), String(r.status) + ' ' + r.text.slice(0, 140));
  }
  const offUnknown = await get('/api/v1/sqmusic/no-such-api');
  ok('未启用 未知子路径 → 503（降级闸门在路由匹配之前，不是 404）',
    offUnknown.status === 503 && isErrEnv(offUnknown, 'SQMUSIC_DISABLED'), String(offUnknown.status));
  const offMethod = await request('/api/v1/sqmusic/tasks', { method: 'DELETE', headers: BEARER });
  ok('未启用 方法不匹配 → 503', offMethod.status === 503 && isErrEnv(offMethod, 'SQMUSIC_DISABLED'), String(offMethod.status));
  const offGetSearch = await request('/api/v1/sqmusic/search', { method: 'GET', headers: BEARER });
  ok('未启用 POST-only 端点用 GET → 503（同一请求在启用态是 404，分状态断言）',
    offGetSearch.status === 503 && isErrEnv(offGetSearch, 'SQMUSIC_DISABLED'), String(offGetSearch.status));
  const offAuth = await request('/api/v1/sqmusic/tasks', {});   // 注意：故意不带 Authorization
  ok('未启用时鉴权仍然生效（Authorization 缺失 → 401 而不是 503）',
    offAuth.status === 401, String(offAuth.status));
  for (const p of ['/api/v1/home', '/api/v1/tracks', '/api/v1/stats', '/api/v1/albums']) {
    const r = await get(p);
    ok(`未启用 既有 v1 端点 ${p} 仍 200`, r.status === 200, String(r.status));
  }
  config.SQ_ENABLED = true;

  /* =====================================================================
   * L. not-configured（缺 SQ_BASE_URL）也必须 503
   * ===================================================================== */
  console.log('\n== L. 缺 SQ_BASE_URL → 503 而非 500 ==');
  const origBase = config.SQ_BASE_URL;
  config.SQ_BASE_URL = '';
  sq.resetClient();
  const ncA = await get('/api/v1/sqmusic/tasks');
  const ncB = await post('/api/v1/sqmusic/search', '{"q":"晴天"}');
  ok('not-configured tasks → 503 SQMUSIC_DISABLED',
    ncA.status === 503 && isErrEnv(ncA, 'SQMUSIC_DISABLED'), String(ncA.status) + ' ' + ncA.text.slice(0, 140));
  ok('not-configured search → 503 SQMUSIC_DISABLED',
    ncB.status === 503 && isErrEnv(ncB, 'SQMUSIC_DISABLED'), String(ncB.status) + ' ' + ncB.text.slice(0, 140));
  const ncSt = await get('/api/v1/sqmusic/status');
  ok('not-configured status → 200 + enabled:true + baseUrl 空',
    ncSt.status === 200 && ncSt.json.data.enabled === true && ncSt.json.data.baseUrl === '',
    String(ncSt.status) + ' ' + JSON.stringify(ncSt.json.data));
  config.SQ_BASE_URL = origBase;
  sq.resetClient();
  const back = await get('/api/v1/sqmusic/tasks');
  ok('恢复配置后立即自愈', back.status === 200 && back.json.data.items.length === 6, String(back.status));

  /* =====================================================================
   * M. 回归 + 零依赖
   * ===================================================================== */
  console.log('\n== M. 回归 / 零依赖 ==');
  for (const [m, p] of [['GET', '/api/sqmusic/status'], ['GET', '/api/sqmusic/tasks'],
    ['GET', '/api/v1/home'], ['GET', '/api/v1/stats'], ['GET', '/api/albums'], ['GET', '/'],
    ['GET', '/discover.js']]) {
    const r = await request(p, { method: m, headers: BEARER });
    ok(`回归 ${m} ${p} → 200`, r.status === 200, String(r.status) + ' ' + r.text.slice(0, 100));
  }
  const v1sqSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'v1-sq.js'), 'utf8');
  const reqs = (v1sqSrc.match(/require\('([^']+)'\)/g) || []).map((x) => /require\('([^']+)'\)/.exec(x)[1]);
  ok('v1-sq.js 零第三方依赖（只 require 内置/相对模块）',
    reqs.every((r) => r.startsWith('.') || ['fs', 'path', 'http', 'https', 'net', 'tls', 'url', 'crypto'].includes(r)),
    JSON.stringify(reqs));
  ok('v1-sq.js 不使用全局 fetch', !/fetch\(/.test(v1sqSrc), '出现了 fetch(');
  const taskSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'scan', 'task.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  ok('回归：protectExisting 仍是 opt-in（rescan 显式传 true 才生效）',
    /if\s*\(\s*opts\.protectExisting\s*\)/.test(taskSrc) && !/protectExisting\s*[:=]\s*true\s*[,)]/.test(taskSrc),
    '默认值被改成 true');

  upstream.close();
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('\n失败清单：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('QA 脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
