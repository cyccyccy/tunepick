'use strict';

/**
 * 00b-probe-net.js — evidence that the response-classification fix works.
 *
 * Written to settle three specific questions raised in the independent QA
 * review of the earlier version of src/util/net.js:
 *   1. did the curl transport really observe HTTP status codes? (it used to
 *      hard-code `status: 200` for every parsable body)
 *   2. is a MusicBrainz "server busy" body now distinguishable from "no
 *      results"?
 *   3. is an HTTP 404 still being counted as a success?
 *
 * Writes data/raw/netfix-probe.json (UTF-8, via fs) so the result can be read
 * back without any shell encoding issues.
 */

const fs = require('fs');
const path = require('path');
const { webGet, webPost, curl } = require('./util/net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'raw', 'netfix-probe.json');

const MB_UA = 'NasMusicScraperSpike/0.1.0 ( https://example.invalid/nas-music-scraper; spike@example.invalid )';
const NE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Trims a response down to the fields this probe is actually about. */
function summarize(label, r) {
  return {
    label,
    via: r.via,
    status: r.status,
    ok: r.ok,
    httpError: r.httpError,
    businessError: r.businessError,
    parseError: r.parseError,
    error: r.error || null,
    bytes: r.bytes,
    bodyKeys: r.body && typeof r.body === 'object' ? Object.keys(r.body).slice(0, 8) : null,
    bodyError: r.body && r.body.error ? String(r.body.error).slice(0, 120) : null,
    bodyCode: r.body && typeof r.body.code === 'number' ? r.body.code : null,
    textSample: r.textSample ? r.textSample.slice(0, 120) : '',
  };
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), probes: [], rawStatusChecks: [] };

  // ---- 1. curl transport must expose the REAL status code ------------------
  // A MusicBrainz path that does not exist answers 404. The old code would have
  // reported `status: 200, ok: true` for this via the curl path.
  const badPath = 'https://musicbrainz.org/ws/2/this-endpoint-does-not-exist';
  const c1 = await curl(badPath, { headers: { 'User-Agent': MB_UA } });
  report.rawStatusChecks.push({ what: 'curl() on a 404 path', status: c1.status, bodyPrefix: c1.text.slice(0, 80) });

  const g404 = await webGet(badPath, { headers: { 'User-Agent': MB_UA }, preferCurl: true });
  report.probes.push(summarize('webGet 404 via curl (must be ok:false, status 404)', g404));

  // ---- 2. MusicBrainz happy path / busy path -------------------------------
  const mbOk = await webGet('https://musicbrainz.org/ws/2/recording?query=recording:%22Blue%20Bird%22&fmt=json&limit=1', {
    headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
    userAgent: MB_UA,
    timeoutMs: 20000,
  });
  report.probes.push(summarize('MusicBrainz normal query', mbOk));
  report.mbBusyDetected = Boolean(mbOk.businessError);

  // ---- 3. NetEase happy path ----------------------------------------------
  const ne = await webPost(
    'https://music.163.com/api/cloudsearch/pc',
    { s: '月亮之上', type: '1', offset: '0', limit: '3', total: 'true' },
    { headers: { Referer: 'https://music.163.com/' }, userAgent: NE_UA, timeoutMs: 20000 }
  );
  report.probes.push(summarize('NetEase cloudsearch/pc', ne));

  // ---- 4. CAA: does an HTML 404 stay a failure? ---------------------------
  const caa = await webGet('https://coverartarchive.org/release/00000000-0000-0000-0000-000000000000', {
    preferCurl: true,
    timeoutMs: 20000,
  });
  report.probes.push(summarize('Cover Art Archive bogus release (HTML or 404)', caa));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log(`wrote ${OUT}`);
  for (const p of report.probes) {
    console.log(
      `${p.ok ? 'OK  ' : 'FAIL'} via=${String(p.via).padEnd(13)} status=${String(p.status).padEnd(4)} httpErr=${String(
        p.httpError
      ).padEnd(5)} biz=${String(p.businessError).slice(0, 48)}  ${p.label}`
    );
  }
}

// Executable, not a library: `require()` must not perform network I/O.
if (require.main === module) {
  main().catch((err) => {
    console.error('probe crashed:', err);
    process.exitCode = 1;
  });
}
