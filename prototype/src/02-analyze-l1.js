'use strict';

/**
 * 02-analyze-l1.js — L1 (embedded tag) analysis over the WHOLE library.
 *
 * Produces data/l1-report.json and prints a readable summary.
 *
 * Design notes:
 *  - "available" always excludes pseudo values: `[Unknown Artist]`,
 *    `[Unknown Album]`, `year == 0`, empty `genres`, duration == 0, promo
 *    strings, and GBK mojibake (a mojibake tag is present but unusable until
 *    L1's restore step runs — that difference is the headline number here).
 *  - Navidrome synthesises a `coverArt` id for EVERY track, so `coverArt`
 *    presence is meaningless. `coverArt.startsWith('al-')` means real album
 *    art; `mf-` means a per-file gradient placeholder (no artwork at all).
 */

const fs = require('fs');
const path = require('path');
const { looksGarbled, fixGarbled } = require('./util/encoding');
const { isAdText, isUnknown, hasTitleSeparator, hasCJK } = require('./util/text');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const OUT_PATH = path.join(ROOT, 'data', 'l1-report.json');

/** Genre strings that are placeholders or junk rather than a real genre. */
const GENRE_JUNK = new Set(['other', 'null', '未知', 'unknown', '']);

const CURRENT_YEAR = new Date().getFullYear();

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

/** `歌手/专辑/文件名` -> { artistDir, albumDir, fileName }. */
function splitPath(p) {
  const parts = String(p || '').split('/').filter((s) => s.length > 0);
  if (parts.length === 0) return { artistDir: '', albumDir: '', fileName: '' };
  const fileName = parts[parts.length - 1];
  if (parts.length === 1) return { artistDir: '', albumDir: '', fileName };
  if (parts.length === 2) return { artistDir: parts[0], albumDir: '', fileName };
  return {
    artistDir: parts[parts.length - 3],
    albumDir: parts[parts.length - 2],
    fileName,
  };
}

/** Compares two labels ignoring mojibake, case, spacing and decoration. */
function sameLabel(a, b) {
  const norm = (s) =>
    fixGarbled(String(s || ''))
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

function analyzeTrack(t) {
  const restoredTitle = fixGarbled(t.title);
  const restoredArtist = fixGarbled(t.artist);
  const restoredAlbum = fixGarbled(t.album);
  const restoredPath = fixGarbled(t.path);
  const genresRaw = t.genres || [];
  const genresRestored = genresRaw.map((g) => fixGarbled(g));

  const { artistDir, albumDir, fileName } = splitPath(restoredPath);
  const fileStem = fileName.replace(/\.[A-Za-z0-9]{2,5}$/, '');

  const yearUsable = Number(t.year) >= 1900 && Number(t.year) <= CURRENT_YEAR;
  const genresUsableRaw =
    genresRaw.length > 0 && genresRaw.some((g) => !GENRE_JUNK.has(String(g).trim().toLowerCase()) && !isAdText(g) && !looksGarbled(g));
  const genresUsableRestored =
    genresRestored.length > 0 && genresRestored.some((g) => !GENRE_JUNK.has(String(g).trim().toLowerCase()) && !isAdText(g));

  const artistRawUsable = !isUnknown(t.artist) && !isAdText(t.artist) && !looksGarbled(t.artist);
  const artistRestoredUsable = !isUnknown(restoredArtist) && !isAdText(restoredArtist) && restoredArtist.trim() !== '';
  const albumRawUsable = !isUnknown(t.album) && !isAdText(t.album) && !looksGarbled(t.album);
  const albumRestoredUsable = !isUnknown(restoredAlbum) && !isAdText(restoredAlbum) && restoredAlbum.trim() !== '';

  const hasRealCover = String(t.coverArt || '').startsWith('al-');

  return {
    id: t.id,
    raw: {
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      genres: genresRaw,
      duration: t.duration,
      comment: t.comment,
      coverArt: t.coverArt,
    },
    restored: {
      title: restoredTitle,
      artist: restoredArtist,
      album: restoredAlbum,
      artistDir,
      albumDir,
      fileStem,
    },
    flags: {
      titleGarbled: looksGarbled(t.title),
      artistGarbled: looksGarbled(t.artist),
      albumGarbled: looksGarbled(t.album),
      pathGarbled: looksGarbled(t.path),
      anyGarbled: looksGarbled(t.title) || looksGarbled(t.artist) || looksGarbled(t.album) || looksGarbled(t.path),
      titleAd: isAdText(t.title),
      artistAd: isAdText(t.artist),
      albumAd: isAdText(t.album),
      genreAd: genresRaw.some((g) => isAdText(g)),
      anyAd: isAdText(t.title) || isAdText(t.artist) || isAdText(t.album) || genresRaw.some((g) => isAdText(g)),
      titleHasSeparator: hasTitleSeparator(t.title),
      artistUnknownTag: String(t.artist).trim().toLowerCase() === '[unknown artist]',
      albumUnknownTag: String(t.album).trim().toLowerCase() === '[unknown album]',
      hasRealCover,
      coverIsPlaceholder: String(t.coverArt || '').startsWith('mf-'),
      durationZero: !Number(t.duration),
    },
    availability: {
      title: { raw: Boolean(String(t.title || '').trim()), restored: Boolean(String(restoredTitle || '').trim()) },
      artist: { raw: artistRawUsable, restored: artistRestoredUsable },
      album: { raw: albumRawUsable, restored: albumRestoredUsable },
      year: { raw: yearUsable, restored: yearUsable },
      genres: { raw: genresUsableRaw, restored: genresUsableRestored },
      duration: { raw: Number(t.duration) > 0, restored: Number(t.duration) > 0 },
      cover: { raw: Boolean(t.coverArt), restored: hasRealCover },
    },
    pathInference: {
      artistDirUsable: Boolean(artistDir) && !isUnknown(artistDir) && !isAdText(artistDir),
      albumDirUsable: Boolean(albumDir) && !isUnknown(albumDir) && !isAdText(albumDir),
      artistDirMatchesTag: sameLabel(artistDir, t.artist),
      artistDirMatchesTagAfterRestore: sameLabel(artistDir, restoredArtist),
      albumDirMatchesTag: sameLabel(albumDir, t.album),
      albumDirMatchesTagAfterRestore: sameLabel(albumDir, restoredAlbum),
      artistDirFillsMissingTag:
        Boolean(artistDir) &&
        !isUnknown(artistDir) &&
        (isUnknown(t.artist) || looksGarbled(t.artist)) &&
        !isAdText(artistDir),
    },
    raw: t,
  };
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const tracks = catalog.tracks.map(analyzeTrack);
  const n = tracks.length;

  const count = (fn) => tracks.filter(fn).length;
  const avail = (field, phase) => count((t) => t.availability[field][phase]);

  const stats = {
    generatedAt: new Date().toISOString(),
    total: n,
    fieldAvailability: {
      title: { raw: pct(avail('title', 'raw'), n), restored: pct(avail('title', 'restored'), n) },
      artist: { raw: pct(avail('artist', 'raw'), n), restored: pct(avail('artist', 'restored'), n) },
      album: { raw: pct(avail('album', 'raw'), n), restored: pct(avail('album', 'restored'), n) },
      year: { raw: pct(avail('year', 'raw'), n), restored: pct(avail('year', 'restored'), n) },
      genres: { raw: pct(avail('genres', 'raw'), n), restored: pct(avail('genres', 'restored'), n) },
      duration: { raw: pct(avail('duration', 'raw'), n), restored: pct(avail('duration', 'restored'), n) },
      coverRealArt: { raw: pct(avail('cover', 'raw'), n), restored: pct(avail('cover', 'restored'), n) },
    },
    dirtiness: {
      mojibakeAny: pct(count((t) => t.flags.anyGarbled), n),
      mojibakeTitle: pct(count((t) => t.flags.titleGarbled), n),
      mojibakeArtist: pct(count((t) => t.flags.artistGarbled), n),
      mojibakeAlbum: pct(count((t) => t.flags.albumGarbled), n),
      mojibakePath: pct(count((t) => t.flags.pathGarbled), n),
      adAny: pct(count((t) => t.flags.anyAd), n),
      adArtist: pct(count((t) => t.flags.artistAd), n),
      adTitle: pct(count((t) => t.flags.titleAd), n),
      adAlbum: pct(count((t) => t.flags.albumAd), n),
      titleHasSeparator: pct(count((t) => t.flags.titleHasSeparator), n),
      artistUnknownTag: pct(count((t) => t.flags.artistUnknownTag), n),
      albumUnknownTag: pct(count((t) => t.flags.albumUnknownTag), n),
      coverIsPlaceholder: pct(count((t) => t.flags.coverIsPlaceholder), n),
      durationZero: pct(count((t) => t.flags.durationZero), n),
    },
    counts: {
      mojibakeAny: count((t) => t.flags.anyGarbled),
      adAny: count((t) => t.flags.anyAd),
      titleHasSeparator: count((t) => t.flags.titleHasSeparator),
      artistUnknownTag: count((t) => t.flags.artistUnknownTag),
      albumUnknownTag: count((t) => t.flags.albumUnknownTag),
      realCover: count((t) => t.flags.hasRealCover),
      placeholderCover: count((t) => t.flags.coverIsPlaceholder),
      yearPresent: count((t) => t.availability.year.raw),
      genresPresent: count((t) => t.availability.genres.restored),
      artistRescuedByRestore: count((t) => !t.availability.artist.raw && t.availability.artist.restored),
      albumRescuedByRestore: count((t) => !t.availability.album.raw && t.availability.album.restored),
      genresRescuedByRestore: count((t) => !t.availability.genres.raw && t.availability.genres.restored),
    },
    pathInference: {
      artistDirUsable: pct(count((t) => t.pathInference.artistDirUsable), n),
      albumDirUsable: pct(count((t) => t.pathInference.albumDirUsable), n),
      // Agreement measured ONLY where both sides are usable, otherwise the
      // shared literal `[Unknown Artist]` would count as an agreement.
      artistDirAgreementRaw: agreement(tracks, 'artistDirMatchesTag', 'artist', 'raw'),
      artistDirAgreementRestored: agreement(tracks, 'artistDirMatchesTagAfterRestore', 'artist', 'restored'),
      albumDirAgreementRestored: agreement(tracks, 'albumDirMatchesTagAfterRestore', 'album', 'restored'),
      artistDirAgreementRestoredSample: denom(tracks, 'artist', 'restored'),
      artistDirFillsMissingTag: count((t) => t.pathInference.artistDirFillsMissingTag),
      artistDirFillsMissingTagPct: pct(count((t) => t.pathInference.artistDirFillsMissingTag), n),
      artistCoverageTagOnly: pct(avail('artist', 'restored'), n),
      artistCoverageTagPlusDir: pct(count((t) => t.availability.artist.restored || t.pathInference.artistDirUsable), n),
      artistDirDisagreements: tracks
        .filter(
          (t) =>
            t.pathInference.artistDirUsable &&
            t.availability.artist.restored &&
            !t.pathInference.artistDirMatchesTagAfterRestore
        )
        .slice(0, 20)
        .map((t) => ({ dir: t.restored.artistDir, tag: t.restored.artist, title: t.restored.title, path: t.raw.path })),
    },
    distinctValues: {
      artists: new Set(tracks.map((t) => t.restored.artist)).size,
      albums: new Set(tracks.map((t) => t.restored.album)).size,
      albumDirs: new Set(tracks.map((t) => t.restored.albumDir)).size,
      artistDirs: new Set(tracks.map((t) => t.restored.artistDir)).size,
      topAlbums: topValues(tracks.map((t) => t.raw.album), 10),
      topArtists: topValues(tracks.map((t) => t.restored.artist), 15),
      topComments: topValues(tracks.map((t) => t.raw.comment).filter(Boolean), 10),
      topGenres: topValues(tracks.flatMap((t) => t.raw.genres), 20),
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(stats, null, 2), 'utf8');
  // Full per-track view kept separately so the report can cite concrete rows.
  fs.writeFileSync(
    path.join(ROOT, 'data', 'l1-tracks.json'),
    JSON.stringify(
      tracks.map((t) => ({
        id: t.id,
        raw: t.raw,
        restored: t.restored,
        flags: t.flags,
        availability: t.availability,
        pathInference: t.pathInference,
      })),
      null,
      1
    ),
    'utf8'
  );

  console.log(JSON.stringify(stats, null, 2));
  console.log(`\nwrote ${OUT_PATH}`);
}

/** Number of tracks where `field` is usable in `phase`. */
function denom(tracks, field, phase) {
  return tracks.filter((t) => t.availability[field][phase]).length;
}

/**
 * Fraction of comparable tracks where the directory-derived label equals the
 * tag label. Comparable = both sides usable AND the directory has a value.
 *
 * @returns {{pct:number, agree:number, comparable:number, rate:number}}
 */
function agreement(tracks, flagKey, field, phase) {
  const comparable = tracks.filter(
    (t) =>
      Boolean(t.restored.artistDir || t.restored.albumDir) &&
      t.availability[field][phase] &&
      (field === 'artist' ? t.pathInference.artistDirUsable : t.pathInference.albumDirUsable)
  );
  const agree = comparable.filter((t) => t.pathInference[flagKey]).length;
  return {
    agree,
    comparable: comparable.length,
    rate: pct(agree, comparable.length),
    pctOfLibrary: pct(agree, tracks.length),
  };
}

/** @returns {[string, number][]} top-N value counts. */
function topValues(values, n) {
  const m = new Map();
  for (const v of values) {
    const k = v == null ? '' : String(v);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Executable, not a library: `require()` must not rewrite data/l1-report.json.
if (require.main === module) main();
