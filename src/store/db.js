'use strict';
/**
 * 存储层 —— 分片 JSON + 内存索引（DESIGN §2 选型结论）
 * 分片：按 id 第三位 hex 分 16 片，单片原子写，避免每次全量重写
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { makeLogger } = require('../logger');
const schema = require('./schema');

const log = makeLogger('store');
const SHARDS = 16;

class DB {
  constructor() {
    this.index = {
      byId: new Map(),
      byPath: new Map(),
      byLegacyId: new Map(),
      byDurPath: new Map(),
      byAlbum: new Map(),
      byCover: new Map(),
    };
    this.dirty = new Set();   // 待落盘分片号
    this.order = [];          // 稳定顺序（按 filePath）
    this.meta = null;
    this.stats = { loaded: 0, shards: 0 };
  }

  shardOf(id) {
    const c = String(id).charAt(3) || '0';
    const n = parseInt(c, 16);
    return Number.isFinite(n) ? n % SHARDS : 0;
  }

  shardPath(n) {
    return path.join(config.paths.tracks, `shard-${n.toString(16)}.json`);
  }

  // ---------- 加载 ----------
  load() {
    const t0 = Date.now();
    for (let n = 0; n < SHARDS; n++) {
      const p = this.shardPath(n);
      if (!fs.existsSync(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const arr = j.tracks || [];
        for (const t of arr) this._indexAdd(t, true);   // 必须入 order，否则重启后 all() 为空
        this.stats.shards++;
      } catch (e) {
        log.error('分片加载失败，已跳过', { shard: n, error: e.message });
      }
    }
    this.order.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
    this.loadMeta();
    log.info('曲库加载完成', {
      tracks: this.index.byId.size,
      shards: this.stats.shards,
      ms: Date.now() - t0,
    });
    return this;
  }

  _indexAdd(t, pushOrder = true) {
    this.index.byId.set(t.id, t);
    if (t.filePath) this.index.byPath.set(t.filePath, t);
    for (const l of t.legacyIds || []) this.index.byLegacyId.set(l, t);
    if (t.durationSec && t.fileName) {
      this.index.byDurPath.set(`${t.durationSec}|${t.fileName}`, t);
    }
    if (t.album) {
      if (!this.index.byAlbum.has(t.album)) this.index.byAlbum.set(t.album, []);
      const arr = this.index.byAlbum.get(t.album);
      if (!arr.includes(t)) arr.push(t);
    }
    if (t.coverHash && t.coverId) this.index.byCover.set(t.coverHash, t.coverId);
    if (pushOrder) this.order.push(t);
  }

  _indexRemove(t) {
    this.index.byId.delete(t.id);
    if (t.filePath) this.index.byPath.delete(t.filePath);
    for (const l of t.legacyIds || []) this.index.byLegacyId.delete(l);
    if (t.durationSec && t.fileName) this.index.byDurPath.delete(`${t.durationSec}|${t.fileName}`);
    if (t.album) {
      const arr = this.index.byAlbum.get(t.album);
      if (arr) {
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1);
      }
    }
  }

  // ---------- 写入 ----------
  upsert(track) {
    const old = this.index.byId.get(track.id);
    if (old) this._indexRemove(old);
    if (!old) this.order.push(track);
    this._indexAdd(track, false);
    this.dirty.add(this.shardOf(track.id));
    return track;
  }

  /** 原子写：写 .tmp → rename */
  flush(force = false) {
    if (!this.dirty.size && !force) return 0;
    let count = 0;
    for (const n of this.dirty) {
      const arr = [...this.index.byId.values()].filter((t) => this.shardOf(t.id) === n);
      const p = this.shardPath(n);
      const tmp = p + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tracks: arr }, null, 0));
        fs.renameSync(tmp, p);
        count++;
      } catch (e) {
        log.error('分片写入失败', { shard: n, error: e.message });
      }
    }
    this.dirty.clear();
    return count;
  }

  // ---------- 查询 ----------
  all() { return this.order; }
  size() { return this.index.byId.size; }

  /**
   * id 解析：新 id → 旧 id 别名 → 「时长+文件名」兜底（FR-75）
   */
  resolve(id) {
    if (!id) return null;
    let t = this.index.byId.get(id);
    if (t) return t;
    t = this.index.byLegacyId.get(id);
    if (t) return t;
    // 兜底：形如 "<duration>|<fileName>"
    const m = String(id).match(/^(\d+)\|(.+)$/);
    if (m) return this.index.byDurPath.get(`${m[1]}|${m[2]}`) || null;
    return null;
  }

  byPath(p) { return this.index.byPath.get(p) || null; }

  /** 多条件筛选 + 排序 + 分页 */
  filter(opts = {}) {
    const {
      q = '', genre = '', mood = '', scene = '', lang = '', era = '',
      albumGroup = '', needReview = null, quality = '', source = '',
      sort = 'title', order = 'asc', limit = 50, offset = 0,
    } = opts;

    let out = this.order;

    if (q) {
      const k = q.toLowerCase();
      out = out.filter((t) =>
        (t.title + t.cleanTitle + t.artist + t.cleanArtist + t.album).toLowerCase().includes(k)
      );
    }
    if (genre) out = out.filter((t) => t.genre === genre);
    if (mood) out = out.filter((t) => (t.mood || []).includes(mood));
    if (scene) out = out.filter((t) => (t.scene || []).includes(scene));
    if (lang) out = out.filter((t) => t.lang === lang);
    if (era) out = out.filter((t) => t.era === era);
    if (albumGroup) out = out.filter((t) => t.albumGroup === albumGroup);
    if (needReview === true) out = out.filter((t) => t.needReview);
    if (needReview === false) out = out.filter((t) => !t.needReview);
    if (quality) out = out.filter((t) => t.qualityLevel === quality);
    if (source) out = out.filter((t) => Object.values(t.sourceMap || {}).some((v) => String(v).includes(source)));

    const dir = order === 'desc' ? -1 : 1;
    out = out.slice().sort((a, b) => {
      let x = a[sort], y = b[sort];
      if (Array.isArray(x)) x = x.join(',');
      if (Array.isArray(y)) y = y.join(',');
      if (typeof x === 'string' && typeof y === 'string') return x.localeCompare(y, 'zh') * dir;
      return ((x || 0) - (y || 0)) * dir;
    });

    const total = out.length;
    const items = out.slice(offset, offset + limit);
    return { total, items, offset, limit };
  }

  /** 标签维度聚合（/api/facets） */
  facets() {
    const f = { mood: {}, genre: {}, scene: {}, lang: {}, era: {} };
    for (const t of this.order) {
      for (const v of t.mood || []) f.mood[v] = (f.mood[v] || 0) + 1;
      for (const v of t.scene || []) f.scene[v] = (f.scene[v] || 0) + 1;
      if (t.genre) f.genre[t.genre] = (f.genre[t.genre] || 0) + 1;
      if (t.lang) f.lang[t.lang] = (f.lang[t.lang] || 0) + 1;
      if (t.era) f.era[t.era] = (f.era[t.era] || 0) + 1;
    }
    const toArr = (o) => Object.entries(o).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    return {
      mood: toArr(f.mood),
      scene: toArr(f.scene),
      genre: toArr(f.genre),
      lang: toArr(f.lang),
      era: toArr(f.era),
    };
  }

  /** 覆盖率统计（/api/stats/coverage） */
  coverage() {
    const total = this.order.length || 1;
    const has = (f) => this.order.filter((t) => !schema.isPseudo(t[f])).length;
    const c = {
      total: this.order.length,
      artist: has('cleanArtist'),
      artistUsable: this.order.filter((t) =>
        !schema.isPseudo(t.cleanArtist) && (t.fieldConfidence?.artist ?? 0) >= 0.5).length,
      year: this.order.filter((t) => t.year > 0).length,
      era: this.order.filter((t) => t.era && t.era !== '未知').length,
      genre: this.order.filter((t) => t.genre && t.genre !== '其他').length,
      mood: this.order.filter((t) => (t.mood || []).length > 0).length,
      scene: this.order.filter((t) => (t.scene || []).length > 0).length,
      lyrics: has('lyrics'),
      cover: has('coverId'),
      bio: has('artistBio'),
    };
    const pct = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === 'total') continue;
      pct[k] = +(v / total * 100).toFixed(1);
    }
    const quality = { high: 0, medium: 0, low: 0 };
    for (const t of this.order) quality[t.qualityLevel] = (quality[t.qualityLevel] || 0) + 1;
    return { coverage: c, coveragePct: pct, quality, needReview: this.order.filter((t) => t.needReview).length };
  }

  // ---------- meta（任务历史 / 源统计 / idmap） ----------
  loadMeta() {
    try {
      this.meta = fs.existsSync(config.paths.meta)
        ? JSON.parse(fs.readFileSync(config.paths.meta, 'utf8'))
        : { runs: [], sources: {}, idmap: {}, llm: {}, sampleReport: null, probeReport: null };
    } catch (e) {
      log.warn('meta 读取失败，使用默认值', { error: e.message });
      this.meta = { runs: [], sources: {}, idmap: {}, llm: {}, sampleReport: null, probeReport: null };
    }
    for (const k of ['runs', 'sources', 'idmap', 'llm']) if (!this.meta[k]) this.meta[k] = {};
    if (!Array.isArray(this.meta.runs)) this.meta.runs = [];
    return this.meta;
  }

  saveMeta() {
    const p = config.paths.meta;
    const tmp = p + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.meta, null, 2));
      fs.renameSync(tmp, p);
    } catch (e) {
      log.error('meta 写入失败', { error: e.message });
    }
  }
}

const db = new DB();
module.exports = db;
module.exports.DB = DB;
