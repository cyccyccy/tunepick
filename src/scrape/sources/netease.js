'use strict';
/**
 * 在线源：网易云音乐
 *
 * ⚠️ 关键坑（原型实测，必须遵守）：
 *   旧端点 /api/search/get/web 会「静默软封」——返回 HTTP 200 + 空结果/错误 code，
 *   不报错。第一轮全量跑因此得出「假 0% 命中率」且 telemetry 误记成功。
 *   本实现：① 主用 /api/cloudsearch/pc（POST）② HTTP 200 但 body 无结果/含错误码一律判为失败
 *   ③ 端点轮换（主端点连续失败 N 次后切备用端点）
 */

const net = require('../../util/net');
const config = require('../../config');
const { makeLogger } = require('../../logger');

const log = makeLogger('source:netease');

const NAME = 'netease';
const ENDPOINTS = [
  'https://music.163.com/api/cloudsearch/pc',   // 主端点
  'https://music.163.com/api/search/get/web',   // 备用（GET 风格，但同样接受 POST）
];

const limiter = new net.RateLimiter(Math.max(1, Math.round(1000 / Math.max(0.1, config.ONLINE_QPS))));

let endpointIdx = 0;
let consecutiveFail = 0;
const FAIL_THRESHOLD = 3;

const stats = { requests: 0, ok: 0, empty: 0, failed: 0, blocked: 0, hits: 0 };

function headers() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Referer: 'https://music.163.com/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
}

function rotateEndpoint() {
  endpointIdx = (endpointIdx + 1) % ENDPOINTS.length;
  consecutiveFail = 0;
  log.warn('切换网易云端点', { to: ENDPOINTS[endpointIdx] });
}

/**
 * 搜索候选
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array>} 候选数组（每项已归一）
 */
async function search(query, limit = 8) {
  if (!query) return [];
  await limiter.acquire();
  const url = ENDPOINTS[endpointIdx];
  stats.requests++;

  let r;
  try {
    r = await net.webPost(url, { s: query, type: '1', offset: '0', limit: String(limit), total: 'true' }, {
      timeoutMs: config.ONLINE_TIMEOUT_MS,
      headers: headers(),
    });
  } catch (e) {
    stats.failed++;
    consecutiveFail++;
    if (consecutiveFail >= FAIL_THRESHOLD) rotateEndpoint();
    log.warn('网易云请求异常', { query, error: e.message });
    return [];
  }

  const body = r.body;
  const bizErr = net.detectBusinessError(body);

  // 静默软封判定：HTTP 200 但业务码非 200 / 无 result / 无 songs
  if (!r.ok || bizErr || !body || !body.result || !Array.isArray(body.result.songs)) {
    stats.blocked++;
    consecutiveFail++;
    if (consecutiveFail >= FAIL_THRESHOLD) rotateEndpoint();
    log.warn('网易云疑似软封或异常响应', { query, status: r.status, bizErr, hasResult: !!body?.result });
    return [];
  }

  const songs = body.result.songs;
  if (songs.length === 0) { stats.empty++; return []; }

  stats.ok++;
  consecutiveFail = 0;
  return songs.map(fromNetease).filter(Boolean);
}

/**
 * 字段名归一化
 * ⚠️ 两个端点的字段名不一致，必须兼容：
 *   cloudsearch/pc  → 缩写：ar(艺人) / al(专辑) / dt(时长ms) / name(曲名)
 *   search/get/web  → 完整：artists / album / duration
 * 不归一化会导致候选的歌手/专辑/时长全为空，打分必然判 miss。
 */
function normalizeSong(s) {
  if (!s || typeof s !== 'object') return null;
  const al = s.album || s.al || {};
  const picUrl = al.picUrl || (al.pic ? `https://p1.music.126.net/${al.pic}.jpg` : '');
  return {
    ...s,
    name: s.name || s.title || '',
    artists: s.artists || s.ar || [],
    album: { ...al, picUrl },
    duration: s.duration || s.dt || 0,
  };
}

/** 归一为统一候选结构 */
function fromNetease(s) {
  s = normalizeSong(s);
  if (!s || !s.name) return null;
  const artists = (s.artists || []).map((a) => a && a.name).filter(Boolean);
  const al = s.album || {};
  let year = 0;
  const pt = al.publishTime || s.publishTime;
  if (pt) {
    const d = new Date(Number(pt));
    if (!Number.isNaN(d.getTime())) year = d.getFullYear();
  }
  return {
    source: NAME,
    id: String(s.id || ''),
    title: s.name,
    artists,
    artist: artists[0] || '',
    album: al.name || '',
    albumId: al.id ? String(al.id) : '',
    year,
    durationSec: Math.round((Number(s.duration) || 0) / 1000),
    picUrl: al.picUrl || '',
    _raw: s,                    // 已归一化，可直接交给 match.fromNetease
  };
}

/**
 * 取歌词（LRC）
 * @param {string} songId 网易云歌曲 id
 */
async function lyric(songId) {
  if (!songId) return '';
  await limiter.acquire();
  try {
    const r = await net.webPost('https://music.163.com/api/song/lyric', { id: String(songId), lv: '1', kv: '1', tv: '-1' }, {
      timeoutMs: config.ONLINE_TIMEOUT_MS,
      headers: headers(),
    });
    const b = r.body;
    if (!r.ok || !b || net.detectBusinessError(b)) return '';
    const lrc = (b.lrc && b.lrc.lyric) || '';
    return typeof lrc === 'string' ? lrc : '';
  } catch (e) {
    log.debug('歌词获取失败', { songId, error: e.message });
    return '';
  }
}

/** 封面 URL（支持 ?param=300y300 直取缩略图，无需本地缩放） */
function coverUrl(picUrl, size = 0) {
  if (!picUrl) return '';
  const base = picUrl.split('?')[0];
  if (size > 0) return `${base}?param=${size}y${size}`;
  return base;
}

/** 连通性测试（/api/sources/:name/test） */
async function test() {
  const t0 = Date.now();
  try {
    const r = await search('周杰伦', 1);
    return { ok: r.length > 0, latencyMs: Date.now() - t0, error: r.length ? '' : '未返回候选' };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

function getStats() { return { ...stats }; }

module.exports = { NAME, search, lyric, coverUrl, test, getStats, fromNetease, limiter };
