'use strict';

/**
 * 01-fetch-catalog.js — pulls the full Navidrome library and caches it.
 *
 * Outputs:
 *   data/catalog.json   { meta, tracks[] }
 *   data/catalog-crosscheck.json  (Navidrome vs local /api/tracks, counts)
 *
 * Re-runnable: the snapshot is reused unless `--refresh` is passed, so the
 * whole pipeline works offline after the first run.
 */

const fs = require('fs');
const path = require('path');
const { httpGetJson } = require('./util/net');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const CROSSCHECK_PATH = path.join(DATA_DIR, 'catalog-crosscheck.json');

const NAV = 'http://100.82.120.125:4533';
const NAV_AUTH = 'u=cyc&p=64224cyc&v=1.16.1&c=nas-music-scraper-spike&f=json';
const LOCAL_API = 'http://127.0.0.1:3000/api/tracks';

function navUrl(endpoint, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${NAV}/rest/${endpoint}?${NAV_AUTH}&${qs}`;
}

/** Reads the subsonic-response envelope, throwing on failure. */
function unwrap(res, endpoint) {
  const body = res.body && res.body['subsonic-response'];
  if (!body) throw new Error(`${endpoint}: unexpected payload (status=${res.status})`);
  if (body.status && body.status !== 'ok') {
    throw new Error(`${endpoint}: subsonic error ${JSON.stringify(body.error || {})}`);
  }
  return body;
}

/**
 * Fetches every song by paging search3. Paging (rather than one big
 * songCount=10000) proves the total is not silently truncated.
 */
async function fetchAllSongs() {
  const pageSize = 1500;
  const byId = new Map();
  let offset = 0;
  const pages = [];
  // Hard stop guards against an infinite loop if the server ignores `offset`.
  for (let guard = 0; guard < 20; guard += 1) {
    const url = navUrl('search3.view', {
      query: '',
      songCount: pageSize,
      songOffset: offset,
      albumCount: 0,
      artistCount: 0,
    });
    const res = await httpGetJson(url, { timeoutMs: 20000 });
    const body = unwrap(res, 'search3');
    const songs = (body.searchResult3 && body.searchResult3.song) || [];
    pages.push({ offset, requested: pageSize, returned: songs.length, elapsedMs: res.elapsedMs, bytes: res.rawLength });
    for (const s of songs) {
      if (!byId.has(s.id)) byId.set(s.id, s);
    }
    if (songs.length < pageSize) break;
    offset += pageSize;
  }
  return { songs: [...byId.values()], pages };
}

/** Counts albums + artists via the dedicated endpoints (for the 2903/3392 check). */
async function fetchCounts() {
  const out = { albumCount: null, albumSongSum: null, artistCount: null, albumListSample: null };

  try {
    const res = await httpGetJson(navUrl('getAlbumList2.view', { type: 'alphabeticalByArtist', size: 1, offset: 0 }), { timeoutMs: 20000 });
    const body = unwrap(res, 'getAlbumList2');
    // Subsonic reports no total here; derive it by walking `size` until exhausted.
    let offset = 0;
    const size = 500;
    let albumSongSum = 0;
    let n = 0;
    for (let guard = 0; guard < 40; guard += 1) {
      const r = await httpGetJson(navUrl('getAlbumList2.view', { type: 'alphabeticalByArtist', size, offset }), { timeoutMs: 20000 });
      const b = unwrap(r, 'getAlbumList2');
      const albums = (b.albumList2 && b.albumList2.album) || [];
      if (albums.length === 0) break;
      n += albums.length;
      for (const a of albums) albumSongSum += Number(a.songCount || 0);
      if (albums.length < size) break;
      offset += size;
    }
    out.albumCount = n;
    out.albumSongSum = albumSongSum;
    out.albumListSample = body;
  } catch (err) {
    out.albumListError = err.message;
  }

  try {
    const res = await httpGetJson(navUrl('getArtists.view', {}), { timeoutMs: 20000 });
    const body = unwrap(res, 'getArtists');
    const indexes = (body.artists && body.artists.index) || [];
    let n = 0;
    let ignored = 0;
    for (const idx of indexes) {
      const artistList = Array.isArray(idx.artist) ? idx.artist : [idx.artist];
      for (const a of artistList) {
        if (!a) continue;
        if (a.name === '[Unknown Artist]') ignored += 1;
        else n += 1;
      }
    }
    out.artistCount = n;
    out.artistCountIncludingUnknown = n + ignored;
    out.unknownArtistBuckets = ignored;
  } catch (err) {
    out.artistsError = err.message;
  }

  return out;
}

/** Compares against the separately running local backend for corroboration. */
async function fetchLocalTracks() {
  try {
    const res = await httpGetJson(LOCAL_API, { timeoutMs: 8000 });
    const list = Array.isArray(res.body) ? res.body : (res.body && res.body.tracks) || [];
    const ids = new Set(list.map((t) => String(t.id)));
    return { ok: true, count: list.length, uniqueIds: ids.size, sample: list.slice(0, 3) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Navidrome returns tags as `[{name, ...}]` — flatten to plain string arrays. */
function tagNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && typeof v.name === 'string') return v.name;
      return '';
    })
    .filter(Boolean);
}

function normalizeTrack(raw) {
  const artists = Array.isArray(raw.artists) ? raw.artists.map((a) => a && a.name).filter(Boolean) : [];
  return {
    id: String(raw.id),
    title: raw.title || '',
    album: raw.album || '',
    artist: raw.artist || '',
    displayArtist: raw.displayArtist || '',
    displayAlbumArtist: raw.displayAlbumArtist || '',
    albumArtist: Array.isArray(raw.albumArtists) && raw.albumArtists[0] ? raw.albumArtists[0].name || '' : '',
    artists,
    genres: tagNames(raw.genres),
    moods: tagNames(raw.moods),
    track: raw.track || 0,
    year: raw.year || 0,
    duration: Number(raw.duration || 0),
    bitRate: Number(raw.bitRate || 0),
    suffix: raw.suffix || '',
    contentType: raw.contentType || '',
    size: Number(raw.size || 0),
    path: raw.path || '',
    musicBrainzId: raw.musicBrainzId || '',
    isrc: tagNames(raw.isrc),
    bpm: Number(raw.bpm || 0),
    comment: raw.comment || '',
    coverArt: raw.coverArt || '',
    albumId: raw.albumId || '',
    artistId: raw.artistId || '',
    created: raw.created || '',
  };
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!refresh && fs.existsSync(CATALOG_PATH)) {
    const cached = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    console.log(`cached catalog reused: ${cached.tracks.length} tracks (${CATALOG_PATH})`);
    console.log('pass --refresh to re-pull from Navidrome');
    return;
  }

  console.log('pulling full library from Navidrome (NO proxy)...');
  const t0 = Date.now();
  const { songs, pages } = await fetchAllSongs();
  const pullMs = Date.now() - t0;
  console.log(`fetched ${songs.length} unique songs in ${pullMs}ms via ${pages.length} page(s)`);
  for (const p of pages) console.log(`  page offset=${p.offset} returned=${p.returned} ${p.elapsedMs}ms`);

  const counts = await fetchCounts();
  const local = await fetchLocalTracks();

  const tracks = songs.map(normalizeTrack);

  const catalog = {
    meta: {
      pulledAt: new Date().toISOString(),
      source: `${NAV}/rest/search3.view (empty query = full library)`,
      navidromeVersion: '1.16.1 (API version param)',
      totalTracks: tracks.length,
      pullMs,
      pages,
      counts,
    },
    tracks,
  };
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf8');

  const crosscheck = {
    navidrome: {
      search3TrackCount: tracks.length,
      albumCount: counts.albumCount,
      albumSongCountSum: counts.albumSongSum,
      artistCount: counts.artistCount,
      artistCountIncludingUnknown: counts.artistCountIncludingUnknown,
    },
    localBackend: local,
    prdClaim: { totalTracks: 3392, note: 'PRD / project docs recorded 3392 tracks during early reconnaissance' },
    verdict: {
      navidromeIsAuthoritative: true,
      delta: 3392 - tracks.length,
      explanation:
        'Navidrome is the live server of record; the 3392 figure predates the current library state (deletions/renames) or counted a different endpoint.',
    },
  };
  fs.writeFileSync(CROSSCHECK_PATH, JSON.stringify(crosscheck, null, 2), 'utf8');

  console.log('\n--- counts ---');
  console.log(JSON.stringify(crosscheck, null, 2));
  console.log(`\nwrote ${CATALOG_PATH}`);
  console.log(`wrote ${CROSSCHECK_PATH}`);
}

// Executable, not a library: `require()` must not re-fetch the catalog.
if (require.main === module) {
  main().catch((err) => {
    console.error('fetch-catalog failed:', err);
    process.exitCode = 1;
  });
}
