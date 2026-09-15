'use strict';

/**
 * 01b-verify-total.js — resolves the "2903 vs 3392 vs 3488" discrepancy.
 *
 * Ad-hoc forensics, not part of the main pipeline. Compares:
 *   - search3 total (the endpoint the spike uses)
 *   - sum(album.songCount) from getAlbumList2
 *   - getAlbum.view song lists for a sample of albums
 *   - local backend /api/tracks
 */

const path = require('path');
const fs = require('fs');
const { httpGetJson, sleep } = require('./util/net');

const ROOT = path.resolve(__dirname, '..');
const NAV = 'http://100.82.120.125:4533';
const NAV_AUTH = 'u=cyc&p=64224cyc&v=1.16.1&c=nas-music-scraper-spike&f=json';

function navUrl(endpoint, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${NAV}/rest/${endpoint}?${NAV_AUTH}&${qs}`;
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
  const search3Ids = new Set(catalog.tracks.map((t) => t.id));
  const albumIdsInSearch3 = new Map();
  for (const t of catalog.tracks) {
    albumIdsInSearch3.set(t.albumId, (albumIdsInSearch3.get(t.albumId) || 0) + 1);
  }

  // Full album list
  const albums = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const r = await httpGetJson(navUrl('getAlbumList2.view', { type: 'alphabeticalByArtist', size: 500, offset }), { timeoutMs: 20000 });
    const list = (r.body['subsonic-response'].albumList2 || {}).album || [];
    albums.push(...list);
    if (list.length < 500) break;
  }

  const albumSongSum = albums.reduce((a, x) => a + Number(x.songCount || 0), 0);
  const distinctAlbumIds = new Set(albums.map((a) => a.id));

  console.log(`search3 tracks            : ${search3Ids.size}`);
  console.log(`albums (getAlbumList2)    : ${albums.length}`);
  console.log(`sum(album.songCount)      : ${albumSongSum}`);
  console.log(`distinct albumId in search3: ${albumIdsInSearch3.size}`);
  console.log(`albums with no search3 song: ${[...distinctAlbumIds].filter((id) => !albumIdsInSearch3.has(id)).length}`);

  // Sample 25 albums: does getAlbum.view return songs missing from search3?
  const sampleAlbums = [];
  const step = Math.max(1, Math.floor(albums.length / 25));
  for (let i = 0; i < albums.length && sampleAlbums.length < 25; i += step) sampleAlbums.push(albums[i]);

  let checked = 0;
  let missing = 0;
  let matched = 0;
  const missingExamples = [];
  for (const al of sampleAlbums) {
    const r = await httpGetJson(navUrl('getAlbum.view', { id: al.id }), { timeoutMs: 20000 });
    const songs = (((r.body['subsonic-response'] || {}).album || {}).song) || [];
    checked += 1;
    for (const s of songs) {
      if (search3Ids.has(s.id)) matched += 1;
      else {
        missing += 1;
        if (missingExamples.length < 10) missingExamples.push({ album: al.name, artist: al.artist, song: s.title, id: s.id, path: s.path });
      }
    }
    await sleep(60);
  }
  console.log(`\ngetAlbum.view song sample : checked=${checked} albums, matchedInSearch3=${matched}, MISSING=${missing}`);
  if (missingExamples.length) console.log(JSON.stringify(missingExamples, null, 2));

  // Local backend
  const local = await httpGetJson('http://127.0.0.1:3000/api/tracks', { timeoutMs: 8000 });
  const localList = Array.isArray(local.body) ? local.body : local.body.tracks || [];
  console.log(`\nlocal /api/tracks          : ${localList.length}`);
  const localIds = new Set(localList.map((t) => String(t.upstreamId || t.id).replace(/^nd_tr_/, '')));
  let inLocalNotNav = 0;
  for (const id of localIds) if (!search3Ids.has(id)) inLocalNotNav += 1;
  console.log(`local ids not in search3   : ${inLocalNotNav}`);
}

// Executable, not a library: `require()` must not re-query Navidrome.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
