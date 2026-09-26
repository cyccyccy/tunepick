'use strict';
/**
 * 对外开放 API v1 —— /api/v1/sqmusic/*（搜歌下载，SqMusic 代理）
 *
 * 定位：把 TunePick 自带网页「搜歌下载」页的能力开放给第三方应用/服务器调用：
 *   搜索 → 试听 → 下载 → 任务列表 → 已下载列表（含入库状态）→ 连通性测试 → 下载目录 → 触发入库扫描
 *
 * 契约（与 /api/v1/* 完全一致）：
 *   成功：{ ok:true, data }
 *   列表：data = { items:[…], pagination:{ total, limit, offset, page, hasMore } }
 *   失败：{ ok:false, error:{ code, message } }
 *
 * ⚠️ 本模块**只做协议转换，不重新实现业务逻辑**：
 *    业务全部走 src/service/sqmusic.js；曲库配对复用 src/api/sqmusic.js 导出的
 *    matchTrackInLibrary（不复制实现，避免两份配对逻辑漂移）。
 * ⚠️ 鉴权已由 src/api/index.js 的 Bearer 闸门统一把关，本模块不再校验。
 * ⚠️ 不修改 src/api/sqmusic.js / src/service/sqmusic.js / src/api/index.js 任何一行。
 *
 * 降级策略：config.SQ_ENABLED 为 false 时，除 GET /status 外一律
 *   503 { code:'SQMUSIC_DISABLED' } —— 未启用是**预期状态**不是故障，
 *   前端据此渲染引导页，不该看到 500。
 */

const config = require('../config');
const sq = require('../service/sqmusic');
const admin = require('./admin');
const compatApi = require('./compat');
const sqApi = require('./sqmusic');
const { makeLogger } = require('../logger');

const log = makeLogger('api:v1:sq');

const json = admin.json;

/** 封面地址复用 compat 的导出（与 /api/v1/* 同源，不另写一份） */
const coverUrlOf = compatApi.coverUrl;

/** 曲库配对：复用既有实现（不复制） */
const matchTrackInLibrary = sqApi.matchTrackInLibrary;

/** 任务列表一次取全的条数上限（超出截断） */
const TASK_MAX = 500;

/** 已下载列表每页条数（SqMusic 侧 page size） */
const DL_PAGE_SIZE = 50;

/** 已下载列表「拉全量」时最多翻多少页（TunePick 侧自我保护） */
const DL_MAX_PAGES = 10;

/* ==========================================================================
 * 小工具
 * ========================================================================== */

/**
 * 取 v1 的分页 helper（pager / pageOf）
 *
 * ⚠️ 必须**调用时懒加载**，不能在文件顶部 require：
 *    v1.js 在顶部 require 了本模块；本模块若在顶部反手 require('./v1')，
 *    拿到的会是 v1 **尚未赋值**的空 exports（CommonJS 循环依赖的经典坑），
 *    pager / pageOf 全是 undefined，一调用就崩。
 *    放到调用时再取，v1 早已加载完毕，拿到的是完整的 module.exports。
 */
function paging() {
  return require('./v1');
}

/** 数值钳制：非法/缺失 → def；合法 → 夹到 [lo, hi]（形参 4 个，别写成 3 个） */
function clamp(n, def, lo, hi) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}

function ok(res, data, status = 200) {
  return json(res, { ok: true, data }, status);
}

function fail(res, status, code, message) {
  return json(res, { ok: false, error: { code, message } }, status);
}

/**
 * 错误映射：SqError → v1 大写错误码
 *
 * bad-request        → 400 INVALID_PARAM
 * cache-miss         → 400 CACHE_EXPIRED（提示重新搜索）
 * unreachable / http / parse / business / no-token / no-url → 502 UPSTREAM_ERROR
 * disabled / not-configured / sqmusic-disabled → 503 SQMUSIC_DISABLED
 * 其余（真正的内部异常）→ 500 SERVER_ERROR
 *
 * ⚠️ 为什么 disabled 之外还要认 not-configured：服务层 assertEnabled() 在
 *    「未启用」和「没配 SQ_BASE_URL」两种情况下分别抛这两个码，都是 503，
 *    漏掉任何一个都会把「未启用」误报成 500。
 * ⚠️ 为什么上游故障统一 502：这 6 个码语义上都是「SqMusic 那边出问题」。
 *    落 500 会把「上游挂了」伪装成「我们挂了」，调用方和告警都会被误导。
 *    只有真正的内部异常（非 SqError，或 SqError 但不在上表内）才给 500。
 *
 * @returns {{status:number, code:string, message:string}}
 */
function mapError(e) {
  if (e && e.name === 'SqError') {
    switch (e.code) {
      case 'bad-request':
        return { status: 400, code: 'INVALID_PARAM', message: e.message || '请求参数不合法' };
      case 'cache-miss':
        return { status: 400, code: 'CACHE_EXPIRED', message: e.message || '搜索结果已过期，请重新搜索后再操作' };
      // ---- 上游故障：统一 502 UPSTREAM_ERROR（lead 裁决，覆盖初版规格的「其余→500」）----
      // 这 6 个码在语义上都是「SqMusic 那边出问题」，不是我们的问题；
      // 落 500 会把「上游挂了」伪装成「我们挂了」，误导调用方和告警。
      case 'unreachable':     // 连不上 SqMusic
      case 'http':            // 上游返回非 2xx
      case 'parse':           // 上游返回非 JSON / 空响应
      case 'business':        // 上游返回业务错误体
      case 'no-token':        // 拿不到上游令牌
      case 'no-url':          // 上游未给出直链
        // message 统一文案、不回显上游原文：对调用方是「可直接展示给用户」的口径；
        // 真正的上游原文仍会进日志（见 route() 的 catch），排障不丢信息。
        return {
          status: 502,
          code: 'UPSTREAM_ERROR',
          message: '连接 SqMusic 失败或上游返回异常（请稍后重试）',
        };
      case 'disabled':
      case 'not-configured':
      case 'sqmusic-disabled':
        return { status: 503, code: 'SQMUSIC_DISABLED', message: e.message || 'SqMusic 集成未启用' };
      default:
        return { status: 500, code: 'SERVER_ERROR', message: e.message || 'SqMusic 服务异常' };
    }
  }
  return { status: 500, code: 'SERVER_ERROR', message: (e && e.message) || '内部错误' };
}

/** 读取 JSON 请求体（1MB 上限）；失败返回 null，由调用方给 400 */
async function readJsonBody(req) {
  let buf;
  try {
    buf = await admin.readBody(req, 1024 * 1024);
  } catch (_) {
    return null;
  }
  if (!buf || !buf.length) return null;
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

/* ==========================================================================
 * 映射器
 * ========================================================================== */

/**
 * 服务层状态 → v1 对外词汇
 * 服务层取值域是 waiting | downloading | success | error（见 service/sqmusic.js:94），
 * v1 契约用 running，这里统一翻译；反向查询（?status=）两个名字都收。
 */
function statusV1(s) {
  return s === 'downloading' ? 'running' : (s || 'waiting');
}

/** 搜索结果 → songLite */
function songLite(s) {
  return {
    key: s.key || '',                 // 试听/下载的凭据，必须原样返回
    songId: s.id || '',
    title: s.name || '',
    name: s.name || '',
    artist: s.artist || '',
    artists: Array.isArray(s.artists) ? s.artists.slice() : [],
    album: s.albumName || '',
    albumId: s.albumId || '',
    coverUrl: s.picUrl || '',
    durationSec: s.durationSec || 0,
    brTypes: Array.isArray(s.brTypes) ? s.brTypes.slice() : [],
    defaultBrType: s.defaultBrType || '',
    plugName: s.plugName || '',
    hasLyric: !!s.hasLyric,
  };
}

/** 把可能是「秒/毫秒时间戳 / 日期字符串」的值统一成毫秒；解析不出返回 0 */
function toMs(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const pureNum = /^\d+$/.test(s);
  let ms = pureNum ? parseInt(s, 10) : Date.parse(s);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  // 纯数字且量级明显是「秒」（< 2001 年的毫秒值）→ 补成毫秒
  if (pureNum && ms < 1e12) ms *= 1000;
  return ms;
}

/** 任务耗时（秒）：updatedAt - startedAt；任一端解析失败或倒挂 → 0 */
function elapsedSec(startedAt, updatedAt) {
  const a = toMs(startedAt);
  const b = toMs(updatedAt);
  if (!a || !b || b < a) return 0;
  return Math.round((b - a) / 1000);
}

/** 估算文件体积（字节）：码率(kbps) × 1000 / 8 × 时长(秒)；缺码率 → 0 */
function sizeEstBytes(bitrateKbps, durationSec) {
  const kb = Number(bitrateKbps) || 0;
  const sec = Number(durationSec) || 0;
  if (!kb || !sec) return 0;
  return Math.round((kb * 1000 / 8) * sec);
}

/** 下载任务 → taskLite */
function taskLite(it) {
  const bitrateKbps = Number(it.bitrateKbps) || 0;
  const durationSec = Number(it.durationSec) || 0;
  const sizeBytesEst = sizeEstBytes(bitrateKbps, durationSec);
  const el = elapsedSec(it.startedAt, it.updatedAt);
  const status = statusV1(it.status);
  return {
    id: it.id || '',
    title: it.name || '',
    name: it.name || '',
    artist: it.artist || '',
    album: it.album || '',
    brType: it.brType || '',
    status,
    progress: Number(it.progress) || 0,
    message: it.message || '',
    startedAt: it.startedAt || '',
    updatedAt: it.updatedAt || '',
    bitrateKbps,
    durationSec,
    // ---- 派生字段 ----
    sizeBytesEst,
    elapsedSec: el,
    speedBpsEst: (status === 'success' && el > 0) ? Math.round(sizeBytesEst / el) : 0,
  };
}

/** 已下载条目（成功任务）→ dlLite；t 为曲库配对命中的曲目（可为 null） */
function dlLite(it, t) {
  const bitrateKbps = Number(it.bitrateKbps) || 0;
  const durationSec = Number(it.durationSec) || 0;
  const inLibrary = !!t;
  return {
    id: it.id || '',
    title: it.name || '',
    name: it.name || '',
    artist: it.artist || '',
    album: it.album || '',
    brType: it.brType || '',
    bitrateKbps,
    downloadedAt: it.startedAt || '',
    sizeBytesEst: sizeEstBytes(bitrateKbps, durationSec),
    inLibrary,
    trackId: inLibrary ? (t.id || '') : '',
    filePath: inLibrary ? (t.filePath || '') : '',
    fileSizeBytes: inLibrary ? (Number(t.fileSizeBytes) || 0) : 0,
    streamUrl: inLibrary ? `/api/stream/${t.id}` : '',
    coverUrl: inLibrary ? coverUrlOf(t) : '',
  };
}

/* ==========================================================================
 * 端点实现
 * ========================================================================== */

/**
 * 集成状态
 * 未启用也返回 200（这是**预期状态**不是故障），启用时顺带读下载目录（读不到只给 error）
 */
async function statusData() {
  const s = sq.status();
  const out = {
    enabled: !!s.enabled,
    baseUrl: s.baseUrl || '',
    plugins: Array.isArray(s.plugins) ? s.plugins.slice() : [],
    pluginLabels: s.pluginLabels || {},
    brType: s.brType || '',
    autoScan: !!s.autoScan,
    loggedIn: !!s.loggedIn,
  };
  if (!out.enabled) return out;

  try {
    const cfg = await sq.configInfo();
    out.downloadPath = (cfg && cfg.downloadPath) || '';
    out.downloadPathError = (cfg && cfg.error) || '';
  } catch (e) {
    out.downloadPath = '';
    out.downloadPathError = (e && e.message) || '读取下载目录失败';
  }
  return out;
}

/**
 * 搜索
 * body: { q（或 keyword，必填）, plugName?, limit?, offset?, page? }
 *
 * ⚠️ 分页是 **SqMusic 服务端分页**，返回的 items 已经是当页内容，
 *    因此这里不能再用 pageOf 做二次切片（会把结果切没），pagination 手动拼。
 */
async function search(req, res) {
  const body = await readJsonBody(req);
  if (!body) return fail(res, 400, 'INVALID_PARAM', '请求体必须是合法 JSON 对象');

  const q = String(body.q || body.keyword || '').trim();
  if (!q) return fail(res, 400, 'MISSING_QUERY', '搜索关键词不能为空');

  const pageSize = clamp(body.limit, 20, 1, 50);
  const rawPage = parseInt(body.page, 10);
  const rawOffset = parseInt(body.offset, 10);
  let pageIndex = 1;
  if (Number.isFinite(rawPage) && rawPage > 0) pageIndex = rawPage;
  else if (Number.isFinite(rawOffset) && rawOffset > 0) pageIndex = Math.floor(rawOffset / pageSize) + 1;

  const plugName = body.plugName ? String(body.plugName).trim() : undefined;
  const r = await sq.search(q, { plugName, pageSize, pageIndex });

  const items = (r.items || []).map(songLite);
  const offset = (pageIndex - 1) * pageSize;
  const total = Number.isFinite(r.total) ? r.total : items.length;

  return ok(res, {
    query: r.keyword || q,
    plugName: r.plugName || '',
    pluginLabel: r.pluginLabel || '',
    items,
    pagination: {
      total,
      limit: pageSize,
      offset,
      page: pageIndex,
      hasMore: offset + items.length < total,
    },
  });
}

/** 试听直链；直链带时间签名会过期，ttlHint 提示调用方失效后重新获取 */
async function preview(req, res) {
  const body = await readJsonBody(req);
  if (!body) return fail(res, 400, 'INVALID_PARAM', '请求体必须是合法 JSON 对象');

  const key = String(body.key || '').trim();
  if (!key) return fail(res, 400, 'INVALID_PARAM', 'key 不能为空');

  const brType = body.brType ? String(body.brType).trim() : undefined;
  const r = await sq.preview({ key, brType });

  return ok(res, {
    url: r.url || '',
    brType: r.brType || '',
    bit: r.bit || '',
    name: r.name || '',
    artist: r.artist || '',
    key: r.key || key,
    ttlHint: '直链带时间签名会过期，失效后重新获取',
  });
}

/** 下发下载任务 */
async function download(req, res) {
  const body = await readJsonBody(req);
  if (!body) return fail(res, 400, 'INVALID_PARAM', '请求体必须是合法 JSON 对象');

  const key = String(body.key || '').trim();
  if (!key) return fail(res, 400, 'INVALID_PARAM', 'key 不能为空');

  const brType = body.brType ? String(body.brType).trim() : undefined;
  const r = await sq.download({ key, brType });

  return ok(res, {
    accepted: true,
    key,
    brType: (r && r.brType) || '',
    hint: '下载完成后的入库：轮询 tasks 或调用 rescan',
  });
}

/**
 * 下载任务列表
 * query: status（waiting / running / downloading / success / error）、limit / offset / page
 *
 * counts 统计的是**过滤前**的全量（这样前端四个角标不会因为筛选而变），items 才是过滤后分页的结果。
 */
async function tasks(res, url) {
  const sp = url.searchParams;
  const r = await sq.tasks({ pageIndex: 1, pageSize: TASK_MAX });
  const rawItems = (r.items || []).slice(0, TASK_MAX);

  const c = r.counts || {};
  const counts = {
    waiting: Number(c.waiting) || 0,
    running: Number(c.downloading) || 0,     // v1 词汇 running = 服务层 downloading
    success: Number(c.success) || 0,
    error: Number(c.error) || 0,
  };

  const want = String(sp.get('status') || '').trim().toLowerCase();
  let list = rawItems.map(taskLite);
  if (want) {
    // running 与 downloading 两个名字都收（服务层叫 downloading，v1 契约叫 running）
    const target = want === 'downloading' ? 'running' : want;
    list = list.filter((it) => it.status === target);
  }

  const { pager, pageOf } = paging();
  const paged = pageOf(list, pager(url, 50));

  return ok(res, {
    counts,
    autoScan: { enabled: !!config.SQ_AUTO_SCAN },
    items: paged.items,
    pagination: paged.pagination,
  });
}

/**
 * 已下载列表（SqMusic 成功任务 × TunePick 曲库配对）
 * query: limit / offset / page / q / all（默认 1 = 翻页拉全）
 *
 * all=1：循环翻页拉全（上限 10 页 / 500 条），counts 的 inLibrary 是全量口径；
 * all=0：只拉当前页，counts 只保证 total 正确，inLibrary / notInLibrary 仅统计本页。
 */
async function downloaded(res, url) {
  const sp = url.searchParams;
  const all = String(sp.get('all') || '1').trim() !== '0';
  const q = String(sp.get('q') || '').trim().toLowerCase();

  const rows = [];
  let total = 0;
  let pageIndex = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sq.downloaded({ pageIndex, pageSize: DL_PAGE_SIZE });
    const items = r.items || [];
    if (pageIndex === 1) total = Number.isFinite(r.total) ? r.total : items.length;
    for (const it of items) rows.push(it);

    if (!items.length) break;                                  // 空页即停
    if (total > 0 && rows.length >= total) break;              // 已拉满
    if (!all) break;                                           // all=0 只拉当前页
    if (pageIndex >= DL_MAX_PAGES) break;                      // 自我保护上限
    pageIndex++;
  }

  // 曲库配对（每条一次 db.filter 查询；数量受 500 条上限约束）
  const mapped = rows.map((it) => dlLite(it, matchTrackInLibrary(it.name, it.artist)));
  const inLibrary = mapped.filter((x) => x.inLibrary).length;

  // counts 按过滤前的全量统计
  const counts = {
    total,
    inLibrary,
    notInLibrary: Math.max(0, total - inLibrary),
  };

  let list = mapped;
  if (q) {
    list = list.filter((x) => String(
      (x.name || '') + (x.artist || '') + (x.album || ''),
    ).toLowerCase().includes(q));
  }

  const { pager, pageOf } = paging();
  const paged = pageOf(list, pager(url, 50));

  let downloadPath = '';
  let downloadPathError = '';
  try {
    const cfg = await sq.configInfo();
    downloadPath = (cfg && cfg.downloadPath) || '';
    downloadPathError = (cfg && cfg.error) || '';
  } catch (e) {
    downloadPathError = (e && e.message) || '读取下载目录失败';
  }

  return ok(res, {
    counts,
    downloadPath,
    downloadPathError,
    items: paged.items,
    pagination: paged.pagination,
  });
}

/** 连通性自检（登录 + 探一个只读端点） */
async function test(res) {
  const r = await sq.ping();
  return ok(res, {
    ok: !!(r && r.ok),
    latencyMs: Number(r && r.latencyMs) || 0,
    baseUrl: (r && r.baseUrl) || '',
  });
}

/**
 * 触发增量扫描入库
 * 已有扫描在跑 → 200 + started:false（不重复启动，也不报错）
 */
async function rescan(res) {
  let scanTask;
  try {
    scanTask = require('../scan/task');
  } catch (e) {
    return fail(res, 500, 'SERVER_ERROR', '扫描模块加载失败');
  }

  const st = (scanTask.status && scanTask.status()) || {};
  if (st.running) {
    return ok(res, { started: false, reason: '扫描任务进行中，本次未重复启动' });
  }

  const r = await scanTask.start({
    mode: 'incremental',
    useL3: true,
    protectExisting: true,      // 保护 SqMusic 已写好的内嵌标签，只补 L3 缺失字段
  });

  /* 防御：只有「确实受理且拿到 taskId」才算启动成功。
   * scan/task.js 的 start() 在已有任务运行时返回 { accepted:false, reason }，
   * 若这里不判，调用方会拿到 { started:true, taskId:'' } —— 拿空 id 去轮询永远查不到，
   * 等价于接口对客户端说谎。对外不允许这种假成功，改成 started:false + 原因。 */
  const taskId = (r && r.taskId) || '';
  if ((r && r.accepted === false) || !taskId) {
    return ok(res, { started: false, reason: (r && r.reason) || '扫描任务未受理（可能已有任务在运行）' });
  }
  return ok(res, { started: true, taskId });
}

/* ==========================================================================
 * 路由
 * ========================================================================== */

/**
 * @param {object} req
 * @param {object} res
 * @param {string} method
 * @param {string} P 完整路径（如 /api/v1/sqmusic/search）
 * @param {URL} url
 * @returns {Promise<boolean>} 恒为 true（本模块自行兜 404 / 错误包）
 */
async function route(req, res, method, P, url) {
  const isStatus = P === '/api/v1/sqmusic/status' && method === 'GET';
  try {
    // ---- 未启用：除 status 外一律优雅降级 503 ----
    if (!config.SQ_ENABLED && !isStatus) {
      return fail(res, 503, 'SQMUSIC_DISABLED', 'SqMusic 集成未启用'), true;
    }

    if (isStatus) return ok(res, await statusData()), true;

    if (P === '/api/v1/sqmusic/search' && method === 'POST') return await search(req, res), true;
    if (P === '/api/v1/sqmusic/preview' && method === 'POST') return await preview(req, res), true;
    if (P === '/api/v1/sqmusic/download' && method === 'POST') return await download(req, res), true;
    if (P === '/api/v1/sqmusic/tasks' && method === 'GET') return await tasks(res, url), true;
    if (P === '/api/v1/sqmusic/downloaded' && method === 'GET') return await downloaded(res, url), true;
    if (P === '/api/v1/sqmusic/test' && method === 'POST') return await test(res), true;
    if (P === '/api/v1/sqmusic/rescan' && method === 'POST') return await rescan(res), true;

    return fail(res, 404, 'NOT_FOUND', `接口不存在：${method} ${P}`), true;
  } catch (e) {
    const m = mapError(e);
    // 「未启用」是预期状态不是故障，已经优雅降级成 503 了，再打日志就是噪音；
    // 只有我们自己的 500 才算 ERROR，上游问题记 WARN 即可（别让告警被上游抖动刷屏）
    if (m.code !== 'SQMUSIC_DISABLED') {
      const level = (m.status >= 500 && m.code === 'SERVER_ERROR') ? 'error' : 'warn';
      log[level]('v1-sqmusic 接口异常', { path: P, method, code: m.code, error: e && e.message });
    }
    return fail(res, m.status, m.code, m.message), true;
  }
}

module.exports = { route, /* 供自测/复用 */ songLite, taskLite, dlLite, mapError, statusV1 };
