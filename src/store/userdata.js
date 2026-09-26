'use strict';
/**
 * 用户数据存储 —— 收藏 + 播放历史
 *
 * 为什么单独一个文件：
 *   曲库（src/store/db.js）是「扫描出来的客观结果」，随时会被增量扫描重写；
 *   收藏/播放历史是「用户的主观行为」，必须由用户自己触发才变，绝不能被扫描覆盖。
 *   两者混在一份存储里，一次扫描就会把用户数据冲掉，所以物理隔离。
 *
 * 存储形态（单文件 JSON，落 DATA_DIR/userdata.json）：
 *   { version: 1,
 *     favorites: { [trackId]: addedAtISO },
 *     history:   [ { trackId, playedAt, durationSec } ]   // 最新在前
 *   }
 *
 * 设计约定：
 *   - 惰性加载：进程启动不读盘，首次访问才读；
 *   - 读盘失败：log.warn + 用默认值，绝不 crash（仿 db.loadMeta 的做法）；
 *   - 写盘：tmp → rename 原子写（仿 db.saveMeta），每次变更立即落盘；
 *   - history 上限 5000 条，超出丢最旧（数组尾部）；
 *   - 全部同步方法：数据量小（收藏几百条、历史上限 5000），同步写盘足够，
 *     没必要引入异步队列把「PUT 成功但没落盘」这种中间态暴露出去。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('store:userdata');

/** 用户数据文件（DATA_DIR 下） */
const FILE = path.join(config.paths.data, 'userdata.json');

/** 播放历史上限，超出丢最旧 */
const HISTORY_MAX = 5000;

let data = null;

function defaults() {
  return { version: 1, favorites: {}, history: [] };
}

/**
 * 把任意来源的 JSON 收敛成合法结构 —— 手改坏了 / 版本升级都不许崩
 * @param {any} j
 * @returns {{version:number, favorites:object, history:Array<{trackId:string,playedAt:string,durationSec:number}>}}
 */
function normalize(j) {
  const d = defaults();
  if (!j || typeof j !== 'object') return d;

  if (j.favorites && typeof j.favorites === 'object' && !Array.isArray(j.favorites)) {
    for (const k of Object.keys(j.favorites)) {
      const v = j.favorites[k];
      if (!k) continue;
      // 兼容两种历史写法：{id: ISO时间} 和 {id: {addedAt: ISO时间}}
      const at = typeof v === 'string' ? v : (v && typeof v === 'object' ? String(v.addedAt || '') : '');
      if (at) d.favorites[k] = at;
    }
  }

  if (Array.isArray(j.history)) {
    for (const h of j.history) {
      if (!h || typeof h !== 'object') continue;
      const trackId = String(h.trackId || '').trim();
      if (!trackId) continue;
      d.history.push({
        trackId,
        playedAt: String(h.playedAt || ''),
        durationSec: Number(h.durationSec) || 0,
      });
    }
  }
  if (d.history.length > HISTORY_MAX) d.history = d.history.slice(0, HISTORY_MAX);
  return d;
}

/** 惰性加载：读一次后常驻内存 */
function load() {
  if (data) return data;
  try {
    if (fs.existsSync(FILE)) {
      data = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } else {
      data = defaults();
    }
  } catch (e) {
    log.warn('用户数据读取失败，使用默认值', { error: e && e.message });
    data = defaults();
  }
  return data;
}

/** 原子写：写 .tmp → rename（中途崩溃不会留下半个文件） */
function save() {
  const tmp = FILE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    log.error('用户数据写入失败', { error: e && e.message });
  }
}

/** 只给测试/运维用：丢弃内存缓存，下次访问重新读盘 */
function reset() {
  data = null;
}

/* ==========================================================================
 * 收藏
 * ========================================================================== */

/** 收藏曲目 id 数组（addedAt 降序，最近收藏在前） */
function favorites() {
  return favoritesDetail().map((x) => x.trackId);
}

/** 收藏明细 `[{trackId, addedAt}]`（addedAt 降序） */
function favoritesDetail() {
  const d = load();
  return Object.keys(d.favorites)
    .map((trackId) => ({ trackId, addedAt: d.favorites[trackId] }))
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

function isFavorite(trackId) {
  const d = load();
  return Object.prototype.hasOwnProperty.call(d.favorites, String(trackId || ''));
}

/**
 * 收藏一首
 * @returns {boolean} true=新增；false=本来就收藏过（保留原 addedAt，不覆盖）
 */
function addFavorite(trackId) {
  const id = String(trackId || '').trim();
  if (!id) return false;
  const d = load();
  if (Object.prototype.hasOwnProperty.call(d.favorites, id)) return false;
  d.favorites[id] = new Date().toISOString();
  save();
  return true;
}

/** 取消收藏（幂等：本来就没收藏也返回 false，不报错） */
function removeFavorite(trackId) {
  const id = String(trackId || '').trim();
  if (!id) return false;
  const d = load();
  if (!Object.prototype.hasOwnProperty.call(d.favorites, id)) return false;
  delete d.favorites[id];
  save();
  return true;
}

function favoriteCount() {
  return Object.keys(load().favorites).length;
}

/* ==========================================================================
 * 播放历史
 * ========================================================================== */

/**
 * 记一次播放（最新在前）
 * @param {string} trackId
 * @param {number} [durationSec] 本次播放时长（秒），可空
 * @returns {{trackId:string, playedAt:string, durationSec:number}}
 */
function addHistory(trackId, durationSec) {
  const id = String(trackId || '').trim();
  const rec = {
    trackId: id,
    playedAt: new Date().toISOString(),
    durationSec: Number(durationSec) || 0,
  };
  if (!id) return rec;
  const d = load();
  d.history.unshift(rec);
  if (d.history.length > HISTORY_MAX) d.history.length = HISTORY_MAX;   // 丢最旧（尾部）
  save();
  return rec;
}

/** 原始播放记录（最新在前） */
function historyRaw() {
  return load().history.slice();
}

/**
 * 按曲目去重：每首歌只留一条，保留最近 playedAt，附带 playCount
 * @returns {Array<{trackId:string, playedAt:string, durationSec:number, playCount:number}>} playedAt 降序
 */
function historyDistinct() {
  const raw = load().history;           // 最新在前
  const map = new Map();
  for (const h of raw) {
    const cur = map.get(h.trackId);
    if (cur) {
      cur.playCount++;
      continue;                          // 第一条就是最近的，playedAt 不再更新
    }
    map.set(h.trackId, {
      trackId: h.trackId,
      playedAt: h.playedAt,
      durationSec: h.durationSec || 0,
      playCount: 1,
    });
  }
  return [...map.values()].sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
}

/** 清空播放历史 */
function clearHistory() {
  const d = load();
  d.history = [];
  save();
  return true;
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */

/** `{favorites, plays}` */
function counts() {
  const d = load();
  return { favorites: Object.keys(d.favorites).length, plays: d.history.length };
}

module.exports = {
  FILE,
  HISTORY_MAX,
  favorites,
  favoritesDetail,
  isFavorite,
  addFavorite,
  removeFavorite,
  favoriteCount,
  addHistory,
  historyRaw,
  historyDistinct,
  clearHistory,
  counts,
  reset,
};
