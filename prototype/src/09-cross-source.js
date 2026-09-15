'use strict';

/**
 * 09-cross-source.js — what the two online sources are worth relative to each
 * other, and what cross-checking them buys.
 *
 * WHY THIS EXISTS
 * The earlier report measured each source's hit-rate but never asked what the
 * SECOND source adds, nor whether the two agree. The independent QA pass found
 * that MusicBrainz's marginal RECALL is about +1 track per 100 — yet the two
 * sources return DIFFERENT artists for a large block of tracks they both match.
 * That second fact is the cheap confidence signal the M-01 metric needs: an
 * online artist is not a fact, it is one source's opinion.
 *
 * Output: data/cross-source.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const QA_DIR = path.join(ROOT, 'qa');
const OUT = path.join(DATA, 'cross-source.json');

const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const qa = JSON.parse(fs.readFileSync(path.join(QA_DIR, 'q1-rows.json'), 'utf8'));
const recheck = fs.existsSync(path.join(DATA, 'mb-recheck.json'))
  ? JSON.parse(fs.readFileSync(path.join(DATA, 'mb-recheck.json'), 'utf8'))
  : null;

const entries = result.entries;
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const hit = (e, src) => RANK[e[src].tier] >= 2;

const fold = (s) =>
  String(s || '')
    .toLowerCase()
    // Strip whitespace, the whole dash family (ASCII hyphen, U+2010..U+2014,
    // U+2212 minus, U+FF0D full-width) and CJK/ASCII punctuation. `K-391` and
    // `K‐391` are the SAME performer, so leaving U+2010 in place would report a
    // punctuation difference as a genuine artist disagreement.
    .replace(/[\s\u002d\u2010\u2011\u2012\u2013\u2014\u2212\uff0d—_|/、,，.。·'"’“”()（）[\]【】「」]/g, '');

const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(s || ''));

/**
 * Classifies two artist strings from the two sources.
 *
 *  - 'same'    : identical once case/punctuation is folded — the sources AGREE
 *  - 'variant' : differ by one character at equal length with CJK present, i.e.
 *                a simplified/traditional or typo-level difference (`张宇` vs
 *                `張宇`) — same performer, different spelling
 *  - 'different': genuinely different performers — this is the interesting case
 *
 * Collapsing 'same' into 'variant' would inflate the disagreement count with
 * tracks where the sources actually agree, and would overstate how unreliable
 * the online artist field is.
 */
function compareArtists(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return 'same';
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) diff += 1;
    if (diff === 1 && hasCJK(x) && hasCJK(y)) return 'variant';
  }
  return 'different';
}

const neRows = new Map(qa.neHits.map((r) => [r.sampleIndex, r]));
const mbRows = new Map(qa.mbHits.map((r) => [r.sampleIndex, r]));

const neOnly = [];
const mbOnly = [];
const both = [];
const neither = [];

for (const e of entries) {
  const a = hit(e, 'netease');
  const b = hit(e, 'musicbrainz');
  if (a && b) both.push(e);
  else if (a) neOnly.push(e);
  else if (b) mbOnly.push(e);
  else neither.push(e);
}

/** Tracks both sources matched but where they name different artists. */
const scriptVariants = [];
const artistDisagreements = both
  .map((e) => {
    const neRow = neRows.get(e.sampleIndex);
    const mbRow = mbRows.get(e.sampleIndex);
    const neArtist = (neRow && neRow.onlineArtist) || (e.netease.best ? e.netease.best.artistText : '');
    const mbArtist = (mbRow && mbRow.onlineArtist) || (e.musicbrainz.best ? e.musicbrainz.best.artistText : '');
    if (!neArtist || !mbArtist) return null;
    const verdict = compareArtists(neArtist, mbArtist);
    if (verdict === 'same') return null;
    if (verdict === 'variant') {
      scriptVariants.push({ sampleIndex: e.sampleIndex, layer: e.layer, neteaseArtist: neArtist, musicbrainzArtist: mbArtist });
      return null;
    }
    const local = fold(e.local.artist);
    return {
      sampleIndex: e.sampleIndex,
      layer: e.layer,
      localTitle: e.local.title,
      localArtist: e.local.artist,
      localArtistMissing: !e.local.artistUsable,
      neteaseArtist: neArtist,
      musicbrainzArtist: mbArtist,
      // Which source, if either, agrees with the local artist?
      neteaseAgreesWithLocal: Boolean(local) && (fold(neArtist).includes(local) || local.includes(fold(neArtist))),
      musicbrainzAgreesWithLocal: Boolean(local) && (fold(mbArtist).includes(local) || local.includes(fold(mbArtist))),
    };
  })
  .filter(Boolean)
  .sort((x, y) => x.sampleIndex - y.sampleIndex);

const agreeWithLocal = artistDisagreements.filter((d) => d.neteaseAgreesWithLocal !== d.musicbrainzAgreesWithLocal);

// ---- MusicBrainz marginal recall, before and after the overload correction --
const corrections = recheck ? recheck.corrections : [];
const improved = new Map(corrections.map((c) => [c.sampleIndex, c]));
const correctedMbHit = (e) => {
  const c = improved.get(e.sampleIndex);
  const tier = c ? c.tierAfter : e.musicbrainz.tier;
  return RANK[tier] >= 2;
};

const mbOnlyCorrected = entries.filter((e) => !hit(e, 'netease') && correctedMbHit(e));
const mbOnlyMeasuredIdx = new Set(mbOnly.map((e) => e.sampleIndex));
const newlyRecovered = mbOnlyCorrected.filter((e) => !mbOnlyMeasuredIdx.has(e.sampleIndex));

const report = {
  generatedAt: new Date().toISOString(),
  why: 'Measures what the second source adds (marginal recall) versus what cross-checking it buys (artist confidence), which the earlier report did not separate.',
  sampleSize: entries.length,
  overlap: {
    neteaseOnly: neOnly.length,
    musicbrainzOnly: mbOnly.length,
    both: both.length,
    neither: neither.length,
    neteaseTotal: neOnly.length + both.length,
    musicbrainzTotal: mbOnly.length + both.length,
    union: neOnly.length + mbOnly.length + both.length,
  },
  musicbrainzMarginalRecall: {
    measured: mbOnly.length,
    measuredTracks: mbOnly.map((e) => ({ sampleIndex: e.sampleIndex, layer: e.layer, title: e.local.title, best: e.musicbrainz.best ? e.musicbrainz.best.artistText : '' })),
    afterOverloadCorrection: mbOnlyCorrected.length,
    newlyRecoveredTracks: newlyRecovered.map((e) => ({ sampleIndex: e.sampleIndex, layer: e.layer, title: e.local.title })),
  },
  artistDisagreements: {
    count: artistDisagreements.length,
    ofBothHit: both.length,
    sourcesAgreeOnArtist: both.filter((e) => {
      const neRow = neRows.get(e.sampleIndex);
      const mbRow = mbRows.get(e.sampleIndex);
      const a = (neRow && neRow.onlineArtist) || '';
      const b = (mbRow && mbRow.onlineArtist) || '';
      return Boolean(a) && Boolean(b) && compareArtists(a, b) === 'same';
    }).length,
    scriptVariantOnly: scriptVariants.length,
    scriptVariantRows: scriptVariants,
    whereLocalArtistMissing: artistDisagreements.filter((d) => d.localArtistMissing).length,
    whereExactlyOneSourceAgreesWithLocal: agreeWithLocal.length,
    rows: artistDisagreements,
  },
  conclusion:
    'MusicBrainz adds almost no recall on this library, but it is valuable as a cross-check: when both sources match a track and name different artists, at most one of them can be right, so agreement between the two is the cheapest available confidence signal for the artist field. Note that a handful of apparent disagreements are only simplified/traditional script differences and must be folded before comparison.',
};

// Executable, not a library: `require()` must not rewrite the cross-source artefact.
if (require.main === module) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

  console.log('=== 源重叠 ===');
  console.log(JSON.stringify(report.overlap, null, 1));
  console.log('\n=== MB 边际召回 ===');
  console.log(JSON.stringify(report.musicbrainzMarginalRecall, null, 1));
  console.log(`\n=== 两源歌手分歧：${artistDisagreements.length} / ${both.length} ===`);
  for (const d of artistDisagreements) {
    console.log(`  #${String(d.sampleIndex).padStart(3)} ${d.layer} ${d.localTitle} | local=${d.localArtist} | ne=${d.neteaseArtist} | mb=${d.musicbrainzArtist}`);
  }
  console.log(`\nwrote ${OUT}`);
}
