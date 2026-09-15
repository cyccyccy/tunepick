'use strict';
/**
 * 兼容层 —— PRD §6.1（决策 #10：核心契约对齐现有 App）
 *
 * ⚠️ PRD §6.2 唯一未缓解项：字段命名映射必须在这里做
 *    对外保持原字段名（albumTitle / coverUrl），对内使用本 Schema（album / coverId）
 */

const db = require('../store/db');
const schema = require('../store/schema');
const vocab = require('../scrape/vocab');
const { makeLogger } = require('../logger');

const log = makeLogger('api:compat');

function coverUrl(t) {
  return t.coverId ? `/api/cover/${t.coverId}?size=300` : '/api/cover/placeholder?size=300';
}

const compat = (t) => schema.toCompat(t, coverUrl);

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/* ---------------- 首页三区 ---------------- */
function library(res) {
  const all = db.all();
  const recent = all
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 30)
    .map(compat);

  const albums = buildAlbums(all).slice(0, 24);
  const playlists = buildPlaylists(all);
  return json(res, { recent, albums, playlists });
}

/* ---------------- 专辑（按刮削结果重建，Q-03） ---------------- */
function buildAlbums(all) {
  const map = new Map();
  for (const t of all) {
    const real = t.albumGroup === 'real' && t.album && !t.albumIsPlaceholder;
    const key = real ? t.album : '__unknown__';
    if (!map.has(key)) {
      map.set(key, {
        id: real ? 'al_' + hash(key) : 'unknown',
        title: real ? t.album : '未知专辑',
        artist: real ? (t.cleanArtist || t.artist || '') : '',
        coverUrl: '',
        trackCount: 0,
        albumGroup: real ? 'real' : 'unknown',
        year: 0,
      });
    }
    const a = map.get(key);
    a.trackCount++;
    if (!a.coverUrl && t.coverId) a.coverUrl = coverUrl(t);
    if (!a.year && t.year) a.year = t.year;
    if (!a.artist && (t.cleanArtist || t.artist)) a.artist = t.cleanArtist || t.artist;
  }
  return [...map.values()].sort((x, y) => y.trackCount - x.trackCount);
}

function albums(res) {
  const all = db.all();
  const list = buildAlbums(all).filter((a) => a.albumGroup === 'real');
  return json(res, { albums: list, total: list.length });
}

function album(res, id) {
  const all = db.all();
  if (id === 'unknown') {
    const tracks = all.filter((t) => t.albumGroup !== 'real' || !t.album || t.albumIsPlaceholder);
    return json(res, {
      album: { id: 'unknown', title: '未知专辑', trackCount: tracks.length, coverUrl: '/api/cover/placeholder?size=300' },
      tracks: tracks.map(compat),
    });
  }
  const list = buildAlbums(all);
  const meta = list.find((a) => a.id === id);
  if (!meta) return json(res, { ok: false, error: '专辑不存在' }, 404);
  const tracks = all.filter((t) => t.albumGroup === 'real' && 'al_' + hash(t.album) === id);
  return json(res, { album: meta, tracks: tracks.map(compat) });
}

/* ---------------- 曲目 ---------------- */
function tracks(res, url) {
  const limit = clamp(parseInt(url.searchParams.get('limit'), 10) || 100, 1, 2000);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
  const q = url.searchParams.get('q') || '';
  const { total, items } = db.filter({ q, limit, offset, sort: 'title' });
  return json(res, { tracks: items.map(compat), total, offset, limit });
}

function track(res, id) {
  const t = db.resolve(id);
  if (!t) return json(res, { ok: false, error: '曲目不存在' }, 404);
  return json(res, { track: t });       // 完整 Schema（63 字段）
}

/* ---------------- 系统歌单（Q-04，只读） ---------------- */
function buildPlaylists(all) {
  const out = [];
  const byDim = (dim, values) => {
    for (const v of values) {
      const n = all.filter((t) => (t[dim] || []).includes(v)).length;
      if (n >= 3) {
        out.push({
          id: `sys_${dim}_${v}`,
          title: `${v} · ${n} 首`,
          trackCount: n,
          coverUrl: '',
          system: true,
          dimension: dim,
          value: v,
        });
      }
    }
  };
  byDim('scene', vocab.VOCAB.scene);
  byDim('mood', vocab.VOCAB.mood);

  for (const g of vocab.VOCAB.genre) {
    const n = all.filter((t) => t.genre === g).length;
    if (n >= 3) {
      out.push({ id: `sys_genre_${g}`, title: `${g} · ${n} 首`, trackCount: n, coverUrl: '', system: true, dimension: 'genre', value: g });
    }
  }
  return out;
}

function playlists(res) {
  return json(res, { playlists: buildPlaylists(db.all()) });
}

function playlist(res, id) {
  const all = db.all();
  const meta = buildPlaylists(all).find((p) => p.id === id);
  if (!meta) return json(res, { ok: false, error: '歌单不存在' }, 404);
  const items = all.filter((t) => {
    if (meta.dimension === 'genre') return t.genre === meta.value;
    return (t[meta.dimension] || []).includes(meta.value);
  });
  return json(res, { playlist: meta, tracks: items.map(compat) });
}

/* ---------------- 搜索 ---------------- */
function search(res, url) {
  const q = url.searchParams.get('q') || '';
  const limit = clamp(parseInt(url.searchParams.get('limit'), 10) || 50, 1, 500);
  const { total, items } = db.filter({ q, limit });
  return json(res, { query: q, total, tracks: items.map(compat) });
}

/* ---------------- AI 歌单：明确未实现（Q-05） ---------------- */
function aiPlaylist(res) {
  return json(res, {
    ok: false,
    unimplemented: true,
    error: '本服务不提供 AI 歌单生成',
    hint: '该能力由 music-player 后端提供，请保持原有配置',
  }, 501);
}

/* ---------------- 歌词 ---------------- */
function lyric(res, id) {
  const t = db.resolve(id);
  // PRD §4.3：未命中返回 200 + available:false，而非 404
  if (!t || !t.lyrics) {
    const body = JSON.stringify({ available: false, id, lyrics: '', hint: '该曲目暂无歌词' });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }
  const body = t.lyrics;
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(body);
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }

module.exports = {
  library, albums, album, tracks, track, playlists, playlist,
  search, aiPlaylist, lyric, compat, coverUrl, buildAlbums, buildPlaylists,
};
