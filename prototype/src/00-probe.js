'use strict';

/**
 * 00-probe.js — environment sanity check. Run this first.
 *
 * Verifies: gb18030 decoder availability, Navidrome reachability (no proxy),
 * public-source reachability (proxy as needed). Prints a compact PASS/FAIL
 * table so a failure is unambiguous.
 */

const { looksGarbled, fixGarbled } = require('./util/encoding');
const { httpGetJson, webGet } = require('./util/net');

const NAV = 'http://100.82.120.125:4533';
const NAV_AUTH = 'u=cyc&p=64224cyc&v=1.16.1&c=proto-probe&f=json';

const GBK_CASES = [
  ['ÂÉ¶¯³µÔØÒôÀÖ', '律动车载音乐'],
  ['½­ÖÇÃñ', '江智民'],
  ['Í«ÀÖ-Ê°Èþ', '瞳乐-拾叁'],
  ['¹«ÖÚºÅ£ºÐ¡²ÝÐÂ¾çÉç', '公众号：小草新剧社'],
  ['ÖÐ¡¾3D»·ÈÆ¡¿I Need a Good One', '中【3D环绕】I Need a Good One'],
];

async function main() {
  const results = [];
  const say = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  };

  // 1. gb18030 decoder
  try {
    let good = 0;
    const rows = [];
    for (const [broken, expected] of GBK_CASES) {
      const detected = looksGarbled(broken);
      const fixed = fixGarbled(broken);
      const ok = detected && fixed === expected;
      if (ok) good += 1;
      rows.push(`${broken} -> ${fixed} ${ok ? 'OK' : `EXPECTED ${expected}`}`);
    }
    say('gb18030 restore', good === GBK_CASES.length, `${good}/${GBK_CASES.length} | ${rows.join(' | ')}`);
  } catch (err) {
    say('gb18030 restore', false, err.message);
  }

  // 2. False-positive guard: clean strings must not be "restored"
  try {
    const clean = ['偏爱', 'Mojito', 'Lo-Fi Beats', 'Café del Mar', 'カルメン'];
    const bad = clean.filter((s) => looksGarbled(s));
    say('garbled false-positive guard', bad.length === 0, bad.length ? `wrongly flagged: ${bad.join(', ')}` : 'clean strings untouched');
  } catch (err) {
    say('garbled false-positive guard', false, err.message);
  }

  // 3. Navidrome via built-in http (must not go through proxy)
  try {
    const url = `${NAV}/rest/search3.view?${NAV_AUTH}&query=&songCount=10000&songOffset=0&albumCount=0&artistCount=0`;
    const res = await httpGetJson(url, { timeoutMs: 15000 });
    const songs = res.body && res.body['subsonic-response'] && res.body['subsonic-response'].searchResult3
      ? res.body['subsonic-response'].searchResult3.song || []
      : [];
    say('navidrome search3 (http, no proxy)', songs.length > 0, `status=${res.status} songs=${songs.length} ${res.elapsedMs}ms ${(res.rawLength / 1048576).toFixed(2)}MB`);
  } catch (err) {
    say('navidrome search3 (http, no proxy)', false, err.message);
  }

  // 4. NetEase via global fetch
  try {
    const url = 'https://music.163.com/api/search/get/web?s=Mojito&type=1&offset=0&limit=3';
    const r = await webGet(url, {
      headers: { Referer: 'https://music.163.com/' },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      timeoutMs: 15000,
    });
    const n = r.body && r.body.result && r.body.result.songs ? r.body.result.songs.length : 0;
    say('netease search (web)', r.ok && n > 0, `via=${r.via} status=${r.status} songs=${n} ${r.elapsedMs}ms ${r.error || ''}`);
  } catch (err) {
    say('netease search (web)', false, err.message);
  }

  // 5. NetEase lyric endpoint (needs an id; use a known one from search result)
  try {
    const url = 'https://music.163.com/api/song/lyric?id=186016&lv=-1&kv=-1&tv=-1';
    const r = await webGet(url, {
      headers: { Referer: 'https://music.163.com/' },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      timeoutMs: 15000,
    });
    const hasLyric = !!(r.body && r.body.lrc && r.body.lrc.lyric);
    say('netease lyric (web)', r.ok, `via=${r.via} status=${r.status} lyric=${hasLyric ? `${r.body.lrc.lyric.length} chars` : 'none'} ${r.elapsedMs}ms`);
  } catch (err) {
    say('netease lyric (web)', false, err.message);
  }

  // 6. MusicBrainz
  try {
    const url = 'https://musicbrainz.org/ws/2/recording?query=recording:%22Mojito%22&fmt=json&limit=3';
    const r = await webGet(url, {
      userAgent: 'NasMusicScraperSpike/0.1 ( spike@example.com )',
      timeoutMs: 20000,
    });
    const n = r.body && r.body.recordings ? r.body.recordings.length : 0;
    say('musicbrainz recording search', r.ok && n >= 0, `via=${r.via} status=${r.status} results=${n} ${r.elapsedMs}ms ${r.error || ''}`);
  } catch (err) {
    say('musicbrainz recording search', false, err.message);
  }

  // 7. Cover Art Archive
  try {
    const url = 'https://coverartarchive.org/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd';
    const r = await webGet(url, { userAgent: 'NasMusicScraperSpike/0.1 ( spike@example.com )', timeoutMs: 20000 });
    say('cover art archive', r.status === 200 || r.status === 307 || r.status === 404, `via=${r.via} status=${r.status} ${r.elapsedMs}ms ${r.error || ''}`);
  } catch (err) {
    say('cover art archive', false, err.message);
  }

  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log('\n=== SUMMARY ===');
  console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
  if (failed.length) console.log(`FAILED: ${failed.join(', ')}`);
}

// Executable, not a library: `require()` must not run the probes.
if (require.main === module) {
  main().catch((err) => {
    console.error('probe crashed:', err);
    process.exitCode = 1;
  });
}
