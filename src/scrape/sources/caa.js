'use strict';
/**
 * 在线源：Cover Art Archive
 *
 * 由 MusicBrainz release id 取封面。
 * ⚠️ 原型实测：沙箱网络对该域间歇不可达（一次拿到 CAA 自己的 404 页，一次 fetch/curl 双双超时），
 *    属环境限制而非源站不可用，报告中不得写成「源不可用」。
 * ⚠️ 访问不存在的 id 也返回 HTTP 200（body 是错误 JSON），不能用状态码判定有无封面。
 */

const net = require('../../util/net');
const config = require('../../config');
const { makeLogger } = require('../../logger');

const log = makeLogger('source:caa');

const NAME = 'caa';
const BASE = 'https://coverartarchive.org/release';
const limiter = new net.RateLimiter(500);

const stats = { requests: 0, ok: 0, empty: 0, failed: 0 };

/** 查询某 release 是否有封面，返回图片信息 */
async function lookup(mbReleaseId) {
  if (!mbReleaseId) return null;
  await limiter.acquire();
  stats.requests++;
  try {
    const r = await net.webGet(`${BASE}/${mbReleaseId}`, {
      timeoutMs: Math.max(config.ONLINE_TIMEOUT_MS, 15000),
      headers: { 'User-Agent': config.USER_AGENT, Accept: 'application/json' },
    });
    const b = r.body;
    // 不存在的 release：HTTP 200 + {"error": ...}
    if (!r.ok || !b || b.error || !Array.isArray(b.images) || b.images.length === 0) {
      stats.empty++;
      return null;
    }
    const front = b.images.find((i) => i.front) || b.images[0];
    stats.ok++;
    return {
      url: front.image || (front.thumbnails && front.thumbnails.large) || '',
      thumb250: front.thumbnails && front.thumbnails['250'] ? front.thumbnails['250'] : '',
      thumb500: front.thumbnails && front.thumbnails['500'] ? front.thumbnails['500'] : '',
    };
  } catch (e) {
    stats.failed++;
    log.debug('CAA 查询失败', { mbReleaseId, error: e.message });
    return null;
  }
}

async function test() {
  const t0 = Date.now();
  // 用一个已知一定有封面的 release（The Dark Side of the Moon）
  const r = await lookup('f0d8f4e0-4f4c-3e5a-8f0e-1a2b3c4d5e6f');
  return { ok: !!r, latencyMs: Date.now() - t0, error: r ? '' : '未取到封面（可能是网络限制）' };
}

function getStats() { return { ...stats }; }

module.exports = { NAME, lookup, test, getStats };
