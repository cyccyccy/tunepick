'use strict';

/**
 * audit-rest.js — QA 独立复核：Q1 明细 / Q3 源健康度 / Q4 封面 / Q5 报告对账 / Q6 失败模式
 */

const fs = require('fs');
const path = require('path');
const L = require('./qa-lib');

const ROOT = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'qa');

const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
const l1 = JSON.parse(fs.readFileSync(path.join(DATA, 'l1-report.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(DATA, 'sample-100.json'), 'utf8'));
const entries = result.entries;
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const POP = sample.meta.layerPopulation;
const popTotal = Object.values(POP).reduce((a, b) => a + b, 0);

const out = {};

// ============================================================ Q3 源健康度
const neAttempts = [];
for (const e of entries) {
  for (const a of e.netease.attempts || []) neAttempts.push({ ...a, sampleIndex: e.sampleIndex });
}
const mbAttempts = [];
for (const e of entries) {
  for (const a of e.musicbrainz.attempts || []) mbAttempts.push({ ...a, sampleIndex: e.sampleIndex });
}

out.q3 = {
  neteaseAttemptTotal: neAttempts.length,
  neteaseEntriesWithAttempts: entries.filter((e) => (e.netease.attempts || []).length > 0).length,
  neteaseCodeDistribution: neAttempts.reduce((m, a) => ((m[String(a.code)] = (m[String(a.code)] || 0) + 1), m), {}),
  neteaseStatusDistribution: neAttempts.reduce((m, a) => ((m[String(a.status)] = (m[String(a.status)] || 0) + 1), m), {}),
  neteaseViaDistribution: neAttempts.reduce((m, a) => ((m[String(a.via)] = (m[String(a.via)] || 0) + 1), m), {}),
  neteaseEndpointDistribution: neAttempts.reduce((m, a) => ((m[String(a.endpoint)] = (m[String(a.endpoint)] || 0) + 1), m), {}),
  neteaseEmptyCandidateAttempts: neAttempts.filter((a) => a.candidateCount === 0).length,
  neteaseNotOk: neAttempts.filter((a) => a.ok === false).length,
  neteaseCodeNot200: neAttempts.filter((a) => a.code !== null && a.code !== 200).length,
  neteaseStatusNot200: neAttempts.filter((a) => a.status !== 200).length,
  neteaseMsgPresent: neAttempts.filter((a) => a.msg).length,
  // 与上面 telemetry 对照：最终落盘的 result.json telemetry 是否为 0
  resultJsonTelemetry: result.telemetry,
  lyricRequestedInSummary: result.meta.summary.netease.lyrics.requested,
  lyricAvailableInSummary: result.meta.summary.netease.lyrics.available,
};

// 分段特征（按 sampleIndex 每 20 首一桶）
out.q3.segment = [0, 20, 40, 60, 80].map((lo) => {
  const rows = neAttempts.filter((a) => a.sampleIndex >= lo && a.sampleIndex < lo + 20);
  const ne = (k) => rows.reduce((s, a) => s + (Number(a[k]) || 0), 0);
  const songs = rows.map((a) => a.songCount).filter((v) => typeof v === 'number');
  return {
    range: `${lo}-${lo + 19}`,
    attempts: rows.length,
    tracks: new Set(rows.map((a) => a.sampleIndex)).size,
    avgCandidates: Math.round((ne('candidateCount') / (rows.length || 1)) * 100) / 100,
    avgSongCount: songs.length ? Math.round(songs.reduce((a, b) => a + b, 0) / songs.length) : null,
    songCountPresent: songs.length,
    avgElapsedMs: Math.round(ne('elapsedMs') / (rows.length || 1)),
    maxElapsedMs: rows.length ? Math.max(...rows.map((a) => a.elapsedMs || 0)) : 0,
    zeroCandidate: rows.filter((a) => a.candidateCount === 0).length,
    viaCurl: rows.filter((a) => String(a.via).startsWith('curl')).length,
    hitRate: Math.round((entries.filter((e) => e.sampleIndex >= lo && e.sampleIndex < lo + 20 && RANK[e.netease.tier] >= 2).length / 20) * 1000) / 10,
  };
});

// ============================================================ Q4 封面前缀
const coverPrefix = {};
for (const t of catalog.tracks) {
  const c = String(t.coverArt || '');
  const p = c ? c.split('-')[0] : '(empty)';
  coverPrefix[p] = (coverPrefix[p] || 0) + 1;
}
out.q4 = {
  total: catalog.tracks.length,
  coverPrefix,
  alCount: catalog.tracks.filter((t) => String(t.coverArt || '').startsWith('al-')).length,
  mfCount: catalog.tracks.filter((t) => String(t.coverArt || '').startsWith('mf-')).length,
  emptyCount: catalog.tracks.filter((t) => !t.coverArt).length,
  samplesMf: catalog.tracks.filter((t) => String(t.coverArt || '').startsWith('mf-')).slice(0, 3).map((t) => ({ coverArt: t.coverArt, title: t.title, artist: t.artist })),
  samplesAl: catalog.tracks.filter((t) => String(t.coverArt || '').startsWith('al-')).slice(0, 3).map((t) => ({ coverArt: t.coverArt, title: t.title, artist: t.artist })),
  catalogTrackKeys: Object.keys(catalog.tracks[0]),
};

// ============================================================ Q5 报告对账
const q5 = {};
// §4.4 样本内字段覆盖
const src4_4 = {};
{
  const artistAvail = (e) => e.local.artistUsable; // L1 后
  const neHit = (e) => RANK[e.netease.tier] >= 2;
  const mbHit = (e) => RANK[e.musicbrainz.tier] >= 2;
  const best = (e) => (neHit(e) ? e.netease.best : mbHit(e) ? e.musicbrainz.best : null);
  const cnt = (fn) => entries.filter(fn).length;
  // artist = L1可用 OR (命中且在线给了歌手)
  src4_4.artist = cnt((e) => artistAvail(e) || (!!best(e) && !!best(e).artistText));
  src4_4.album = cnt((e) => best(e) && !!best(e).album);
  src4_4.year = cnt((e) => best(e) && !!best(e).year);
  src4_4.cover = cnt((e) => neHit(e) && e.netease.best && !!e.netease.best.picId);
  src4_4.lyrics = cnt((e) => e.netease.lyrics && e.netease.lyrics.requested && e.netease.lyrics.chars > 0);
  src4_4.perLayerArtist = {};
  src4_4.perLayerYear = {};
  for (const layer of ['A', 'B', 'C', 'D', 'E']) {
    const rows = entries.filter((e) => e.layer === layer);
    src4_4.perLayerArtist[layer] = Math.round((rows.filter((e) => artistAvail(e) || (!!best(e) && !!best(e).artistText)).length / rows.length) * 1000) / 10;
    src4_4.perLayerYear[layer] = Math.round((rows.filter((e) => best(e) && !!best(e).year).length / rows.length) * 1000) / 10;
  }
}
q5.sampleFieldCounts = src4_4;

// 按层人口加权外推（对任意曲目级达标函数）
function weightedRate(pred) {
  let s = 0;
  for (const layer of ['A', 'B', 'C', 'D', 'E']) {
    const rows = entries.filter((e) => e.layer === layer);
    if (!rows.length) continue;
    const r = rows.filter(pred).length / rows.length;
    s += (POP[layer] / popTotal) * r;
  }
  return Math.round(s * 1000) / 10;
}
q5.weighted = {
  M01_artist: weightedRate((e) => e.local.artistUsable || (!!(RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2) && !!(RANK[e.netease.tier] >= 2 ? e.netease.best : e.musicbrainz.best).artistText)),
  M02_year: weightedRate((e) => {
    const b = RANK[e.netease.tier] >= 2 ? e.netease.best : RANK[e.musicbrainz.tier] >= 2 ? e.musicbrainz.best : null;
    return !!(b && b.year);
  }),
  M06_lyrics: weightedRate((e) => e.netease.lyrics && e.netease.lyrics.requested && e.netease.lyrics.chars > 0),
  M07_cover: weightedRate((e) => RANK[e.netease.tier] >= 2 && e.netease.best && !!e.netease.best.picId),
  M18_combinedStrict: weightedRate((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2),
  neteaseStrict: weightedRate((e) => RANK[e.netease.tier] >= 2),
  neteaseRelaxed: weightedRate((e) => RANK[e.netease.tierRelaxed] >= 2),
  mbStrict: weightedRate((e) => RANK[e.musicbrainz.tier] >= 2),
  union: weightedRate((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2 || RANK[e.netease.tierRelaxed] >= 2 || RANK[e.musicbrainz.tierRelaxed] >= 2),
  perLayer: { netease: {}, mb: {}, combined: {}, union: {} },
};
for (const layer of ['A', 'B', 'C', 'D', 'E']) {
  const rows = entries.filter((e) => e.layer === layer);
  const r = (fn) => Math.round((rows.filter(fn).length / rows.length) * 1000) / 10;
  q5.weighted.perLayer.netease[layer] = r((e) => RANK[e.netease.tier] >= 2);
  q5.weighted.perLayer.mb[layer] = r((e) => RANK[e.musicbrainz.tier] >= 2);
  q5.weighted.perLayer.combined[layer] = r((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2);
  q5.weighted.perLayer.union[layer] = r((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2 || RANK[e.netease.tierRelaxed] >= 2 || RANK[e.musicbrainz.tierRelaxed] >= 2);
}

out.q5 = q5;

// §8 耗时
out.q5.timing = {
  elapsedPerTrack: entries.map((e) => e.elapsedMs),
  meanElapsed: Math.round(entries.reduce((s, e) => s + (e.elapsedMs || 0), 0) / entries.length),
  medianElapsed: (() => {
    const a = [...entries].map((e) => e.elapsedMs).sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  })(),
  neRequestsPerTrack: Math.round((neAttempts.length / entries.length) * 100) / 100,
  mbRequestsPerTrack: Math.round((mbAttempts.length / entries.length) * 100) / 100,
  lyricRequests: entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested).length,
  extrapolatedMinutesAtMean: Math.round((entries.reduce((s, e) => s + (e.elapsedMs || 0), 0) / entries.length) * 2903 / 60000),
  extrapolatedMinutesAt6197: Math.round((6197 * 2903) / 60000),
};

// §7.3 伪歌手合计
const artistCounts = new Map();
for (const t of catalog.tracks) {
  const a = String(t.artist || '').trim();
  if (!a) continue;
  artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
}
const pseudo = [...artistCounts.entries()].filter(([n]) => L.isPseudoArtist(n) && n !== '[Unknown Artist]').sort((a, b) => b[1] - a[1]);
out.q5.pseudoArtists = { list: pseudo.slice(0, 15), totalTracks: pseudo.reduce((s, x) => s + x[1], 0) };
out.q5.unknownArtistTracks = artistCounts.get('[Unknown Artist]') || 0;

// ============================================================ Q6 MusicBrainz
out.q6 = {
  mbAttemptTotal: mbAttempts.length,
  mbStatus: mbAttempts.reduce((m, a) => ((m[String(a.status)] = (m[String(a.status)] || 0) + 1), m), {}),
  mbVia: mbAttempts.reduce((m, a) => ((m[String(a.via)] = (m[String(a.via)] || 0) + 1), m), {}),
  mbErrors: mbAttempts.filter((a) => a.error).length,
  mbNotOk: mbAttempts.filter((a) => a.ok === false).length,
  mbEmptyCandidates: mbAttempts.filter((a) => a.candidateCount === 0).length,
  mbEmptyWithCountZero: mbAttempts.filter((a) => a.candidateCount === 0 && a.count === 0).length,
  mbEmptyWithCountNull: mbAttempts.filter((a) => a.candidateCount === 0 && (a.count === null || a.count === undefined)).length,
  mbErrorsSample: mbAttempts.filter((a) => a.error).slice(0, 5),
  mbErrorByStatus: mbAttempts.filter((a) => a.error).reduce((m, a) => ((m[String(a.status)] = (m[String(a.status)] || 0) + 1), m), {}),
  // 请求成功的空结果 vs 被限速的空结果
  mbNoCandidateByIndexBucket: [0, 20, 40, 60, 80].map((lo) => {
    const rows = mbAttempts.filter((a) => a.sampleIndex >= lo && a.sampleIndex < lo + 20);
    return { range: `${lo}-${lo + 19}`, attempts: rows.length, empty: rows.filter((a) => a.candidateCount === 0).length, avgElapsed: Math.round(rows.reduce((s, a) => s + a.elapsedMs, 0) / (rows.length || 1)) };
  }),
};

// ============================================================ Q1 明细表
const DUR_OK = 15;
const q1rows = require('./q1-rows.json');
const neHits = q1rows.neHits;
fs.writeFileSync(path.join(OUT, 'audit-rest.json'), JSON.stringify(out, null, 1), 'utf8');

const failB = neHits.filter((r) => !r.B);
console.log('=== Q3 网易云 attempts 完整性 ===');
console.log(JSON.stringify({ ...out.q3, resultJsonTelemetry: undefined }, null, 1));
console.log('\n=== result.json 落盘 telemetry ===');
console.log(JSON.stringify(out.q3.resultJsonTelemetry));
console.log('\n=== Q4 封面前缀 ===', JSON.stringify(out.q4.coverPrefix), 'al=', out.q4.alCount, 'mf=', out.q4.mfCount, 'empty=', out.q4.emptyCount);
console.log('Q4 mf 样例:', JSON.stringify(out.q4.samplesMf));
console.log('Q4 al 样例:', JSON.stringify(out.q4.samplesAl));
console.log('\n=== Q5 样本字段覆盖（复算 §4.4）===');
console.log(JSON.stringify(out.q5.sampleFieldCounts, null, 1));
console.log('\n=== Q5 按层加权外推（复算 §4.1/§4.4）===');
console.log(JSON.stringify(out.q5.weighted, null, 1));
console.log('\n=== Q5 §8 耗时 ===');
console.log(JSON.stringify(out.q5.timing, null, 1));
console.log('\n=== Q5 伪歌手 ===');
console.log(JSON.stringify(out.q5.pseudoArtists, null, 1), 'unknownArtistTracks=', out.q5.unknownArtistTracks);
console.log('\n=== Q6 MusicBrainz ===');
console.log(JSON.stringify(out.q6, null, 1));
console.log('\n=== Q1: 63 个网易云 strict 命中里不满足口径 B 的', failB.length, '条 ===');
for (const r of failB) {
  console.log(`  [${r.sampleIndex}] ${r.localTitle} / ${r.localArtist} -> ${r.onlineTitle} / ${r.onlineArtist} | myTitle=${r.myTitleSim} recTitle=${r.recTitleSim} artist=${r.myArtistVerdict}(${r.myArtistReason}) dur=${r.durDiff} pseudo=${r.pseudo}`);
}
console.log('\nwrote qa/audit-rest.json');
