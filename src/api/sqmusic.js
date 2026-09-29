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

/** GET /api/sqmusic/dir —— SqMusic 的下载保存目录（读不到只给 error，不崩页面） */
async function dir(res) {
  try {
    const r = await sq.configInfo();
    return json(res, { ok: true, downloadPath: r.downloadPath || '', error: r.error || '' });
  } catch (e) {
    return fail(res, e, 'dir');
  }
}

/**
 * POST /api/sqmusic/preview —— 试听直链
 * ⚠️ 直链带时间签名会过期，服务端只缓存 30s；前端失效时重新点一次即可。
 */
async function preview(req, res) {
  try {
    const body = await readJson(req);
    const r = await sq.preview({ key: body.key, brType: body.brType });
    return json(res, {
      ok: true,
      url: r.url,
      brType: r.brType,
      bit: r.bit,
      name: r.name,
      artist: r.artist,
      key: r.key,
    });
  } catch (e) {
    return fail(res, e, 'preview');
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

/* ==========================================================================
 * 已下载列表：SqMusic 的成功任务 × TunePick 曲库配对
 * ========================================================================== */

/** 归一化歌名/歌手用于比较：小写 + 去空格 + 剔除括号内容（《后来的我们》这类副信息） */
function normName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '');
}

/** 相等或互相包含即认为对得上 */
function namesMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** 双方都有歌手时才要求歌手对得上（与旧逻辑一致：宁可判「未入库」也不瞎猜） */
function artistOk(track, nArtist) {
  if (!nArtist) return true;
  const candArtist = normName(track.cleanArtist || track.artist);
  if (!candArtist) return true;
  return namesMatch(candArtist, nArtist);
}

/* ---------------- 文件名兜底配对 ----------------
 * 为什么需要：SqMusic 下载的文件，其**内嵌标签**可能是繁体（实测「漂洋过海来看你」
 * 入库后 title=飄洋過海來看你 / artist=劉明湘），而下载任务名是简体 →
 * 按标题索引永远对不上。但**文件名**是 SqMusic 按任务信息写的简体
 * （「漂洋过海来看你 - 刘明湘.flac」），且包含真实歌手 → 用它兜底非常可靠。
 */

/** 去扩展名后的文件名主体（「漂洋过海来看你 - 刘明湘.flac」→「漂洋过海来看你 - 刘明湘」） */
function fileNameCore(fileName) {
  return String(fileName || '').replace(/\.[a-zA-Z0-9]{1,5}$/, '').trim();
}

/** 文件名首段 = 歌名部分（按「 - 」切第一段；SqMusic 命名固定「歌名 - 歌手」） */
function fileNameTitle(fileName) {
  const base = fileNameCore(fileName);
  const seg = base.split(/\s+[-–—]\s+/)[0] || base;
  return seg.trim();
}

/**
 * 文件名路径的歌手校验：标签歌手对不上时，只要**文件名里含有任务歌手**也算过
 * （文件名是 SqMusic 用任务信息拼的，可信度高于内嵌标签）。
 */
function artistOkViaFile(track, nArtist) {
  if (!nArtist) return true;
  if (artistOk(track, nArtist)) return true;
  const inFile = normName(fileNameCore(track.fileName));
  return !!inFile && inFile.includes(nArtist);
}

/** 建索引时一次最多取多少条（与 /api/export 同量级，够覆盖正常曲库） */
const LIB_INDEX_LIMIT = 100000;

/**
 * 用「一次」db.filter 建「归一化歌名 → 曲目」索引（O(N)，N = 曲库条数）
 *
 * ⚠️ 刻意复用 db.filter 而不是 db.all()：
 *    1) 数据口径与排序顺序和旧实现完全一致（旧实现就是在 filter 的排序结果里取第一条），
 *       配对结果不会因改实现而发生漂移；
 *    2) 兼容既有测试对 db.filter 的桩替换。
 *    关键变化是「只查一次」而不是「每条查一次」。
 */
function buildNameIndex(db) {
  if (!db || typeof db.filter !== 'function') return null;
  const r = db.filter({ limit: LIB_INDEX_LIMIT });
  const items = (r && r.items) || [];
  if (!Array.isArray(items) || !items.length) return null;   // 空库 → 交给 legacy 路径
  const title = new Map();
  const file = new Map();                                     // 文件名兜底索引（键 → 候选数组，同名文件段很常见）
  for (const t of items) {
    if (!t || typeof t !== 'object') continue;
    const nName = normName(t.cleanTitle || t.title);
    if (nName && !title.has(nName)) title.set(nName, t);     // 重名取排序靠前的那条（与旧实现一致）
    const core = fileNameCore(t.fileName);
    if (core) {
      for (const k of new Set([normName(core), normName(fileNameTitle(t.fileName))])) {
        if (!k) continue;
        if (!file.has(k)) file.set(k, []);
        file.get(k).push(t);
      }
    }
  }
  return { title, file };
}

/** 索引内配对：标题索引精确 → 标题互相包含兜底 → 文件名索引（精确 / 前缀互含） */
function matchInIndex(index, name, artist) {
  const nName = normName(name);
  const nArtist = normName(artist);
  if (!nName) return null;

  // 1) 标题精确命中
  const hit = index.title.get(nName);
  if (hit && artistOk(hit, nArtist)) return hit;

  // 2) 标题互相包含兜底：旧实现用的是 includes 双向匹配（「后来的我们」能对上「后来」），
  //    精确表命中不了时线性扫一遍保留旧行为；这里只是字符串比较，不再有全库排序开销。
  for (const [candName, t] of index.title) {
    if (!namesMatch(candName, nName)) continue;
    if (!artistOk(t, nArtist)) continue;
    return t;
  }

  // 3) 文件名兜底：内嵌标签是繁体/异体字时标题路径全灭，但文件名是 SqMusic 按
  //    任务信息写的简体。先精确（文件名首段=任务名），再前缀互含
  //    （任务名带「-《…》电视剧插曲」副标题时，首段是它的前缀）。歌手校验放宽到
  //    「文件名里含有任务歌手」即可（artistOkViaFile）。
  const tryFileCandidates = (cands) => {
    for (const t of cands || []) {
      if (t && artistOkViaFile(t, nArtist)) return t;
    }
    return null;
  };
  let fHit = tryFileCandidates(index.file.get(nName));
  if (fHit) return fHit;
  for (const [candName, cands] of index.file) {
    const matched = candName === nName || candName.startsWith(nName) || nName.startsWith(candName);
    if (!matched) continue;
    fHit = tryFileCandidates(cands);
    if (fHit) return fHit;
  }
  return null;
}

/**
 * 旧路径（仅在曲库为空 / db 没有 all() 时启用）：每条一次 db.filter。
 * 保留它是为了行为兼容（db.filter 被桩替换时结果不变），此时 N≈0，成本可忽略。
 */
function legacyMatcher(db) {
  if (!db || typeof db.filter !== 'function') return () => null;
  return (name, artist) => {
    const nName = normName(name);
    const nArtist = normName(artist);
    if (!nName) return null;
    const r = db.filter({ q: name, limit: 50 });
    for (const t of (r && r.items) || []) {
      const candName = normName(t.cleanTitle || t.title);
      if (!namesMatch(candName, nName)) continue;
      const candArtist = normName(t.cleanArtist || t.artist);
      if (nArtist && candArtist && !namesMatch(candArtist, nArtist)) continue;
      return t;
    }
    return null;
  };
}

/**
 * 建一个「已下载条目 → 曲库曲目」的配对器。
 *
 * ⚠️ 为什么要它：旧实现是**每条**调一次 db.filter，
 *    db.filter 会全库 filter + localeCompare 排序（zh 排序很贵）；
 *    /api/sqmusic/downloaded 与 /api/v1/sqmusic/downloaded 最多 500 条
 *    → 500 次全库排序，单次请求能把主线程钉死几秒。
 *    改成「只查一次建索引 + 每条 O(1) 命中」，配对结果不变。
 *
 * @returns {(name:string, artist:string) => object|null} 配对函数
 */
function createLibraryMatcher() {
  let db;
  try { db = require('../store/db'); } catch (e) { return () => null; }
  const index = buildNameIndex(db);
  if (!index) return legacyMatcher(db);
  return (name, artist) => matchInIndex(index, name, artist);
}

/**
 * 在 TunePick 曲库里找与「已下载任务条目」对应的曲目（单条便捷入口）。
 * 防误配：歌名必须先对上；双方都有歌手时歌手也要对得上，否则宁可判「未入库」不瞎猜。
 *
 * @returns {object|null} 命中的曲目对象（含 filePath / fileSizeBytes），未命中 null
 */
function matchTrackInLibrary(name, artist) {
  return createLibraryMatcher()(name, artist);
}

/**
 * GET /api/sqmusic/downloaded —— 已下载列表
 * query: pageIndex(默认 1) / pageSize(默认 50)
 */
async function downloaded(res, url) {
  try {
    const sp = (url && url.searchParams) || new URLSearchParams();
    const pageIndex = parseInt(sp.get('pageIndex') || '1', 10) || 1;
    const pageSize = parseInt(sp.get('pageSize') || '50', 10) || 50;

    const r = await sq.downloaded({ pageIndex, pageSize });
    const cfg = await sq.configInfo().catch(() => ({ downloadPath: '', error: '' }));

    // 整个列表共用一份索引：建一次 O(N)，之后每条 O(1)
    const matchTrack = createLibraryMatcher();
    const items = (r.items || []).map((it) => {
      const t = matchTrack(it.name, it.artist);
      return {
        ...it,
        trackId: t ? t.id : '',
        filePath: t ? (t.filePath || '') : '',
        fileSizeBytes: t ? (t.fileSizeBytes || 0) : 0,
        inLibrary: !!t,
      };
    });

    return json(res, {
      ok: true,
      items,
      total: r.total,
      counts: r.counts,
      pageIndex,
      pageSize,
      downloadPath: cfg.downloadPath || '',
      downloadPathError: cfg.error || '',
    });
  } catch (e) {
    return fail(res, e, 'downloaded');
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

module.exports = {
  status,
  search,
  download,
  tasks,
  dir,
  preview,
  downloaded,
  ping,
  json,
  readJson,
  maybeAutoScan,
  matchTrackInLibrary,
  createLibraryMatcher,
  normName,
  namesMatch,
  AUTO_SCAN_COOLDOWN_MS,
};
