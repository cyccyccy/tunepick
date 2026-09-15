'use strict';

/**
 * 10-relaxed-max.js — two measurements the main pass could not report.
 *
 * (1) RELAXED-MAXIMISED hit rate.
 *     `pickBest()` ranks strict-first, so a track that a strict rule likes but a
 *     relaxed rule dislikes is credited to strict. Reporting the relaxed rate
 *     from that ranking UNDERSTATES what a relaxed-only product would achieve.
 *     Here the SAME `scoreCandidate()` from src/match.js is used, and only the
 *     ORDERING is changed to relaxed-first. Nothing else differs, so the delta
 *     between this and §4.1 is attributable to the ranking rule alone.
 *
 * (2) DURATION CONSISTENCY of hits.
 *     Duration is the only cross-check that is independent of the title string,
 *     so its error rate belongs in the PRD. Reported at the 15 s and 20 s
 *     thresholds separately, because 90.5% at ±15 s leaves only 0.5 pp of
 *     headroom against a ≥90% target — too brittle to be a single metric.
 *
 * LIMITATION (must be stated in the report): the persisted candidate pool was
 * capped at 5 per source by the original run, so this is a re-ranking inside a
 * TRUNCATED pool, not a fresh search. It bounds the relaxed rate from below.
 *
 * No network access. Reads data/result.json only.
 */

const fs = require('fs');
const path = require('path');
const { scoreCandidate, TIER_RANK } = require('./match');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'relaxed-max.json');

const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(DATA, 'sample-100.json'), 'utf8'));

const entries = result.entries;
const pop = sample.meta.layerPopulation;
const popTotal = Object.values(pop).reduce((a, b) => a + b, 0);
const layers = ['A', 'B', 'C', 'D', 'E'];

/** Rank a candidate pool relaxed-first, using match.js's own scorer. */
function pickBestRelaxed(local, candidates) {
  const ranked = candidates
    .map((cand) => ({ candidate: cand, score: scoreCandidate(local, cand) }))
    .sort((a, b) => {
      const t = TIER_RANK[b.score.relaxed.tier] - TIER_RANK[a.score.relaxed.tier];
      if (t !== 0) return t;
      if (b.score.relaxed.score !== a.score.relaxed.score) return b.score.relaxed.score - a.score.relaxed.score;
      const s = TIER_RANK[b.score.strict.tier] - TIER_RANK[a.score.strict.tier];
      if (s !== 0) return s;
      return b.score.strict.score - a.score.strict.score;
    });
  return { best: ranked.length ? ranked[0].candidate : null, bestScore: ranked.length ? ranked[0].score : null, ranked };
}

/** Candidate pool as persisted (top 5). */
function poolOf(entry, source) {
  const block = entry[source];
  if (!block || !block.valid) return [];
  return (block.topCandidates || []).map((x) => x.candidate).filter(Boolean);
}

const hit = (block, bestScore, profile) => {
  const tier = bestScore ? bestScore[profile].tier : 'miss';
  return TIER_RANK[tier] >= 2 && block.valid;
};

// ------------------------------------------------------- (1) relaxed maximised
const perTrack = entries.map((e) => {
  const local = e.local;
  const row = { sampleIndex: e.sampleIndex, layer: e.layer, title: local.title };
  for (const source of ['netease', 'musicbrainz']) {
    const block = e[source];
    const pool = poolOf(e, source);
    const best = pickBestRelaxed(local, pool);
    // what the main pass recorded under the strict-first ranking
    const recordedRelaxedTier = block ? block.tierRelaxed : 'miss';
    row[source] = {
      relaxedTier: best.bestScore ? best.bestScore.relaxed.tier : 'miss',
      relaxedScore: best.bestScore ? best.bestScore.relaxed.score : 0,
      recordedRelaxedTier,
      changed: recordedRelaxedTier !== (best.bestScore ? best.bestScore.relaxed.tier : 'miss'),
      valid: Boolean(block && block.valid),
      best: best.best,
    };
  }
  row.isHit = (s) => hit(e[s], { relaxed: { tier: row[s].relaxedTier } }, 'relaxed');
  return row;
});

const isRelaxedHit = (row, source) => row[source].valid && TIER_RANK[row[source].relaxedTier] >= 2;

const relaxedMax = {
  netease: entries.filter((e, i) => isRelaxedHit(perTrack[i], 'netease')).length,
  musicbrainz: entries.filter((e, i) => isRelaxedHit(perTrack[i], 'musicbrainz')).length,
  combined: entries.filter((e, i) => isRelaxedHit(perTrack[i], 'netease') || isRelaxedHit(perTrack[i], 'musicbrainz')).length,
};
relaxedMax.neteasePct = Math.round((relaxedMax.netease / entries.length) * 1000) / 10;
relaxedMax.musicbrainzPct = Math.round((relaxedMax.musicbrainz / entries.length) * 1000) / 10;
relaxedMax.combinedPct = Math.round((relaxedMax.combined / entries.length) * 1000) / 10;

const byLayer = (pred) =>
  Object.fromEntries(
    layers.map((L) => {
      const idx = perTrack.map((r, i) => (r.layer === L ? i : -1)).filter((i) => i >= 0);
      return [L, Math.round((idx.filter((i) => pred(perTrack[i])).length / idx.length) * 1000) / 10];
    })
  );
const weighted = (rateByLayer) =>
  Math.round(
    (layers.reduce((a, L) => a + (pop[L] / popTotal) * rateByLayer[L], 0) / layers.reduce((a, L) => a + pop[L] / popTotal, 0)) *
      10
  ) / 10;

const neLayer = byLayer((r) => isRelaxedHit(r, 'netease'));
const bothLayer = byLayer((r) => isRelaxedHit(r, 'netease') || isRelaxedHit(r, 'musicbrainz'));

// how many tracks change tier when the ranking rule flips
const reRanked = perTrack.filter((r) => r.netease.changed || r.musicbrainz.changed);

// ------------------------------------------- (1b) per-source profile UNION
// Two distinct quantities get called "the relaxed rate" and they differ:
//   A. relaxed-ONLY, re-ranked relaxed-first inside the pool   -> 70% (NetEase)
//   B. the UNION of the strict and relaxed profiles per source -> 77% (NetEase)
// B is the honest per-source recall ceiling (a product may adopt either profile
// per track); A is what a relaxed-only product would get. The cross-source union
// of B is the library-wide ceiling.
const R = (t) => TIER_RANK[t] >= 2;
const neUnion = entries.filter((e) => R(e.netease.tier) || R(e.netease.tierRelaxed)).length;
const mbUnion = entries.filter((e) => R(e.musicbrainz.tier) || R(e.musicbrainz.tierRelaxed)).length;
const crossUnion = entries.filter(
  (e) => R(e.netease.tier) || R(e.netease.tierRelaxed) || R(e.musicbrainz.tier) || R(e.musicbrainz.tierRelaxed)
).length;
const neUnionLayer = Object.fromEntries(
  layers.map((L) => {
    const rows = entries.filter((e) => e.layer === L);
    return [L, Math.round((rows.filter((e) => R(e.netease.tier) || R(e.netease.tierRelaxed)).length / rows.length) * 1000) / 10];
  })
);
const profileUnion = {
  netease: neUnion,
  musicbrainz: mbUnion,
  crossSource: crossUnion,
  crossSourcePct: Math.round((crossUnion / entries.length) * 1000) / 10,
  crossSourceLibraryPct: weighted(
    Object.fromEntries(
      layers.map((L) => {
        const rows = entries.filter((e) => e.layer === L);
        return [
          L,
          Math.round(
            (rows.filter((e) => R(e.netease.tier) || R(e.netease.tierRelaxed) || R(e.musicbrainz.tier) || R(e.musicbrainz.tierRelaxed)).length /
              rows.length) *
              1000
          ) / 10,
        ];
      })
    )
  ),
  neteaseLibraryPct: weighted(neUnionLayer),
  neteaseByLayer: neUnionLayer,
};

// --------------------------------------------------- (2) duration consistency
const strictHitRows = entries.filter(
  (e) => TIER_RANK[e.netease.tier] >= 2 || TIER_RANK[e.musicbrainz.tier] >= 2
);
const durBuckets = { le15: 0, gt15le20: 0, gt20le30: 0, gt30: 0, unknown: 0 };
const durRows = [];
for (const e of strictHitRows) {
  const src = TIER_RANK[e.netease.tier] >= 2 ? 'netease' : 'musicbrainz';
  const sc = e[src].bestScore || {};
  const d = sc.durDiff;
  durRows.push({ sampleIndex: e.sampleIndex, layer: e.layer, source: src, title: e.local.title, durDiff: d });
  if (d === null || d === undefined) durBuckets.unknown += 1;
  else if (d <= 15) durBuckets.le15 += 1;
  else if (d <= 20) durBuckets.gt15le20 += 1;
  else if (d <= 30) durBuckets.gt20le30 += 1;
  else durBuckets.gt30 += 1;
}
const durKnown = durRows.length - durBuckets.unknown;
const durationConsistency = {
  strictHits: strictHitRows.length,
  comparable: durKnown,
  buckets: durBuckets,
  within15pct: Math.round((durBuckets.le15 / durKnown) * 1000) / 10,
  within20pct: Math.round(((durBuckets.le15 + durBuckets.gt15le20) / durKnown) * 1000) / 10,
  over15: durBuckets.gt15le20 + durBuckets.gt20le30 + durBuckets.gt30,
  over30: durBuckets.gt30,
  over15Rows: durRows.filter((r) => typeof r.durDiff === 'number' && r.durDiff > 15),
};

// ------------------------------------------- (3) CJK threshold sanity probes
/** Fetch a track's recorded candidate pool + scores for named examples. */
function probe(sampleIndex) {
  const e = entries.find((x) => x.sampleIndex === sampleIndex);
  if (!e) return null;
  const out = { sampleIndex, layer: e.layer, localTitle: e.local.title, localArtist: e.local.artist, sources: {} };
  for (const source of ['netease', 'musicbrainz']) {
    const pool = poolOf(e, source);
    const scored = pool
      .map((cand) => ({ cand, score: scoreCandidate(e.local, cand) }))
      .sort((a, b) => b.score.strict.score - a.score.strict.score)
      .slice(0, 3);
    out.sources[source] = {
      valid: Boolean(e[source] && e[source].valid),
      recordedTier: e[source] ? e[source].tier : 'miss',
      recordedTierRelaxed: e[source] ? e[source].tierRelaxed : 'miss',
      top: scored.map((s) => ({
        title: s.cand.title,
        artist: s.cand.artistText,
        titleSim: s.score.titleSim,
        artistSim: s.score.artistSim,
        durDiff: s.score.durDiff,
        strictTier: s.score.strict.tier,
        relaxedTier: s.score.relaxed.tier,
        relaxedScore: s.score.relaxed.score,
      })),
    };
  }
  return out;
}
const cjkProbes = [70, 75, 11, 67].map(probe).filter(Boolean);

// ------------------------------------------------------------------- persist
// Executable, not a library: `require()` must not rewrite the artefact.
if (require.main === module) {
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        method: 'src/match.js scoreCandidate() re-used verbatim; only the ranking key changed (relaxed-first instead of strict-first).',
        limitation:
          'Ranked inside the persisted top-5 candidate pool per source, so the relaxed rate is a LOWER BOUND. A fresh search could only add candidates.',
        relaxedMaximised: {
          sample: { netease: relaxedMax.netease, musicbrainz: relaxedMax.musicbrainz, combined: relaxedMax.combined },
          samplePct: {
            netease: relaxedMax.neteasePct,
            musicbrainz: relaxedMax.musicbrainzPct,
            combined: relaxedMax.combinedPct,
          },
          byLayer: { netease: neLayer, combined: bothLayer },
          libraryPct: { netease: weighted(neLayer), combined: weighted(bothLayer) },
          reRankedTracks: reRanked.length,
        },
        profileUnion,
        strictFirstComparison: {
          neteaseRecordedRelaxedPct:
            Math.round((entries.filter((e) => TIER_RANK[e.netease.tierRelaxed] >= 2).length / entries.length) * 1000) / 10,
          note: 'Recorded value uses the strict-first ranking (the §4.1 relaxed column).',
        },
        durationConsistency,
        cjkProbes,
      },
      null,
      1
    ),
    'utf8'
  );

  console.log('relaxed-maximised (sample %):', relaxedMax.neteasePct, relaxedMax.musicbrainzPct, relaxedMax.combinedPct);
  console.log('relaxed-maximised (library weighted %):', weighted(neLayer), weighted(bothLayer));
  console.log('profile UNION (strict | relaxed) per source:', JSON.stringify({ netease: neUnion, musicbrainz: mbUnion, crossSource: crossUnion }));
  console.log('cross-source union weighted %:', profileUnion.crossSourceLibraryPct);
  console.log('re-ranked tracks:', reRanked.length);
  console.log(
    'duration consistency:',
    JSON.stringify(durationConsistency.buckets),
    '<=15s',
    durationConsistency.within15pct + '%',
    '<=20s',
    durationConsistency.within20pct + '%'
  );
  console.log(`wrote ${OUT}`);
}
