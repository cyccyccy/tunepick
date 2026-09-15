'use strict';
/**
 * probe-net.js — QA 抽查外网源（≤8 次请求，遵守 MB ≤1 req/s）
 * 直接调用工程师的 src/util/net.js，既抽查源，也顺带验证网络层对
 * "HTTP 200 + 错误体" 的识别能力。
 */
const path = require('path');
const ROOT = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const { webGet, sleep } = require(path.join(ROOT, 'src', 'util', 'net.js'));
const MB_UA = 'NasMusicScraperSpike/0.1.0 ( https://example.invalid/nas-music-scraper; spike@example.invalid )';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const probes = [
    { name: 'MB 空结果（中文车载冷门）', url: 'https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent('recording:"好想你" AND artist:"Cydian"') + '&fmt=json&limit=5', headers: { 'User-Agent': MB_UA, Accept: 'application/json' } },
    { name: 'MB 有结果（英文知名曲）', url: 'https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent('recording:"Spectre" AND artist:"Alan Walker"') + '&fmt=json&limit=5', headers: { 'User-Agent': MB_UA, Accept: 'application/json' } },
    { name: 'MB 故意非法 query（看错误体形状）', url: 'https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent('recording:"((((broken') + '&fmt=json&limit=5', headers: { 'User-Agent': MB_UA, Accept: 'application/json' } },
    { name: 'Cover Art Archive front-250（沙箱可达性）', url: 'https://coverartarchive.org/release/f1e0b6e1-3e7b-3a58-9e6c-9f1f5f4a4b9c/front-250', headers: { 'User-Agent': MB_UA } },
  ];
  for (const p of probes) {
    await sleepMs(1300);
    const r = await webGet(p.url, { headers: p.headers, userAgent: p.headers['User-Agent'], timeoutMs: 20000 });
    const shape = r.body
      ? Object.keys(r.body).slice(0, 6).join(',') + (typeof r.body.count === 'number' ? ' count=' + r.body.count : '') + (r.body.error ? ' error=' + JSON.stringify(r.body.error).slice(0, 120) : '')
      : '(no body)';
    console.log('--- ' + p.name + ' ---');
    console.log('  ok=' + r.ok + ' via=' + r.via + ' status=' + r.status + ' bytes=' + r.bytes + ' elapsed=' + r.elapsedMs + 'ms err=' + (r.error || '-'));
    console.log('  body: ' + shape);
    if (r.body && Array.isArray(r.body.recordings)) console.log('  recordings=' + r.body.recordings.length);
  }
})().catch((e) => console.error('probe failed', e));
