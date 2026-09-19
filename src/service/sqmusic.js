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
 *    downloadMusicname / downloadArtistname / downloadAlbumname / downloadBrType /
 *    downloadStatus / downloadMsg / downloadFile / downloadGid
 * 早期版本猜测的 name/artist/album 等键保留在回退链尾部做兼容。
 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.downloadGid || raw.taskId || raw.musicId || raw.songId || '').trim();
  const name = String(raw.name || raw.downloadMusicname || raw.downloadFile
    || raw.songName || raw.musicName || raw.title || '').trim();
  if (!id && !name) return null;
  return {
    id: id || name,
    name,
    artist: String(raw.artist || raw.artistName || raw.downloadArtistname || '').trim(),
    album: String(raw.album || raw.albumName || raw.downloadAlbumname || '').trim(),
    brType: String(raw.brType || raw.downloadBrType || raw.br || '').trim(),
    status: normalizeStatus(raw.downloadStatus || raw.status || raw.state),
    progress: Number(raw.progress ?? raw.percent ?? 0) || 0,
    filePath: String(raw.filePath || raw.path || raw.savePath || '').trim(),
    message: String(raw.message || raw.downloadMsg || raw.msg || raw.error || '').trim(),
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
    const body = await this._request('POST', '/api/task/list', {
      body: {
        pageIndex: opts.pageIndex || 1,
        pageSize: opts.pageSize || 50,
      },
    });
    const data = body.data || {};
    const raw = pickTaskList(data);
    const items = raw.map(normalizeTask).filter(Boolean);
    const counts = { waiting: 0, downloading: 0, success: 0, error: 0 };
    for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
    const total = Number(data.total);
    return { items, counts, total: Number.isFinite(total) ? total : items.length };
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

/** 丢弃单例（配置变更后 / 测试用） */
function resetClient() {
  client = null;
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
  PLUGIN_LABELS,
  // 便捷入口：直接用单例
  search: (kw, opts) => getClient().search(kw, opts),
  download: (payload) => getClient().download(payload),
  tasks: () => getClient().tasks(),
  ping: () => getClient().ping(),
};
