'use strict';
/** 补充核算：简繁折叠敏感度 / year 口径 / 策略计数 / 空候选 / MB count=null 归属 */

const fs = require('fs');
const path = require('path');
const L = require('./qa-lib');
const ROOT = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const DATA = path.join(ROOT, 'data');
const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const entries = result.entries;
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const q1 = require('./q1-rows.json');
const neHits = q1.neHits;

// ---- 简繁折叠（仅覆盖本样本出现的常见异体，明确声明为示意表，非 OpenCC）
const T2S = {
  傷: '伤', 愛: '爱', 還: '还', 樂: '乐', 車: '车', 藍: '蓝', 蓮: '莲', 許: '许', 時: '时',
  陣: '阵', 難: '难', 為: '为', 該: '该', 響: '响', 說: '说', 這: '这', 麼: '么', 華: '华',
  語: '语', 飛: '飞', 於: '于', 與: '与', 對: '对', 別: '别', 沒: '没', 個: '个', 們: '们',
  過: '过', 後: '后', 東: '东', 風: '风', 雲: '云', 長: '长', 門: '门', 間: '间', 請: '请',
  誰: '谁', 讓: '让', 兒: '儿', 幾: '几', 頭: '头', 心: '心', 聲: '声', 實: '实', 現: '现',
  開: '开', 關: '关', 覺: '觉', 見: '见', 現: '现', 場: '场', 環: '环', 繞: '绕', 車: '车',
};
const fold = (s) => String(s || '').replace(/[\u4e00-\u9fff]/g, (ch) => T2S[ch] || ch);
function myTitleSimFolded(a, b) {
  return Math.max(L.myTitleSim(a, b), L.myTitleSim(fold(a), fold(b)));
}

const rows = neHits.map((r) => {
  const e = entries.find((x) => x.sampleIndex === r.sampleIndex);
  const folded = myTitleSimFolded(e.local.title, r.onlineTitle);
  return { ...r, folded: Math.round(folded * 1000) / 1000 };
});

const DUR_OK = 15;
function bOf(r) {
  const titleOK = r.folded >= 0.8;
  const titleLoose = r.folded >= 0.65 && r.myArtistVerdict === 'exact';
  const corroborated = r.myArtistVerdict === 'exact' || r.myArtistVerdict === 'near';
  const durOK = r.durDiff !== null && r.durDiff <= DUR_OK;
  return (titleOK || titleLoose) && ((!r.pseudo && corroborated) || (r.pseudo && durOK));
}
const B_orig = rows.filter((r) => r.B).length;
const B_folded = rows.filter(bOf).length;
console.log('=== 口径 B 敏感度 ===');
console.log('原始（未折叠简繁，title>=0.8）:', B_orig);
console.log('加简繁折叠 + 歌手精确佐证可放宽 title 到 0.65:', B_folded);
console.log('折叠后新增通过的条目:', JSON.stringify(rows.filter((r) => !r.B && bOf(r)).map((r) => ({ i: r.sampleIndex, t: r.localTitle, o: r.onlineTitle, myTitle: r.myTitleSim, folded: r.folded, artist: r.myArtistVerdict, dur: r.durDiff }))));

console.log('\n=== 63 条 strict 命中按 myTitleSim 升序（前 12）===');
for (const r of [...rows].sort((a, b) => a.folded - b.folded).slice(0, 12)) {
  console.log(`  [${r.sampleIndex}] title=${r.folded}(${r.myTitleSim}) artist=${r.myArtistVerdict} dur=${r.durDiff} pseudo=${r.pseudo} | ${r.localTitle} / ${r.localArtist} -> ${r.onlineTitle} / ${r.onlineArtist}`);
}

// ---- year 口径：单一来源 vs 任一来源
const either = (pred) => entries.filter((e) => {
  const a = RANK[e.netease.tier] >= 2 && pred(e.netease.best);
  const b = RANK[e.musicbrainz.tier] >= 2 && pred(e.musicbrainz.best);
  return a || b;
}).length;
const preferred = (pred) =>
  entries.filter((e) => {
    const b = RANK[e.netease.tier] >= 2 ? e.netease.best : RANK[e.musicbrainz.tier] >= 2 ? e.musicbrainz.best : null;
    return !!b && pred(b);
  }).length;
console.log('\n=== year/album 口径对比（样本 100）===');
console.log('netease-only year:', entries.filter((e) => RANK[e.netease.tier] >= 2 && e.netease.best.year).length);
console.log('preferred-source year:', preferred((b) => b.year));
console.log('either-source year:', either((b) => b.year));
console.log('report §4.4 year = 63');
console.log('preferred-source album:', preferred((b) => b.album));
console.log('either-source album:', either((b) => b.album));
console.log('report §4.4 album = 64');
const perLayerEitherYear = {};
for (const layer of ['A', 'B', 'C', 'D', 'E']) {
  const rs = entries.filter((e) => e.layer === layer);
  perLayerEitherYear[layer] = Math.round((rs.filter((e) => (RANK[e.netease.tier] >= 2 && e.netease.best.year) || (RANK[e.musicbrainz.tier] >= 2 && e.musicbrainz.best.year)).length / rs.length) * 1000) / 10;
}
console.log('either-source year 分层:', JSON.stringify(perLayerEitherYear), '（报告 §4.4: A20 B86.7 C44 D93.3 E84）');

// ---- 策略计数（真实请求数 vs perStrategy 行数）
const stratCount = {};
for (const e of entries) for (const a of e.netease.attempts || []) stratCount[a.strategy] = (stratCount[a.strategy] || 0) + 1;
const perStratRows = {};
for (const e of entries) for (const k of Object.keys(e.netease.perStrategy || {})) perStratRows[k] = (perStratRows[k] || 0) + 1;
console.log('\n=== 策略：真实请求数 vs perStrategy 聚合行数（§4.2 "发出次数"）===');
console.log('真实 requests:', JSON.stringify(stratCount), ' 合计', Object.values(stratCount).reduce((a, b) => a + b, 0));
console.log('perStrategy 行数:', JSON.stringify(perStratRows));
console.log('summary.strategyComparison.issued:', JSON.stringify(Object.fromEntries(Object.entries(result.meta.summary.netease.strategyComparison).map(([k, v]) => [k, v.issued]))));

// ---- 空候选的 6 次网易云请求
console.log('\n=== 网易云 candidateCount=0 的请求 ===');
for (const e of entries) for (const a of e.netease.attempts || []) if (a.candidateCount === 0) console.log(`  [${e.sampleIndex}] ${a.strategy} q="${a.query}" code=${a.code} songCount=${a.songCount} status=${a.status}`);

// ---- MB count=null 的归属
const mbNull = [];
for (const e of entries) for (const a of e.musicbrainz.attempts || []) if (a.candidateCount === 0 && (a.count === null || a.count === undefined)) mbNull.push({ i: e.sampleIndex, via: a.via, status: a.status, q: a.query, elapsed: a.elapsedMs });
console.log('\n=== MB candidateCount=0 且 count===null 的请求 n=' + mbNull.length + ' ===');
console.log('按 via 分布:', JSON.stringify(mbNull.reduce((m, x) => ((m[x.via] = (m[x.via] || 0) + 1), m), {})));
console.log('按 status 分布:', JSON.stringify(mbNull.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {})));
console.log('样例:', JSON.stringify(mbNull.slice(0, 4), null, 1));
const mbZeroCount = [];
for (const e of entries) for (const a of e.musicbrainz.attempts || []) if (a.candidateCount === 0 && a.count === 0) mbZeroCount.push(a);
console.log('MB candidateCount=0 且 count===0 的请求 n=' + mbZeroCount.length, '按 via:', JSON.stringify(mbZeroCount.reduce((m, x) => ((m[x.via] = (m[x.via] || 0) + 1), m), {})));
console.log('全部 MB via=curl 且 candidateCount=0 的请求数:', (() => {
  let n = 0;
  for (const e of entries) for (const a of e.musicbrainz.attempts || []) if (a.via === 'curl' && a.candidateCount === 0) n += 1;
  return n;
})());

// ---- 全库 artist 可用率复算（§3.3 74.4% / 222 首）
const fs2 = require('fs');
const l1tracks = JSON.parse(fs2.readFileSync(path.join(DATA, 'l1-tracks.json'), 'utf8'));
const tk = Array.isArray(l1tracks) ? l1tracks : l1tracks.tracks || [];
console.log('\n=== L1 逐曲明细 keys ===', tk.length, JSON.stringify(Object.keys(tk[0] || {})));
const g = tk.filter((t) => t.flags && t.flags.artistGarbled);
console.log('artistGarbled 曲目数:', g.length);
const restoredUsable = tk.filter((t) => t.after && t.after.artistUsable).length;
const rawUsable = tk.filter((t) => t.before && t.before.artistUsable).length;
console.log('raw artistUsable:', rawUsable, '-> restored artistUsable:', restoredUsable, ' (报告 66.8% -> 74.4%, +222)');
const albumAfter = tk.filter((t) => t.after && t.after.albumUsable).length;
const albumBefore = tk.filter((t) => t.before && t.before.albumUsable).length;
console.log('raw albumUsable:', albumBefore, '-> restored albumUsable:', albumAfter, ' (报告 59.9% -> 85.3%, +739)');
