'use strict';
/** probe-caa2.js — 用真实 release id 抽查 Cover Art Archive（JSON 视图） */
const path = require('path');
const http = require('http');
const { webGet, sleep } = require(path.join('D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype', 'src', 'util', 'net.js'));
const UA = 'NasMusicScraperSpike/0.1.0 ( https://example.invalid/nas-music-scraper; spike@example.invalid )';
const ids = ['f25432e1-ae11-4701-87a1-855d6819b4bd', '16393dfe-b46f-4490-802a-951e803b5a30'];
(async () => {
  for (const id of ids) {
    const r = await webGet('https://coverartarchive.org/release/' + id, { headers: { 'User-Agent': UA, Accept: 'application/json' }, userAgent: UA, timeoutMs: 20000 });
    console.log('--- ' + id + ' --- via=' + r.via + ' ok=' + r.ok + ' status=' + r.status + ' bytes=' + r.bytes + ' err=' + (r.error || '-'));
    if (r.body && r.body.images) {
      console.log('  images=' + r.body.images.length + ' front=' + JSON.stringify(r.body.images[0].image) + ' types=' + JSON.stringify(r.body.images[0].types));
      // 试着真的把图片取下来（走代理）
      const img = await webGet(r.body.images[0].image, { headers: { 'User-Agent': UA }, userAgent: UA, timeoutMs: 20000 });
      console.log('  image fetch: ok=' + img.ok + ' status=' + img.status + ' bytes=' + img.bytes + ' via=' + img.via + ' err=' + (img.error || '-'));
    } else {
      console.log('  textSample=' + JSON.stringify(String(r.textSample || '').slice(0, 200)));
    }
    await sleep(1200);
  }
})();
