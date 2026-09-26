'use strict';
/**
 * 对外开放 API v1 —— /api/v1/*
 *
 * 定位：给外部音乐 App（首页 / 专辑 / 歌手 / 风格 / 歌单 / 搜索 / 收藏 / 最近播放 / 播放器）
 * 提供一层稳定契约；内部 Schema 的演进不再暴露给调用方。
 *
 * 契约约定：
 *   成功：{ ok:true, data }
 *   列表：data = { items:[…], pagination:{ total, limit, offset, page, hasMore } }
 *   失败：{ ok:false, error:{ code, message } } —— 400/404/500
 *
 * ⚠️ 本模块只读曲库 + 读写用户数据，**不修改任何既有端点行为**；
 *    对 src/api/index.js 只新增一段分发（见该文件 /api/v1/ 那一行）。
 *
 * ⚠️ 过滤/排序全部在本模块内对 db.all() 做，不去改 src/store/db.js：
 *    既有 /api/tracks/filter 的语义必须保持原样，不能被 v1 的需求带偏。
 */

const db = require('../store/db');
const schema = require('../store/schema');
const compatApi = require('./compat');
const admin = require('./admin');
const ud = require('../store/userdata');
const v1sq = require('./v1-sq');
const { makeLogger } = require('../logger');

const log = makeLogger('api:v1');

const json = admin.json;

/* ==========================================================================
 * 小工具
 * ========================================================================== */

/** 与 compat.js 内部一致的 djb2 hex —— 专辑 id 必须和 /api/albums 算出来的一样 */
function hash(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * 数值钳制：非法/缺失 → def（默认值）；合法 → 夹到 [lo, hi]
 * @param {any} n 原始入参（通常是 sp.get(...) 的字符串或 null）
 * @param {number} def 缺省值（非法入参时回落到这里）
 * @param {number} lo 下界
 * @param {number} hi 上界
 *
 * ⚠️ 形参顺序是 (n, def, lo, hi)，**4 个**：
 *    三处调用（pager 的 limit、home 的 limit / albumLimit）都按这个顺序传 4 个实参。
 *    曾经写成 3 个形参 (n, lo, hi)，结果 def 被当上界、1 被当下界，
 *    limit 恒等于默认值 → 分页全废、page 按错误 limit 换算 offset → 第二页起空页。
 *    ⚠️ 也不要拿 compat.js 的 clamp 来对齐：那边是 3 参 (n, lo, hi)、自带默认下界，
 *    和这里是两套不同的约定，别互相抄。
 */
function clamp(n, def, lo, hi) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}

/** 成功包 */
function ok(res, data, status = 200) {
  return json(res, { ok: true, data }, status);
}

/** 失败包：错误码 + 中文提示，状态码由调用方给 */
function fail(res, status, code, message) {
  return json(res, { ok: false, error: { code, message } }, status);
}

/**
 * 分页参数解析
 * limit 1..200（默认 defLimit）、offset 默认 0；给了 page（1 起）就覆盖 offset
 * @param {URL} url
 * @param {number} [defLimit]
 * @returns {{limit:number, offset:number, page:number}}
 */
function pager(url, defLimit = 30) {
  const sp = url.searchParams;
  const limit = clamp(sp.get('limit'), defLimit, 1, 200);
  const rawOffset = parseInt(sp.get('offset'), 10);
  let offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const rawPage = parseInt(sp.get('page'), 10);
  if (Number.isFinite(rawPage) && rawPage > 0) offset = (rawPage - 1) * limit;
  return { limit, offset, page: Math.floor(offset / limit) + 1 };
}

/**
 * 内存分页（数据已过滤/排序完毕）
 * @param {Array} arr
 * @param {{limit:number, offset:number, page:number}} p
 * @returns {{items:Array, pagination:{total:number, limit:number, offset:number, page:number, hasMore:boolean}}}
 */
function pageOf(arr, p) {
  const total = arr.length;
  const items = arr.slice(p.offset, p.offset + p.limit);
  return {
    items,
    pagination: {
      total,
      limit: p.limit,
      offset: p.offset,
      page: p.page,
      hasMore: p.offset + items.length < total,
    },
  };
}

/* ==========================================================================
 * 映射器：内部 Schema → v1 契约
 * ========================================================================== */

/** 封面地址：直接复用 compat 的导出，避免两处各写一份、将来格式漂移 */
const coverOf = compatApi.coverUrl;

/** 曲目精简视图（列表用，不含大字段：歌词/简介/来源图） */
function trackLite(t) {
  return {
    id: t.id,
    title: t.cleanTitle || t.title,
    artist: t.cleanArtist || t.artist,
    album: t.album,
    albumTitle: t.album,
    year: t.year || 0,
    durationSec: t.durationSec || 0,
    trackNo: t.trackNo || 0,
    format: t.format || '',
    bitrate: t.bitrate || 0,
    genre: t.genre || '',
    mood: t.mood || [],
    scene: t.scene || [],
    lang: t.lang || '',
    era: t.era || '',
    coverUrl: coverOf(t),
    streamUrl: `/api/stream/${t.id}`,
    lyricUrl: `/api/track/${t.id}/lyric`,
    addedAt: t.createdAt || '',
    updatedAt: t.updatedAt || '',
  };
}

/** 曲目详情（在精简视图上补文件/质量/来源） */
function trackFull(t) {
  return {
    ...trackLite(t),
    fileName: t.fileName || '',
    fileSizeBytes: t.fileSizeBytes || 0,
    sampleRate: t.sampleRate || 0,
    confidence: t.confidence ?? 0,
    qualityLevel: t.qualityLevel || '',
    lyricsSource: t.lyricsSource || '',
    coverSource: t.coverSource || '',
  };
}

/** 专辑视图；addedAt 取成员曲目 createdAt 最大值（App 用来排「最近添加」） */
function albumLite(a, tracks = []) {
  let addedAt = '';
  for (const t of tracks) {
    if (t.createdAt && t.createdAt > addedAt) addedAt = t.createdAt;
  }
  return {
    id: a.id,
    title: a.title,
    artist: a.artist || '',
    year: a.year || 0,
    trackCount: a.trackCount || tracks.length,
    coverUrl: a.coverUrl || '/api/cover/placeholder?size=300',
    albumGroup: a.albumGroup || 'unknown',
    addedAt,
  };
}

/** 歌手视图：albumCount 是去重后的专辑数 */
function artistLite(group) {
  const albums = new Set();
  let cover = '';
  for (const t of group.tracks) {
    if (t.album && !t.albumIsPlaceholder) albums.add(t.album);
    if (!cover && t.coverId) cover = coverOf(t);
  }
  return {
    id: 'ar_' + hash(group.name),
    name: group.name,
    trackCount: group.tracks.length,
    albumCount: albums.size,
    coverUrl: cover || '/api/cover/placeholder?size=300',
  };
}

/* ==========================================================================
 * 聚合
 * ========================================================================== */

/**
 * 专辑索引：复用 compat.buildAlbums（保证与既有 /api/albums 同一套 id），
 * 额外建一份「专辑 id → 成员曲目」，供详情与 addedAt 使用。
 */
function albumIndex() {
  const all = db.all();
  const albums = compatApi.buildAlbums(all);
  const members = new Map();
  for (const a of albums) members.set(a.id, []);
  for (const t of all) {
    const real = t.albumGroup === 'real' && t.album && !t.albumIsPlaceholder;
    const id = real ? 'al_' + hash(t.album) : 'unknown';
    const arr = members.get(id);
    if (arr) arr.push(t);
  }
  return { all, albums, members };
}

/** 歌手聚合：cleanArtist 优先，否则 artist；两者都是伪值就跳过 */
function artistIndex() {
  const map = new Map();
  for (const t of db.all()) {
    const name = !schema.isPseudo(t.cleanArtist)
      ? t.cleanArtist
      : (!schema.isPseudo(t.artist) ? t.artist : '');
    if (!name) continue;
    if (!map.has(name)) map.set(name, { name, tracks: [] });
    map.get(name).tracks.push(t);
  }
  return [...map.values()];
}

function statsData() {
  const all = db.all();
  const albums = compatApi.buildAlbums(all).filter((a) => a.id !== 'unknown' || a.trackCount > 0);
  const facets = db.facets();
  const c = ud.counts();
  return {
    tracks: all.length,
    albums: albums.length,
    artists: artistIndex().length,
    genres: (facets.genre || []).length,
    favorites: c.favorites,
    plays: c.plays,
    needReview: all.filter((t) => t.needReview).length,
  };
}

/* ==========================================================================
 * 过滤 / 排序
 * ========================================================================== */

/**
 * 曲目过滤（语义对齐 db.filter，但独立实现，不去动 db.js）
 * q 走子串匹配；artist/album 走忽略大小写的精确匹配；其余维度走等值/包含。
 */
function filterTracks(all, sp) {
  const q = (sp.get('q') || '').trim().toLowerCase();
  const artist = (sp.get('artist') || '').trim().toLowerCase();
  const album = (sp.get('album') || '').trim().toLowerCase();
  const genre = (sp.get('genre') || '').trim();
  const mood = (sp.get('mood') || '').trim();
  const scene = (sp.get('scene') || '').trim();
  const lang = (sp.get('lang') || '').trim();
  const era = (sp.get('era') || '').trim();
  const albumGroup = (sp.get('albumGroup') || '').trim();

  return all.filter((t) => {
    if (q) {
      const hay = String(t.title || '') + String(t.cleanTitle || '')
        + String(t.artist || '') + String(t.cleanArtist || '') + String(t.album || '');
      if (!hay.toLowerCase().includes(q)) return false;
    }
    if (artist && String(t.cleanArtist || t.artist || '').toLowerCase() !== artist) return false;
    if (album && String(t.album || '').toLowerCase() !== album) return false;
    if (genre && t.genre !== genre) return false;
    if (mood && !(t.mood || []).includes(mood)) return false;
    if (scene && !(t.scene || []).includes(scene)) return false;
    if (lang && t.lang !== lang) return false;
    if (era && t.era !== era) return false;
    if (albumGroup && t.albumGroup !== albumGroup) return false;
    return true;
  });
}

/** 排序键：字符串 localeCompare('zh')，数字数值差 */
function sortKey(t, sort) {
  switch (sort) {
    case 'artist': return t.cleanArtist || t.artist || '';
    case 'album': return t.album || '';
    case 'year': return t.year || 0;
    case 'duration': return t.durationSec || 0;
    case 'trackNo': return t.trackNo || 0;
    case 'added': return t.createdAt || '';
    case 'updated': return t.updatedAt || '';
    case 'title':
    default: return t.cleanTitle || t.title || '';
  }
}

function sortTracks(list, sort = 'title', order = 'asc') {
  const dir = order === 'desc' ? -1 : 1;
  return list.slice().sort((x, y) => {
    const a = sortKey(x, sort);
    const b = sortKey(y, sort);
    if (typeof a === 'string' || typeof b === 'string') {
      return String(a).localeCompare(String(b), 'zh') * dir;
    }
    return ((a || 0) - (b || 0)) * dir;
  });
}

/** mulberry32：小而稳的确定性 PRNG（零依赖） */
function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 随机排序：同一 seed 必得同一顺序（App 翻页/刷新不会跳）
 * @param {Array} list
 * @param {string} [seed] 缺省则每次随机
 */
function shuffleSeeded(list, seed) {
  const s = String(seed == null || seed === '' ? `${Date.now()}:${Math.random()}` : seed);
  const rnd = mulberry32(parseInt(hash(s), 16) >>> 0);
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/* ==========================================================================
 * 端点实现
 * ========================================================================== */

function home(sp) {
  const limit = clamp(sp.get('limit'), 6, 1, 200);
  const albumLimit = clamp(sp.get('albumLimit'), 12, 1, 200);
  const all = db.all();

  const random = shuffleSeeded(all, sp.get('seed')).slice(0, limit).map(trackLite);

  const recentAdded = all.slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit)
    .map(trackLite);

  // 最近播放：播放历史按曲目去重 → 解析成曲目（历史里已删除的曲目跳过）
  const distinct = ud.historyDistinct();
  const recentPlayedItems = [];
  for (const h of distinct) {
    if (recentPlayedItems.length >= limit) break;
    const t = db.resolve(h.trackId);
    if (t) recentPlayedItems.push(trackLite(t));
  }

  const favDetail = ud.favoritesDetail();
  const favItems = [];
  for (const f of favDetail) {
    if (favItems.length >= limit) break;
    const t = db.resolve(f.trackId);
    if (t) favItems.push({ ...trackLite(t), favoritedAt: f.addedAt });
  }

  const { albums, members } = albumIndex();
  const recentAlbums = albums
    .map((a) => albumLite(a, members.get(a.id) || []))
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
    .slice(0, albumLimit);

  const s = statsData();
  return {
    random,
    recentAdded,
    recentPlayed: { items: recentPlayedItems, total: distinct.length },
    favorites: { count: ud.favoriteCount(), items: favItems },
    recentAlbums,
    stats: {
      tracks: s.tracks,
      albums: s.albums,
      artists: s.artists,
      favorites: s.favorites,
      plays: s.plays,
    },
  };
}

function tracks(sp) {
  const all = db.all();
  const filtered = filterTracks(all, sp);
  const sort = sp.get('sort') || 'title';
  const order = sp.get('order') || 'asc';
  const list = sort === 'random'
    ? shuffleSeeded(filtered, sp.get('seed'))
    : sortTracks(filtered, sort, order);
  return pageOf(list.map(trackLite), pager(spUrl(sp), 30));
}

/**
 * ⚠️ 上面 tracks() 需要 URL 对象来算分页，这里做个统一入口把 searchParams 包成 URL。
 *    直接传 URLSearchParams 也能用（pager 只读 searchParams）。
 */
function spUrl(sp) {
  return { searchParams: sp };
}

function trackDetail(id) {
  const t = db.resolve(id);
  if (!t) return null;
  return trackFull(t);
}

function albums(sp) {
  const { albums: list, members } = albumIndex();
  const q = (sp.get('q') || '').trim().toLowerCase();
  const artist = (sp.get('artist') || '').trim().toLowerCase();
  const include = (sp.get('include') || 'all').trim();

  let out = list.filter((a) => a.id !== 'unknown' || a.trackCount > 0);
  if (include === 'real') out = out.filter((a) => a.id !== 'unknown');
  if (q) {
    out = out.filter((a) => (String(a.title || '') + String(a.artist || '')).toLowerCase().includes(q));
  }
  if (artist) {
    out = out.filter((a) => String(a.artist || '').toLowerCase() === artist);
  }

  const mapped = out.map((a) => albumLite(a, members.get(a.id) || []));
  const sort = sp.get('sort') || 'tracks';
  const order = sp.get('order') || 'desc';
  const dir = order === 'asc' ? 1 : -1;
  mapped.sort((x, y) => {
    if (sort === 'added') return String(x.addedAt || '').localeCompare(String(y.addedAt || '')) * dir;
    if (sort === 'year') return ((x.year || 0) - (y.year || 0)) * dir;
    if (sort === 'title') return String(x.title || '').localeCompare(String(y.title || ''), 'zh') * dir;
    return ((x.trackCount || 0) - (y.trackCount || 0)) * dir;   // 默认 tracks
  });
  return pageOf(mapped, pager(spUrl(sp), 30));
}

function albumDetail(id, sp) {
  const { albums, members } = albumIndex();
  const meta = albums.find((a) => a.id === id);
  if (!meta) return null;
  const tracks = members.get(meta.id) || [];
  const sort = sp.get('sort') || 'trackNo';
  const order = sp.get('order') || 'asc';
  const list = sortTracks(tracks, sort, order);
  return { album: albumLite(meta, tracks), ...pageOf(list.map(trackLite), pager(spUrl(sp), 30)) };
}

function artists(sp) {
  const q = (sp.get('q') || '').trim().toLowerCase();
  let groups = artistIndex();
  if (q) groups = groups.filter((g) => g.name.toLowerCase().includes(q));
  const mapped = groups.map(artistLite);
  const sort = sp.get('sort') || 'tracks';
  const order = sp.get('order') || 'desc';
  const dir = order === 'asc' ? 1 : -1;
  if (sort === 'name') {
    mapped.sort((x, y) => String(x.name).localeCompare(String(y.name), 'zh') * dir);
  } else {
    mapped.sort((x, y) => ((x.trackCount || 0) - (y.trackCount || 0)) * dir);
  }
  return pageOf(mapped, pager(spUrl(sp), 30));
}

function artistDetail(id, sp) {
  const group = artistIndex().find((g) => 'ar_' + hash(g.name) === id);
  if (!group) return null;
  const list = sortTracks(group.tracks, sp.get('sort') || 'title', sp.get('order') || 'asc');
  return { artist: artistLite(group), ...pageOf(list.map(trackLite), pager(spUrl(sp), 30)) };
}

function genres(sp) {
  const all = db.all();
  const facets = db.facets();
  const items = (facets.genre || []).map((g) => {
    let cover = '';
    for (const t of all) {
      if (t.genre === g.value && t.coverId) { cover = coverOf(t); break; }
    }
    return {
      value: g.value,
      count: g.count,
      coverUrl: cover || '/api/cover/placeholder?size=300',
    };
  });
  return pageOf(items, pager(spUrl(sp), 30));
}

function genreTracks(value, sp) {
  const all = db.all();
  const list = sortTracks(
    all.filter((t) => t.genre === value),
    sp.get('sort') || 'title',
    sp.get('order') || 'asc',
  );
  return { genre: value, ...pageOf(list.map(trackLite), pager(spUrl(sp), 30)) };
}

function playlists(sp) {
  const list = compatApi.buildPlaylists(db.all());
  return pageOf(list, pager(spUrl(sp), 30));
}

function playlistDetail(id, sp) {
  const meta = compatApi.buildPlaylists(db.all()).find((p) => p.id === id);
  if (!meta) return null;
  const items = db.all().filter((t) => {
    if (meta.dimension === 'genre') return t.genre === meta.value;
    return (t[meta.dimension] || []).includes(meta.value);
  });
  const list = sortTracks(items, sp.get('sort') || 'title', sp.get('order') || 'asc');
  return { playlist: meta, ...pageOf(list.map(trackLite), pager(spUrl(sp), 30)) };
}

/** 搜索：q 必填；type=all 给四组概览，type=单值给全分页 */
function search(sp) {
  const q = (sp.get('q') || '').trim();
  const type = (sp.get('type') || 'all').trim();
  const k = q.toLowerCase();
  const all = db.all();

  const matchTracks = all.filter((t) => String(
    (t.title || '') + (t.cleanTitle || '') + (t.artist || '') + (t.cleanArtist || '') + (t.album || ''),
  ).toLowerCase().includes(k));

  const artistGroups = artistIndex().filter((g) => g.name.toLowerCase().includes(k));
  const { albums: albumList, members } = albumIndex();
  const albumHit = albumList
    .filter((a) => a.id !== 'unknown' || a.trackCount > 0)
    .filter((a) => (String(a.title || '') + String(a.artist || '')).toLowerCase().includes(k));
  const playlistHit = compatApi.buildPlaylists(all).filter((p) => String(p.title || '').toLowerCase().includes(k));

  if (type === 'all') {
    return {
      query: q,
      tracks: { total: matchTracks.length, items: matchTracks.slice(0, 10).map(trackLite) },
      artists: { total: artistGroups.length, items: artistGroups.slice(0, 8).map(artistLite) },
      albums: {
        total: albumHit.length,
        items: albumHit.slice(0, 8).map((a) => albumLite(a, members.get(a.id) || [])),
      },
      playlists: { total: playlistHit.length, items: playlistHit.slice(0, 8) },
    };
  }

  if (type === 'track') return { query: q, type, ...pageOf(matchTracks.map(trackLite), pager(spUrl(sp), 30)) };
  if (type === 'artist') return { query: q, type, ...pageOf(artistGroups.map(artistLite), pager(spUrl(sp), 30)) };
  if (type === 'album') {
    const mapped = albumHit.map((a) => albumLite(a, members.get(a.id) || []));
    return { query: q, type, ...pageOf(mapped, pager(spUrl(sp), 30)) };
  }
  if (type === 'playlist') return { query: q, type, ...pageOf(playlistHit, pager(spUrl(sp), 30)) };
  return null;   // 非法 type
}

/** 收藏列表：固定 addedAt 降序；已失效（曲库里没有）的条目跳过 */
function favoritesList(sp) {
  const rows = [];
  for (const f of ud.favoritesDetail()) {
    const t = db.resolve(f.trackId);
    if (!t) continue;                    // 曲目已被删除/重新扫描换 id → 不出现在列表里
    rows.push({ ...trackLite(t), favoritedAt: f.addedAt });
  }
  return pageOf(rows, pager(spUrl(sp), 30));
}

/** 播放历史：scope=distinct（默认，按曲目去重）/ raw（原始流水） */
function historyList(sp) {
  const scope = (sp.get('scope') || 'distinct').trim();
  const raw = scope === 'raw' ? ud.historyRaw() : ud.historyDistinct();
  const rows = [];
  for (const h of raw) {
    const t = db.resolve(h.trackId);
    if (!t) continue;
    const base = { ...trackLite(t), playedAt: h.playedAt };
    if (scope !== 'raw') base.playCount = h.playCount || 1;
    rows.push(base);
  }
  return pageOf(rows, pager(spUrl(sp), 30));
}

/* ==========================================================================
 * 路由
 * ========================================================================== */

/** 解析 JSON 请求体（1MB 上限）；失败返回 null，由调用方给 400 */
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

/**
 * @param {object} req
 * @param {object} res
 * @param {string} method
 * @param {string} P 完整路径（如 /api/v1/tracks）
 * @param {URL} url
 * @returns {Promise<boolean>} 恒为 true（v1 内部自行兜 404）
 */
async function route(req, res, method, P, url) {
  const sp = url.searchParams;
  try {
    /* ===== 搜歌下载（SqMusic 代理）=====
     * 单独一个模块；它内部自带 503 降级与 404 兜底，这里直接 return true。
     */
    if (P.startsWith('/api/v1/sqmusic')) { await v1sq.route(req, res, method, P, url); return true; }

    // ---- 首页聚合 ----
    if (P === '/api/v1/home' && method === 'GET') return ok(res, home(sp)), true;

    // ---- 曲目 ----
    if (P === '/api/v1/tracks' && method === 'GET') return ok(res, tracks(sp)), true;
    {
      const m = /^\/api\/v1\/tracks\/(.+)$/.exec(P);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const t = trackDetail(id);
        if (!t) return fail(res, 404, 'NOT_FOUND', '曲目不存在'), true;
        return ok(res, t), true;
      }
    }

    // ---- 专辑 ----
    if (P === '/api/v1/albums' && method === 'GET') return ok(res, albums(sp)), true;
    {
      const m = /^\/api\/v1\/albums\/(.+)$/.exec(P);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const r = albumDetail(id, sp);
        if (!r) return fail(res, 404, 'NOT_FOUND', '专辑不存在'), true;
        return ok(res, r), true;
      }
    }

    // ---- 歌手 ----
    if (P === '/api/v1/artists' && method === 'GET') return ok(res, artists(sp)), true;
    {
      const m = /^\/api\/v1\/artists\/(.+)$/.exec(P);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const r = artistDetail(id, sp);
        if (!r) return fail(res, 404, 'NOT_FOUND', '歌手不存在'), true;
        return ok(res, r), true;
      }
    }

    // ---- 风格 ----
    if (P === '/api/v1/genres' && method === 'GET') return ok(res, genres(sp)), true;
    {
      const m = /^\/api\/v1\/genres\/(.+)\/tracks$/.exec(P);
      if (m && method === 'GET') {
        const value = decodeURIComponent(m[1]);
        return ok(res, genreTracks(value, sp)), true;
      }
    }

    // ---- 系统歌单 ----
    if (P === '/api/v1/playlists' && method === 'GET') return ok(res, playlists(sp)), true;
    {
      const m = /^\/api\/v1\/playlists\/(.+)$/.exec(P);
      if (m && method === 'GET') {
        const id = decodeURIComponent(m[1]);
        const r = playlistDetail(id, sp);
        if (!r) return fail(res, 404, 'NOT_FOUND', '歌单不存在'), true;
        return ok(res, r), true;
      }
    }

    // ---- 搜索 ----
    if (P === '/api/v1/search' && method === 'GET') {
      if (!(sp.get('q') || '').trim()) {
        return fail(res, 400, 'MISSING_QUERY', '搜索关键词不能为空'), true;
      }
      const r = search(sp);
      if (!r) return fail(res, 400, 'INVALID_PARAM', 'type 只能是 all / track / artist / album / playlist'), true;
      return ok(res, r), true;
    }

    // ---- 收藏 ----
    if (P === '/api/v1/favorites' && method === 'GET') return ok(res, favoritesList(sp)), true;
    {
      const m = /^\/api\/v1\/favorites\/(.+)$/.exec(P);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'GET') {
          return ok(res, { favorited: ud.isFavorite(id), count: ud.favoriteCount() }), true;
        }
        if (method === 'PUT') {
          if (!db.resolve(id)) return fail(res, 404, 'NOT_FOUND', '曲目不存在'), true;
          ud.addFavorite(id);
          return ok(res, { favorited: true, count: ud.favoriteCount() }), true;
        }
        if (method === 'DELETE') {
          ud.removeFavorite(id);            // 幂等：本来没收藏也返回 200
          return ok(res, { favorited: false, count: ud.favoriteCount() }), true;
        }
      }
    }

    // ---- 播放历史 ----
    if (P === '/api/v1/history' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) return fail(res, 400, 'INVALID_PARAM', '请求体必须是合法 JSON 对象'), true;
      const trackId = String(body.trackId || '').trim();
      if (!trackId) return fail(res, 400, 'INVALID_PARAM', 'trackId 不能为空'), true;
      if (!db.resolve(trackId)) return fail(res, 404, 'NOT_FOUND', '曲目不存在'), true;
      const rec = ud.addHistory(trackId, body.durationSec);
      return ok(res, { plays: ud.counts().plays, latest: rec.playedAt }), true;
    }
    if (P === '/api/v1/history' && method === 'GET') return ok(res, historyList(sp)), true;
    if (P === '/api/v1/history' && method === 'DELETE') {
      ud.clearHistory();
      return ok(res, { cleared: true }), true;
    }

    // ---- 维度与统计 ----
    if (P === '/api/v1/facets' && method === 'GET') return ok(res, db.facets()), true;
    if (P === '/api/v1/stats' && method === 'GET') return ok(res, statsData()), true;

    return fail(res, 404, 'NOT_FOUND', `接口不存在：${method} ${P}`), true;
  } catch (e) {
    log.error('v1 接口异常', { path: P, method, error: e && e.message });
    return fail(res, 500, 'SERVER_ERROR', (e && e.message) || '内部错误'), true;
  }
}

module.exports = { route, /* 供自测/复用 */ trackLite, trackFull, albumLite, artistLite, pager, pageOf };
