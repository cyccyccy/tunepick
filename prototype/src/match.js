'use strict';

/**
 * match.js — candidate matching & scoring.
 *
 * The rules below are the contract the report describes; they are deliberately
 * strict so that "hit-rate" is not inflated by loose string containment.
 *
 * Score = titleWeight * titleSim + artistWeight * artistSim
 *   - when the local artist is unusable, the score is title-only
 * Duration is used as an independent gate, not a soft signal:
 *   |Δ| <= 15s  -> factor 1.00
 *   |Δ| <= 30s  -> factor 0.85
 *   |Δ| >  30s  -> duration conflict, score capped at 0.50  (different version)
 * Tiers:
 *   exact  : score >= 0.85 and no duration conflict
 *   likely : score >= 0.65 and no duration conflict
 *   weak   : score >= 0.45  (kept for the "mis-match" audit, NOT counted as a hit)
 *   miss   : otherwise
 */

const { similarity, artistSimilarity, isUnknown, isAdText, squeeze } = require('./util/text');
const { fixGarbled } = require('./util/encoding');

const DURATION_SOFT_S = 15;
const DURATION_HARD_S = 30;

/** Normalises a local track for matching (mojibake restored, junk flagged). */
function localView(track) {
  const artist = fixGarbled(track.artist || '');
  const artistUsable = !isUnknown(artist) && !isAdText(artist) && artist.trim() !== '';
  return {
    id: track.id,
    title: fixGarbled(track.title || ''),
    artist,
    artistUsable,
    album: fixGarbled(track.album || ''),
    year: Number(track.year) >= 1900 ? Number(track.year) : 0,
    durationSec: Number(track.duration) || 0,
  };
}

/** NetEase search item -> uniform candidate. */
function fromNetease(item, query) {
  const artists = Array.isArray(item.artists) ? item.artists.map((a) => a && a.name).filter(Boolean) : [];
  const album = item.album || {};
  const publishTime = Number(album.publishTime || 0);
  return {
    source: 'netease',
    id: String(item.id),
    title: item.name || '',
    artists,
    artistText: artists.join('/'),
    album: album.name || '',
    albumId: album.id ? String(album.id) : '',
    picId: album.picId ? String(album.picId) : '',
    year: publishTime > 0 ? new Date(publishTime).getFullYear() : 0,
    durationSec: Math.round(Number(item.duration || 0) / 1000),
    fee: item.fee,
    query,
  };
}

/** MusicBrainz recording -> uniform candidate. */
function fromMusicBrainz(rec, query) {
  const credits = Array.isArray(rec['artist-credit']) ? rec['artist-credit'] : [];
  const artists = credits
    .map((c) => (c && c.name) || (c && c.artist && c.artist.name) || '')
    .filter(Boolean);
  const releases = Array.isArray(rec.releases) ? rec.releases : [];
  const firstRelease = releases[0] || {};
  const date = String(firstRelease.date || '');
  const yearMatch = date.match(/(\d{4})/);
  return {
    source: 'musicbrainz',
    id: rec.id,
    title: rec.title || '',
    artists,
    artistText: artists.join('/'),
    album: firstRelease.title || '',
    albumId: firstRelease.id || '',
    picId: '',
    year: yearMatch ? Number(yearMatch[1]) : 0,
    durationSec: rec.length ? Math.round(Number(rec.length) / 1000) : 0,
    mbScore: rec.score,
    query,
  };
}

/**
 * Scores one candidate against the local track, under BOTH profiles.
 *
 * STRICT  — artist must corroborate the title. High precision, low recall.
 *           This is the headline number: a wrong artist written into the
 *           library is worse than no artist.
 * RELAXED — title + duration only. Measures the *reachable* ceiling, i.e. how
 *           much of the library an online source could cover if the product
 *           accepted title-only matches. Used to quantify the precision/recall
 *           trade-off, never as the headline.
 *
 * @param {object} local   output of localView()
 * @param {object} cand    output of fromNetease()/fromMusicBrainz()
 * @returns {{strict:object, relaxed:object}}
 */
function scoreCandidate(local, cand) {
  const titleSim = similarity(local.title, cand.title);
  const artistSim = local.artistUsable ? artistSimilarity(local.artist, cand.artistText) : 0;

  let durDiff = null;
  let durFactor = 1;
  let conflict = false;
  if (local.durationSec > 0 && cand.durationSec > 0) {
    durDiff = Math.abs(local.durationSec - cand.durationSec);
    if (durDiff > DURATION_HARD_S) {
      conflict = true;
      durFactor = 0.5;
    } else if (durDiff > DURATION_SOFT_S) {
      durFactor = 0.85;
    }
  }

  // A duration conflict must only be forgiven for genuine long-form sets
  // (DJ medleys / 串烧), which legitimately differ in length. An earlier
  // version matched on /Mix|Remix/ in the ONLINE title, which wrongly forgave
  // a 64-second mismatch on `Remember (Original Mix)` — hence the explicit
  // >= 10 minute requirement.
  const LONG_FORM_S = 600;
  const isLongForm = cand.durationSec >= LONG_FORM_S || local.durationSec >= LONG_FORM_S;
  const suppressConflict = conflict && isLongForm && titleSim >= 0.95;

  const strictConflict = conflict && !suppressConflict;
  const strictFactor = suppressConflict ? 1 : durFactor;

  let strictBase;
  if (local.artistUsable) {
    strictBase = 0.6 * titleSim + 0.4 * artistSim;
  } else {
    // No trustworthy local artist -> title carries the match, with a small
    // bonus when the source actually names an artist.
    strictBase = 0.8 * titleSim + 0.2 * (cand.artistText ? 0.6 : 0);
  }
  let strictScore = strictBase * strictFactor;
  if (strictConflict) strictScore = Math.min(strictScore, 0.5);

  let strictTier = 'miss';
  if (strictScore >= 0.85 && !strictConflict) strictTier = 'exact';
  else if (strictScore >= 0.65 && !strictConflict) strictTier = 'likely';
  else if (strictScore >= 0.45) strictTier = 'weak';

  let relaxedScore = titleSim * strictFactor;
  if (strictConflict) relaxedScore = Math.min(relaxedScore, 0.5);
  let relaxedTier = 'miss';
  if (relaxedScore >= 0.92 && !strictConflict) relaxedTier = 'exact';
  else if (relaxedScore >= 0.8 && !strictConflict) relaxedTier = 'likely';
  else if (relaxedScore >= 0.6) relaxedTier = 'weak';

  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    titleSim: round(titleSim),
    artistSim: round(artistSim),
    durDiff,
    durFactor,
    conflict: strictConflict,
    strict: { score: round(Math.max(0, Math.min(1, strictScore))), tier: strictTier },
    relaxed: { score: round(Math.max(0, Math.min(1, relaxedScore))), tier: relaxedTier },
  };
}

const TIER_RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };

/**
 * Picks the best candidate across every query tried for one track.
 * Ranking is strict-first, then strict score, then relaxed score.
 *
 * @param {object} local
 * @param {object[]} candidates
 * @returns {{best:object|null, bestScore:object|null, ranked:object[]}}
 */
function pickBest(local, candidates) {
  const ranked = candidates
    .map((cand) => ({ candidate: cand, score: scoreCandidate(local, cand) }))
    .sort((a, b) => {
      const t = TIER_RANK[b.score.strict.tier] - TIER_RANK[a.score.strict.tier];
      if (t !== 0) return t;
      if (b.score.strict.score !== a.score.strict.score) return b.score.strict.score - a.score.strict.score;
      const r = TIER_RANK[b.score.relaxed.tier] - TIER_RANK[a.score.relaxed.tier];
      if (r !== 0) return r;
      return b.score.relaxed.score - a.score.relaxed.score;
    });
  return {
    best: ranked.length ? ranked[0].candidate : null,
    bestScore: ranked.length ? ranked[0].score : null,
    ranked,
  };
}

module.exports = {
  localView,
  fromNetease,
  fromMusicBrainz,
  scoreCandidate,
  pickBest,
  TIER_RANK,
  DURATION_SOFT_S,
  DURATION_HARD_S,
  isUnknown,
  isAdText,
  squeeze,
};
