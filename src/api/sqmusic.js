'use strict';
/**
 * /api/sqmusic/* —— SqMusic 服务端代理
 *
 * 为什么要代理而不是让浏览器直连：
 *   1. token 不落浏览器（登录凭据只在服务端，避免泄漏与越权）
 *   2. 规避 CORS（SqMusic 未开跨域，浏览器直连必失败）
 *   3. 基址可配置（容器名 / 宿主 IP 两种部署形态）
 *
 * 鉴权：全部挂在 /api/* 之下，由 src/api/index.js 的 checkApi 统一把关，
 *       本模块不再重复校验，也不允许免鉴权。
 */

const config = require('../config');
const sq = require('../service/sqmusic');
const { makeLogger } = require('../logger');

const log = makeLogger('api:sqmusic');

/** 自动增量扫描冷却时间（避免轮询期间反复触发） */
const AUTO_SCAN_COOLDOWN_MS = 60 * 1000;

/**
 * seenSuccess 容量上限。
 * SqMusic 的任务列表会持续累积历史成功任务，若只增不删，长时间运行会无限增长。
 * 超过上限时淘汰最早加入的一半（Set 的迭代顺序即插入顺序）。
 */
const SEEN_MAX = 5000;

/** 已判定为成功的任务 id（用于识别「新完成」） */
const seenSuccess = new Set();
let primed = false;
let lastAutoScanAt = 0;

/** 有界淘汰：超过 SEEN_MAX 时丢掉最早加入的一半 */
function trimSeen() {
  if (seenSuccess.size <= SEEN_MAX) return;
  const drop = Math.ceil(SEEN_MAX / 2);
  let i = 0;
  for (const id of seenSuccess) {
    seenSuccess.delete(id);
    if (++i >= drop) break;
  }
}

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (_) {
    return {};
  }
}

/**
 * 统一错误出口：
 *   SqError 带建议状态码 → 原样透出（含 503「未启用」这种优雅降级）
 *   其余异常 → 500，且绝不把堆栈抛给前端
 */
function fail(res, e, where) {
  const status = e && e.status ? e.status : 500;
  const code = e && e.code ? e.code : 'internal';
  if (status >= 500) log.warn('SqMusic 接口失败', { where, code, error: e && e.message });
  return json(res, {
    ok: false,
    error: (e && e.message) || '内部错误',
    code,
    enabled: !!config.SQ_ENABLED,
  }, status);
}

/** GET /api/sqmusic/status —— 集成开关与配置（未启用也返回 200，供前端渲染引导页） */
function status(res) {
  return json(res, { ok: true, status: sq.status() });
}

/** POST /api/sqmusic/search —— 搜索单曲 */
async function search(req, res) {
  try {
    const body = await readJson(req);
    const keyword = String(body.keyword || '').trim();
    if (!keyword) return json(res, { ok: false, error: '搜索关键词不能为空', code: 'bad-request' }, 400);

    const r = await sq.search(keyword, {
      plugName: body.plugName,
      pageSize: body.pageSize,
      pageIndex: body.pageIndex,
    });
    return json(res, { ok: true, ...r });
  } catch (e) {
    return fail(res, e, 'search');
  }
}

/** POST /api/sqmusic/download —— 下发下载任务 */
async function download(req, res) {
  try {
    const body = await readJson(req);
    const r = await sq.download({
      key: body.key,
      song: body.song,
      brType: body.brType,
    });
    return json(res, { ok: true, download: r });
  } catch (e) {
    return fail(res, e, 'download');
  }
}

/**
 * 下载任务列表 / 进度
 * 顺带承担「下载完成后自动增量扫描」的触发点：
 *   前端每 2s 轮询本接口 → 服务端发现「新完成」的任务 → 触发一次增量扫描
 *   （增量扫描只补充 SqMusic 给不了的字段，不覆盖它已写好的内嵌标签）
 */
async function tasks(res) {
  try {
    const r = await sq.tasks();
    const triggered = maybeAutoScan(r.items);
    return json(res, {
      ok: true,
      items: r.items,
      counts: r.counts,
      total: r.total,
      autoScan: { enabled: !!config.SQ_AUTO_SCAN, triggered, lastAt: lastAutoScanAt || 0 },
    });
  } catch (e) {
    return fail(res, e, 'tasks');
  }
}

/**
 * 识别「新完成」的下载任务并触发增量扫描。
 * @param {Array<{id:string, status:string}>} items
 * @returns {string} 触发的扫描 taskId，未触发时返回 ''
 */
function maybeAutoScan(items = []) {
  const doneIds = items.filter((t) => t.status === 'success').map((t) => String(t.id));
  // 首次轮询只做基线登记：历史成功任务不算「新完成」，避免一打开页面就扫全库
  if (!primed) {
    primed = true;
    for (const id of doneIds) seenSuccess.add(id);
    trimSeen();                 // 基线可能一次性灌入大量历史任务，同样需要有界
    return '';
  }

  const fresh = doneIds.filter((id) => !seenSuccess.has(id));
  for (const id of doneIds) seenSuccess.add(id);
  trimSeen();
  if (!fresh.length) return '';
  if (!config.SQ_AUTO_SCAN) return '';
  if (Date.now() - lastAutoScanAt < AUTO_SCAN_COOLDOWN_MS) return '';

  // 懒加载：未启用 SqMusic 时完全不牵连扫描/存储链路
  let scanTask;
  try {
    scanTask = require('../scan/task');
  } catch (e) {
    log.warn('增量扫描模块加载失败', { error: e.message });
    return '';
  }
  const st = scanTask.status ? scanTask.status() : {};
  if (st.running) {
    log.info('已有扫描任务在运行，跳过本次自动增量扫描', { songs: fresh.length });
    return '';
  }

  lastAutoScanAt = Date.now();
  let taskId = '';
  Promise.resolve(scanTask.start({
    mode: 'incremental',
    useL3: true,
    protectExisting: true,      // 保护 SqMusic 已写好的内嵌字段，只补充 L3 标签
  })).then((r) => {
    taskId = (r && r.taskId) || '';
    log.info('SqMusic 下载完成，已触发增量扫描', { scanTaskId: taskId, songs: fresh.length });
  }).catch((e) => {
    log.warn('自动增量扫描启动失败', { error: e.message });
  });
  return 'pending';
}

/** POST /api/sqmusic/test —— 连通性自检 */
async function ping(res) {
  try {
    const r = await sq.ping();
    return json(res, { ok: true, ...r });
  } catch (e) {
    return fail(res, e, 'test');
  }
}

module.exports = { status, search, download, tasks, ping, json, readJson, maybeAutoScan, AUTO_SCAN_COOLDOWN_MS };
