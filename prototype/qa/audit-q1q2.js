'use strict';

/**
 * audit-q1q2.js — QA 独立复核：命中口径（Q1）+ 档位单调性（Q2）
 *
 * 不复用 src/match.js 的 tier 判定；所有"是否命中"的重新判定都用 qa-lib.js 里的
 * 自写算法。match.js 的 scoreCandidate 仅在需要"隔离实现 bug vs 定义问题"时被
 * 显式调用（会明确标注）。
 */

const fs = require('fs');
const path = require('path');
const L = require('./qa-lib');

const ROOT = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'qa');

const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
const entries = result.entries;
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };

// ------------------------------------------------------- 全库歌手频次（伪歌手佐证）
const artistCounts = new Map();
for (const t of catalog.tracks) {
  const a = String(t.artist || '').trim();
  if (!a) continue;
  artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
}

// ------------------------------------------------------------ 逐条重新判定
const DUR_OK = 15;
const DUR_TIGHT = 5;

function adjudicate(entry, src) {
  const block = entry[src];
  if (!block || !block.valid || !block.best) return null;
  const local = entry.local;
  const best = block.best;
  const sc = block.bestScore || {};
  const myTitle = L.myTitleSim(local.title, best.title);
  const aVerdict = L.artistVerdict(local.artist, best.artistText);
  const pseudo = !local.artistUsable || L.isPseudoArtist(local.artist);
  const durDiff = sc.durDiff === null || sc.durDiff === undefined ? null : sc.durDiff;
  const durOK = durDiff !== null && durDiff <= DUR_OK;
  const durTight = durDiff !== null && durDiff <= DUR_TIGHT;

  const titleOK = myTitle >= 0.8;
  const titleStrong = myTitle >= 0.9;

  // 口径 A —— 工程师的 strict 档
  const A = RANK[block.tier] >= 2;
  // 口径 B —— 歌手（或时长）必须佐证
  const artistCorroborated = aVerdict.verdict === 'exact' || aVerdict.verdict === 'near';
  const B = titleOK && ((!pseudo && artistCorroborated) || (pseudo && durOK));
  // 口径 C —— 曲名 + 时长 + 歌手 三方互证（可安全覆盖写库）
  const C = titleOK && !pseudo && aVerdict.verdict === 'exact' && durOK;
  // 口径 C'（口径 C 的宽松版：允许简繁/错别字近似）
  const C2 = titleOK && !pseudo && artistCorroborated && durOK;
  // 最弱档：无歌手可核 AND 无时长证据 —— 只有曲名一个信号
  const weakestOnly = pseudo && titleOK && !durOK;

  return {
    sampleIndex: entry.sampleIndex,
    layer: entry.layer,
    source: src,
    localTitle: local.title,
    localArtist: local.artist,
    artistUsable: local.artistUsable,
    pseudo,
    libraryArtistCount: artistCounts.get(String(local.artist || '').trim()) || 0,
    onlineTitle: best.title,
    onlineArtist: best.artistText,
    onlineAlbum: best.album,
    onlineYear: best.year,
    recTier: block.tier,
    recTierRelaxed: block.tierRelaxed,
    recTitleSim: sc.titleSim,
    recArtistSim: sc.artistSim,
    myTitleSim: Math.round(myTitle * 1000) / 1000,
    myArtistVerdict: aVerdict.verdict,
    myArtistReason: aVerdict.reason,
    durDiff,
    A,
    B,
    C,
    C2,
    weakestOnly,
  };
}

const rows = [];
for (const e of entries) {
  for (const src of ['netease', 'musicbrainz']) {
    const r = adjudicate(e, src);
    if (r) rows.push(r);
  }
}
const neHits = rows.filter((r) => r.source === 'netease' && r.A);
const mbHits = rows.filter((r) => r.source === 'musicbrainz' && r.A);

// combined（去重到曲目级）：任一边命中
const combinedHitIdx = entries
  .filter((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2)
  .map((e) => e.sampleIndex);
const combinedRows = combinedHitIdx.map((idx) => {
  const e = entries.find((x) => x.sampleIndex === idx);
  const ne = RANK[e.netease.tier] >= 2 ? rows.find((r) => r.sampleIndex === idx && r.source === 'netease') : null;
  const mb = RANK[e.musicbrainz.tier] >= 2 ? rows.find((r) => r.sampleIndex === idx && r.source === 'musicbrainz') : null;
  // 曲目级口径：两个源里"最好的那个判定"胜出（B/C 取或）
  return { sampleIndex: idx, layer: e.layer, ne, mb };
});

function tally(rowsIn, key) {
  return { total: rowsIn.length, yes: rowsIn.filter((r) => r[key]).length, pct: Math.round((rowsIn.filter((r) => r[key]).length / (rowsIn.length || 1)) * 1000) / 10 };
}

const digest = {
  reproduced: {
    netease: {
      tierHist: Object.fromEntries(['exact', 'likely', 'weak', 'miss'].map((t) => [t, entries.filter((e) => e.netease.tier === t).length])),
      hitA: neHits.length,
      relaxedHits: entries.filter((e) => RANK[e.netease.tierRelaxed] >= 2).length,
    },
    musicbrainz: {
      tierHist: Object.fromEntries(['exact', 'likely', 'weak', 'miss'].map((t) => [t, entries.filter((e) => e.musicbrainz.tier === t).length])),
      hitA: mbHits.length,
      relaxedHits: entries.filter((e) => RANK[e.musicbrainz.tierRelaxed] >= 2).length,
    },
    combined: { hitA: combinedHitIdx.length, sampleN: entries.length, pct: Math.round((combinedHitIdx.length / entries.length) * 1000) / 10 },
  },

  q1: {
    // 口径 A/B/C 计数（曲目级，按"该源命中"的曲目集合各自计算）
    netease: {
      A: neHits.length,
      B: neHits.filter((r) => r.B).length,
      C: neHits.filter((r) => r.C).length,
      C2: neHits.filter((r) => r.C2).length,
      weakestOnly: neHits.filter((r) => r.weakestOnly).length,
      pseudoCount: neHits.filter((r) => r.pseudo).length,
      artistExact: neHits.filter((r) => r.myArtistVerdict === 'exact').length,
      artistNear: neHits.filter((r) => r.myArtistVerdict === 'near').length,
      artistNone: neHits.filter((r) => r.myArtistVerdict === 'none').length,
      pseudoButArtistExact: neHits.filter((r) => r.pseudo && r.myArtistVerdict === 'exact').length,
      pseudoAndDurOK: neHits.filter((r) => r.pseudo && r.durDiff !== null && r.durDiff <= 15).length,
      pseudoNoDur: neHits.filter((r) => r.pseudo && !(r.durDiff !== null && r.durDiff <= 15)).length,
    },
    musicbrainz: {
      A: mbHits.length,
      B: mbHits.filter((r) => r.B).length,
      C: mbHits.filter((r) => r.C).length,
      C2: mbHits.filter((r) => r.C2).length,
      pseudoCount: mbHits.filter((r) => r.pseudo).length,
      artistExact: mbHits.filter((r) => r.myArtistVerdict === 'exact').length,
      artistNear: mbHits.filter((r) => r.myArtistVerdict === 'near').length,
      artistNone: mbHits.filter((r) => r.myArtistVerdict === 'none').length,
    },
    combined: {
      A: combinedRows.length,
      B: combinedRows.filter((r) => (r.ne && r.ne.B) || (r.mb && r.mb.B)).length,
      C: combinedRows.filter((r) => (r.ne && r.ne.C) || (r.mb && r.mb.C)).length,
      C2: combinedRows.filter((r) => (r.ne && r.ne.C2) || (r.mb && r.mb.C2)).length,
    },
    // 我的标题相似度 vs match.js 记录的 titleSim 的偏差（校验 match.js 是否算错）
    titleSimAgreement: (() => {
      const pairs = rows.filter((r) => r.A).map((r) => ({ i: r.sampleIndex, s: r.source, rec: r.recTitleSim, mine: r.myTitleSim, d: Math.abs(r.recTitleSim - r.myTitleSim) }));
      const big = pairs.filter((p) => p.d > 0.25);
      return { n: pairs.length, maxDelta: Math.round(Math.max(...pairs.map((p) => p.d)) * 1000) / 1000, over25: big };
    })(),
  },
};

// ------------------------------------------------------------------ Q2
const q2 = (() => {
  const out = { nonMonotonic: [], strictHitRelaxedMiss: [], strictMissRelaxedHit: [] };
  for (const e of entries) {
    for (const src of ['netease', 'musicbrainz']) {
      const b = e[src];
      if (!b || !b.valid) continue;
      const sh = RANK[b.tier] >= 2;
      const rh = RANK[b.tierRelaxed] >= 2;
      if (sh !== rh) {
        out.nonMonotonic.push({
          sampleIndex: e.sampleIndex,
          source: src,
          tier: b.tier,
          tierRelaxed: b.tierRelaxed,
          titleSim: b.bestScore && b.bestScore.titleSim,
          artistSim: b.bestScore && b.bestScore.artistSim,
          durDiff: b.bestScore && b.bestScore.durDiff,
          localArtist: e.local.artist,
          artistUsable: e.local.artistUsable,
          onlineArtist: b.best && b.best.artistText,
        });
        (sh ? out.strictHitRelaxedMiss : out.strictMissRelaxedHit).push(e.sampleIndex + '/' + src);
      }
    }
  }
  return out;
})();

// 隔离"实现 bug" vs "定义问题"：用 match.js 自己的 scoreCandidate，
// 但改成"按 relaxed 档优先"重新排序（真正的 relaxed 最大化）
const matchjs = require(path.join(ROOT, 'src', 'match.js'));
const q2b = (() => {
  const per = { netease: { recorded: 0, reRanked: 0, union: 0, poolLimited: 0 }, musicbrainz: { recorded: 0, reRanked: 0, union: 0, poolLimited: 0 } };
  const detail = [];
  for (const e of entries) {
    for (const src of ['netease', 'musicbrainz']) {
      const b = e[src];
      if (!b || !b.valid || !b.topCandidates || !b.topCandidates.length) continue;
      if (b.candidatePoolSize > b.topCandidates.length) per[src].poolLimited += 1;
      const pool = b.topCandidates.map((x) => x.candidate);
      // 用 match.js 自己打分，但按 relaxed 档优先取 best
      const scored = pool.map((c) => ({ c, s: matchjs.scoreCandidate(e.local, c) }));
      scored.sort((a, x) => {
        const t = matchjs.TIER_RANK[x.s.relaxed.tier] - matchjs.TIER_RANK[a.s.relaxed.tier];
        if (t !== 0) return t;
        if (x.s.relaxed.score !== a.s.relaxed.score) return x.s.relaxed.score - a.s.relaxed.score;
        return x.s.strict.score - a.s.strict.score;
      });
      const bestRelaxed = scored[0];
      const recorded = RANK[b.tierRelaxed] >= 2;
      const reranked = matchjs.TIER_RANK[bestRelaxed.s.relaxed.tier] >= 2 || matchjs.TIER_RANK[bestRelaxed.s.strict.tier] >= 2;
      const union = RANK[b.tier] >= 2 || recorded;
      if (recorded) per[src].recorded += 1;
      if (reranked) per[src].reRanked += 1;
      if (union) per[src].union += 1;
      if (reranked && !union) {
        detail.push({ sampleIndex: e.sampleIndex, source: src, gotTitle: bestRelaxed.c.title, gotArtist: bestRelaxed.c.artistText, relaxedTier: bestRelaxed.s.relaxed.tier, strictTier: bestRelaxed.s.strict.tier });
      }
    }
  }
  return { per, recoveredByReRanking: detail };
})();

// 曲目级并集 vs relaxed 最大化
const q2c = (() => {
  const rec = entries.filter((e) => RANK[e.netease.tierRelaxed] >= 2 || RANK[e.musicbrainz.tierRelaxed] >= 2).length;
  const uni = entries.filter((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2 || RANK[e.netease.tierRelaxed] >= 2 || RANK[e.musicbrainz.tierRelaxed] >= 2).length;
  return { relaxedRecorded: rec, unionTrackLevel: uni };
})();

// ------------------------------------------------------- 报告 §2.3 "6 首" 的真因
const sixClaim = entries
  .filter((e) => RANK[e.netease.tier] >= 2 && RANK[e.netease.tierRelaxed] < 2)
  .map((e) => ({
    sampleIndex: e.sampleIndex,
    tier: e.netease.tier,
    tierRelaxed: e.netease.tierRelaxed,
    titleSim: e.netease.bestScore.titleSim,
    artistSim: e.netease.bestScore.artistSim,
    durDiff: e.netease.bestScore.durDiff,
    durFactor: e.netease.bestScore.durFactor,
    localTitle: e.local.title,
    onlineTitle: e.netease.best.title,
  }));

fs.writeFileSync(path.join(OUT, 'q1-rows.json'), JSON.stringify({ neHits, mbHits, combinedRows }, null, 1), 'utf8');
fs.writeFileSync(
  path.join(OUT, 'audit-q1q2.json'),
  JSON.stringify({ digest, q2, q2b, q2c, sixClaim }, null, 1),
  'utf8'
);

// ------------------------------------------------------------------ print
console.log('=== 复现的档位直方图 ===');
console.log(JSON.stringify(digest.reproduced, null, 1));
console.log('\n=== Q1 口径 A/B/C（曲目级）===');
console.log(JSON.stringify(digest.q1, null, 1));
console.log('\n=== Q2 非单调明细（strict 与 relaxed 不一致）===');
console.log(JSON.stringify(q2.nonMonotonic, null, 1));
console.log('\n=== §2.3 声称的"6 首 strict 命中却掉到 relaxed weak" ===');
console.log(JSON.stringify(sixClaim, null, 1));
console.log('\n=== relaxed 最大化重排（用 match.js 自己的 scoreCandidate，仅换排序）===');
console.log(JSON.stringify(q2b, null, 1));
console.log('\n=== 曲目级 ===');
console.log(JSON.stringify(q2c, null, 1));
console.log('\nwrote qa/audit-q1q2.json + qa/q1-rows.json');
