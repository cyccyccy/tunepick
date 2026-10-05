'use strict';
/**
 * 在线源：Cover Art Archive
 *
 * 由 MusicBrainz release id 取封面。
 * ⚠️ 原型实测：沙箱网络对该域间歇不可达（一次拿到 CAA 自己的 404 页，一次 fetch/curl 双双超时），
 *    属环境限制而非源站不可用，报告中不得写成「源不可用」。
 * ⚠️ 访问不存在的 id 也返回 HTTP 200（body 是错误 JSON），不能用状态码判定有无封面。
 *
 * 评审发现 #12：旧实现把所有失败一律记 stats.empty++，500/超时被记成
 * 「该 release 没有封面」，源健康度失真。现在区分 empty（业务上真没有）
 * 与 failed（网络 / HTTP 错误）。
 */

const net = require('../../util/net');
const config = require('../../config');
const { makeLogger } = require('../../logger');

const log = makeLogger('source:caa');

const NAME = 'caa';
const BASE = 'https://coverartarchive.org/release';
const limiter = new net.RateLimiter(500);

/** 连通性探测用的 mbid：全零占位，服务端一定回 404——但能收到 HTTP 响应即证明连通 */
const PROBE_MBID = '00000000-0000-0000-0000-000000000000';

const stats = { requests: 0, ok: 0, empty: 0, failed: 0 };

function headers() {
  return { 'User-Agent': config.USER_AGENT, Accept: 'application/json' };
}

/** 查询某 release 是否有封面，返回图片信息 */
async function lookup(mbReleaseId) {
  if (!mbReleaseId) return null;
  await limiter.acquire();
  stats.requests++;

  let r;
  try {
    r = await net.webGet(`${BASE}/${mbReleaseId}`, {
      timeoutMs: Math.max(config.ONLINE_TIMEOUT_MS, 15000),
      headers: headers(),
    });
  } catch (e) {
    // 网络层异常（DNS / 连接重置 / 超时）≠ 该 release 没有封面
    stats.failed++;
    log.debug('CAA 查询失败', { mbReleaseId, error: e.message });
    return null;
  }

  const b = r.body;

  // 非 2xx / 拿不到可解析的 body：记为失败（500、超时、劫持页都属于这一类）
  if (!r.ok || !b) {
    stats.failed++;
    log.debug('CAA 响应异常', { mbReleaseId, status: r.status, error: r.error || '', via: r.via });
    return null;
  }

  // HTTP 200 但业务上确实没有封面：{"error": ...} 或 images 为空
  if (b.error || !Array.isArray(b.images) || b.images.length === 0) {
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
}

/**
 * 连通性测试
 *
 * ⚠️ 旧实现用一个虚构的 mbid 去查封面（必然取不到），无论网络好坏都恒失败，
 *    健康度永远显示不可用。这里改成真正的连通性探测：只要收到任何 HTTP 响应
 *    （404 也算）就认为源站可达——我们测的是「能不能连上」，不是「这个 id 有没有封面」。
 */
async function test() {
  const t0 = Date.now();
  await limiter.acquire();
  try {
    const r = await net.rawRequest(`${BASE}/${PROBE_MBID}`, {
      method: 'GET',
      timeoutMs: Math.max(config.ONLINE_TIMEOUT_MS, 15000),
      headers: headers(),
    });
    const reachable = Number(r.status) > 0;
    return {
      ok: reachable,
      latencyMs: Date.now() - t0,
      error: reachable ? '' : `未收到 HTTP 响应（status=${r.status}）`,
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

function getStats() { return { ...stats }; }

module.exports = { NAME, lookup, test, getStats, PROBE_MBID };
