'use strict';

/**
 * 08-mb-recheck.js — targeted re-query of the MusicBrainz responses that the
 * main run could not classify, plus a corrected MusicBrainz hit-rate for the
 * affected tracks.
 *
 * BACKGROUND
 * The main run recorded 137 MusicBrainz requests and 87 empty results, with
 * `errors: 0`. The independent QA review showed that `errors: 0` cannot be
 * trusted: of those 87, only 63 carried a real `count === 0`, while 24 had NO
 * `count` field at all and had all been fetched over the `curl` transport —
 * whose HTTP status the old code hard-coded to 200. MusicBrainz reports
 * overload as a JSON body (`{"error":"…server is currently busy…"}`); that body
 * parses cleanly, so the old code filed it under "the song does not exist".
 *
 * WHAT THIS DOES
 * 1. Re-issues exactly those 24 queries (with one backoff retry each) using the
 *    fixed transport, and records whether the source was busy, genuinely
 *    empty, or returning data.
 * 2. For every affected track, merges the recoverable candidates back into
 *    that track's MusicBrainz pool and re-scores it, producing a corrected
 *    MusicBrainz tier. This is a partial correction by construction: it only
 *    repairs the 24 unclassified attempts, and re-scoring still happens within
 *    the persisted candidate pool.
 *
 * MusicBrainz allows 1 request/second, so ~24 queries take well under a minute.
 * Output: data/mb-recheck.json
 */

const fs = require('fs');
const path = require('path');
const { webGet, RateLimiter, sleep } = require('./util/net');
const { fromMusicBrainz, pickBest, TIER_RANK } = require('./match');

const ROOT = path.resolve(__dirname, '..');
const RESULT_PATH = path.join(ROOT, 'data', 'result.json');
const OUT = path.join(ROOT, 'data', 'mb-recheck.json');

const MB_USER_AGENT =
  'NasMusicScraperSpike/0.1.0 ( https://example.invalid/nas-music-scraper; spike@example.invalid )';
const MB_LIMIT = 1200;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_BACKOFF_MS = 2500;

const limiter = new RateLimiter(MB_LIMIT);

/** True when a MusicBrainz response is an overload/rate notice rather than data. */
function isBusy(r) {
  const text = `${r.businessError || ''} ${r.error || ''}`;
  if (/busy|try again|rate limit|too many/i.test(text)) return true;
  return Boolean(r.httpError) && Number(r.status) >= 500;
}

/** Collects every MusicBrainz attempt whose `count` the main run could not read. */
function findUnclassified(entries) {
  const out = [];
  for (const e of entries) {
    const block = e.musicbrainz;
    if (!block) continue;
    for (const at of block.attempts || []) {
      if (at.count === null || at.count === undefined) {
        out.push({
          sampleIndex: e.sampleIndex,
          layer: e.layer,
          title: e.local ? e.local.title : '',
          artist: e.local ? e.local.artist : '',
          query: at.query,
          mainRun: {
            ok: at.ok,
            via: at.via,
            status: at.status,
            count: at.count === undefined ? null : at.count,
            candidateCount: at.candidateCount,
            elapsedMs: at.elapsedMs,
            error: at.error || null,
          },
        });
      }
    }
  }
  return out;
}

async function queryOnce(q) {
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  await limiter.acquire();
  const r = await webGet(url, {
    headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
    userAgent: MB_USER_AGENT,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const recs = r.body && Array.isArray(r.body.recordings) ? r.body.recordings : [];
  return {
    ok: r.ok,
    via: r.via,
    status: r.status,
    httpError: Boolean(r.httpError),
    businessError: r.businessError || null,
    error: r.error || null,
    busy: isBusy(r),
    count: r.body && r.body.count !== undefined ? r.body.count : null,
    candidateCount: recs.length,
    candidates: recs.map((rec) => fromMusicBrainz(rec, q)),
    elapsedMs: r.elapsedMs,
    textSample: (r.textSample || '').slice(0, 160),
  };
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
  const targets = findUnclassified(doc.entries);

  console.log(`re-checking ${targets.length} MusicBrainz responses with a missing count ...`);

  const rows = [];
  for (const t of targets) {
    const attempt1 = await queryOnce(t.query);
    let attempt2 = null;
    // One retry, so a transient overload is not mistaken for a persistent one.
    if (attempt1.busy || attempt1.httpError) {
      await sleep(RETRY_BACKOFF_MS);
      attempt2 = await queryOnce(t.query);
    }
    const settled = attempt2 && !attempt2.busy && !attempt2.httpError ? attempt2 : attempt1;

    let verdict;
    if (attempt1.busy && (!attempt2 || attempt2.busy)) verdict = 'source_busy_confirmed';
    else if (settled.ok && settled.count === 0) verdict = 'truly_empty_source_lacks_track';
    else if (settled.ok && settled.count > 0) verdict = 'has_results_main_run_underestimated';
    else verdict = 'still_unclassifiable';

    rows.push({
      sampleIndex: t.sampleIndex,
      layer: t.layer,
      title: t.title,
      artist: t.artist,
      query: t.query,
      mainRun: t.mainRun,
      recheck: {
        attempt1,
        attempt2,
        settledFrom: settled === attempt1 ? 'attempt1' : 'attempt2',
      },
      verdict,
    });
    console.log(
      `[${String(t.sampleIndex).padStart(3)}] old(status=${t.mainRun.status},via=${t.mainRun.via}) -> ` +
        `new1(status=${attempt1.status},busy=${attempt1.busy},count=${attempt1.count})` +
        `${attempt2 ? ` new2(status=${attempt2.status},count=${attempt2.count})` : ''} ${verdict}`
    );
  }

  const settledOf = (r) => (r.recheck.settledFrom === 'attempt2' ? r.recheck.attempt2 : r.recheck.attempt1);

  const byStatus = {};
  const byVia = {};
  for (const r of rows) {
    const s = settledOf(r);
    byStatus[String(s.status)] = (byStatus[String(s.status)] || 0) + 1;
    byVia[String(s.via)] = (byVia[String(s.via)] || 0) + 1;
  }

  // ---- corrected MusicBrainz verdict for every track touched by the recheck --
  const recovered = new Map(); // sampleIndex -> candidate[]
  for (const r of rows) {
    const s = settledOf(r);
    if (s.ok && s.candidates && s.candidates.length) {
      const list = recovered.get(r.sampleIndex) || [];
      for (const c of s.candidates) list.push(c);
      recovered.set(r.sampleIndex, list);
    }
  }

  const corrections = [];
  for (const [idx, newCands] of recovered) {
    const entry = doc.entries.find((e) => e.sampleIndex === idx);
    if (!entry) continue;
    const block = entry.musicbrainz;
    const oldPool = (block.topCandidates || []).map((x) => x.candidate).filter(Boolean);
    const seen = new Set(oldPool.map((c) => `${c.source}:${c.id}`));
    const merged = oldPool.slice();
    for (const c of newCands) {
      const key = `${c.source}:${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
    const before = block.tier;
    const best = pickBest(entry.local, merged);
    const after = best.bestScore ? best.bestScore.strict.tier : 'miss';
    if (TIER_RANK[after] > TIER_RANK[before]) {
      corrections.push({
        sampleIndex: idx,
        layer: entry.layer,
        title: entry.local.title,
        artist: entry.local.artist,
        tierBefore: before,
        tierAfter: after,
        recoveredCandidates: merged.length - oldPool.length,
        best: best.best
          ? { title: best.best.title, artist: best.best.artistText, album: best.best.album, durationSec: best.best.durationSec }
          : null,
        bestScore: best.bestScore,
      });
    }
  }

  const tally = {
    targets: rows.length,
    source_busy_confirmed: rows.filter((r) => r.verdict === 'source_busy_confirmed').length,
    truly_empty_source_lacks_track: rows.filter((r) => r.verdict === 'truly_empty_source_lacks_track').length,
    has_results_main_run_underestimated: rows.filter((r) => r.verdict === 'has_results_main_run_underestimated').length,
    still_unclassifiable: rows.filter((r) => r.verdict === 'still_unclassifiable').length,
    tracksWithRecoveredCandidates: recovered.size,
    tracksWhoseMusicBrainzTierImproves: corrections.length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    why: 'The main run counted 87 MusicBrainz "empty" results with errors:0. QA showed 24 lacked a `count` field and all 24 used the curl transport, whose HTTP status was hard-coded to 200 by the old code. Re-querying them settles whether MusicBrainz was overloaded or genuinely had no such track.',
    musicbrainzLimit: `${MB_LIMIT} ms between requests`,
    tally,
    settledStatusHistogram: byStatus,
    settledViaHistogram: byVia,
    corrections,
    rows,
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');
  console.log('\n=== TALLY ===');
  console.log(JSON.stringify(tally, null, 2));
  console.log('\n=== CORRECTIONS (MB tier improves) ===');
  console.log(JSON.stringify(corrections, null, 2));
  console.log(`wrote ${OUT}`);
}

// Executable, not a library. This guard is load-bearing: the re-check performs
// 24 live MusicBrainz requests and OVERWRITES data/mb-recheck.json, so running it
// merely because someone `require()`d the file would silently burn rate limit
// and replace the recorded evidence.
if (require.main === module) {
  main().catch((err) => {
    console.error('mb-recheck crashed:', err);
    process.exitCode = 1;
  });
}
