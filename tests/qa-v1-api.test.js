'use strict';
/**
 * QA 审计 —— 对外开放 API v1（/api/v1/*）独立验收
 *
 * 立场：不看「有没有这个文件」，只看「wire 上返回了什么」。
 * 起真服务 + 真实 socket，曲库由本测试自己播种（不依赖 data/ 里的真实数据）。
 *
 * 覆盖：
 *   A. 空曲库：所有列表端点 200 + items:[]，绝不能 500
 *   B. 鉴权矩阵：21 个端点 ×（无令牌 / 错误令牌）→ 401（不用 /api/health 当判据）
 *   C. 信封契约：成功 {ok:true,data} / 失败 {ok:false,error:{code,message}}，错误码白名单
 *   D. home / tracks / 详情 / 分页器（limit 夹取 1..200、page 覆盖 offset）
 *   E. albums：id 必须与既有 /api/albums 同源同值（写死 al_64d3ce 防 hash 漂移）
 *   F. artists / genres / playlists（≥3 阈值行为，不是 bug）
 *   G. search：缺 q / 空白 q / 非法 type / type=all / type=track
 *   H. favorites 往返：幂等、addedAt 不被覆盖、不存在的曲目先 404 且不落脏数据
 *   I. history：plays 递增、distinct 有 playCount / raw 没有、清空、脏 JSON 400
 *   J. 落盘：原子写真的写进磁盘、不留 .tmp、reset 后重载一致
 *   K. 路径变形 / 编码绕过：不得泄露文件
 *   L. 回归：既有端点不受影响 + 零依赖 + /api/health 哨兵
 *   M. pager 单元：边界值
 *
 * 运行：node tests/qa-v1-api.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
// 只读自检：用一个不存在的音乐目录（writeFileSync 抛 ENOENT → 自检跳过，不阻塞）
process.env.MUSIC_DIR = require('path').join(__dirname, '..', '.tmp-qa-v1', 'music-notexist');
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-qa-v1');
process.env.PORT = '18311';
process.env.LOG_LEVEL = 'error';

const fs = require('fs');
const path = require('path');
const http = require('http');

// 干净起步：上一轮的用户数据/分片绝不能污染本轮
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

const PORT = 18311;

/** 真实 socket 请求（零依赖） */
function request(p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
    if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p,
      method: opts.method || 'GET', headers, timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* 非 JSON 也照收 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('QA 请求超时')));
    if (opts.body) req.write(opts.body);      // GET 不带 body（Node HTTP parser 会直接 400）
    req.end();
  });
}

const BEARER = { authorization: 'Bearer testtoken' };
const get = (p) => request(p, { headers: BEARER });

/* ---------- 契约断言小工具 ---------- */
const CODES = ['NOT_FOUND', 'MISSING_QUERY', 'INVALID_PARAM', 'SERVER_ERROR'];

/** 成功包：200 + ok:true + 有 data + 没有 error */
function isOkEnv(r) {
  return !!r.json && r.json.ok === true
    && Object.prototype.hasOwnProperty.call(r.json, 'data')
    && r.json.error === undefined;
}
/** 失败包：ok:false + error.code 在白名单内 + 有中文 message */
function isErrEnv(r, code) {
  return !!r.json && r.json.ok === false && !!r.json.error
    && (code ? r.json.error.code === code : CODES.includes(r.json.error.code))
    && typeof r.json.error.message === 'string' && r.json.error.message.length > 0;
}
/** 列表包：data.items 是数组 + pagination 五件套齐全且类型正确 */
function isListEnv(r) {
  if (!isOkEnv(r)) return false;
  const d = r.json.data;
  if (!Array.isArray(d.items)) return false;
  const pg = d.pagination;
  return !!pg && typeof pg.total === 'number' && typeof pg.limit === 'number'
    && typeof pg.offset === 'number' && typeof pg.page === 'number'
    && typeof pg.hasMore === 'boolean';
}

/* ---------- 与被测代码同源、但独立实现的 djb2（用于写死断言，防 hash 漂移） ---------- */
function djb2(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* ---------- 播种数据：6 首 / 3 专辑 / 3 歌手 / 2 风格 ---------- */
const mk = (id, o) => Object.assign({
  id,
  filePath: '/music/' + id + '.mp3',
  fileName: id + '.mp3',
  fileSizeBytes: 1024 * 1024 * 5,
  title: id,
  cleanTitle: id,
  artist: '未知歌手',
  cleanArtist: '未知歌手',
  album: '',
  albumGroup: 'unknown',
  albumIsPlaceholder: true,
  year: 0,
  durationSec: 240,
  trackNo: 1,
  format: 'mp3',
  bitrate: 320,
  sampleRate: 44100,
  genre: '其他',
  mood: [],
  scene: [],
  lang: '国语',
  era: '未知',
  qualityLevel: 'high',
  confidence: 90,
  coverId: '',
  lyricsSource: '',
  coverSource: '',
  needReview: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}, o);

const SEED = [
  mk('tp_qa01', { title: '天空', cleanTitle: '天空', artist: '王菲', cleanArtist: '王菲', album: '唱游', albumGroup: 'real', albumIsPlaceholder: false, year: 1998, trackNo: 1, genre: '流行', mood: ['怀旧'], scene: ['夜晚独处'], createdAt: '2026-01-03T00:00:00.000Z', coverId: 'cv_qa01' }),
  mk('tp_qa02', { title: '你快乐所以我快乐', cleanTitle: '你快乐所以我快乐', artist: '王菲', cleanArtist: '王菲', album: '唱游', albumGroup: 'real', albumIsPlaceholder: false, year: 1998, trackNo: 2, genre: '流行', mood: ['怀旧'], scene: ['夜晚独处'], createdAt: '2026-01-04T00:00:00.000Z' }),
  mk('tp_qa03', { title: '闷', cleanTitle: '闷', artist: '王菲', cleanArtist: '王菲', album: '唱游', albumGroup: 'real', albumIsPlaceholder: false, year: 1998, trackNo: 3, genre: '流行', mood: ['怀旧'], scene: ['夜晚独处'], createdAt: '2026-01-05T00:00:00.000Z' }),
  mk('tp_qa04', { title: '晴天', cleanTitle: '晴天', artist: '周杰伦', cleanArtist: '周杰伦', album: '范特西', albumGroup: 'real', albumIsPlaceholder: false, year: 2001, trackNo: 1, genre: '流行', mood: ['思念'], scene: ['雨天'], createdAt: '2026-01-06T00:00:00.000Z', coverId: 'cv_qa04' }),
  mk('tp_qa05', { title: '七里香', cleanTitle: '七里香', artist: '周杰伦', cleanArtist: '周杰伦', album: '范特西', albumGroup: 'real', albumIsPlaceholder: false, year: 2001, trackNo: 2, genre: '流行', mood: ['思念'], scene: ['雨天'], createdAt: '2026-01-07T00:00:00.000Z' }),
  mk('tp_qa06', { title: '旋律', cleanTitle: '旋律', artist: '玉置浩二', cleanArtist: '玉置浩二', album: 'Friend', albumGroup: 'real', albumIsPlaceholder: false, year: 1988, trackNo: 1, genre: '民谣', mood: ['孤独'], scene: [], createdAt: '2026-01-08T00:00:00.000Z' }),
];

// 写死断言：改了 hash 会让 /api/v1/albums 与 /api/albums 两套 id 漂移，这里立刻炸
const ALBUM_唱游 = 'al_' + djb2('唱游');       // 实测 al_64d3ce
const ARTIST_王菲 = 'ar_' + djb2('王菲');      // 实测 ar_68d322

(async () => {
  /* =====================================================================
   * 0. 起真服务（此时曲库为空 —— 正好用来验「空库不 500」）
   * ===================================================================== */
  console.log('\n== 0. 启动真实服务 ==');
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));
  const db = require('../src/store/db');
  const ud = require('../src/store/userdata');
  ok('服务已起（空曲库）', db.size() === 0, 'size=' + db.size());

  /* =====================================================================
   * A. 空曲库：列表端点必须 200 + 空数组，绝不能 500
   * ===================================================================== */
  console.log('\n== A. 空曲库不 500 ==');
  const emptyLists = [
    '/api/v1/home', '/api/v1/tracks', '/api/v1/albums', '/api/v1/artists',
    '/api/v1/genres', '/api/v1/playlists', '/api/v1/favorites', '/api/v1/history',
    '/api/v1/facets', '/api/v1/stats',
  ];
  for (const p of emptyLists) {
    const r = await get(p);
    if (p === '/api/v1/home') {
      ok('空库 GET /api/v1/home → 200 且 ok:true', r.status === 200 && isOkEnv(r), String(r.status) + ' ' + r.text.slice(0, 120));
      const d = r.json && r.json.data;
      ok('空库 home 各区都是空数组', !!d && Array.isArray(d.random) && d.random.length === 0
        && Array.isArray(d.recentAdded) && d.recentAdded.length === 0
        && Array.isArray(d.recentAlbums) && d.recentAlbums.length === 0,
      JSON.stringify(d && { r: (d.random || []).length, a: (d.recentAdded || []).length, al: (d.recentAlbums || []).length }));
    } else if (p === '/api/v1/stats') {
      const d = r.json && r.json.data;
      ok('空库 GET /api/v1/stats → 200 且全 0',
        r.status === 200 && isOkEnv(r) && d && d.tracks === 0 && d.albums === 0
        && d.artists === 0 && d.genres === 0 && d.favorites === 0 && d.plays === 0 && d.needReview === 0,
        String(r.status) + ' ' + JSON.stringify(d));
    } else if (p === '/api/v1/facets') {
      ok('空库 GET /api/v1/facets → 200', r.status === 200 && isOkEnv(r), String(r.status));
    } else {
      ok(`空库 GET ${p} → 200 + items:[]（不是 500）`,
        r.status === 200 && isListEnv(r) && r.json.data.items.length === 0 && r.json.data.pagination.total === 0,
        String(r.status) + ' ' + r.text.slice(0, 120));
    }
  }
  const emptyTrack = await get('/api/v1/tracks/tp_none');
  ok('空库 GET /api/v1/tracks/tp_none → 404 NOT_FOUND 信封',
    emptyTrack.status === 404 && isErrEnv(emptyTrack, 'NOT_FOUND'), String(emptyTrack.status) + ' ' + emptyTrack.text.slice(0, 120));
  const emptySearch = await get('/api/v1/search?q=' + encodeURIComponent('天空'));
  ok('空库搜索 → 200 且 0 命中（不是 500）',
    emptySearch.status === 200 && isOkEnv(emptySearch) && emptySearch.json.data.tracks.total === 0,
    String(emptySearch.status));

  /* =====================================================================
   * 播种
   * ===================================================================== */
  console.log('\n== 播种 6 首 ==');
  for (const t of SEED) db.upsert(t);
  ok('曲库已播种 6 首', db.size() === 6, 'size=' + db.size());
  ok('写死断言：唱游 的专辑 id = al_64d3ce', ALBUM_唱游 === 'al_64d3ce', ALBUM_唱游);
  ok('写死断言：王菲 的歌手 id = ar_68d322', ARTIST_王菲 === 'ar_68d322', ARTIST_王菲);

  /* =====================================================================
   * B. 鉴权矩阵：21 个端点逐个验（不用 /api/health 当判据）
   * ===================================================================== */
  console.log('\n== B. /api/v1/* 鉴权矩阵（缺 Bearer 必须 401）==');
  const ENDPOINTS = [
    ['GET', '/api/v1/home'],
    ['GET', '/api/v1/tracks'],
    ['GET', '/api/v1/tracks/tp_qa01'],
    ['GET', '/api/v1/albums'],
    ['GET', '/api/v1/albums/' + ALBUM_唱游],
    ['GET', '/api/v1/artists'],
    ['GET', '/api/v1/artists/' + ARTIST_王菲],
    ['GET', '/api/v1/genres'],
    ['GET', '/api/v1/genres/' + encodeURIComponent('流行') + '/tracks'],
    ['GET', '/api/v1/playlists'],
    ['GET', '/api/v1/playlists/sys_genre_' + encodeURIComponent('流行')],
    ['GET', '/api/v1/search?q=' + encodeURIComponent('唱游')],
    ['GET', '/api/v1/favorites'],
    ['GET', '/api/v1/favorites/tp_qa01'],
    ['PUT', '/api/v1/favorites/tp_qa01'],
    ['DELETE', '/api/v1/favorites/tp_qa01'],
    ['GET', '/api/v1/history'],
    ['POST', '/api/v1/history'],
    ['DELETE', '/api/v1/history'],
    ['GET', '/api/v1/facets'],
    ['GET', '/api/v1/stats'],
  ];
  for (const [m, p] of ENDPOINTS) {
    const anon = await request(p, { method: m, body: m === 'POST' ? '{"trackId":"tp_qa01"}' : null });
    const bad = await request(p, {
      method: m, headers: { authorization: 'Bearer wrong-token' },
      body: m === 'POST' ? '{"trackId":"tp_qa01"}' : null,
    });
    ok(`${m} ${p} 无令牌 → 401`, anon.status === 401, String(anon.status));
    ok(`${m} ${p} 错误令牌 → 401`, bad.status === 401, String(bad.status));
    // 401 绝不能是「数据信封」，否则就是鉴权被绕过
    ok(`${m} ${p} 401 响应里不含 ok:true`,
      !(anon.json && anon.json.ok === true) && !(bad.json && bad.json.ok === true),
      JSON.stringify(anon.json) + ' | ' + JSON.stringify(bad.json));
  }
  // v1 明确是 Bearer-only：Cookie 不等于通行证（与 /api/stream/* 的放宽不同）
  const cookieOnly = await request('/api/v1/home', { headers: { cookie: 'tp_token=testtoken' } });
  ok('仅 Cookie（无 Bearer）→ 401（v1 是 Bearer-only，与 stream 放宽不同）',
    cookieOnly.status === 401, String(cookieOnly.status));
  // 反例哨兵：证明我们没拿「任何令牌都放行」的端点当判据
  const health = await request('/api/health', { headers: {} });
  console.log('     （哨兵）GET /api/health 无令牌 → ' + health.status + '（免鉴权，不能用作鉴权判据）');

  /* =====================================================================
   * C. 信封契约
   * ===================================================================== */
  console.log('\n== C. 信封契约 ==');
  const t1 = await get('/api/v1/tracks/tp_qa01');
  ok('成功包 = {ok:true, data}', t1.status === 200 && isOkEnv(t1), String(t1.status));
  const notFound = await get('/api/v1/tracks/nope-not-exist');
  ok('404 包 = {ok:false, error:{code,message}}',
    notFound.status === 404 && isErrEnv(notFound, 'NOT_FOUND'), String(notFound.status) + ' ' + notFound.text.slice(0, 140));
  const unknown = await get('/api/v1/this-route-does-not-exist');
  ok('未定义路由 → 404 NOT_FOUND 信封（不是裸 error 字符串）',
    unknown.status === 404 && isErrEnv(unknown, 'NOT_FOUND'), String(unknown.status) + ' ' + unknown.text.slice(0, 140));
  const wrongMethod = await request('/api/v1/tracks', { method: 'POST', headers: BEARER, body: '{}' });
  ok('POST /api/v1/tracks（方法不匹配）→ 404 NOT_FOUND',
    wrongMethod.status === 404 && isErrEnv(wrongMethod, 'NOT_FOUND'), String(wrongMethod.status));
  const noSlash = await get('/api/v1');
  ok('GET /api/v1（无尾斜杠）不返回 ok:true', !(noSlash.json && noSlash.json.ok === true), String(noSlash.status));

  /* =====================================================================
   * D. home / tracks / 详情 / 分页
   * ===================================================================== */
  console.log('\n== D. home / tracks / 详情 / 分页 ==');
  const home = await get('/api/v1/home');
  ok('home → 200', home.status === 200 && isOkEnv(home), String(home.status));
  const H = home.json && home.json.data;
  ok('home 含 random/recentAdded/recentPlayed/favorites/recentAlbums/stats 六段',
    !!H && ['random', 'recentAdded', 'recentPlayed', 'favorites', 'recentAlbums', 'stats'].every((k) => k in H),
    Object.keys(H || {}).join(','));
  ok('home.random 默认 6 条（曲库 6 首）', H && H.random.length === 6, String(H && H.random.length));
  ok('home.recentAlbums 默认 12 上限，实得 3 张', H && H.recentAlbums.length === 3, String(H && H.recentAlbums.length));
  const homeL = await get('/api/v1/home?limit=2&albumLimit=1');
  ok('home?limit=2&albumLimit=1 真的生效',
    homeL.json.data.random.length === 2 && homeL.json.data.recentAlbums.length === 1,
    JSON.stringify({ r: homeL.json.data.random.length, a: homeL.json.data.recentAlbums.length }));
  const seedStable = await get('/api/v1/home?seed=qa-fixed');
  const seedStable2 = await get('/api/v1/home?seed=qa-fixed');
  ok('home?seed= 固定 → 随机区顺序稳定（App 翻页不跳）',
    JSON.stringify(seedStable.json.data.random.map((x) => x.id))
    === JSON.stringify(seedStable2.json.data.random.map((x) => x.id)),
    '两次不一致');

  const full = await get('/api/v1/tracks?limit=200');
  ok('tracks → 200 + 列表信封', full.status === 200 && isListEnv(full), String(full.status));
  ok('tracks pagination.total = 6', full.json.data.pagination.total === 6, String(full.json.data.pagination.total));
  const LITE_KEYS = ['id', 'title', 'artist', 'album', 'albumTitle', 'year', 'durationSec', 'trackNo',
    'format', 'bitrate', 'genre', 'mood', 'scene', 'lang', 'era', 'coverUrl', 'streamUrl', 'lyricUrl',
    'addedAt', 'updatedAt'];
  ok('trackLite 字段齐全', full.json.data.items.every((it) => LITE_KEYS.every((k) => k in it)),
    JSON.stringify(Object.keys(full.json.data.items[0] || {})));
  ok('streamUrl 指向 /api/stream/<id>',
    full.json.data.items.every((it) => it.streamUrl === '/api/stream/' + it.id),
    JSON.stringify(full.json.data.items[0]));

  const ids200 = full.json.data.items.map((x) => x.id);
  const p1 = await get('/api/v1/tracks?limit=2&page=1');
  const p3 = await get('/api/v1/tracks?limit=2&page=3');
  ok('tracks 默认 limit=30', (await get('/api/v1/tracks')).json.data.pagination.limit === 30,
    String((await get('/api/v1/tracks')).json.data.pagination.limit));
  ok('page=1&limit=2 → offset 0 / hasMore true',
    p1.json.data.pagination.offset === 0 && p1.json.data.pagination.hasMore === true,
    JSON.stringify(p1.json.data.pagination));
  ok('page=1&limit=2 的 items = 全量前两条',
    JSON.stringify(p1.json.data.items.map((x) => x.id)) === JSON.stringify(ids200.slice(0, 2)),
    JSON.stringify(p1.json.data.items.map((x) => x.id)));
  ok('page=3&limit=2 → offset 4 / hasMore false',
    p3.json.data.pagination.offset === 4 && p3.json.data.pagination.hasMore === false,
    JSON.stringify(p3.json.data.pagination));
  ok('page=3&limit=2 真的返回剩余 2 首（不是空页）',
    p3.json.data.items.length === 2, 'items=' + p3.json.data.items.length);
  const pOverride = await get('/api/v1/tracks?limit=2&page=2&offset=5');
  ok('page 覆盖 offset（page=2&offset=5 → offset=2）',
    pOverride.json.data.pagination.offset === 2, JSON.stringify(pOverride.json.data.pagination));
  ok('page=2&limit=2 的 items = 全量第 3、4 条',
    JSON.stringify(pOverride.json.data.items.map((x) => x.id)) === JSON.stringify(ids200.slice(2, 4)),
    JSON.stringify(pOverride.json.data.items.map((x) => x.id)));
  const p4 = await get('/api/v1/tracks?limit=2&page=4');
  ok('page=4（越过末尾）→ items 0 / hasMore false / 仍是 200（不是 404/500）',
    p4.status === 200 && p4.json.data.items.length === 0
    && p4.json.data.pagination.hasMore === false && p4.json.data.pagination.total === 6,
    String(p4.status) + ' ' + JSON.stringify(p4.json.data && p4.json.data.pagination));
  const lim0 = await get('/api/v1/tracks?limit=0');
  ok('limit=0 → 夹到 1', lim0.json.data.pagination.limit === 1, String(lim0.json.data.pagination.limit));
  const lim999 = await get('/api/v1/tracks?limit=999');
  ok('limit=999 → 夹到 200', lim999.json.data.pagination.limit === 200, String(lim999.json.data.pagination.limit));
  const limAbc = await get('/api/v1/tracks?limit=abc');
  ok('limit=abc → 回落默认 30', limAbc.json.data.pagination.limit === 30, String(limAbc.json.data.pagination.limit));
  const limNeg = await get('/api/v1/tracks?limit=-5');
  ok('limit=-5 → 夹到 1（不是负数）', limNeg.json.data.pagination.limit === 1, String(limNeg.json.data.pagination.limit));
  const offNeg = await get('/api/v1/tracks?offset=-3');
  ok('offset=-3 → 0', offNeg.json.data.pagination.offset === 0, String(offNeg.json.data.pagination.offset));

  const detail = await get('/api/v1/tracks/tp_qa01');
  ok('tracks/:id → 200 + 详情字段（比列表多 file/quality/source）',
    detail.status === 200 && isOkEnv(detail)
    && ['fileName', 'fileSizeBytes', 'sampleRate', 'confidence', 'qualityLevel', 'lyricsSource', 'coverSource']
      .every((k) => k in detail.json.data),
    JSON.stringify(Object.keys(detail.json.data || {})));
  ok('详情 title 取 cleanTitle（不是脏 title）', detail.json.data.title === '天空', detail.json.data.title);

  /* =====================================================================
   * E. albums：id 必须与 /api/albums 同源同值
   * ===================================================================== */
  console.log('\n== E. albums（id 同源同值）==');
  const va = await get('/api/v1/albums?limit=200');
  ok('albums → 200 + 列表信封', va.status === 200 && isListEnv(va), String(va.status));
  ok('albums 共 3 张', va.json.data.pagination.total === 3, String(va.json.data.pagination.total));
  const legacyAlbums = await get('/api/albums');
  const legacyIds = (legacyAlbums.json.albums || []).map((a) => a.id).sort();
  const v1Ids = va.json.data.items.map((a) => a.id).sort();
  ok('v1 专辑 id 集合 === 既有 /api/albums 的 id 集合（同源同值）',
    JSON.stringify(v1Ids) === JSON.stringify(legacyIds),
    'v1=' + JSON.stringify(v1Ids) + ' legacy=' + JSON.stringify(legacyIds));
  ok('唱游 的 v1 id 是写死的 al_64d3ce（防 hash 漂移）',
    v1Ids.includes('al_64d3ce'), JSON.stringify(v1Ids));
  const ad = await get('/api/v1/albums/al_64d3ce');
  ok('GET /api/v1/albums/al_64d3ce → 200 且 3 首',
    ad.status === 200 && isOkEnv(ad) && ad.json.data.album.id === 'al_64d3ce'
    && ad.json.data.items.length === 3,
    String(ad.status) + ' ' + JSON.stringify(ad.json.data && ad.json.data.album));
  ok('专辑详情带分页信封（items + pagination）',
    ad.json.data && Array.isArray(ad.json.data.items) && !!ad.json.data.pagination,
    JSON.stringify(Object.keys(ad.json.data || {})));
  const ad404 = await get('/api/v1/albums/al_not_exist');
  ok('不存在的专辑 → 404 NOT_FOUND', ad404.status === 404 && isErrEnv(ad404, 'NOT_FOUND'), String(ad404.status));
  const adSort = await get('/api/v1/albums/al_64d3ce?sort=trackNo&order=desc');
  ok('专辑详情 sort=trackNo&order=desc 生效（3,2,1）',
    JSON.stringify(adSort.json.data.items.map((x) => x.trackNo)) === '[3,2,1]',
    JSON.stringify(adSort.json.data.items.map((x) => x.trackNo)));
  const alQ = await get('/api/v1/albums?q=' + encodeURIComponent('范特西'));
  ok('albums?q=范特西 → 只命中 1 张', alQ.json.data.pagination.total === 1, String(alQ.json.data.pagination.total));

  /* =====================================================================
   * F. artists / genres / playlists
   * ===================================================================== */
  console.log('\n== F. artists / genres / playlists ==');
  const ar = await get('/api/v1/artists?limit=200');
  ok('artists → 200 + 3 位歌手', ar.status === 200 && isListEnv(ar) && ar.json.data.pagination.total === 3,
    String(ar.status) + ' ' + JSON.stringify(ar.json.data && ar.json.data.pagination));
  ok('歌手 id 是 ar_<djb2(name)> 且含写死的 ar_68d322',
    ar.json.data.items.every((a) => a.id === 'ar_' + djb2(a.name)) && ar.json.data.items.some((a) => a.id === 'ar_68d322'),
    JSON.stringify(ar.json.data.items.map((a) => a.id)));
  const wf = ar.json.data.items.find((a) => a.id === ARTIST_王菲);
  ok('王菲：3 首 / 1 张专辑（albumCount 去重）',
    wf && wf.trackCount === 3 && wf.albumCount === 1, JSON.stringify(wf));
  const ard = await get('/api/v1/artists/' + ARTIST_王菲);
  ok('歌手详情 → 200 + 3 首', ard.status === 200 && isOkEnv(ard) && ard.json.data.items.length === 3,
    String(ard.status));
  const ard404 = await get('/api/v1/artists/ar_not_exist');
  ok('不存在的歌手 → 404 NOT_FOUND', ard404.status === 404 && isErrEnv(ard404, 'NOT_FOUND'), String(ard404.status));

  const ge = await get('/api/v1/genres');
  ok('genres → 200 + 2 个风格（流行 5 / 民谣 1）',
    ge.status === 200 && isListEnv(ge) && ge.json.data.pagination.total === 2,
    String(ge.status) + ' ' + JSON.stringify(ge.json.data && ge.json.data.items));
  const gt = await get('/api/v1/genres/' + encodeURIComponent('流行') + '/tracks');
  ok('genres/流行/tracks → 200 + 5 首 + 回显 genre',
    gt.status === 200 && isOkEnv(gt) && gt.json.data.items.length === 5 && gt.json.data.genre === '流行',
    String(gt.status) + ' ' + JSON.stringify(gt.json.data && { g: gt.json.data.genre, n: gt.json.data.items.length }));
  const gtEmpty = await get('/api/v1/genres/' + encodeURIComponent('摇滚') + '/tracks');
  ok('genres/摇滚/tracks（0 首）→ 200 + 空数组（不是 404/500）',
    gtEmpty.status === 200 && isOkEnv(gtEmpty) && gtEmpty.json.data.items.length === 0, String(gtEmpty.status));

  // playlists：≥3 才成单，这是既有 compat 语义，不是 bug —— 这里把阈值行为钉死
  const pl = await get('/api/v1/playlists?limit=200');
  ok('playlists → 200 + 列表信封', pl.status === 200 && isListEnv(pl), String(pl.status));
  const plIds = pl.json.data.items.map((p) => p.id);
  ok('流行 5 首 → sys_genre_流行 成单', plIds.includes('sys_genre_流行'), JSON.stringify(plIds));
  ok('怀旧 3 首 → sys_mood_怀旧 成单', plIds.includes('sys_mood_怀旧'), JSON.stringify(plIds));
  ok('孤独 只有 1 首 → 不成单（≥3 阈值，正确行为）', !plIds.includes('sys_mood_孤独'), JSON.stringify(plIds));
  const pd = await get('/api/v1/playlists/sys_genre_' + encodeURIComponent('流行'));
  ok('歌单详情 → 200 + 5 首 + playlist 元信息',
    pd.status === 200 && isOkEnv(pd) && pd.json.data.items.length === 5 && pd.json.data.playlist.trackCount === 5,
    String(pd.status) + ' ' + JSON.stringify(pd.json.data && pd.json.data.playlist));
  const pd404 = await get('/api/v1/playlists/sys_not_exist');
  ok('不存在的歌单 → 404 NOT_FOUND', pd404.status === 404 && isErrEnv(pd404, 'NOT_FOUND'), String(pd404.status));

  /* =====================================================================
   * G. search
   * ===================================================================== */
  console.log('\n== G. search ==');
  const sNoQ = await get('/api/v1/search');
  ok('search 缺 q → 400 MISSING_QUERY', sNoQ.status === 400 && isErrEnv(sNoQ, 'MISSING_QUERY'),
    String(sNoQ.status) + ' ' + sNoQ.text.slice(0, 140));
  const sBlankQ = await get('/api/v1/search?q=%20%20');
  ok('search q 是纯空格 → 400 MISSING_QUERY（不是空搜全库）',
    sBlankQ.status === 400 && isErrEnv(sBlankQ, 'MISSING_QUERY'), String(sBlankQ.status));
  const sBadType = await get('/api/v1/search?q=' + encodeURIComponent('天空') + '&type=banana');
  ok('search 非法 type → 400 INVALID_PARAM', sBadType.status === 400 && isErrEnv(sBadType, 'INVALID_PARAM'),
    String(sBadType.status) + ' ' + sBadType.text.slice(0, 140));
  const sAll = await get('/api/v1/search?q=' + encodeURIComponent('唱游') + '&type=all');
  ok('search type=all → 200 + 四组概览（tracks/artists/albums/playlists）',
    sAll.status === 200 && isOkEnv(sAll)
    && ['tracks', 'artists', 'albums', 'playlists'].every((k) => sAll.json.data[k] && 'total' in sAll.json.data[k]),
    String(sAll.status) + ' ' + JSON.stringify(Object.keys(sAll.json.data || {})));
  const sTrack = await get('/api/v1/search?q=' + encodeURIComponent('王菲') + '&type=track&limit=2');
  ok('search type=track → 带分页信封 + total=3',
    sTrack.status === 200 && isListEnv(sTrack) && sTrack.json.data.pagination.total === 3,
    String(sTrack.status) + ' ' + JSON.stringify(sTrack.json.data && sTrack.json.data.pagination));
  const sArtist = await get('/api/v1/search?q=' + encodeURIComponent('王菲') + '&type=artist');
  ok('search type=artist → 命中 1 位', sArtist.json.data.pagination.total === 1, String(sArtist.json.data.pagination.total));
  const sZero = await get('/api/v1/search?q=' + encodeURIComponent('不存在的歌') + '&type=all');
  ok('search 0 命中 → 200 + total 0（不是 404）',
    sZero.status === 200 && isOkEnv(sZero) && sZero.json.data.tracks.total === 0, String(sZero.status));

  /* =====================================================================
   * H. favorites 往返
   * ===================================================================== */
  console.log('\n== H. favorites 往返 ==');
  let r = await request('/api/v1/favorites/tp_qa01', { method: 'PUT', headers: BEARER });
  ok('PUT 收藏 tp_qa01 → 200 + count:1', r.status === 200 && isOkEnv(r) && r.json.data.count === 1,
    String(r.status) + ' ' + r.text.slice(0, 140));
  const addedAt1 = (ud.favoritesDetail().find((f) => f.trackId === 'tp_qa01') || {}).addedAt;
  ok('收藏已落内存且带 addedAt', !!addedAt1, String(addedAt1));
  r = await request('/api/v1/favorites/tp_qa01', { method: 'PUT', headers: BEARER });
  ok('重复 PUT 同一首 → 200 且 count 仍为 1（不重复计数）',
    r.status === 200 && r.json.data.count === 1, String(r.status) + ' ' + r.text.slice(0, 140));
  const addedAt2 = (ud.favoritesDetail().find((f) => f.trackId === 'tp_qa01') || {}).addedAt;
  ok('重复 PUT 不覆盖 addedAt（收藏时间不许被刷新）', addedAt1 === addedAt2, addedAt1 + ' vs ' + addedAt2);
  r = await request('/api/v1/favorites/tp_qa04', { method: 'PUT', headers: BEARER });
  ok('PUT 第二首 tp_qa04 → count:2', r.status === 200 && r.json.data.count === 2, String(r.status));
  const favList = await get('/api/v1/favorites');
  ok('GET /favorites → 2 条，且带 favoritedAt',
    favList.status === 200 && isListEnv(favList) && favList.json.data.items.length === 2
    && favList.json.data.items.every((x) => !!x.favoritedAt),
    String(favList.status) + ' ' + JSON.stringify(favList.json.data && favList.json.data.items.map((x) => x.id)));
  r = await get('/api/v1/favorites/tp_qa01');
  ok('GET /favorites/tp_qa01 → favorited:true',
    r.status === 200 && r.json.data.favorited === true && r.json.data.count === 2, String(r.status));
  r = await request('/api/v1/favorites/tp_qa01', { method: 'DELETE', headers: BEARER });
  ok('DELETE 取消收藏 → favorited:false + count:1',
    r.status === 200 && r.json.data.favorited === false && r.json.data.count === 1, String(r.status) + ' ' + r.text.slice(0, 140));
  r = await request('/api/v1/favorites/tp_qa01', { method: 'DELETE', headers: BEARER });
  ok('重复 DELETE → 200 幂等（不报错、count 不变）',
    r.status === 200 && isOkEnv(r) && r.json.data.count === 1, String(r.status) + ' ' + r.text.slice(0, 140));
  r = await request('/api/v1/favorites/does-not-exist', { method: 'PUT', headers: BEARER });
  ok('PUT 不存在的曲目 → 404 NOT_FOUND（先查曲库再写收藏）',
    r.status === 404 && isErrEnv(r, 'NOT_FOUND'), String(r.status) + ' ' + r.text.slice(0, 140));
  ok('404 之后收藏数不变（没有落脏数据）', ud.favoriteCount() === 1, String(ud.favoriteCount()));
  ok('不存在的曲目没进收藏表', !ud.isFavorite('does-not-exist'), '被写进去了');

  /* =====================================================================
   * I. history
   * ===================================================================== */
  console.log('\n== I. history ==');
  const post = (body) => request('/api/v1/history', { method: 'POST', headers: BEARER, body });
  let h1 = await post('{"trackId":"tp_qa01"}');
  ok('POST history ×1 → plays:1', h1.status === 200 && isOkEnv(h1) && h1.json.data.plays === 1,
    String(h1.status) + ' ' + h1.text.slice(0, 140));
  ok('返回 latest 时间戳', !!h1.json.data.latest, String(h1.json.data.latest));
  let h2 = await post('{"trackId":"tp_qa01"}');
  ok('POST history ×2 → plays:2', h2.json.data.plays === 2, String(h2.json.data.plays));
  let h3 = await post('{"trackId":"tp_qa04"}');
  ok('POST history ×3（换一首）→ plays:3', h3.json.data.plays === 3, String(h3.json.data.plays));
  const hDistinct = await get('/api/v1/history');
  ok('GET history 默认 scope=distinct → 2 条（按曲目去重）',
    hDistinct.status === 200 && isListEnv(hDistinct) && hDistinct.json.data.items.length === 2,
    String(hDistinct.status) + ' ' + JSON.stringify(hDistinct.json.data && hDistinct.json.data.items.map((x) => x.id)));
  ok('distinct 条目带 playCount 与 playedAt',
    hDistinct.json.data.items.every((x) => 'playCount' in x && !!x.playedAt)
    && hDistinct.json.data.items.find((x) => x.id === 'tp_qa01').playCount === 2,
    JSON.stringify(hDistinct.json.data.items.map((x) => ({ id: x.id, c: x.playCount }))));
  const hRaw = await get('/api/v1/history?scope=raw');
  ok('GET history?scope=raw → 3 条原始流水', hRaw.json.data.items.length === 3, String(hRaw.json.data.items.length));
  ok('raw 条目不带 playCount（两种 scope 语义必须区分）',
    hRaw.json.data.items.every((x) => !('playCount' in x)),
    JSON.stringify(Object.keys(hRaw.json.data.items[0] || {})));
  const hBad = await post('这不是 JSON');
  ok('POST 非 JSON → 400 INVALID_PARAM（不是 500 崩溃）',
    hBad.status === 400 && isErrEnv(hBad, 'INVALID_PARAM'), String(hBad.status) + ' ' + hBad.text.slice(0, 160));
  const hEmpty = await post('');
  ok('POST 空体 → 400 INVALID_PARAM', hEmpty.status === 400 && isErrEnv(hEmpty, 'INVALID_PARAM'), String(hEmpty.status));
  const hNoId = await post('{"foo":1}');
  ok('POST 缺 trackId → 400 INVALID_PARAM', hNoId.status === 400 && isErrEnv(hNoId, 'INVALID_PARAM'), String(hNoId.status));
  const h404 = await post('{"trackId":"not-a-track"}');
  ok('POST 不存在的 trackId → 404 NOT_FOUND', h404.status === 404 && isErrEnv(h404, 'NOT_FOUND'), String(h404.status));
  ok('404 之后播放数不变（没记脏流水）', ud.counts().plays === 3, String(ud.counts().plays));
  const hDel = await request('/api/v1/history', { method: 'DELETE', headers: BEARER });
  ok('DELETE history → cleared:true', hDel.status === 200 && hDel.json.data.cleared === true, String(hDel.status));
  const hAfter = await get('/api/v1/history');
  ok('清空后 GET history → 0 条', hAfter.json.data.pagination.total === 0, String(hAfter.json.data.pagination.total));

  /* =====================================================================
   * J. home 反映用户数据（跨模块一致性）
   * ===================================================================== */
  console.log('\n== J. home / stats 反映用户数据 ==');
  await request('/api/v1/favorites/tp_qa02', { method: 'PUT', headers: BEARER });   // 收藏 tp_qa02（+tp_qa04 = 2）
  await post('{"trackId":"tp_qa05"}');                                              // 播放 1 次
  const home2 = await get('/api/v1/home');
  ok('home.favorites.count = 2', home2.json.data.favorites.count === 2, String(home2.json.data.favorites.count));
  ok('home.favorites.items 带 favoritedAt',
    home2.json.data.favorites.items.length === 2
    && home2.json.data.favorites.items.every((x) => !!x.favoritedAt),
    JSON.stringify(home2.json.data.favorites.items.map((x) => x.id)));
  ok('home.recentPlayed.total = 1', home2.json.data.recentPlayed.total === 1, String(home2.json.data.recentPlayed.total));
  ok('home.stats.favorites=2 / plays=1',
    home2.json.data.stats.favorites === 2 && home2.json.data.stats.plays === 1,
    JSON.stringify(home2.json.data.stats));
  const st = await get('/api/v1/stats');
  ok('stats：6 首 / 3 专辑 / 3 歌手 / 2 风格',
    st.json.data.tracks === 6 && st.json.data.albums === 3 && st.json.data.artists === 3 && st.json.data.genres === 2,
    JSON.stringify(st.json.data));
  ok('stats.favorites=2 / plays=1 / needReview=0',
    st.json.data.favorites === 2 && st.json.data.plays === 1 && st.json.data.needReview === 0,
    JSON.stringify(st.json.data));
  const fac = await get('/api/v1/facets');
  ok('facets 与既有 /api/facets 同构（都有 genre 数组）',
    fac.status === 200 && Array.isArray(fac.json.data.genre), String(fac.status));
  const legacyFacets = await get('/api/facets');
  ok('facets.genre 与既有端点一致',
    JSON.stringify(fac.json.data.genre) === JSON.stringify(legacyFacets.json.genre),
    'v1=' + JSON.stringify(fac.json.data.genre) + ' legacy=' + JSON.stringify(legacyFacets.json.genre));

  /* =====================================================================
   * K. 落盘
   * ===================================================================== */
  console.log('\n== K. 用户数据真的落盘 ==');
  const UFILE = path.join(DATA_DIR, 'userdata.json');
  ok('userdata.json 已生成', fs.existsSync(UFILE), '不存在');
  const onDisk = JSON.parse(fs.readFileSync(UFILE, 'utf8'));
  ok('盘上收藏 2 条（tp_qa02 / tp_qa04）',
    Object.keys(onDisk.favorites || {}).sort().join(',') === 'tp_qa02,tp_qa04',
    JSON.stringify(Object.keys(onDisk.favorites || {})));
  ok('盘上历史 1 条（tp_qa05）',
    (onDisk.history || []).length === 1 && onDisk.history[0].trackId === 'tp_qa05',
    JSON.stringify(onDisk.history));
  ok('盘上 version = 1', onDisk.version === 1, String(onDisk.version));
  ok('原子写无 .tmp 残留', !fs.existsSync(UFILE + '.tmp'), '存在 .tmp');
  ud.reset();
  ok('reset 后重载：收藏 2 / 播放 1（证明写盘不是空喊）',
    ud.counts().favorites === 2 && ud.counts().plays === 1, JSON.stringify(ud.counts()));

  /* =====================================================================
   * L. 路径变形 / 编码绕过：不得泄露文件
   * ===================================================================== */
  console.log('\n== L. 路径变形 / 编码绕过 ==');
  // GET 类：查不到就是 NOT_FOUND 信封（tracks/albums/artists/playlists）
  const attacks = [
    '/api/v1/tracks/' + encodeURIComponent('../../package.json'),
    '/api/v1/tracks/%2e%2e%2f%2e%2e%2fpackage.json',
    '/api/v1/tracks/' + encodeURIComponent('..\\..\\package.json'),
    '/api/v1/albums/' + encodeURIComponent('../../etc/passwd'),
    '/api/v1/artists/' + encodeURIComponent('../../src/config.js'),
    '/api/v1/playlists/' + encodeURIComponent('../../.env'),
  ];
  for (const a of attacks) {
    const rr = await get(a);
    const leaked = /dependencies|DB_PASSWORD|AUTH_TOKEN=/.test(rr.text);
    ok(`路径变形 ${a.slice(0, 46)}… 不泄露文件（404）`,
      rr.status === 404 && !leaked, String(rr.status) + ' ' + rr.text.slice(0, 120));
  }
  // GET /favorites/:id 是「查询态」，不存在的 id 按契约返回 200 + favorited:false，
  // 不是 404 —— 这里只要求它绝不泄露文件内容
  const favTrav = await get('/api/v1/favorites/' + encodeURIComponent('../../package.json'));
  ok('GET /favorites/<路径变形> → 200 favorited:false 且不泄露文件',
    favTrav.status === 200 && favTrav.json.data.favorited === false
    && !/dependencies|AUTH_TOKEN=/.test(favTrav.text), String(favTrav.status) + ' ' + favTrav.text.slice(0, 120));
  const putTrav = await request('/api/v1/favorites/' + encodeURIComponent('../../package.json'),
    { method: 'PUT', headers: BEARER });
  ok('PUT 路径变形 → 404 且不写脏收藏',
    putTrav.status === 404 && ud.favoriteCount() === 2, String(putTrav.status) + ' count=' + ud.favoriteCount());

  /* =====================================================================
   * M. 回归 + 零依赖
   * ===================================================================== */
  console.log('\n== M. 回归 / 零依赖 ==');
  const regression = [
    ['GET', '/api/albums'],
    ['GET', '/api/library'],
    ['GET', '/api/playlists'],
    ['GET', '/api/tracks?limit=5'],
    ['GET', '/api/facets'],
    ['GET', '/api/search?keyword=' + encodeURIComponent('天空')],
    ['GET', '/api/scan/status'],
    ['GET', '/api/sqmusic/status'],
    ['GET', '/'],
  ];
  for (const [m, p] of regression) {
    const rr = await request(p, { method: m, headers: BEARER });
    ok(`回归 ${m} ${p} → 200`, rr.status === 200, String(rr.status) + ' ' + rr.text.slice(0, 100));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  ok('零第三方依赖（package.json dependencies 为空）',
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies));

  /* =====================================================================
   * N. pager 单元（边界值）
   * ===================================================================== */
  console.log('\n== N. pager 边界 ==');
  const v1mod = require('../src/api/v1');
  const pg = (qs, def) => v1mod.pager({ searchParams: new URLSearchParams(qs) }, def);
  ok('pager 默认 limit=30/offset=0/page=1',
    JSON.stringify(pg('')) === JSON.stringify({ limit: 30, offset: 0, page: 1 }), JSON.stringify(pg('')));
  ok('pager limit=0 → 1', pg('limit=0').limit === 1, String(pg('limit=0').limit));
  ok('pager limit=200 → 200', pg('limit=200').limit === 200, String(pg('limit=200').limit));
  ok('pager limit=201 → 200', pg('limit=201').limit === 200, String(pg('limit=201').limit));
  ok('pager limit=abc → 默认', pg('limit=abc').limit === 30, String(pg('limit=abc').limit));
  ok('pager offset 负数 → 0', pg('offset=-9').offset === 0, String(pg('offset=-9').offset));
  ok('pager page=1 → offset 0 / page 1',
    pg('page=1&limit=10').offset === 0 && pg('page=1&limit=10').page === 1, JSON.stringify(pg('page=1&limit=10')));
  ok('pager page=0 被忽略（回 offset）', pg('page=0&offset=7').offset === 7, String(pg('page=0&offset=7').offset));
  ok('pager page 覆盖 offset', pg('page=3&offset=50&limit=10').offset === 20, String(pg('page=3&offset=50&limit=10').offset));
  ok('pager 自定义默认 limit 生效', pg('', 5).limit === 5, String(pg('', 5).limit));

  /* =====================================================================
   * O. userdata 存储健壮性（承诺：「读盘失败也要用默认值，绝不 crash」）
   * ===================================================================== */
  console.log('\n== O. userdata 存储健壮性 ==');
  const writeUd = (obj) => { fs.writeFileSync(UFILE, typeof obj === 'string' ? obj : JSON.stringify(obj)); ud.reset(); };

  writeUd('这不是 JSON {{{');
  let crashed = false;
  let c1 = null;
  try { c1 = ud.counts(); } catch (_) { crashed = true; }
  ok('盘上是坏 JSON → 不抛异常，回落默认值',
    !crashed && c1 && c1.favorites === 0 && c1.plays === 0, JSON.stringify(c1) + ' crashed=' + crashed);

  writeUd({ version: 1, favorites: ['这不是对象'], history: '这不是数组' });
  ok('favorites 是数组 / history 是字符串 → 收敛成空，不崩',
    ud.counts().favorites === 0 && ud.counts().plays === 0, JSON.stringify(ud.counts()));

  writeUd({
    version: 1,
    favorites: { tp_qa01: '2026-01-01T00:00:00.000Z', '': '空 key 应被丢掉', bad: { nope: 1 } },
    history: [{ trackId: 'tp_qa01', playedAt: '2026-01-01T00:00:00.000Z' }, null, { trackId: '' }, 42],
  });
  ok('脏条目被清洗：空 key / 空 trackId / null / 数字全丢弃，只留合法 1 条',
    ud.counts().favorites === 1 && ud.counts().plays === 1, JSON.stringify(ud.counts()));

  const big = { version: 1, favorites: {}, history: [] };
  for (let i = 0; i < 5005; i++) big.history.push({ trackId: 'tp_qa0' + (i % 6 + 1), playedAt: '2026-01-0' + (i % 9 + 1) + 'T00:00:00.000Z' });
  writeUd(big);
  ok('历史超 5000 条 → 截断到 HISTORY_MAX（丢最旧，保最新在前）',
    ud.historyRaw().length === ud.HISTORY_MAX && ud.HISTORY_MAX === 5000,
    'len=' + ud.historyRaw().length);

  // 曲库里已不存在的收藏：列表必须跳过（用户看到的是「还能播的歌」）
  ud.reset();
  ud.addFavorite('tp_qa03');
  ud.addFavorite('ghost-deleted-track');
  const ghostList = await get('/api/v1/favorites');
  const ghostIds = ghostList.json.data.items.map((x) => x.id);
  ok('失效收藏（曲库里没有）不出现在列表里', !ghostIds.includes('ghost-deleted-track'), JSON.stringify(ghostIds));
  ok('失效收藏不影响正常收藏展示', ghostIds.includes('tp_qa03'), JSON.stringify(ghostIds));
  const ghostDetail = await get('/api/v1/tracks/ghost-deleted-track');
  ok('失效收藏指向的曲目详情 → 404（不是幽灵 200）',
    ghostDetail.status === 404 && isErrEnv(ghostDetail, 'NOT_FOUND'), String(ghostDetail.status));
  ud.removeFavorite('ghost-deleted-track');
  ud.removeFavorite('tp_qa03');

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
