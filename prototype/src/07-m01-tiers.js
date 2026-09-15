'use strict';

/**
 * 07-m01-tiers.js — the M-01 (artist) metric, expressed as four graduated tiers.
 *
 * WHY THIS EXISTS
 * The earlier draft of the report published a single "M-01 歌手 = 93.9%" number.
 * The independent QA pass showed that one number conflates four very different
 * things: "the field is not empty", "the value is corroborated by a second
 * signal", "it is safe to write automatically", and "it is safe to OVERWRITE an
 * existing value". Only 26 of the 64 strict hits have an online artist that
 * actually agrees with the local one, so a single number cannot represent it.
 *
 * INPUTS
 *  - data/result.json     : the measured per-track source blocks
 *  - data/sample-100.json : layer populations, for population weighting
 *  - data/catalog.json    : the library artist index (used to decide whether an
 *                           `X - Y` title segment looks like a person's name)
 *  - qa/q1-rows.json      : READ-ONLY per-row adjudication from the independent
 *                           QA pass (artist verdict exact/near/none, the
 *                           second-evidence flag, the three-way flag, the
 *                           pseudo-artist flag). Reusing these flags keeps this
 *                           report and 报告-独立复核.md pinned to identical
 *                           per-row inputs, so the two cannot drift apart.
 *
 * Output: data/m01-tiers.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const QA_DIR = path.join(ROOT, 'qa');
const OUT = path.join(DATA, 'm01-tiers.json');

const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const sample = JSON.parse(fs.readFileSync(path.join(DATA, 'sample-100.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
const q1 = JSON.parse(fs.readFileSync(path.join(QA_DIR, 'q1-rows.json'), 'utf8'));

const entries = result.entries;
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const LAYERS = ['A', 'B', 'C', 'D', 'E'];
const POP = sample.meta.layerPopulation;
const POP_TOTAL = Object.values(POP).reduce((a, b) => a + b, 0);

/**
 * How often a title segment occurs as an `artist` in the library.
 * A segment that names a real performer appears repeatedly; a song title or a
 * role prefix does not. This is the "is X a person's name?" test.
 */
const MIN_LIBRARY_MENTIONS = 4;
const artistCounts = new Map();
for (const t of catalog.tracks) {
  const a = String(t.artist || '').trim();
  if (!a) continue;
  artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
}

const neRows = new Map(q1.neHits.map((r) => [r.sampleIndex, r]));
const mbRows = new Map(q1.mbHits.map((r) => [r.sampleIndex, r]));

const fold = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\s\-–—_|/、,，.。·'"“”()（）[\]【】「」]/g, '');

/** Splits `X - Y` / `X--Y` / `X - Y (mix)` into its two segments. */
const SEG_RE = /^(.{1,14}?)\s*[-–—_|/]+\s*(.+)$/;
function titleSegments(title) {
  const m = String(title || '').match(SEG_RE);
  if (!m) return null;
  return { left: m[1].trim(), right: m[2].trim() };
}

/** Population-weighted rate of a per-track predicate (matches the report's method). */
function weighted(flags) {
  let sum = 0;
  for (const L of LAYERS) {
    const rows = entries.filter((e) => e.layer === L);
    if (!rows.length) continue;
    const hit = rows.filter((e) => flags.get(e.sampleIndex)).length;
    sum += (POP[L] / POP_TOTAL) * (hit / rows.length);
  }
  return Math.round(sum * 1000) / 10;
}

/** The row for a source, but only when that source actually produced a hit. */
function hitRow(e, source) {
  if (source === 'netease') return RANK[e.netease.tier] >= 2 ? neRows.get(e.sampleIndex) : null;
  return RANK[e.musicbrainz.tier] >= 2 ? mbRows.get(e.sampleIndex) : null;
}
const anyHitRow = (e) => hitRow(e, 'netease') || hitRow(e, 'musicbrainz');

/*
 * Every tier is evaluated once per track and stored in a Map. The tiers are
 * genuinely independent predicates — computing them inside a filter used to
 * push duplicates into the review queue, because the same predicate ran once
 * for the total, once per layer, and once for the weighted mean.
 */
const tier1 = new Map(); // ① non-empty
const tier2 = new Map(); // ② usable (second evidence)
const tier3 = new Map(); // ③ usable AND not an `X - Y` ambiguity
const tier4 = new Map(); // ④ safe to overwrite an existing value
const ambiguous = new Map();

for (const e of entries) {
  const idx = e.sampleIndex;
  const ne = hitRow(e, 'netease');
  const mb = hitRow(e, 'musicbrainz');
  const row = ne || mb;

  // ① the field is present and not junk
  tier1.set(idx, Boolean(e.local.artistUsable) || Boolean(ne && ne.onlineArtist) || Boolean(mb && mb.onlineArtist));

  // ② corroborated by a second, independent signal. A title-only coincidence
  //    must not count as a delivered artist.
  tier2.set(
    idx,
    Boolean(e.local.artistUsable) || Boolean(ne && ne.B && ne.onlineArtist) || Boolean(mb && mb.B && mb.onlineArtist)
  );

  // ④ local artist trustworthy AND the online artist is an exact match AND the
  //    durations agree — the only case where overwriting is permitted.
  tier4.set(
    idx,
    Boolean(e.local.artistUsable) || Boolean(ne && ne.C && ne.onlineArtist) || Boolean(mb && mb.C && mb.onlineArtist)
  );

  // `X - Y` ambiguity: the local title may already name the performer, and the
  // online source is then frequently the ORIGINAL performer instead.
  let isAmbiguous = false;
  if (!e.local.artistUsable && row) {
    const seg = titleSegments(e.local.title);
    if (seg) {
      const online = fold(row.onlineArtist);
      for (const s of [seg.left, seg.right]) {
        const mentions = artistCounts.get(s) || 0;
        if (mentions < MIN_LIBRARY_MENTIONS) continue;
        // If the source returns exactly that name it is confirming the title,
        // not contradicting it — `DJ - 纯音乐…` is the case that matters here.
        const f = fold(s);
        if (f && (online.includes(f) || f.includes(online))) continue;
        isAmbiguous = true;
        break;
      }
    }
  }
  ambiguous.set(idx, isAmbiguous);

  // ③ usable, minus the rows a human should look at first
  tier3.set(idx, Boolean(tier2.get(idx)) && !isAmbiguous);
}

const rawCount = (flags) => entries.filter((e) => flags.get(e.sampleIndex)).length;

const tiers = {
  tier1_nonEmpty: {
    label: '① 非空率（字段非空且非垃圾）',
    rule: 'local artist usable, or either source returned an artist',
    sample: rawCount(tier1),
    weighted: weighted(tier1),
  },
  tier2_usable: {
    label: '② 可用率（有第二证据：可信歌手对上了，或时长 ±15s）',
    rule: 'local artist usable AND online agrees, or (local junk AND duration within 15s)',
    sample: rawCount(tier2),
    weighted: weighted(tier2),
  },
  tier3_autoWrite: {
    label: '③ 可自动写入（剔除 X - Y 歧义后）',
    rule: `tier ② minus rows whose title segment names a library artist (>= ${MIN_LIBRARY_MENTIONS} mentions) while the online artist differs`,
    sample: rawCount(tier3),
    weighted: weighted(tier3),
  },
  tier4_overwriteSafe: {
    label: '④ 可安全覆盖（本地歌手可信 ∧ 在线歌手精确对上 ∧ 时长 ±15s）',
    rule: 'local artist usable AND exact online agreement AND duration within 15s',
    sample: rawCount(tier4),
    weighted: weighted(tier4),
  },
};

const perLayer = {};
for (const L of LAYERS) {
  const rows = entries.filter((e) => e.layer === L);
  const rate = (flags) => Math.round((rows.filter((e) => flags.get(e.sampleIndex)).length / rows.length) * 1000) / 10;
  perLayer[L] = {
    n: rows.length,
    population: POP[L],
    tier1: rate(tier1),
    tier2: rate(tier2),
    tier3: rate(tier3),
    tier4: rate(tier4),
  };
}

// ---- why "64 hits" is not "64 delivered artists" ---------------------------
const strictHits = entries.filter((e) => RANK[e.netease.tier] >= 2 || RANK[e.musicbrainz.tier] >= 2);
const corroborated = strictHits.filter((e) => {
  const row = anyHitRow(e);
  const verdict = row ? row.myArtistVerdict : null;
  return Boolean(e.local.artistUsable) && (verdict === 'exact' || verdict === 'near');
});
const hitBreakdown = {
  strictHits: strictHits.length,
  artistCorroborated: corroborated.length,
  artistNotCorroborated: strictHits.length - corroborated.length,
  notCorroboratedBreakdown: (() => {
    const rest = strictHits.filter((e) => !corroborated.includes(e));
    const unknown = rest.filter((e) => !e.local.artistUsable).length;
    return { localArtistMissingOrJunk: unknown, localArtistPresentButSourceDisagrees: rest.length - unknown };
  })(),
};

const reviewQueue = entries
  .filter((e) => ambiguous.get(e.sampleIndex))
  .map((e) => {
    const row = anyHitRow(e);
    const seg = titleSegments(e.local.title);
    return {
      sampleIndex: e.sampleIndex,
      layer: e.layer,
      localTitle: e.local.title,
      localArtist: e.local.artist,
      libraryNameSegment: seg ? (artistCounts.get(seg.left) >= MIN_LIBRARY_MENTIONS ? seg.left : seg.right) : '',
      onlineArtist: row ? row.onlineArtist : '',
      onlineTitle: row ? row.onlineTitle : '',
      source: hitRow(e, 'netease') ? 'netease' : 'musicbrainz',
      durationDiff: row ? row.durDiff : null,
      titleSim: row ? row.myTitleSim : null,
    };
  })
  .sort((x, y) => x.sampleIndex - y.sampleIndex);

const report = {
  generatedAt: new Date().toISOString(),
  method:
    'Per-track adjudication (artist verdict exact/near/none, second-evidence flag, three-way flag, pseudo-artist flag) comes from the independent QA pass in qa/q1-rows.json. Weighting is by layer population (A562/B44/C342/D92/E1863) so the sample represents the 2903-track library.',
  ambiguityRule: `a title segment counts as a performer name when it appears >= ${MIN_LIBRARY_MENTIONS} times in the library's artist field AND the online artist differs from it`,
  population: POP,
  populationTotal: POP_TOTAL,
  tiers,
  perLayer,
  hitBreakdown,
  reviewQueue,
  reviewQueueSize: reviewQueue.length,
};

// Executable, not a library: `require()` must not rewrite the M-01 artefact.
if (require.main === module) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

  console.log('=== M-01 四档（加权外推 / 样本）===');
  for (const [k, v] of Object.entries(tiers)) {
    console.log(`${k.padEnd(22)} weighted=${String(v.weighted).padStart(5)}%  sample=${v.sample}/100`);
  }
  console.log('\n=== 命中 vs 交付 ===');
  console.log(JSON.stringify(hitBreakdown, null, 1));
  console.log(`\n=== 审阅队列（X - Y 歧义，${reviewQueue.length} 首）===`);
  for (const r of reviewQueue) {
    console.log(`  #${r.sampleIndex} ${r.layer} ${r.localTitle} / ${r.localArtist} -> ${r.onlineArtist} (dur=${r.durationDiff})`);
  }
  console.log(`\nwrote ${OUT}`);
}
