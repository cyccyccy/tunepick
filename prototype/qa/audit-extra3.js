'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const DATA = path.join(ROOT, 'data');
const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const l1tracks = JSON.parse(fs.readFileSync(path.join(DATA, 'l1-tracks.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(DATA, 'sample-100.json'), 'utf8'));
const entries = result.entries;
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const POP = sample.meta.layerPopulation;
const popTotal = Object.values(POP).reduce((a, b) => a + b, 0);
const arr = Array.isArray(l1tracks) ? l1tracks : l1tracks.tracks;
const N = arr.length;
const u = (k, w) => arr.filter((t) => t.availability[k] && t.availability[k][w]).length;
console.log('=== L1 全库复算（N=' + N + '）===');
for (const k of ['title', 'artist', 'album', 'year', 'genres', 'duration', 'cover']) {
  const raw = u(k, 'raw');
  const res = u(k, 'restored');
  console.log(k + ' raw=' + raw + ' (' + Math.round((raw / N) * 1000) / 10 + '%) restored=' + res + ' (' + Math.round((res / N) * 1000) / 10 + '%)');
}
const flags = arr.map((t) => t.flags || {});
console.log('=== flags ===');
for (const k of Object.keys(flags[0])) console.log('  ' + k + ' = ' + flags.filter((f) => f[k]).length);

const q1 = require('./q1-rows.json');
const neRows = new Map(q1.neHits.map((r) => [r.sampleIndex, r]));
const mbRows = new Map(q1.mbHits.map((r) => [r.sampleIndex, r]));
const w = (f) => {
  let s = 0;
  for (const L2 of ['A', 'B', 'C', 'D', 'E']) {
    const rs = entries.filter((e) => e.layer === L2);
    if (!rs.length) continue;
    s += (POP[L2] / popTotal) * (rs.filter(f).length / rs.length);
  }
  return Math.round(s * 1000) / 10;
};
const hitRow = (e, name) => {
  if (name === 'netease') return RANK[e.netease.tier] >= 2 ? neRows.get(e.sampleIndex) : null;
  return RANK[e.musicbrainz.tier] >= 2 ? mbRows.get(e.sampleIndex) : null;
};
const artistA = (e) => {
  const a = hitRow(e, 'netease');
  const b = hitRow(e, 'musicbrainz');
  return e.local.artistUsable || !!(a && a.onlineArtist) || !!(b && b.onlineArtist);
};
const artistB = (e) => {
  const a = hitRow(e, 'netease');
  const b = hitRow(e, 'musicbrainz');
  return e.local.artistUsable || !!(a && a.B && a.onlineArtist) || !!(b && b.B && b.onlineArtist);
};
const artistC = (e) => {
  const a = hitRow(e, 'netease');
  const b = hitRow(e, 'musicbrainz');
  return e.local.artistUsable || !!(a && a.C && a.onlineArtist) || !!(b && b.C && b.onlineArtist);
};
console.log('\n=== M-01 加权外推（口径 A/B/C）===');
console.log('A（非空，报告 93.9%）: ' + w(artistA));
console.log('B（可用：需第二证据）: ' + w(artistB));
console.log('C（可安全覆盖）: ' + w(artistC));

console.log('\n=== 歌手已佐证(exact/near)但不满足口径 C 的条目 ===');
for (const r of [...neRows.values(), ...mbRows.values()].filter((r) => r.A && (r.myArtistVerdict === 'exact' || r.myArtistVerdict === 'near') && !r.C)) {
  console.log('  [' + r.sampleIndex + '/' + r.source + '] ' + r.localTitle + ' / ' + r.localArtist + ' -> ' + r.onlineTitle + ' / ' + r.onlineArtist + ' verdict=' + r.myArtistVerdict + ' dur=' + r.durDiff + ' myTitle=' + r.myTitleSim);
}
console.log('\n=== 歌手 near（近似写法，需人工确认）===');
for (const r of [...neRows.values(), ...mbRows.values()].filter((r) => r.A && r.myArtistVerdict === 'near')) {
  console.log('  [' + r.sampleIndex + '/' + r.source + '] ' + r.localArtist + ' -> ' + r.onlineArtist + ' (' + r.myArtistReason + ')');
}
console.log('\n=== 63 命中的伪歌手/未知分布 ===');
const g = {};
for (const r of neRows.values()) {
  if (!r.pseudo) continue;
  const k = r.artistUsable ? r.localArtist : '[Unknown Artist]';
  g[k] = (g[k] || 0) + 1;
}
console.log(JSON.stringify(Object.entries(g).sort((a, b) => b[1] - a[1])));
console.log('\n=== 未命中 36 首的 source 侧证据（独立于 06-audit 分类）===');
const miss = entries.filter((e) => RANK[e.netease.tier] < 2 && RANK[e.musicbrainz.tier] < 2);
console.log('miss n = ' + miss.length);
let noCand = 0; let titleHigh = 0; let mid = 0; let low = 0;
for (const e of miss) {
  const pool = e.netease.candidatePoolSize;
  const ts = e.netease.bestScore ? e.netease.bestScore.titleSim : 0;
  if (pool === 0) noCand += 1;
  else if (ts >= 0.9) titleHigh += 1;
  else if (ts >= 0.6) mid += 1;
  else low += 1;
}
console.log('网易云候选池为 0: ' + noCand + ' | 有候选且 titleSim>=0.9: ' + titleHigh + ' | 0.6-0.9: ' + mid + ' | <0.6: ' + low);
