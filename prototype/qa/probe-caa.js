'use strict';
/** probe-caa.js — 单次 Cover Art Archive 抽查，看被拦时到底返回什么（区分沙箱/代理 vs 源站） */
const path = require('path');
const ROOT = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const { webGet } = require(path.join(ROOT, 'src', 'util', 'net.js'));
const UA = 'NasMusicScraperSpike/0.1.0 ( https://example.invalid/nas-music-scraper; spike@example.invalid )';
(async () => {
  const url = 'https://coverartarchive.org/release/f1e0b6e1-3e7b-3a58-9e6c-9f1f5f4a4b9c/';
  const r = await webGet(url, { headers: { 'User-Agent': UA }, userAgent: UA, timeoutMs: 20000 });
  console.log('via=' + r.via + ' ok=' + r.ok + ' status=' + r.status + ' bytes=' + r.bytes + ' err=' + (r.error || '-'));
  console.log('textSample:', JSON.stringify(String(r.textSample || '').slice(0, 400)));
  console.log('env proxy:', JSON.stringify({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, http_proxy: process.env.http_proxy, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY }));
})();
