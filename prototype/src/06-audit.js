'use strict';

/**
 * 06-audit.js — qualitative audit that the report's §5/§6/§7/§9 rely on.
 *
 * Answers questions the hit-rate numbers cannot:
 *   - when we "hit", is the artist we would write actually correct?
 *   - what exactly makes the misses miss?
 *   - which artist names in this library are pseudonyms / compilation uploaders?
 *
 * Writes data/qualitative-audit.json and prints a readable digest.
 */

const fs = require('fs');
const path = require('path');
const { fixGarbled, looksGarbled } = require('./util/encoding');
const { isAdText, isUnknown, hasTitleSeparator, splitTitle, squeeze } = require('./util/text');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
const l1 = JSON.parse(fs.readFileSync(path.join(DATA, 'l1-report.json'), 'utf8'));
const sampleDoc = JSON.parse(fs.readFileSync(path.join(DATA, 'sample-100.json'), 'utf8'));
const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const entries = result.entries;
const TIER_RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const CURRENT_YEAR = new Date().getFullYear();

const isHit = (e, src) => e[src].valid && TIER_RANK[e[src].tier] >= 2;
const bestOf = (e) => (isHit(e, 'netease') ? { ...e.netease.best, _src: 'netease' } : isHit(e, 'musicbrainz') ? { ...e.musicbrainz.best, _src: 'musicbrainz' } : null);

// ------------------------------------------------- 1. artist-trust of the hits
const hits = entries.filter((e) => isHit(e, 'netease') || isHit(e, 'musicbrainz'));
const corroborated = hits.filter((e) => e.local.artistUsable);
const uncorroborated = hits.filter((e) => !e.local.artistUsable);

// For an uncorroborated hit, if the title is `X - Y` and the tag artist is
// unusable, the LEFT side is very often the real performer while the online
// source returns the ORIGINAL artist. Detect that shape explicitly.
const dashPattern = uncorroborated.filter((e) => {
  const raw = fixGarbled(e.restoredTitle || '');
  return /^[^-–—_\n]{1,24}\s*[-–—]\s*.+/.test(raw) && !/^\d/.test(raw.trim());
});

const swappedFields = catalog.tracks.filter((t) => {
  // e.g. title="程响", artist="不该相遇在秋天" — artist/title inverted in the tag
  return isUnknown(t.artist) === false && t.title && t.artist && t.title.length <= 4 && t.artist.length >= 5 && !isAdText(t.artist);
});

// ------------------------------------------------------------ 2. miss anatomy
const misses = entries.filter((e) => !isHit(e, 'netease') && !isHit(e, 'musicbrainz'));

/** Classifies WHY a track was missed. First matching rule wins. */
function missReason(e) {
  const title = fixGarbled(e.restoredTitle || '');
  const rawTitle = e.local.title || '';
  const artist = e.local.artist || '';
  if (isAdText(rawTitle) || isAdText(artist) || /^公众号|^微信|抖音|快手|关注|加群/.test(squeeze(rawTitle))) return 'query_is_ad_string';
  if (isAdText(artist)) return 'artist_is_ad_string';
  if (e.netease.candidatePoolSize === 0) return 'online_source_returned_nothing';
  // NOTE: the "song was actually found" test must come BEFORE any
  // title-shape test — otherwise a decorated title whose song WAS returned
  // gets mislabelled as "noise blocked the query".
  const top = (e.netease.topCandidates && e.netease.topCandidates[0]) || null;
  const ts = top ? top.score.titleSim : 0;
  if (ts >= 0.9) return 'song_found_but_artist_disagrees';
  if (/【|】|\[|\]|「|」/.test(rawTitle)) return 'title_noise_blocks_query';
  if (hasTitleSeparator(rawTitle) && (!artist || isUnknown(artist))) return 'title_embeds_artist_split_ambiguous';
  if (ts >= 0.6) return 'candidate_found_but_not_confident';
  return 'source_lacks_the_track';
}

const missByReason = {};
for (const e of misses) {
  const r = missReason(e);
  missByReason[r] = (missByReason[r] || 0) + 1;
}
const missDetail = misses.map((e) => ({
  sampleIndex: e.sampleIndex,
  layer: e.layer,
  title: e.local.title,
  artist: e.local.artist,
  reason: missReason(e),
  neteaseReturned: e.netease.candidatePoolSize,
  musicbrainzReturned: e.musicbrainz.candidatePoolSize,
}));

// --------------------------------------------------- 3. pseudonym artist hunt
const artistCounts = new Map();
for (const t of catalog.tracks) {
  const a = fixGarbled(t.artist || '').trim();
  if (!a) continue;
  artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
}
/** Artists that are clearly not performers: promo strings / bulk uploaders. */
const PSEUDONYM_MARKERS = [
  /公众号/,
  /微信/,
  /抖音/,
  /快手/,
  /资源库/,
  /上传/,
  /推广/,
  /收藏/,
  /音乐驿站/,
  /群/,
  /不改音响/,
  /提升.*音质/,
  /^Cydian$/,
  /^DJ\s/i,
];
const pseudonymArtists = [...artistCounts.entries()]
  .filter(([name]) => PSEUDONYM_MARKERS.some((re) => re.test(name)))
  .sort((a, b) => b[1] - a[1])
  .map(([name, count]) => ({ name, count }));

const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([name, count]) => ({ name, count }));

// ------------------------------------------- 4. data-quality traps in the srcs
const yearOutOfRange = [];
const titleLengthAnomalies = [];
for (const e of entries) {
  const b = bestOf(e);
  if (b && b.year && (b.year > CURRENT_YEAR || b.year < 1900)) {
    yearOutOfRange.push({ sampleIndex: e.sampleIndex, title: e.local.title, onlineTitle: b.title, year: b.year, source: b._src });
  }
}

// --------------------------------------------- 5. search-strategy attribution
// For each hit, which strategy actually produced the winning candidate?
const strategyAttribution = {};
for (const e of entries) {
  const src = isHit(e, 'netease') ? 'netease' : isHit(e, 'musicbrainz') ? 'musicbrainz' : null;
  if (!src) continue;
  const q = e[src].best.query || '(unknown)';
  const strat = e.queriesTried.find((x) => x.source === src && x.query === q);
  const key = strat ? strat.strategy : 'MB';
  strategyAttribution[key] = (strategyAttribution[key] || 0) + 1;
}

const audit = {
  generatedAt: new Date().toISOString(),
  hits: {
    total: hits.length,
    artistCorroborated: corroborated.length,
    artistUncorroborated: uncorroborated.length,
    uncorroboratedWithDashTitle: dashPattern.length,
    corroborationNote:
      'artistCorroborated = the local tag already had a trustworthy artist, so the online artist CONFIRMS it. ' +
      'artistUncorroborated = the local artist was missing/junk; the online artist is the source ORIGINAL performer and may differ from the performer on this file (covers/remakes).',
  },
  missed: { total: misses.length, byReason: missByReason, detail: missDetail },
  pseudonymArtists,
  pseudonymArtistTracks: pseudonymArtists.reduce((a, x) => a + x.count, 0),
  topArtists,
  yearOutOfRange,
  strategyAttribution,
  titleLengthAnomalies,
  writerSwappedFieldsSample: swappedFields.slice(0, 10).map((t) => ({ title: t.title, artist: t.artist, path: t.path })),
  note: `swappedFields = tracks whose title looks like a person name and whose artist looks like a song title (${swappedFields.length} candidates library-wide)`,
};

// Executable, not a library: `require()` must not rewrite the audit artefact.
if (require.main === module) {
  fs.writeFileSync(path.join(DATA, 'qualitative-audit.json'), JSON.stringify(audit, null, 2), 'utf8');

  console.log('=== HIT TRUSTWORTHINESS ===');
  console.log(JSON.stringify(audit.hits, null, 2));
  console.log('\n=== MISS REASONS ===');
  console.log(JSON.stringify(missByReason, null, 2));
  console.log('\n=== MISS DETAIL ===');
  for (const m of missDetail) console.log(` [${m.sampleIndex}] ${m.layer} ${m.reason.padEnd(38)} ${String(m.title).slice(0, 42)}`);
  console.log('\n=== PSEUDONYM ARTISTS (tracks total: ' + audit.pseudonymArtistTracks + ') ===');
  console.log(pseudonymArtists.map((p) => `${p.count}\t${p.name}`).join('\n'));
  console.log('\n=== TOP ARTISTS ===');
  console.log(topArtists.map((p) => `${p.count}\t${p.name}`).join('\n'));
  console.log('\n=== YEAR OUT OF RANGE ===');
  console.log(JSON.stringify(yearOutOfRange, null, 1));
  console.log('\n=== STRATEGY THAT PRODUCED THE WIN ===');
  console.log(JSON.stringify(strategyAttribution, null, 1));
  console.log('\n=== SWAPPED-FIELD TRACKS (title<->artist) ===');
  console.log(JSON.stringify(audit.writerSwappedFieldsSample, null, 1));
  console.log(`\nwrote ${path.join(DATA, 'qualitative-audit.json')}`);
}
