'use strict';
const fs = require('fs');
const L = require('./qa-lib');
const q1 = require('./q1-rows.json');
const result = JSON.parse(fs.readFileSync('D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype/data/result.json', 'utf8'));
const entries = new Map(result.entries.map((e) => [e.sampleIndex, e]));
const SEP = /[（(\[【]|\s[-–—_|/]\s?|[-–—_|]/;
const B = q1.neHits.filter((r) => r.B);
console.log('口径 B 通过的网易云命中 n=' + B.length);
const buckets = { overwriteSafe: [], fillSafe: [], fillReview: [] };
for (const r of B) {
  const e = entries.get(r.sampleIndex);
  const title = String(e.local.title || '');
  const m = title.match(/^([^\-–—_|/]{1,12})\s*[-–—_|/]\s*(.+)$/);
  const leftIsName = !!m && !/^\d/.test(m[1].trim()) && m[1].trim().length >= 2 && m[1].trim().length <= 8 && !/【|】|\(|（/.test(m[1]);
  if (!r.pseudo) buckets.overwriteSafe.push(r);
  else if (leftIsName) buckets.fillReview.push({ ...r, left: m[1].trim() });
  else buckets.fillSafe.push(r);
}
console.log('A) 本地歌手可信且被佐证（= 覆盖写，安全）:', buckets.overwriteSafe.length);
console.log('B) 本地无可用歌手、标题不含 "X-Y" 歌手形态（= 补全，较安全）:', buckets.fillSafe.length);
console.log('C) 本地无可用歌手、标题形如 "X - 曲名"（X 疑似本文件演唱者）+ 在线歌手与 X 不符（= 补全，需审阅）:', buckets.fillReview.length);
console.log('\nC 桶明细：');
for (const r of buckets.fillReview) console.log('  [' + r.sampleIndex + '] ' + r.localTitle + ' → 在线歌手 ' + r.onlineArtist + ' (dur=' + r.durDiff + ', title=' + r.myTitleSim + ')');
console.log('\nA 桶里歌手近似写法（需人工确认）:');
for (const r of buckets.overwriteSafe.filter((x) => x.myArtistVerdict === 'near')) console.log('  [' + r.sampleIndex + '] ' + r.localArtist + ' → ' + r.onlineArtist);
