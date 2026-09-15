'use strict';

/**
 * 04-run-l2.js — L2 online scraping over the 100-track stratified sample.
 *
 * Sources : NetEase Cloud Music (anonymous search API), MusicBrainz.
 * Honours  : NetEase <= 2 QPS  -> we use 2000 ms spacing (= 0.5 QPS, polite)
 *            MusicBrainz <= 1 req/s (1200 ms spacing, mandatory real UA)
 * Zero deps: built-in modules + global fetch only (see util/net.js).
 *
 * ---------------------------------------------------------------------------
 * BAN NOTE — what is actually evidenced, and what is not
 * An earlier pass of this script scored 0% on NetEase. The only surviving
 * record of that pass is data/l2-run.log, which shows: 248 requests, 246 of
 * them empty, 0 errors, and a 0% hit-rate. That is enough to prove the real
 * failure mode — the run did NOT crash, it simply recorded "0 results" 246
 * times, so a naive client reports 0% instead of reporting a problem.
 *
 * What that log does NOT prove: the specific error code, the request index at
 * which it started, or how long it lasted. Those numbers circulated earlier as
 * 405 / "around request 50" / ">=25 minutes", but the old code never recorded
 * `body.code` and 246/248 empty is incompatible with a healthy first 50
 * requests. They have been removed from the report rather than restated.
 *
 * Because of that, `searchNetease` inspects `body.code` on every response
 * (business errors are now also classified centrally in util/net.js), and an
 * aborted NetEase phase is marked `valid: false` so it cannot be counted.
 * ---------------------------------------------------------------------------
 *
 * Strategy per track:
 *   NetEase   S1 (cleaned title) always; S2 (title + artist) when S1 misses;
 *             S3 (extra candidates) only when both miss (max 2 extra).
 *   MB        one combined query (title + artist); a title-only retry happens
 *             only when the combined query misses.
 *
 * Resumable: results are flushed to data/result.json every 5 tracks, and the
 * two source phases are cached independently, so `--netease-only` re-runs just
 * the NetEase half without re-querying MusicBrainz.
 */

const fs = require('fs');
const path = require('path');
const { webGet, webPost, RateLimiter } = require('./util/net');
const { buildQueries } = require('./util/text');
const { localView, fromMusicBrainz, pickBest, TIER_RANK } = require('./match');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_PATH = path.join(ROOT, 'data', 'sample-100.json');
const RESULT_PATH = path.join(ROOT, 'data', 'result.json');
const RAW_DIR = path.join(ROOT, 'data', 'raw');

/** NetEase spacing: 2000 ms = 0.5 QPS, i.e. well inside the 2 QPS allowance. */
const NET_EASE_LIMIT = 2000;
const MB_LIMIT = 1200;
const REQUEST_TIMEOUT_MS = 20000;
const MB_USER_AGENT = 'NasMusicScraperSpike/0.1.0 ( https://example.invalid/nas-music-scraper; spike@example.invalid )';
const NET_EASE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** Escalating cooldowns kept for reference; endpoints are rotated instead. */
const BACKOFF_MS = [60000, 180000, 300000];

/** Pause before re-asking MusicBrainz after a "server busy" (HTTP 503). */
const MB_BUSY_BACKOFF_MS = 3000;

/**
 * How many scored candidates are persisted per source per track.
 *
 * This used to be 5, which silently capped every offline re-scoring pass:
 * NetEase returns >5 candidates for 93/100 tracks, so a scoring-rule change
 * could only re-rank within an already-truncated pool. 20 keeps the offline
 * `--rescore` path honest for this library's candidate distributions.
 */
const TOP_CANDIDATES_KEPT = 20;

const neteaseLimiter = new RateLimiter(NET_EASE_LIMIT);
const mbLimiter = new RateLimiter(MB_LIMIT);

const state = {
  neteaseBlocked: false,
  neteaseBlockCode: null,
  neteaseBlockMsg: null,
};

const telemetry = {
  netease: {
    requests: 0,
    errors: 0,
    blocked: 0,
    emptyResult: 0,
    totalMs: 0,
    limiterWaitMs: 0,
    lastError: null,
    byEndpoint: {},
    bannedEndpoints: [],
  },
  musicbrainz: {
    requests: 0,
    errors: 0,
    businessErrors: 0,
    httpErrors: 0,
    emptyResult: 0,
    totalMs: 0,
    limiterWaitMs: 0,
    lastError: null,
  },
  neteaseLyric: { requests: 0, errors: 0, available: 0, totalMs: 0 },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NetEase endpoints, tried in order.
 *
 * `cloudsearch-pc` is the endpoint the current web player actually calls and is
 * the only one this spike has ever exercised successfully (187/187 requests,
 * all `code=200`, see data/l2-final.log).
 *
 * The rotation below was added as a safeguard after an earlier pass scored 0%
 * on the legacy endpoint — but note that the rotation has NOT been exercised:
 * no run in this spike ever had to fall through to endpoint 2 or 3, so
 * "rotation works" is untested. Treat it as defensive code, not as validated
 * behaviour.
 */
const NET_EASE_ENDPOINTS = [
  { name: 'cloudsearch-pc', method: 'POST', url: 'https://music.163.com/api/cloudsearch/pc' },
  { name: 'search-get', method: 'GET', url: 'https://music.163.com/api/search/get' },
  { name: 'search-get/web', method: 'GET', url: 'https://music.163.com/api/search/get/web' },
];

/** Endpoints currently believed to be 405-blocked (reset per process). */
const bannedEndpoints = new Set();

/**
 * Normalises a NetEase song object from EITHER endpoint shape.
 * cloudsearch/pc : `{id,name,ar:[],al:{},dt,publishTime}`
 * search/get     : `{id,name,artists:[],album:{},duration,album.publishTime}`
 */
function normalizeNeteaseSong(item) {
  const artists = Array.isArray(item.ar)
    ? item.ar.map((a) => a && a.name).filter(Boolean)
    : Array.isArray(item.artists)
      ? item.artists.map((a) => a && a.name).filter(Boolean)
      : [];
  const al = item.al || item.album || {};
  const publishTime = Number(item.publishTime || al.publishTime || 0);
  const picId =
    (al.pic_str && String(al.pic_str)) || (al.pic ? String(al.pic) : '') || (al.picId ? String(al.picId) : '');
  return {
    source: 'netease',
    id: String(item.id),
    title: item.name || '',
    artists,
    artistText: artists.join('/'),
    album: al.name || '',
    albumId: al.id ? String(al.id) : '',
    picId,
    picUrl: al.picUrl || '',
    year: publishTime > 0 ? new Date(publishTime).getFullYear() : 0,
    durationSec: Math.round(Number(item.dt || item.duration || 0) / 1000),
    popularity: item.pop,
    query: '',
  };
}

/**
 * NetEase anonymous search with per-endpoint ban tracking.
 *
 * @returns {Promise<{ok:boolean, blocked:boolean, endpoint:string, code:number|null, msg:string|null, candidates:object[], allBlocked:boolean, ...}>}
 */
async function searchNetease(query) {
  const usable = NET_EASE_ENDPOINTS.filter((e) => !bannedEndpoints.has(e.name));
  if (usable.length === 0) {
    return {
      ok: false,
      blocked: true,
      allBlocked: true,
      endpoint: 'none',
      code: 405,
      msg: 'all endpoints banned',
      candidates: [],
      elapsedMs: 0,
    };
  }

  let last = null;
  for (const ep of usable) {
    const before = neteaseLimiter.totalWaitMs;
    await neteaseLimiter.acquire();
    const common = {
      headers: { Referer: 'https://music.163.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      userAgent: NET_EASE_UA,
      timeoutMs: REQUEST_TIMEOUT_MS,
    };
    const r =
      ep.method === 'POST'
        ? await webPost(ep.url, { s: query, type: '1', offset: '0', limit: '8', total: 'true' }, common)
        : await webGet(`${ep.url}?s=${encodeURIComponent(query)}&type=1&offset=0&limit=8`, common);

    telemetry.netease.requests += 1;
    telemetry.netease.totalMs += r.elapsedMs;
    telemetry.netease.limiterWaitMs += neteaseLimiter.totalWaitMs - before;
    telemetry.netease.byEndpoint[ep.name] = telemetry.netease.byEndpoint[ep.name] || { requests: 0, candidates: 0, blocked: 0 };
    telemetry.netease.byEndpoint[ep.name].requests += 1;

    const code = r.body && typeof r.body.code === 'number' ? r.body.code : null;
    const msg = r.body && r.body.msg ? String(r.body.msg) : null;
    const rawSongs = r.body && r.body.result && Array.isArray(r.body.result.songs) ? r.body.result.songs : [];
    const blocked = code !== null && code !== 200;

    if (blocked) {
      bannedEndpoints.add(ep.name);
      telemetry.netease.blocked += 1;
      telemetry.netease.byEndpoint[ep.name].blocked += 1;
      telemetry.netease.lastError = `${ep.name}: code ${code} ${msg || ''}`.trim();
      console.warn(`  !! NetEase endpoint ${ep.name} returned code ${code} (${msg || ''}) — dropping it for this run`);
      last = { ok: false, blocked: true, allBlocked: bannedEndpoints.size >= NET_EASE_ENDPOINTS.length, endpoint: ep.name, code, msg, candidates: [], elapsedMs: r.elapsedMs, via: r.via, status: r.status };
      continue;
    }
    if (!r.ok) {
      telemetry.netease.errors += 1;
      telemetry.netease.lastError = r.error || `status ${r.status}`;
      last = { ok: false, blocked: false, allBlocked: false, endpoint: ep.name, code, msg, candidates: [], elapsedMs: r.elapsedMs, via: r.via, status: r.status, error: r.error };
      continue;
    }
    if (rawSongs.length === 0) telemetry.netease.emptyResult += 1;

    const songs = rawSongs.map((s) => {
      const c = normalizeNeteaseSong(s);
      c.query = query;
      return c;
    });
    telemetry.netease.byEndpoint[ep.name].candidates += songs.length;
    return {
      ok: true,
      blocked: false,
      allBlocked: false,
      endpoint: ep.name,
      code,
      msg,
      via: r.via,
      status: r.status,
      songCount: r.body && r.body.result ? r.body.result.songCount : null,
      elapsedMs: r.elapsedMs,
      candidates: songs,
    };
  }
  return last || { ok: false, blocked: true, allBlocked: true, endpoint: 'none', code: null, msg: null, candidates: [], elapsedMs: 0 };
}

/**
 * MusicBrainz recording search.
 *
 * IMPORTANT: when MusicBrainz is overloaded it answers with a body of
 * `{"error":"The MusicBrainz web server is currently busy. Please try again
 * later."}`. This used to be silently counted as `emptyResult` — i.e. "this
 * song does not exist" — because the old curl transport reported every
 * parsable body as `status: 200, ok: true`. That body is in fact HTTP 503
 * (verified in src/00b-probe-net.js), so the check has to live here: a busy
 * response is an ERROR, never an empty result.
 *
 * One short-backoff retry absorbs most transient 503s.
 */
async function searchMusicBrainz(query) {
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
  const MAX_ATTEMPTS = 2;
  let r = null;
  let attemptsMade = 0;

  for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo += 1) {
    const before = mbLimiter.totalWaitMs;
    await mbLimiter.acquire();
    r = await webGet(url, {
      headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
      userAgent: MB_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    attemptsMade = attemptNo;
    telemetry.musicbrainz.requests += 1;
    telemetry.musicbrainz.totalMs += r.elapsedMs;
    telemetry.musicbrainz.limiterWaitMs += mbLimiter.totalWaitMs - before;

    const busy = isMbBusy(r);
    if (!busy || attemptNo === MAX_ATTEMPTS) break;
    await sleep(MB_BUSY_BACKOFF_MS);
  }

  const recs = r.body && Array.isArray(r.body.recordings) ? r.body.recordings : [];
  if (!r.ok) {
    telemetry.musicbrainz.errors += 1;
    if (r.businessError) telemetry.musicbrainz.businessErrors += 1;
    if (r.httpError) telemetry.musicbrainz.httpErrors += 1;
    telemetry.musicbrainz.lastError = r.error || `status ${r.status}`;
  } else if (recs.length === 0) {
    telemetry.musicbrainz.emptyResult += 1;
  }
  return {
    ok: r.ok,
    via: r.via,
    status: r.status,
    error: r.error,
    businessError: r.businessError || null,
    httpError: Boolean(r.httpError),
    busy: isMbBusy(r),
    attemptsMade,
    elapsedMs: r.elapsedMs,
    count: r.body ? r.body.count : null,
    candidates: recs.map((rec) => fromMusicBrainz(rec, query)),
  };
}

/** True when a MusicBrainz response is an overload/rate-limit notice, not data. */
function isMbBusy(r) {
  if (!r) return false;
  const text = `${r.businessError || ''} ${r.error || ''}`;
  if (/busy|try again|rate limit|too many/i.test(text)) return true;
  // A 5xx from MusicBrainz is transient by nature; treat it the same way.
  return Boolean(r.httpError) && Number(r.status) >= 500;
}

/** Lyrics via the NetEase lyric API (evidence for the M-06 assessment). */
async function fetchNeteaseLyric(id) {
  const url = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`;
  await neteaseLimiter.acquire();
  const r = await webGet(url, {
    headers: { Referer: 'https://music.163.com/' },
    userAgent: NET_EASE_UA,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  telemetry.neteaseLyric.requests += 1;
  telemetry.neteaseLyric.totalMs += r.elapsedMs;
  if (!r.ok) {
    telemetry.neteaseLyric.errors += 1;
    return { ok: false, error: r.error || `status ${r.status}`, chars: 0 };
  }
  const code = r.body && typeof r.body.code === 'number' ? r.body.code : null;
  if (code !== null && code !== 200) {
    telemetry.neteaseLyric.errors += 1;
    return { ok: false, blocked: true, error: `code ${code} ${r.body.msg || ''}`.trim(), chars: 0 };
  }
  const lyric = (r.body && r.body.lrc && r.body.lrc.lyric) || '';
  const tlyric = (r.body && r.body.tlyric && r.body.tlyric.lyric) || '';
  // NetEase returns a stub line for instrumental / unavailable tracks.
  const stub = /纯音乐，请欣赏|没有找到歌词|此歌曲为没有填词的纯音乐/.test(lyric) && lyric.length < 80;
  const chars = stub ? 0 : lyric.length;
  if (chars > 0 || tlyric.length > 0) telemetry.neteaseLyric.available += 1;
  return { ok: true, chars, translationChars: tlyric.length, stub, sample: lyric.slice(0, 400) };
}

/** Escapes a value for a MusicBrainz Lucene field query. */
function mbEscape(value) {
  return String(value || '').replace(/([\\"])/g, '\\$1');
}

/** Issues one NetEase query, rotating endpoints. Returns null when all are banned. */
async function neteaseQueryWithBackoff(query) {
  if (state.neteaseBlocked) return null;
  const res = await searchNetease(query);
  if (!res.blocked) return res;
  if (res.allBlocked) {
    state.neteaseBlocked = true;
    state.neteaseBlockCode = res.code;
    state.neteaseBlockMsg = res.msg;
    console.error(`  !! all NetEase endpoints blocked (code ${res.code} ${res.msg || ''}). NetEase phase aborted.`);
    return null;
  }
  // A single endpoint died but others are alive: the caller retries the same
  // query through `searchNetease`, which already skipped the banned endpoint.
  const retry = await searchNetease(query);
  if (retry.blocked) {
    state.neteaseBlocked = retry.allBlocked;
    state.neteaseBlockCode = retry.code;
    state.neteaseBlockMsg = retry.msg;
    if (retry.allBlocked) {
      console.error(`  !! all NetEase endpoints blocked (code ${retry.code}). NetEase phase aborted.`);
      return null;
    }
  }
  return retry.blocked ? null : retry;
}

// --------------------------------------------------------------------- phases

/** NetEase phase. Returns the source block, or null when the phase was aborted. */
async function runNeteasePhase(local, row, entry) {
  const qs = buildQueries({ title: row.restored.title, artist: row.restored.artist });
  const s1 = qs.find((q) => q.strategy === 'S1');
  const s2 = qs.find((q) => q.strategy === 'S2');
  const s3 = qs.filter((q) => q.strategy === 'S3');

  const attempts = [];
  const pool = [];
  const run = async (strategy, q) => {
    const res = await neteaseQueryWithBackoff(q);
    if (!res) return null;
    attempts.push({
      strategy,
      query: q,
      endpoint: res.endpoint,
      ok: res.ok,
      via: res.via,
      status: res.status,
      code: res.code,
      msg: res.msg,
      error: res.error,
      songCount: res.songCount,
      elapsedMs: res.elapsedMs,
      candidateCount: res.candidates.length,
    });
    entry.queriesTried.push({ source: 'netease', strategy, query: q, ok: res.ok, hits: res.candidates.length });
    for (const c of res.candidates) pool.push(c);
    return res;
  };

  if (s1) {
    const r = await run('S1', s1.q);
    if (!r) return null;
  }
  let best = pickBest(local, pool);
  const hit = () => TIER_RANK[best.bestScore ? best.bestScore.strict.tier : 'miss'] >= 2;
  if (!hit() && s2) {
    const r = await run('S2', s2.q);
    if (!r) return null;
    best = pickBest(local, pool);
  }
  if (!hit()) {
    for (const alt of s3.slice(0, 2)) {
      const r = await run('S3', alt.q);
      if (!r) return null;
      best = pickBest(local, pool);
      if (hit()) break;
    }
  }

  const lyrics = { requested: false };
  if (best.best && hit()) {
    const lyric = await fetchNeteaseLyric(best.best.id);
    lyrics.requested = true;
    Object.assign(lyrics, lyric);
  }

  const perStrategy = {};
  for (const at of attempts) {
    const subset = pool.filter((c) => c.query === at.query);
    const b = pickBest(local, subset);
    perStrategy[at.strategy] = {
      query: at.query,
      candidateCount: subset.length,
      tier: b.bestScore ? b.bestScore.strict.tier : 'miss',
      score: b.bestScore ? b.bestScore.strict.score : 0,
      title: b.best ? b.best.title : '',
      artist: b.best ? b.best.artistText : '',
    };
  }

  return {
    valid: true,
    attempts,
    candidatePoolSize: pool.length,
    topCandidates: best.ranked.slice(0, TOP_CANDIDATES_KEPT).map((r) => ({ candidate: r.candidate, score: r.score })),
    best: best.best,
    bestScore: best.bestScore,
    tier: best.bestScore ? best.bestScore.strict.tier : 'miss',
    tierRelaxed: best.bestScore ? best.bestScore.relaxed.tier : 'miss',
    lyrics,
    perStrategy,
  };
}

/** MusicBrainz phase. Returns the source block. */
async function runMbPhase(local, entry) {
  const qs = buildQueries({ title: entry.restoredTitle, artist: entry.restoredArtist });
  const s1 = qs.find((q) => q.strategy === 'S1');
  const primaryTitle = (s1 && s1.q) || local.title;

  const attempts = [];
  const pool = [];
  const run = async (q) => {
    const res = await searchMusicBrainz(q);
    attempts.push({
      query: q,
      ok: res.ok,
      via: res.via,
      status: res.status,
      error: res.error,
      // Kept so a later audit can tell "the source said no" from "the source
      // was overloaded" without re-querying (this is the evidence the earlier
      // version threw away).
      businessError: res.businessError,
      httpError: res.httpError,
      busy: res.busy,
      attemptsMade: res.attemptsMade,
      count: res.count,
      elapsedMs: res.elapsedMs,
      candidateCount: res.candidates.length,
    });
    entry.queriesTried.push({ source: 'musicbrainz', strategy: 'MB', query: q, ok: res.ok, hits: res.candidates.length });
    for (const c of res.candidates) pool.push(c);
    return res;
  };

  const combined = local.artistUsable
    ? `recording:"${mbEscape(primaryTitle)}" AND artist:"${mbEscape(local.artist)}"`
    : `recording:"${mbEscape(primaryTitle)}"`;
  await run(combined);
  let best = pickBest(local, pool);
  const hit = () => TIER_RANK[best.bestScore ? best.bestScore.strict.tier : 'miss'] >= 2;
  if (local.artistUsable && !hit()) {
    await run(`recording:"${mbEscape(primaryTitle)}"`);
    best = pickBest(local, pool);
  }

  return {
    valid: true,
    attempts,
    candidatePoolSize: pool.length,
    topCandidates: best.ranked.slice(0, TOP_CANDIDATES_KEPT).map((r) => ({ candidate: r.candidate, score: r.score })),
    best: best.best,
    bestScore: best.bestScore,
    tier: best.bestScore ? best.bestScore.strict.tier : 'miss',
    tierRelaxed: best.bestScore ? best.bestScore.relaxed.tier : 'miss',
  };
}

const EMPTY_NETEASE = () => ({
  valid: false,
  attempts: [],
  candidatePoolSize: 0,
  topCandidates: [],
  best: null,
  bestScore: null,
  tier: 'miss',
  tierRelaxed: 'miss',
  lyrics: { requested: false },
  perStrategy: {},
});
const EMPTY_MB = () => ({
  valid: false,
  attempts: [],
  candidatePoolSize: 0,
  topCandidates: [],
  best: null,
  bestScore: null,
  tier: 'miss',
  tierRelaxed: 'miss',
});

// ------------------------------------------------------------------ bootstrap
function loadExisting() {
  if (!fs.existsSync(RESULT_PATH)) return { meta: {}, entries: [], telemetry: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
    return {
      meta: parsed.meta || {},
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      telemetry: parsed.telemetry || null,
    };
  } catch (err) {
    console.warn(`result.json unreadable (${err.message}); starting fresh`);
    return { meta: {}, entries: [], telemetry: null };
  }
}

/**
 * Persists the run.
 *
 * `telemetryOverride` exists so an offline pass (`--rescore`) can carry the
 * ORIGINAL run's source-health counters forward. Overwriting them with a fresh
 * process's empty counters is how the source-health evidence disappeared once
 * already — after which the report printed a table of zeroes that contradicted
 * its own prose.
 *
 * @param {object} meta
 * @param {object[]} entries
 * @param {object} [telemetryOverride]
 */
function save(meta, entries, telemetryOverride) {
  const tele = telemetryOverride || telemetry;
  fs.writeFileSync(RESULT_PATH, JSON.stringify({ meta, entries, telemetry: tele }, null, 1), 'utf8');
}

async function main() {
  const skipNetease = process.argv.includes('--mb-only');
  const skipMb = process.argv.includes('--netease-only');
  const replay = process.argv.includes('--replay');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const limit = onlyArg ? Number(onlyArg.split('=')[1]) : Infinity;

  fs.mkdirSync(RAW_DIR, { recursive: true });
  const sampleDoc = JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));
  const sample = sampleDoc.sample.slice(0, limit);

  const cached = replay ? [] : loadExisting().entries;
  const cacheByIndex = new Map(cached.map((e) => [e.sampleIndex, e]));

  console.log(
    `L2 run: ${sample.length} tracks | netease ${skipNetease ? 'SKIPPED' : `${NET_EASE_LIMIT}ms`} | musicbrainz ${
      skipMb ? 'SKIPPED' : `${MB_LIMIT}ms`
    } | cached=${cacheByIndex.size}`
  );

  const entries = [];
  let processed = 0;

  for (const row of sample) {
    const prev = cacheByIndex.get(row.sampleIndex);
    const local = localView(row.raw);

    const entry =
      prev ||
      {
        sampleIndex: row.sampleIndex,
        layer: row.layer,
        layerName: row.layerName,
        id: row.id,
        local,
        restoredTitle: row.restored.title,
        restoredArtist: row.restored.artist,
        queriesTried: [],
        netease: EMPTY_NETEASE(),
        musicbrainz: EMPTY_MB(),
        elapsedMs: 0,
      };
    entry.local = local;
    entry.restoredTitle = row.restored.title;
    entry.restoredArtist = row.restored.artist;

    const started = Date.now();

    // NetEase: reuse a valid cached phase, otherwise re-run.
    if (!skipNetease && !(prev && prev.netease && prev.netease.valid)) {
      const ne = await runNeteasePhase(local, row, entry);
      entry.netease = ne || EMPTY_NETEASE();
      if (!ne) {
        // Phase aborted: keep whatever MusicBrainz data we already had.
        entry.musicbrainz = prev && prev.musicbrainz ? { ...prev.musicbrainz, valid: true } : entry.musicbrainz;
        entry.elapsedMs = Date.now() - started;
        entries.push(entry);
        // Persist what we have, then stop: continuing would just burn time.
        const merged = mergeWithCache(entries, cacheByIndex);
        save(sampleDoc.meta, merged);
        console.error(
          `\nABORTED at track ${row.sampleIndex}: NetEase blocked. Re-run later with --netease-only (progress kept, ${merged.length} tracks on disk).`
        );
        return;
      }
    }

    // MusicBrainz: reuse a valid cached phase, otherwise run.
    if (!skipMb && !(prev && prev.musicbrainz && prev.musicbrainz.valid)) {
      entry.musicbrainz = await runMbPhase(local, entry);
    } else if (prev && prev.musicbrainz && !prev.musicbrainz.valid && prev.musicbrainz.attempts && prev.musicbrainz.attempts.length > 0) {
      // Legacy cache written before the `valid` flag existed: the requests did
      // happen, so adopt them rather than re-querying MusicBrainz (1 req/s).
      entry.musicbrainz = { ...prev.musicbrainz, valid: true };
    }

    entry.elapsedMs = Date.now() - started;
    entry.done = true;
    entries.push(entry);
    processed += 1;

    const tierOf = (b) => (b && b.tier ? b.tier : 'miss');
    console.log(
      `[${String(row.sampleIndex).padStart(3)}/${sample.length}] ${row.layer} ne=${tierOf(entry.netease).padEnd(6)} mb=${tierOf(
        entry.musicbrainz
      ).padEnd(6)} ${String(local.title).slice(0, 26)}  (${entry.elapsedMs}ms)`
    );

    if (processed % 5 === 0) {
      entries.sort((a, b) => a.sampleIndex - b.sampleIndex);
      save(sampleDoc.meta, mergeWithCache(entries, cacheByIndex));
    }
  }

  const all = mergeWithCache(entries, cacheByIndex);
  const summary = summarize(all);
  save({ ...sampleDoc.meta, runFinishedAt: new Date().toISOString(), summary }, all);

  fs.writeFileSync(
    path.join(RAW_DIR, 'digest.json'),
    JSON.stringify(
      all.map((e) => ({
        sampleIndex: e.sampleIndex,
        layer: e.layer,
        id: e.id,
        title: e.local.title,
        artist: e.local.artist,
        queries: e.queriesTried,
        neteaseValid: e.netease.valid,
        neteaseTier: e.netease.tier,
        neteaseTierRelaxed: e.netease.tierRelaxed,
        neteaseBest: e.netease.best,
        neteaseAttempts: e.netease.attempts,
        lyricsChars: e.netease.lyrics ? e.netease.lyrics.chars : 0,
        musicbrainzValid: e.musicbrainz.valid,
        musicbrainzTier: e.musicbrainz.tier,
        musicbrainzBest: e.musicbrainz.best,
        musicbrainzAttempts: e.musicbrainz.attempts,
      })),
      null,
      1
    ),
    'utf8'
  );

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\n=== TELEMETRY ===');
  console.log(JSON.stringify(telemetry, null, 2));
  console.log('\n=== BLOCKED SOURCES ===');
  console.log(JSON.stringify({ neteaseBlocked: state.neteaseBlocked, code: state.neteaseBlockCode, msg: state.neteaseBlockMsg }));
  console.log(`\nwrote ${RESULT_PATH}`);
}

/** Merges freshly-processed entries with untouched cache entries. */
function mergeWithCache(fresh, cacheByIndex) {
  const byIndex = new Map(cacheByIndex);
  for (const e of fresh) byIndex.set(e.sampleIndex, e);
  return [...byIndex.values()].sort((a, b) => a.sampleIndex - b.sampleIndex);
}

module.exports = { summarize, TIER_RANK, isHit, pct, weighted, fieldStats };

// ------------------------------------------------------------------- summary
function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

/** True when `source` produced an exact/likely match for this track. */
function isHit(entry, source, profile = 'strict') {
  const block = entry[source];
  if (!block || !block.valid) return false;
  return TIER_RANK[profile === 'relaxed' ? block.tierRelaxed : block.tier] >= 2;
}

/**
 * How many hit tracks carry a usable value for one field.
 * `libraryPct` uses the whole sample as denominator — that maps onto the PRD
 * coverage metrics (M-01/M-02/M-06/M-07).
 */
function fieldStats(hits, pick, total) {
  const withField = hits.filter((e) => {
    const v = pick(e);
    return v !== null && v !== undefined && v !== '' && v !== 0;
  }).length;
  return { count: withField, hits: hits.length, amongHitsPct: pct(withField, hits.length), libraryPct: pct(withField, total) };
}

/** Weighted mean, used for the library-level extrapolation. */
function weighted(rateByLayer, pop) {
  const total = Object.values(pop).reduce((a, b) => a + b, 0);
  let sum = 0;
  for (const [layer, rate] of Object.entries(rateByLayer)) sum += ((pop[layer] || 0) / total) * rate;
  return Math.round(sum * 10) / 10;
}

function summarize(entries) {
  const tiers = ['exact', 'likely', 'weak', 'miss'];
  /**
   * Tier histogram over an explicit row set. `rows` must be passed in — the
   * per-layer breakdown would otherwise silently reuse the whole-sample counts.
   */
  const tiersOf = (rows, get) => Object.fromEntries(tiers.map((t) => [t, rows.filter((e) => get(e) === t).length]));

  const neteaseValid = entries.filter((e) => e.netease.valid);
  const mbValid = entries.filter((e) => e.musicbrainz.valid);

  const perLayer = {};
  for (const layer of ['A', 'B', 'C', 'D', 'E']) {
    const rows = entries.filter((e) => e.layer === layer);
    if (!rows.length) continue;
    perLayer[layer] = {
      n: rows.length,
      netease: tiersOf(rows, (e) => e.netease.tier),
      musicbrainz: tiersOf(rows, (e) => e.musicbrainz.tier),
      neteaseHitRate: pct(rows.filter((e) => isHit(e, 'netease')).length, rows.length),
      neteaseHitRateRelaxed: pct(rows.filter((e) => isHit(e, 'netease', 'relaxed')).length, rows.length),
      musicbrainzHitRate: pct(rows.filter((e) => isHit(e, 'musicbrainz')).length, rows.length),
      combinedHitRate: pct(rows.filter((e) => isHit(e, 'netease') || isHit(e, 'musicbrainz')).length, rows.length),
    };
  }

  const neteaseHits = entries.filter((e) => isHit(e, 'netease'));
  const mbHits = entries.filter((e) => isHit(e, 'musicbrainz'));
  const combinedHits = entries.filter((e) => isHit(e, 'netease') || isHit(e, 'musicbrainz'));

  return {
    sampleSize: entries.length,
    tiers,
    validity: { neteaseValidTracks: neteaseValid.length, musicbrainzValidTracks: mbValid.length, total: entries.length },
    netease: {
      ...tiersOf(entries, (e) => (e.netease.valid ? e.netease.tier : 'invalid')),
      hitRate: pct(neteaseHits.length, entries.length),
      hitRateRelaxed: pct(entries.filter((e) => isHit(e, 'netease', 'relaxed')).length, entries.length),
      perLayer: Object.fromEntries(
        Object.entries(perLayer).map(([k, v]) => [k, { n: v.n, ...v.netease, hitRate: v.neteaseHitRate, hitRateRelaxed: v.neteaseHitRateRelaxed }])
      ),
      fields: {
        artist: fieldStats(neteaseHits, (e) => e.netease.best && e.netease.best.artistText, entries.length),
        album: fieldStats(neteaseHits, (e) => e.netease.best && e.netease.best.album, entries.length),
        year: fieldStats(neteaseHits, (e) => e.netease.best && e.netease.best.year, entries.length),
        cover: fieldStats(neteaseHits, (e) => e.netease.best && e.netease.best.picId, entries.length),
      },
      lyrics: {
        requested: entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested).length,
        available: entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested && e.netease.lyrics.chars > 0).length,
        amongRequestedPct: pct(
          entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested && e.netease.lyrics.chars > 0).length,
          entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested).length
        ),
        libraryPct: pct(
          entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested && e.netease.lyrics.chars > 0).length,
          entries.length
        ),
      },
      strategyComparison: compareStrategies(entries, 'netease'),
    },
    musicbrainz: {
      ...tiersOf(entries, (e) => (e.musicbrainz.valid ? e.musicbrainz.tier : 'invalid')),
      hits: mbHits.length,
      hitRate: pct(mbHits.length, entries.length),
      hitRateRelaxed: pct(entries.filter((e) => isHit(e, 'musicbrainz', 'relaxed')).length, entries.length),
      perLayer: Object.fromEntries(
        Object.entries(perLayer).map(([k, v]) => [k, { n: v.n, ...v.musicbrainz, hitRate: v.musicbrainzHitRate }])
      ),
      fields: {
        artist: fieldStats(mbHits, (e) => e.musicbrainz.best && e.musicbrainz.best.artistText, entries.length),
        album: fieldStats(mbHits, (e) => e.musicbrainz.best && e.musicbrainz.best.album, entries.length),
        year: fieldStats(mbHits, (e) => e.musicbrainz.best && e.musicbrainz.best.year, entries.length),
        cover: {
          amongHitsPct: 0,
          libraryPct: 0,
          count: 0,
          hits: mbHits.length,
          note: 'release id present, but the Cover Art Archive image fetch is blocked in this sandbox (see report)',
        },
      },
      releaseIdPresent: pct(mbHits.filter((e) => e.musicbrainz.best && e.musicbrainz.best.albumId).length, mbHits.length),
    },
    perLayer,
    combined: {
      hitRate: pct(combinedHits.length, entries.length),
      hitRateRelaxed: pct(
        entries.filter((e) => isHit(e, 'netease', 'relaxed') || isHit(e, 'musicbrainz', 'relaxed')).length,
        entries.length
      ),
      perLayer: Object.fromEntries(Object.entries(perLayer).map(([k, v]) => [k, { n: v.n, hitRate: v.combinedHitRate }])),
    },
    relaxedUpside: entries
      .filter(
        (e) =>
          !isHit(e, 'netease') &&
          !isHit(e, 'musicbrainz') &&
          (isHit(e, 'netease', 'relaxed') || isHit(e, 'musicbrainz', 'relaxed'))
      )
      .map((e) => {
        const src = isHit(e, 'netease', 'relaxed') ? 'netease' : 'musicbrainz';
        const best = e[src].best;
        const sc = e[src].bestScore;
        return {
          sampleIndex: e.sampleIndex,
          layer: e.layer,
          localTitle: e.local.title,
          localArtist: e.local.artist,
          source: src,
          onlineTitle: best.title,
          onlineArtist: best.artistText,
          onlineAlbum: best.album,
          titleSim: sc.titleSim,
          artistSim: sc.artistSim,
          durDiff: sc.durDiff,
        };
      }),
  };
}

/** Best-tier-per-strategy comparison across all tracks. */
function compareStrategies(entries, source) {
  const out = {};
  for (const strategy of ['S1', 'S2', 'S3', 'MB']) {
    const rows = entries.map((e) => e[source].perStrategy && e[source].perStrategy[strategy]).filter(Boolean);
    if (!rows.length) continue;
    out[strategy] = {
      issued: rows.length,
      exact: rows.filter((r) => r.tier === 'exact').length,
      likely: rows.filter((r) => r.tier === 'likely').length,
      weak: rows.filter((r) => r.tier === 'weak').length,
      miss: rows.filter((r) => r.tier === 'miss').length,
      hitRate: pct(rows.filter((r) => r.tier === 'exact' || r.tier === 'likely').length, rows.length),
    };
  }
  return out;
}

/**
 * `--rescore` — recompute every match from the candidate snapshots already in
 * data/result.json, with NO network access. Used after a scoring-rule change so
 * the sample does not have to be re-scraped (and cannot be re-banned).
 *
 * The original run's `telemetry` is carried forward untouched: this pass issues
 * no requests, so its own counters are all zero and must never replace real
 * source-health evidence.
 *
 * Pool note: `TOP_CANDIDATES_KEPT` candidates per source are persisted, so a
 * rule change can re-rank within that pool but cannot surface a candidate the
 * old rules had already discarded beyond it.
 */
function rescore() {
  const doc = loadExisting();
  const carriedTelemetry = doc.telemetry;
  let changed = 0;
  for (const entry of doc.entries) {
    // `entry.local` is already a `localView` result (it carries `durationSec`,
    // not `duration`) — feeding it back through localView would zero the
    // duration and silently disable the duration gate.
    const local = entry.local;
    if (!local || typeof local.durationSec !== 'number') continue;
    for (const source of ['netease', 'musicbrainz']) {
      const block = entry[source];
      if (!block || !block.valid) continue;
      const pool = (block.topCandidates || []).map((x) => x.candidate).filter(Boolean);
      if (pool.length === 0) continue;
      const before = block.tier;
      const best = pickBest(local, pool);
      block.topCandidates = best.ranked.slice(0, TOP_CANDIDATES_KEPT).map((r) => ({ candidate: r.candidate, score: r.score }));
      block.best = best.best;
      block.bestScore = best.bestScore;
      block.tier = best.bestScore ? best.bestScore.strict.tier : 'miss';
      block.tierRelaxed = best.bestScore ? best.bestScore.relaxed.tier : 'miss';
      if (block.perStrategy) {
        for (const key of Object.keys(block.perStrategy)) {
          const q = block.perStrategy[key].query;
          const subset = pool.filter((c) => c.query === q);
          const b = pickBest(local, subset);
          block.perStrategy[key].tier = b.bestScore ? b.bestScore.strict.tier : 'miss';
          block.perStrategy[key].score = b.bestScore ? b.bestScore.strict.score : 0;
        }
      }
      if (before !== block.tier) {
        changed += 1;
        console.log(`  rescore ${entry.sampleIndex} ${source}: ${before} -> ${block.tier} (${entry.local.title.slice(0, 30)})`);
      }
    }
  }
  const summary = summarize(doc.entries);
  save(
    {
      ...doc.meta,
      rescoredAt: new Date().toISOString(),
      summary,
      telemetryPreservedFrom: carriedTelemetry ? doc.meta.runFinishedAt || doc.meta.runAt || 'previous run' : null,
    },
    doc.entries,
    carriedTelemetry
  );
  console.log(`\nrescored ${doc.entries.length} entries, ${changed} tier changes`);
  console.log(
    `telemetry: ${carriedTelemetry ? 'preserved from the scraping run' : 'UNAVAILABLE (no telemetry on disk)'}`
  );
  console.log(JSON.stringify({ netease: { hitRate: summary.netease.hitRate }, musicbrainz: { hitRate: summary.musicbrainz.hitRate }, combined: summary.combined }, null, 2));
}

if (require.main === module) {
  // `rescore` runs fully offline and returns synchronously; `main` is async.
  // Wrap with Promise.resolve so both paths share one error handler.
  const run = process.argv.includes('--rescore') ? rescore : main;
  Promise.resolve()
    .then(() => run())
    .catch((err) => {
      console.error('run-l2 crashed:', err);
      process.exitCode = 1;
    });
}
