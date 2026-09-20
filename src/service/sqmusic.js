'use strict';
/**
 * SqMusic 客户端 —— 在线搜歌 / 下载 / 任务进度
 *
 * 职责边界（TunePick 原则）：
 *   TunePick **只下发下载任务**，写文件（建目录 / 写 ID3 / 封面 / 歌词）由 SqMusic 完成，
 *   绝不修改或覆盖音乐原文件。下载完成后只做「增量扫描入库」。
 *
 * 接口契约：
 *   登录  POST /api/config/login          {"username","password","device"} → data.tokenValue
 *   搜索  GET  /api/music/searchSong      ?plugName=&keyword=&pageSize=&pageIndex=
 *   下载  POST /api/download/downloadSong  body = 搜索结果整条 record + brType
 *   任务  POST /api/task/list   body {"pageIndex":1,"pageSize":50}（⚠️ 不支持 GET）
 *   探针  GET  /api/config/version
 *   下载任务字段是 download* 前缀：downloadMusicname / downloadArtistname / downloadBrType / downloadStatus …
 *   鉴权  请求头 `sqmusic: <tokenValue>`（除登录外全部需要）
 *
 * ⚠️ 网络层只用 Node 内置 http/https（经 src/util/net.js 的 rawRequest）。
 *    实测：全局 fetch(undici) 并发请求上游会整体卡死，禁止在本模块使用。
 *    且内网地址必须 noProxy=true，否则会被 HTTP_PROXY 接管而失败。
 */

const net = require('../util/net');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('service:sqmusic');

/** 搜索结果缓存上限与有效期（下载需要整条原始 record，不落浏览器） */
const SEARCH_CACHE_MAX = 1000;
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;

/** key → { record, at } */
const searchCache = new Map();

/** 下载目录缓存（SqMusic 配置很少变，10 分钟足够；resetClient 时会清掉） */
const CONFIG_CACHE_TTL_MS = 10 * 60 * 1000;
let dirCache = { v: '', at: 0 };

/**
 * 试听直链缓存 —— 只缓存 30 秒。
 * ⚠️ 实测：getDownloadUrl 返回的 URL 中间段 hex 随时间递增（如 .../6aafee1b/... →
 *    .../6aafefa6/...），是带时间签名的临时地址，长缓存必然失效。
 *    同一次播放会话内复用即可，绝不要跨会话缓存。
 */
const PREVIEW_CACHE_TTL_MS = 30 * 1000;
const previewCache = new Map();

/** 音源中文名（仅用于界面展示） */
const PLUGIN_LABELS = {
  kw: '酷我',
  kg: '酷狗',
  qq: 'QQ音乐',
  netease: '网易云',
};

/* ==========================================================================
 * 错误类型
 * ========================================================================== */

class SqError extends Error {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {number} status  建议的 HTTP 状态码
   * @param {string} code    机器可读错误码
   */
  constructor(message, status = 502, code = 'sqmusic') {
    super(message);
    this.name = 'SqError';
    this.status = status;
    this.code = code;
  }
}

/* ==========================================================================
 * 工具函数
 * ========================================================================== */

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function toStrArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/[,/、;；]|\s+&\s+/).map((s) => s.trim()).filter(Boolean);
  }
  return [String(v).trim()].filter(Boolean);
}

/**
 * 任务状态归一化 → waiting | downloading | success | error
 * ⚠️ 顺序敏感：'waiting' 里含 'ing'，必须先判等待态再判进行态。
 */
function normalizeStatus(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return 'waiting';
  if (/wait|queue|pending|等待|排队/.test(s)) return 'waiting';
  if (/success|成功|完成|done|finish/.test(s)) return 'success';
  if (/error|fail|失败|错误/.test(s)) return 'error';
  if (/download|下载|running|progress|进行/.test(s)) return 'downloading';
  return 'waiting';
}

/** 从 brTypes（如 KW_FLAC_2000 / KW_MP3_320 / KW_MP3_128）里挑最高码率 */
function bestBrType(brTypes = []) {
  const list = toStrArray(brTypes);
  if (!list.length) return '';
  const rate = (b) => {
    const m = /(\d{3,4})\s*$/.exec(b);
    return m ? parseInt(m[1], 10) : 0;
  };
  const rank = (b) => (/flac|ape|wav|lossless/i.test(b) ? 1 : 0);
  return [...list].sort((a, b) => (rate(b) - rate(a)) || (rank(b) - rank(a)))[0];
}

function putCache(key, record) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { record, at: Date.now() });
}

function getCache(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.record;
}

/**
 * 搜索结果归一化为前端展示结构
 * @param {object} rec SqMusic 返回的原始 record
 * @param {string} plugName 音源
 * @returns {object|null}
 */
function normalizeSong(rec, plugName = '') {
  if (!rec || typeof rec !== 'object') return null;
  const id = String(rec.id || rec.songId || rec.musicId || '').trim();
  const name = String(rec.name || rec.songName || rec.title || '').trim();
  if (!id || !name) return null;

  const artists = toStrArray(rec.artistName);
  const brTypes = toStrArray(rec.brTypes);
  const durationMs = Number(rec.duration != null ? rec.duration : (rec.dataInfo && rec.dataInfo.DURATION));

  return {
    key: `${plugName}:${id}`,
    id,
    name,
    artists,
    artist: artists.join(' / ') || String(rec.artist || '').trim(),
    albumName: String(rec.albumName || (rec.dataInfo && rec.dataInfo.ALBUM) || '').trim(),
    albumId: String(rec.albumId || rec.albumid || '').trim(),
    picUrl: String(rec.pic || '').trim(),
    durationSec: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    brTypes,
    defaultBrType: bestBrType(brTypes),
    plugName: String(rec.plugName || plugName || '').trim(),
    hasLyric: !!(rec.lyric && String(rec.lyric).trim()),
  };
}

/**
 * 下载任务归一化
 *
 * ⚠️ 真实服务的字段名是 download* 前缀（实测 http://<host>/api/task/list）：
 *    id / downloadGid / downloadTime / downloadFile / downloadMusicId / downloadPlugName /
 *    downloadBrType / downloadMusicname / downloadArtistname / downloadAlbumname /
 *    downloadMsg / downloadMusicInfo / downloadStatus / downloadUpdateTime / …
 *    —— 真实任务记录里**不存在** name / artist / album / brType 这些键。
 *
 * ⚠️ 取值顺序约定（不要改回去）：
 *    **download* 真实字段在前，早期猜测字段只在尾部兜底。**
 *    以前把 name/artist/album/brType 写在最前面，只是因为真实响应里恰好没有同名键才没出错；
 *    一旦 SqMusic 某版本新增了这些键（哪怕语义不同），我们会静默取到错值。
 *    唯一例外：`downloadFile` 的值是「后来 - 刘若英」这种「歌名 - 歌手」拼接串，
 *    只能当兜底，必须排在 downloadMusicname 之后。
 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.downloadGid || raw.taskId || raw.musicId || raw.songId || '').trim();
  // 真实字段在前，猜测字段兜底（顺序约定见函数头注释，勿改）
  const name = String(raw.downloadMusicname || raw.downloadFile
    || raw.name || raw.songName || raw.musicName || raw.title || '').trim();
  if (!id && !name) return null;
  const brType = String(raw.downloadBrType || raw.brType || raw.br || '').trim();
  const durationSec = durationSecFromTask(raw);
  return {
    id: id || name,
    name,
    artist: String(raw.downloadArtistname || raw.artistName || raw.artist || '').trim(),
    album: String(raw.downloadAlbumname || raw.albumName || raw.album || '').trim(),
    brType,
    status: normalizeStatus(raw.downloadStatus || raw.status || raw.state),
    progress: Number(raw.progress ?? raw.percent ?? 0) || 0,
    // ⚠️ filePath/path/savePath 三个键在真实任务记录里都不存在（真实字段清单见函数头注释），
    //    仅作兼容占位；前端看到的文件路径来自 API 层曲库配对后回填的 filePath。
    filePath: String(raw.filePath || raw.path || raw.savePath || '').trim(),
    message: String(raw.downloadMsg || raw.message || raw.msg || raw.error || '').trim(),
    // ---- 算「耗时 / 速度 / 估算大小」需要的字段，原样透传不做加工 ----
    startedAt: String(raw.downloadTime || raw.startedAt || '').trim(),
    updatedAt: String(raw.downloadUpdateTime || raw.updatedAt || '').trim(),
    bitrateKbps: bitrateFromBrType(brType),
    plugName: String(raw.downloadPlugName || raw.plugName || '').trim(),
    durationSec,
    durationMs: durationSec * 1000,
  };
}

/** 从 /api/task/list 的响应体里取出任务数组（兼容 array / {records} / {list} / {content}） */
function pickTaskList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of ['records', 'list', 'tasks', 'content', 'items']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

/**
 * 从 /api/config/getConfigList 的响应里取出配置数组。
 * 兼容多种形态：顶层数组 / {data:[…]} / {data:{records:[…]}} —— 不写死某一种。
 */
function pickConfigList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  const KEYS = ['records', 'list', 'items', 'content', 'configs'];
  const d = body.data;
  if (d && typeof d === 'object') {
    for (const k of KEYS) if (Array.isArray(d[k])) return d[k];
  }
  for (const k of KEYS) if (Array.isArray(body[k])) return body[k];
  return [];
}

/** 从 brType（如 KW_FLAC_2000 / kw_mp3_320）末尾解析码率 kbps，解析不出为 0 */
function bitrateFromBrType(brType) {
  const m = /(\d{3,4})\s*$/.exec(String(brType == null ? '' : brType).trim());
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 从任务的 downloadMusicInfo 里取时长（秒）。
 * downloadMusicInfo 在真实服务里是 **JSON 字符串**，需先解析。
 * 实测其中 duration 是秒（"309"），而搜索 record 的 duration 是毫秒（"309000"），
 * 因此大于 600 的值按毫秒处理（600 秒 = 10 分钟，正常单曲不会超过）。
 */
function durationSecFromTask(raw) {
  let info = raw && raw.downloadMusicInfo;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch (_) { info = null; }
  }
  if (!info || typeof info !== 'object') return 0;
  const n = Number(info.duration ?? info.durationSec ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 600 ? Math.round(n / 1000) : Math.round(n);
}

/* ==========================================================================
 * 客户端
 * ========================================================================== */

class SqMusicClient {
  /**
   * @param {{baseUrl?:string, username?:string, password?:string, timeoutMs?:number}} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = String(opts.baseUrl || config.SQ_BASE_URL || '').replace(/\/+$/, '');
    this.username = opts.username != null ? opts.username : config.SQ_USERNAME;
    this.password = opts.password != null ? opts.password : config.SQ_PASSWORD;
    this.timeoutMs = opts.timeoutMs || config.SQ_TIMEOUT_MS || 15000;
    this.token = '';
    this._loginPromise = null;
  }

  /** 未启用时抛错（503），由 API 层转成优雅降级响应 */
  assertEnabled() {
    if (!config.SQ_ENABLED) {
      throw new SqError('未启用 SqMusic 集成', 503, 'disabled');
    }
    if (!this.baseUrl) {
      throw new SqError('未配置 SQ_BASE_URL', 503, 'not-configured');
    }
    return true;
  }

  /**
   * 登录并缓存 token（token 永不过期，但进程重启后需重新获取）
   * @param {boolean} [force] 强制重新登录
   * @returns {Promise<string>} tokenValue
   */
  async login(force = false) {
    if (this.token && !force) return this.token;
    // 并发去重：多个请求同时发现无 token 时只登录一次
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = (async () => {
      const body = await this._request('POST', '/api/config/login', {
        body: { username: this.username, password: this.password, device: 'web' },
        skipAuth: true,
        retryAuth: false,
      });
      const data = body.data || {};
      const tokenValue = String(data.tokenValue || data.token || '').trim();
      if (!tokenValue) {
        throw new SqError('SqMusic 登录未返回 token（检查 SQ_USERNAME / SQ_PASSWORD）', 502, 'no-token');
      }
      this.token = tokenValue;
      log.info('SqMusic 登录成功', { baseUrl: this.baseUrl, tokenName: data.tokenName || 'sqmusic' });
      return this.token;
    })();

    try {
      return await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  /** 取有效 token（无则登录） */
  async ensureToken() {
    return this.login();
  }

  /**
   * 统一的 HTTP 请求：带 sqmusic 头、解析 JSON、401 自动重登一次
   * @param {string} method
   * @param {string} path
   * @param {{query?:object, body?:any, skipAuth?:boolean, retryAuth?:boolean}} [opts]
   * @returns {Promise<object>} 已校验的响应体
   */
  async _request(method, path, opts = {}) {
    const query = opts.query || null;
    const qs = query
      ? '?' + Object.keys(query)
          .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== '')
          .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`)
          .join('&')
      : '';
    const url = this.baseUrl + path + qs;

    const headers = { Accept: 'application/json, text/plain, */*' };
    if (!opts.skipAuth) {
      const token = await this.ensureToken();
      if (token) headers.sqmusic = token;
    }

    let payload = null;
    if (opts.body !== undefined && opts.body !== null) {
      payload = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    let res;
    try {
      res = await net.rawRequest(url, {
        method,
        headers,
        body: payload,
        timeoutMs: this.timeoutMs,
        noProxy: true,          // 内网/容器名直连，绝不过代理
      });
    } catch (e) {
      throw new SqError(`无法连接 SqMusic（${this.baseUrl}）：${e.message}`, 502, 'unreachable');
    }

    // 401：token 失效（服务端重启/清库）→ 清缓存重登后重试一次
    if (res.status === 401 && opts.retryAuth !== false) {
      log.warn('SqMusic token 失效，自动重登后重试', { path });
      this.token = '';
      return this._request(method, path, { ...opts, retryAuth: false });
    }

    if (!res.status) throw new SqError(`SqMusic 无响应（${this.baseUrl}）`, 502, 'unreachable');
    if (res.status < 200 || res.status >= 300) {
      throw new SqError(`SqMusic 返回 HTTP ${res.status}`, 502, 'http');
    }

    let body = null;
    try {
      body = res.text ? JSON.parse(res.text) : null;
    } catch (_) {
      throw new SqError('SqMusic 返回非 JSON 响应', 502, 'parse');
    }
    if (!body) throw new SqError('SqMusic 返回空响应', 502, 'parse');
    if (body.code !== undefined && Number(body.code) !== 200) {
      throw new SqError(`SqMusic 返回业务码 ${body.code}${body.msg ? '：' + body.msg : ''}`, 502, 'business');
    }
    return body;
  }

  /**
   * 搜索单曲
   * @param {string} keyword
   * @param {{plugName?:string, pageSize?:number, pageIndex?:number}} [opts]
   */
  async search(keyword, opts = {}) {
    this.assertEnabled();
    const kw = String(keyword || '').trim();
    if (!kw) throw new SqError('搜索关键词不能为空', 400, 'bad-request');

    const plugName = String(opts.plugName || config.SQ_PLUGINS[0] || 'kw').trim() || 'kw';
    const pageSize = clampInt(opts.pageSize, 20, 1, 100);
    const pageIndex = clampInt(opts.pageIndex, 1, 1, 1000);

    const body = await this._request('GET', '/api/music/searchSong', {
      query: { plugName, keyword: kw, pageSize, pageIndex },
    });

    const data = body.data || {};
    const records = Array.isArray(data.records) ? data.records
      : (Array.isArray(data.list) ? data.list : []);

    const items = [];
    for (const rec of records) {
      const norm = normalizeSong(rec, plugName);
      if (!norm) continue;
      putCache(norm.key, rec);          // 下载时需要整条原始 record
      items.push(norm);
    }

    const total = Number(data.searchTotal ?? data.total ?? records.length);
    log.info('SqMusic 搜索完成', { keyword: kw, plugName, hits: items.length });
    return {
      plugName,
      pluginLabel: PLUGIN_LABELS[plugName] || plugName,
      keyword: kw,
      pageIndex,
      pageSize,
      total: Number.isFinite(total) ? total : items.length,
      items,
    };
  }

  /**
   * 下发下载任务
   * @param {{key?:string, song?:object, brType?:string}} payload
   *        key    —— 搜索结果缓存键（推荐，服务端保留完整 record）
   *        song   —— 原始 record（兜底，客户端回传时使用）
   *        brType —— 指定码率；留空则用 SQ_BR_TYPE 或由 SqMusic 自动选最高
   */
  async download(payload = {}) {
    this.assertEnabled();

    let record = null;
    if (payload.key) {
      record = getCache(String(payload.key));
      if (!record) {
        throw new SqError('搜索结果已过期，请重新搜索后再下载', 400, 'cache-miss');
      }
    } else if (payload.song && typeof payload.song === 'object') {
      record = payload.song;
    } else {
      throw new SqError('缺少下载参数：需要 key 或 song', 400, 'bad-request');
    }

    const brType = String(payload.brType || config.SQ_BR_TYPE || '').trim();
    const bodyObj = brType ? { ...record, brType } : { ...record };

    const body = await this._request('POST', '/api/download/downloadSong', { body: bodyObj });
    const data = body.data || {};

    const result = {
      accepted: true,
      status: normalizeStatus(data.downloadStatus || data.status || 'waiting'),
      songId: String(record.id || '').trim(),
      name: String(record.name || '').trim(),
      brType: brType || bestBrType(record.brTypes) || '',
      raw: data,
    };
    log.info('SqMusic 下载任务已入队', { name: result.name, brType: result.brType, status: result.status });
    return result;
  }

  /**
   * 下载任务列表与进度
   *
   * ⚠️ 实测：/api/task/list **只接受 POST**，GET 会返回
   *    {"code":500,"msg":"Request method 'GET' not supported"}（HTTP 200 包业务错误）。
   *    且 body 必须带 pageIndex/pageSize，缺 pageIndex 服务端会 NPE。
   */
  async tasks(opts = {}) {
    this.assertEnabled();
    const reqBody = {
      pageIndex: opts.pageIndex || 1,
      pageSize: opts.pageSize || 50,
    };
    // 实测：task/list 支持 downloadStatus 过滤（传 'success' 即「已下载」列表）
    const status = String(opts.status || '').trim();
    if (status) reqBody.downloadStatus = status;

    const body = await this._request('POST', '/api/task/list', { body: reqBody });
    const data = body.data || {};
    const raw = pickTaskList(data);
    const items = raw.map(normalizeTask).filter(Boolean);
    const counts = { waiting: 0, downloading: 0, success: 0, error: 0 };
    for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
    const total = Number(data.total);
    return { items, counts, total: Number.isFinite(total) ? total : items.length };
  }

  /** 已下载列表 —— 就是 task/list 按 downloadStatus=success 过滤 */
  async downloaded(opts = {}) {
    return this.tasks({ ...opts, status: 'success' });
  }

  /**
   * 读取 SqMusic 的下载保存目录
   * @param {boolean} [force] 跳过缓存强制重读
   * @returns {Promise<{downloadPath:string, error:string}>} 失败不抛，error 给原因
   */
  async getConfig(force = false) {
    this.assertEnabled();
    if (!force && dirCache.v && Date.now() - dirCache.at < CONFIG_CACHE_TTL_MS) {
      return { downloadPath: dirCache.v, error: '' };
    }
    try {
      const body = await this._request('GET', '/api/config/getConfigList');
      const list = pickConfigList(body);
      let path = '';
      for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        if (String(c.configKey || '').trim() === 'system.download.path') {
          path = String(c.configValue || '').trim();
          break;
        }
      }
      dirCache = { v: path, at: Date.now() };
      if (!path) {
        return { downloadPath: '', error: 'SqMusic 未返回下载路径（system.download.path）' };
      }
      return { downloadPath: path, error: '' };
    } catch (e) {
      // 读不到目录不能让页面崩掉：交给前端显示「未能读取下载目录」
      log.warn('读取 SqMusic 下载目录失败', { error: e && e.message });
      return { downloadPath: '', error: (e && e.message) || '读取失败' };
    }
  }

  /**
   * 取试听直链
   * @param {{key:string, brType?:string}} payload
   * @returns {Promise<{url:string, brType:string, bit:string, plugBrTypeId:string, name:string, artist:string, key:string}>}
   */
  async preview(payload = {}) {
    this.assertEnabled();
    const key = String(payload.key || '').trim();
    if (!key) throw new SqError('缺少试听参数：需要 key', 400, 'bad-request');
    const record = getCache(key);
    if (!record) throw new SqError('搜索结果已过期，请重新搜索后再试听', 400, 'cache-miss');

    // 码率：入参 → 自动挑最高（实测最高档是 FLAC/320，Content-Type 正常；
    // 不要降级到 128 —— 实测 128 档返回 application/octet-stream，浏览器不一定播）
    const brType = String(payload.brType || '').trim() || bestBrType(record.brTypes) || '';

    const ck = `${key}|${brType}`;
    const hit = previewCache.get(ck);
    if (hit && Date.now() - hit.at < PREVIEW_CACHE_TTL_MS) return { ...hit.data };

    const body = await this._request('POST', '/api/music/getDownloadUrl', {
      body: brType ? { ...record, brType } : { ...record },
    });
    const d = body.data || {};
    const url = String(d.url || '').trim();
    if (!url) throw new SqError('未取得播放地址（SqMusic 未返回直链）', 502, 'no-url');

    const data = {
      url,
      brType: String(d.plugBrTypeId || brType || '').trim(),
      bit: String(d.bit || '').trim(),
      plugBrTypeId: String(d.plugBrTypeId || '').trim(),
      name: String(record.name || '').trim(),
      artist: toStrArray(record.artistName).join(' / '),
      key,
    };
    previewCache.set(ck, { data, at: Date.now() });
    return { ...data };
  }

  /** 连通性自检（登录 + 探一个只读端点） */
  async ping() {
    this.assertEnabled();
    const started = Date.now();
    await this.login(true);
    // /api/task/list 是 POST-only，不适合做探针；/api/config/version 是 GET 且实测 200
    await this._request('GET', '/api/config/version');
    return { ok: true, latencyMs: Date.now() - started, baseUrl: this.baseUrl };
  }
}

/* ==========================================================================
 * 单例（懒加载：配置在 require 之后被修改也能生效）
 * ========================================================================== */

let client = null;

function getClient() {
  if (!client) client = new SqMusicClient();
  return client;
}

/** 丢弃单例（配置变更后 / 测试用）；顺带清掉下载目录缓存 */
function resetClient() {
  client = null;
  dirCache = { v: '', at: 0 };
  return getClient();
}

/** 集成状态（供 /api/sqmusic/status 与前端引导页使用） */
function status() {
  return {
    enabled: !!config.SQ_ENABLED,
    baseUrl: config.SQ_BASE_URL || '',
    username: config.SQ_USERNAME || '',
    plugins: (config.SQ_PLUGINS || []).slice(),
    pluginLabels: PLUGIN_LABELS,
    brType: config.SQ_BR_TYPE || '',
    autoScan: !!config.SQ_AUTO_SCAN,
    loggedIn: !!(client && client.token),
  };
}

module.exports = {
  SqMusicClient,
  SqError,
  getClient,
  resetClient,
  status,
  normalizeSong,
  normalizeTask,
  normalizeStatus,
  bestBrType,
  bitrateFromBrType,
  pickConfigList,
  durationSecFromTask,
  PLUGIN_LABELS,
  // 便捷入口：直接用单例
  search: (kw, opts) => getClient().search(kw, opts),
  download: (payload) => getClient().download(payload),
  tasks: (opts) => getClient().tasks(opts || {}),
  downloaded: (opts) => getClient().downloaded(opts || {}),
  preview: (payload) => getClient().preview(payload),
  configInfo: () => getClient().getConfig(),
  ping: () => getClient().ping(),
};
