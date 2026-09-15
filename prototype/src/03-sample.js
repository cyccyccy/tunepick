'use strict';

/**
 * 03-sample.js — stratified sample of 100 tracks (PRD Q-23 decision).
 *
 * Layers are assigned in priority order A > B > C > D > E so that no track
 * belongs to two layers (the per-layer hit-rates must partition cleanly).
 *
 *   A  乱码标题/歌手      20
 *   B  广告串             15
 *   C  标题含分隔符       25
 *   D  英文/日文标题      15
 *   E  其余随机           25
 *
 * Output: data/sample-100.json  (also prints a layer summary)
 */

const fs = require('fs');
const path = require('path');
const { buildQueries, hasTitleSeparator, isAdText, isUnknown } = require('./util/text');
const { looksGarbled, fixGarbled } = require('./util/encoding');
const { hasCJK } = require('./util/encoding');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const OUT_PATH = path.join(ROOT, 'data', 'sample-100.json');

const LAYER_SPEC = {
  A: { name: '乱码标题/歌手', size: 20 },
  B: { name: '广告串', size: 15 },
  C: { name: '标题含分隔符', size: 25 },
  D: { name: '英文/日文标题', size: 15 },
  E: { name: '其余随机', size: 25 },
};

/** Deterministic PRNG so the sample is reproducible across runs. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with an injected PRNG. */
function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** First matching layer wins, giving a clean partition. */
function layerOf(t) {
  const title = t.title || '';
  const artist = t.artist || '';
  const album = t.album || '';
  if (looksGarbled(title) || looksGarbled(artist)) return 'A';
  if (
    isAdText(title) ||
    isAdText(artist) ||
    isAdText(album) ||
    (t.genres || []).some((g) => isAdText(g))
  ) {
    return 'B';
  }
  if (hasTitleSeparator(title)) return 'C';
  if (!hasCJK(title)) return 'D';
  return 'E';
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const rng = mulberry32(20260913);

  const pools = { A: [], B: [], C: [], D: [], E: [] };
  for (const t of catalog.tracks) pools[layerOf(t)].push(t);

  console.log('layer pool sizes (before sampling):');
  for (const [k, v] of Object.entries(LAYER_SPEC)) {
    console.log(`  ${k} ${v.name}: ${pools[k].length} available, need ${v.size}`);
  }

  const picked = [];
  const shortfalls = [];
  for (const [layer, spec] of Object.entries(LAYER_SPEC)) {
    const pool = shuffle(pools[layer], rng);
    const take = Math.min(spec.size, pool.length);
    if (take < spec.size) shortfalls.push({ layer, need: spec.size, got: take });
    picked.push(...pool.slice(0, take).map((t) => ({ t, layer, source: 'primary' })));
  }

  // Fill any shortfall from the residual pool so the sample still totals 100.
  const target = Object.values(LAYER_SPEC).reduce((a, s) => a + s.size, 0);
  if (picked.length < target) {
    const used = new Set(picked.map((p) => p.t.id));
    const residual = shuffle(
      catalog.tracks.filter((t) => !used.has(t.id)),
      rng
    );
    while (picked.length < target && residual.length) {
      const t = residual.pop();
      picked.push({ t, layer: layerOf(t), source: 'fill' });
    }
  }

  const sample = picked.map((entry, i) => {
    const t = entry.t;
    const restoredArtist = fixGarbled(t.artist || '');
    const artistUsable = !isUnknown(restoredArtist) && !isAdText(restoredArtist) && restoredArtist.trim() !== '';
    return {
      sampleIndex: i,
      layer: entry.layer,
      layerName: LAYER_SPEC[entry.layer].name,
      layerSource: entry.source,
      id: t.id,
      raw: {
        title: t.title,
        artist: t.artist,
        album: t.album,
        year: t.year,
        genres: t.genres,
        duration: t.duration,
        path: t.path,
        comment: t.comment,
        coverArt: t.coverArt,
      },
      restored: {
        title: fixGarbled(t.title || ''),
        artist: restoredArtist,
        album: fixGarbled(t.album || ''),
        path: fixGarbled(t.path || ''),
      },
      l1: {
        artistUsable,
        yearUsable: Number(t.year) >= 1900 && Number(t.year) <= new Date().getFullYear(),
        genresUsable: (t.genres || []).some((g) => g && !['other', 'null', '未知'].includes(String(g).toLowerCase())),
        titleGarbled: looksGarbled(t.title),
        artistGarbled: looksGarbled(t.artist),
        adMarked: isAdText(t.title) || isAdText(t.artist) || isAdText(t.album),
        titleHasSeparator: hasTitleSeparator(t.title),
        hasRealCover: String(t.coverArt || '').startsWith('al-'),
      },
      durationSec: Number(t.duration) || 0,
      queries: buildQueries({ title: fixGarbled(t.title || ''), artist: restoredArtist }),
    };
  });

  const meta = {
    generatedAt: new Date().toISOString(),
    catalogTotal: catalog.tracks.length,
    sampleSize: sample.length,
    layerSpec: LAYER_SPEC,
    layerCounts: sample.reduce((acc, s) => {
      acc[s.layer] = (acc[s.layer] || 0) + 1;
      return acc;
    }, {}),
    layerPopulation: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    shortfalls,
    note: 'Stratified by priority A>B>C>D>E; sampled with mulberry32(20260913) for reproducibility.',
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify({ meta, sample }, null, 2), 'utf8');
  console.log('\n--- sample composition ---');
  console.log(JSON.stringify(meta.layerCounts));
  console.log(JSON.stringify(meta.layerPopulation));
  if (shortfalls.length) console.log('shortfalls:', JSON.stringify(shortfalls));
  console.log('\n--- first 12 sample rows ---');
  for (const s of sample.slice(0, 12)) {
    console.log(
      `[${s.layer}] ${s.raw.title.slice(0, 34)} | artist=${s.raw.artist.slice(0, 18)} | restored=${s.restored.title.slice(0, 30)} | q=${s.queries[0].q.slice(0, 30)}`
    );
  }
  console.log(`\nwrote ${OUT_PATH}`);
}

// Executable, not a library: `require()` must not reshuffle the sample.
if (require.main === module) main();
