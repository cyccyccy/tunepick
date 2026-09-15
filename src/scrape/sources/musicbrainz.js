'use strict';
/**
 * 在线源：MusicBrainz
 *
 * ⚠️ 硬性限速 ≤ 1 请求/秒（官方规定），必须带真实 User-Agent
 * ⚠️ 源繁忙时返回 HTTP 200 + {"error": "The MusicBrainz web server is currently busy..."}
 *    —— 原型曾因 curl 路径把 status 伪造成 200 而把这 24 次错误当成「源没有」，必须检查 body.error
 *
 * 实测结论：对本中文车载曲库 strict 命中仅 28%（修正后 33%），命中集中在英文/日文层。
 * 定位：交叉验证信号源，不指望它提升覆盖率。
 */

const net = require('../../util/net');
const config = require('../../config');
const { makeLogger } = require('../../logger');

const log = makeLogger('source:musicbrainz');

const NAME = 'musicbrainz';
const BASE = 'https://musicbrainz.org/ws/2';

// 官方硬性限速：1 req/s
const limiter = new net.RateLimiter(1000);

const stats = { requests: 0, ok: 0, empty: 0, failed: 0, busy: 0, hits: 0 };

function headers() {
  return {
    'User-Agent': config.USER_AGENT,
    Accept: 'application/json',
  };
}

/**
 * 搜索录音
 * @param {string} query
 * @param {number} limit
 */
async function search(query, limit = 5) {
  if (!query) return [];
  await limiter.acquire();
  stats.requests++;

  const url = `${BASE}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
  let r;
  try {
    r = await net.webGet(url, { timeoutMs: Math.max(config.ONLINE_TIMEOUT_MS, 15000), headers: headers() });
  } catch (e) {
    stats.failed++;
    log.debug('MusicBrainz 请求异常', { query, error: e.message });
    return [];
  }

  const b = r.body;

  // 源繁忙：HTTP 200 + body.error（原型实测 24 次被误判为「无结果」）
  if (b && b.error) {
    stats.busy++;
    stats.failed++;
    log.warn('MusicBrainz 源繁忙或返回错误', { query, error: String(b.error).slice(0, 100) });
    return [];
  }
  if (!r.ok || !b) {
    stats.failed++;
    log.debug('MusicBrainz 响应异常', { query, status: r.status });
    return [];
  }

  const recordings = Array.isArray(b.recordings) ? b.recordings : [];
  if (recordings.length === 0) {
    stats.empty++;
    return [];
  }

  stats.ok++;
  return recordings.map(fromMB).filter(Boolean);
}

function fromMB(rec) {
  if (!rec || !rec.title) return null;
  const artist = (rec['artist-credit'] || []).map((a) => (a && (a.name || (a.artist && a.artist.name))) || '').filter(Boolean);
  const rel = (rec.releases || [])[0] || {};
  let year = 0;
  const d = rel.date || '';
  const m = String(d).match(/(\d{4})/);
  if (m) year = parseInt(m[1], 10);
  return {
    source: NAME,
    id: rec.id || '',
    title: rec.title,
    artists: artist,
    artist: artist[0] || '',
    album: rel.title || '',
    albumId: rel.id || '',
    year,
    durationSec: Math.round((Number(rec.length) || 0) / 1000),
    picUrl: '',                 // MusicBrainz 不提供封面，需经 CAA 取
    mbReleaseId: rel.id || '',
    _raw: rec,
  };
}

/** 连通性测试 */
async function test() {
  const t0 = Date.now();
  try {
    const r = await search('Jay Chou', 1);
    return { ok: r.length > 0, latencyMs: Date.now() - t0, error: r.length ? '' : '未返回候选（也可能是源繁忙）' };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

function getStats() { return { ...stats }; }

module.exports = { NAME, search, test, getStats, fromMB, limiter };
