'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./qa-lib');
const DATA = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype/data';
const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const entries = result.entries;
const rows = [];
for (const e of entries) for (const a of e.musicbrainz.attempts || []) rows.push({ i: e.sampleIndex, ...a });
const nul = rows.filter((a) => a.candidateCount === 0 && (a.count === null || a.count === undefined));
console.log('MB count===null 的 sampleIndex 分布:', JSON.stringify(nul.map((x) => x.i)));
console.log('桶分布:', JSON.stringify([0, 20, 40, 60, 80].map((lo) => ({ r: lo + '-' + (lo + 19), n: nul.filter((x) => x.i >= lo && x.i < lo + 20).length }))));
console.log('via 分布 全部 MB:', JSON.stringify([0, 20, 40, 60, 80].map((lo) => {
  const rs = rows.filter((a) => a.i >= lo && a.i < lo + 20);
  return { r: lo + '-' + (lo + 19), fetch: rs.filter((a) => a.via === 'fetch').length, curl: rs.filter((a) => a.via === 'curl').length, empty: rs.filter((a) => a.candidateCount === 0).length };
})));
// 网易云同一问题：via 分布（全 fetch）
const ner = [];
for (const e of entries) for (const a of e.netease.attempts || []) ner.push({ i: e.sampleIndex, ...a });
console.log('netease via:', JSON.stringify(ner.reduce((m, a) => ((m[a.via] = (m[a.via] || 0) + 1), m), {})));
// 网易云 relaxed 最大化后的 track 级并集（用 match.js scoreCandidate 重排）
const matchjs = require('D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype/src/match.js');
const RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
let trackLevelRelaxedMax = 0;
const recovered = [];
for (const e of entries) {
  let hit = false;
  for (const src of ['netease', 'musicbrainz']) {
    const b = e[src];
    if (!b || !b.valid || !b.topCandidates || !b.topCandidates.length) continue;
    const scored = b.topCandidates.map((x) => ({ c: x.candidate, s: matchjs.scoreCandidate(e.local, x.candidate) }));
    scored.sort((a, x) => {
      const t = matchjs.TIER_RANK[x.s.relaxed.tier] - matchjs.TIER_RANK[a.s.relaxed.tier];
      if (t !== 0) return t;
      return x.s.relaxed.score - a.s.relaxed.score;
    });
    const best = scored[0];
    const relaxedHit = matchjs.TIER_RANK[best.s.relaxed.tier] >= 2;
    const strictHit = matchjs.TIER_RANK[best.s.strict.tier] >= 2;
    if (relaxedHit || strictHit) hit = true;
    if (relaxedHit && RANK[b.tierRelaxed] < 2) recovered.push({ i: e.sampleIndex, src, title: best.c.title, artist: best.c.artistText, relaxed: best.s.relaxed.tier });
  }
  if (hit) trackLevelRelaxedMax += 1;
}
console.log('\n=== relaxed 最大化后的 track 级命中数（用 match.js 自己的打分，仅改排序）:', trackLevelRelaxedMax, '（报告"两档并集 78"）===');
console.log('重排后新纳入的条目:', JSON.stringify(recovered, null, 1));
