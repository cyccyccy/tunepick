'use strict';
const fs = require('fs');
const L = require('./qa-lib');
const q1 = require('./q1-rows.json');
const R = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype/data';
const result = JSON.parse(fs.readFileSync(R + '/result.json', 'utf8'));
const catalog = JSON.parse(fs.readFileSync(R + '/catalog.json', 'utf8'));
const entries = new Map(result.entries.map((e) => [e.sampleIndex, e]));
const cnt = new Map();
for (const t of catalog.tracks) {
  const a = String(t.artist || '').trim();
  if (a) cnt.set(a, (cnt.get(a) || 0) + 1);
}
const B = q1.neHits.filter((r) => r.B);
const out = [];
for (const r of B) {
  const e = entries.get(r.sampleIndex);
  const title = String(e.local.title || '');
  const m = title.match(/^([^\-–—_|/]{1,14})\s*[-–—_|/]\s*(.+)$/);
  const left = m ? m[1].replace(/[（(].*$/, '').trim() : '';
  const right = m ? m[2].replace(/[（(].*$/, '').trim() : '';
  const leftCount = cnt.get(left) || 0;
  const rightCount = cnt.get(right) || 0;
  const onlineMatchLeft = left ? L.artistVerdict(left, r.onlineArtist).verdict !== 'none' : false;
  const onlineMatchRight = right ? L.artistVerdict(right, r.onlineArtist).verdict !== 'none' : false;
  out.push({ i: r.sampleIndex, title, left, right, leftCount, rightCount, online: r.onlineArtist, onlineMatchLeft, onlineMatchRight, dur: r.durDiff, pseudo: r.pseudo });
}
console.log('=== 口径 B 通过的 55 首中，标题形如 "X - Y" 的条目（共 ' + out.filter((x) => x.left).length + '）===');
console.log('| # | 本地标题 | X | Y | X在库内歌手字段出现次数 | 在线歌手 | 在线歌手≈X | 在线歌手≈Y | 时长差 |');
for (const x of out.filter((y) => y.left)) {
  console.log('| ' + x.i + ' | ' + x.title + ' | ' + x.left + ' | ' + x.right + ' | ' + x.leftCount + ' | ' + x.online + ' | ' + (x.onlineMatchLeft ? 'Y' : '-') + ' | ' + (x.onlineMatchRight ? 'Y' : '-') + ' | ' + x.dur + ' |');
}
const risk = out.filter((x) => x.left && !x.onlineMatchLeft && !x.onlineMatchRight);
const riskCounted = out.filter((x) => x.left && x.leftCount >= 5 && !x.onlineMatchLeft);
console.log('\n在线歌手既不≈X 也不≈Y 的条目数:', risk.length, JSON.stringify(risk.map((x) => x.i)));
console.log('X 在库内歌手字段出现>=5次 且 在线歌手≠X（疑似用"原唱"覆盖了"本文件演唱者"）:', riskCounted.length, JSON.stringify(riskCounted.map((x) => ({ i: x.i, left: x.left, n: x.leftCount, online: x.online }))));
