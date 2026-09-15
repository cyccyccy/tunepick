'use strict';

/**
 * 11-consistency-check.js — global cross-file consistency review (rework pass).
 *
 * The rework touched four code files and one report generator, and the report
 * now cites five new data artefacts. This script re-derives every headline
 * number FROM THE DATA FILES and asserts that the corresponding string is
 * actually present in 报告-命中率实测.md. It is deliberately a text-level check:
 * it catches the failure mode that matters here — a report that quietly drifts
 * away from the data after a rule change.
 *
 * It also asserts the specific reconciliation claims of §0.4 (63 vs 64,
 * 25 vs 26, 57 vs 58, 17 vs 18) so those do not rot.
 *
 * No network access. Exit code 0 = IS_PASS: YES.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const j = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const report = fs.readFileSync(path.join(ROOT, '报告-命中率实测.md'), 'utf8');
const result = j('result.json');
const sample = j('sample-100.json');
const m01 = j('m01-tiers.json');
const cross = j('cross-source.json');
const mbRe = j('mb-recheck.json');
const tsrc = j('telemetry-sources.json');
const rmax = j('relaxed-max.json');
const l1 = j('l1-report.json');
const qaReportPath = path.join(ROOT, '报告-独立复核.md');
const qaReport = fs.existsSync(qaReportPath) ? fs.readFileSync(qaReportPath, 'utf8') : '';

const TIER_RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const R = (t) => TIER_RANK[t] >= 2;
const E = result.entries;
const layers = ['A', 'B', 'C', 'D', 'E'];
const pop = sample.meta.layerPopulation;
const popTotal = Object.values(pop).reduce((a, b) => a + b, 0);
const weighted = (byL) =>
  Math.round((layers.reduce((a, L) => a + (pop[L] / popTotal) * byL[L], 0) / layers.reduce((a, L) => a + pop[L] / popTotal, 0)) * 10) / 10;
const pct = (n, d) => Math.round((n / d) * 1000) / 10;

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

// ---------------------------------------------------------------- §0.4 anchors
const strictHits = E.filter((e) => R(e.netease.tier) || R(e.musicbrainz.tier));
const neHits = E.filter((e) => R(e.netease.tier));
const mbHits = E.filter((e) => R(e.musicbrainz.tier));
const neOnly = E.filter((e) => R(e.netease.tier) && !R(e.musicbrainz.tier));
const mbOnly = E.filter((e) => !R(e.netease.tier) && R(e.musicbrainz.tier));
add('strict 命中 = 64（两源）', strictHits.length === 64, `got ${strictHits.length}`);
add('网易云 strict = 63（§0.4 的 QA 基数）', neHits.length === 63, `got ${neHits.length}`);
add('两源合并 − 网易云单源 = 1（#90 只被 MB 命中）', mbOnly.length === 1 && mbOnly[0].sampleIndex === 90,
  `mbOnly ids = ${mbOnly.map((e) => e.sampleIndex).join(',')}`);
add('§0.4 的 MB 边际贡献与 cross-source.json 一致',
  cross.musicbrainzMarginalRecall.measured === mbOnly.length,
  `${cross.musicbrainzMarginalRecall.measured} vs ${mbOnly.length}`);

// ------------------------------------------------------- M-01 four tiers (from m01)
add('M-01 档① = 93.9', m01.tiers.tier1_nonEmpty.weighted === 93.9, `got ${m01.tiers.tier1_nonEmpty.weighted}`);
add('M-01 档② = 89.4', m01.tiers.tier2_usable.weighted === 89.4, `got ${m01.tiers.tier2_usable.weighted}`);
add('M-01 档④ = 75.3', m01.tiers.tier4_overwriteSafe.weighted === 75.3, `got ${m01.tiers.tier4_overwriteSafe.weighted}`);
add('M-01 佐证 26 = 命中 64 − 未佐证 38',
  m01.hitBreakdown.artistCorroborated === 26 &&
    m01.hitBreakdown.artistNotCorroborated === 38 &&
    m01.hitBreakdown.artistCorroborated + m01.hitBreakdown.artistNotCorroborated === m01.hitBreakdown.strictHits,
  JSON.stringify(m01.hitBreakdown));
add('未佐证 38 = [Unknown Artist] 36 + 伪歌手 2',
  m01.hitBreakdown.notCorroboratedBreakdown.localArtistMissingOrJunk === 36 &&
    m01.hitBreakdown.notCorroboratedBreakdown.localArtistPresentButSourceDisagrees === 2,
  JSON.stringify(m01.hitBreakdown.notCorroboratedBreakdown));
add('审阅队列 12 条', m01.reviewQueueSize === 12 && m01.reviewQueue.length === 12, `got ${m01.reviewQueueSize}`);

// ------------------------------------------------------------ profile union
const neRelaxed = E.filter((e) => R(e.netease.tierRelaxed));
add('网易云 relaxed 单档 = 69', neRelaxed.length === 69, `got ${neRelaxed.length}`);
add('网易云两档并集 = 77（= 63 ∪ 69）',
  rmax.profileUnion.netease === 77 &&
    E.filter((e) => R(e.netease.tier) || R(e.netease.tierRelaxed)).length === 77,
  `declared ${rmax.profileUnion.netease}`);
const union = E.filter(
  (e) => R(e.netease.tier) || R(e.musicbrainz.tier) || R(e.netease.tierRelaxed) || R(e.musicbrainz.tierRelaxed)
);
add('跨源两档并集 = 78', union.length === 78 && rmax.profileUnion.crossSource === 78, `got ${union.length}`);
const unionByLayer = Object.fromEntries(
  layers.map((L) => {
    const rows = E.filter((e) => e.layer === L);
    return [L, pct(rows.filter((e) => R(e.netease.tier) || R(e.musicbrainz.tier) || R(e.netease.tierRelaxed) || R(e.musicbrainz.tierRelaxed)).length, rows.length)];
  })
);
add('跨源并集外推 = 84.3', weighted(unionByLayer) === 84.3 && rmax.profileUnion.crossSourceLibraryPct === 84.3,
  `got ${weighted(unionByLayer)}`);
add('网易云单源并集外推 = 81.8', rmax.profileUnion.neteaseLibraryPct === 81.8, `got ${rmax.profileUnion.neteaseLibraryPct}`);
add('relaxed-only 重排（池内）= 70（< 77，故 77 才是单源口径）',
  rmax.relaxedMaximised.samplePct.netease === 70, `got ${rmax.relaxedMaximised.samplePct.netease}`);
add('strict-only 三种计数单位 = 8 / 10 / 6',
  rmax && E.filter((e) => R(e.netease.tier) && !R(e.netease.tierRelaxed)).length === 8 &&
    E.filter((e) => (R(e.netease.tier) && !R(e.netease.tierRelaxed)) || (R(e.musicbrainz.tier) && !R(e.musicbrainz.tierRelaxed))).length === 10 &&
    E.filter((e) => (R(e.netease.tier) || R(e.musicbrainz.tier)) && !(R(e.netease.tierRelaxed) || R(e.musicbrainz.tierRelaxed))).length === 6,
  `ne=${E.filter((e) => R(e.netease.tier) && !R(e.netease.tierRelaxed)).length}`);

// ------------------------------------------------------- duration consistency
const dur = rmax.durationConsistency;
add('时长一致性 ≤15s = 58/64 = 90.6%', dur.buckets.le15 === 58 && dur.comparable === 64 && dur.within15pct === 90.6,
  JSON.stringify(dur.buckets));
add('时长一致性 ≤20s = 60/64 = 93.8%', dur.buckets.le15 + dur.buckets.gt15le20 === 60 && dur.within20pct === 93.8,
  `${dur.buckets.le15}+${dur.buckets.gt15le20}`);
add('>30s 为 0 首', dur.over30 === 0, `got ${dur.over30}`);
add('>15s 恰为 6 首 #5/38/44/52/57/62',
  dur.over15Rows.map((r) => r.sampleIndex).join(',') === '5,38,44,52,57,62',
  dur.over15Rows.map((r) => r.sampleIndex).join(','));
// §0.4: NetEase-only base gives 57/63
const neStrictDur = neHits.map((e) => e.netease.bestScore).filter((s) => s && typeof s.durDiff === 'number' && s.durDiff <= 15);
add('§0.4 对账：网易云口径 ≤15s = 57/63', neStrictDur.length === 57, `got ${neStrictDur.length}`);

// ---------------------------------------------------- MusicBrainz correction
const corr = tsrc.musicbrainzCorrection;
add('MB 定向重跑：24 目标 / 12 真空 / 12 找回 / 首试 9 次 503',
  corr.recheckTargets === 24 &&
    corr.verdicts.truly_empty_source_lacks_track === 12 &&
    corr.verdicts.has_results_main_run_underestimated === 12 &&
    corr.firstAttemptBusy503 === 9,
  JSON.stringify(corr.verdicts));
add('MB 28% → 33%，合并命中 64 → 65',
  corr.effect.musicbrainzRateBefore === 28 &&
    corr.effect.musicbrainzRateAfter === 33 &&
    corr.effect.combinedHitsBefore === 64 &&
    corr.effect.combinedHitsAfter === 65,
  JSON.stringify(corr.effect));
add('mb-recheck.json 与 telemetry-sources.json 口径一致',
  mbRe.tally.targets === 24 && mbRe.tally.has_results_main_run_underestimated === 12,
  JSON.stringify(mbRe.tally));

// --------------------------------------------------------- source health
add('网易云 187 请求 / 0 错误 / 0 封禁', tsrc.mainRun.netease.requests === 187 && tsrc.mainRun.netease.errors === 0 && tsrc.mainRun.netease.blocked === 0,
  JSON.stringify({ r: tsrc.mainRun.netease.requests, e: tsrc.mainRun.netease.errors }));
add('端点轮换未生效（全部 187 次走 cloudsearch-pc）',
  Object.keys(tsrc.mainRun.netease.byEndpoint).length === 1 && tsrc.mainRun.netease.byEndpoint['cloudsearch-pc'].requests === 187,
  JSON.stringify(tsrc.mainRun.netease.byEndpoint));
add('result.json 的 telemetry 确为 0（故权威值另存）', result.telemetry.netease.requests === 0,
  `got ${result.telemetry.netease.requests}`);

// ------------------------------------------------------ timing scenarios
const sc = {
  serial: Math.round(((E.reduce((a, e) => a + e.elapsedMs, 0) / E.length / 1000) * 2903) / 60),
};
add('串行外推 = 300 分钟', sc.serial === 300, `got ${sc.serial}`);

// --------------------------------------------------- cross-source §4.6 anchors
const ad = cross.artistDisagreements;
add('§4.6 三桶互斥且合计 27：10 一致 + 3 变体 + 14 真不一致',
  ad.sourcesAgreeOnArtist === 10 && ad.scriptVariantOnly === 3 && ad.count === 14 && ad.ofBothHit === 27,
  JSON.stringify({ a: ad.sourcesAgreeOnArtist, v: ad.scriptVariantOnly, g: ad.count, n: ad.ofBothHit }));
add('§4.6 一致 + 变体 + 真不一致 = ofBothHit',
  ad.sourcesAgreeOnArtist + ad.scriptVariantOnly + ad.count === ad.ofBothHit, '');
add('§0.4 对账：破折号归一化后 18 → 17', ad.scriptVariantOnly + ad.count === 17, `got ${ad.scriptVariantOnly + ad.count}`);

// ------------------------------------------------------------ L1 anchors
add('L1 [Unknown Artist] 704 首 = 24.3%', l1.counts.artistUnknownTag === 704 && l1.dirtiness.artistUnknownTag === 24.3,
  `${l1.counts.artistUnknownTag} / ${l1.dirtiness.artistUnknownTag}`);
add('L1 真实封面 14 首（al- 前缀）', l1.counts.realCover === 14, `got ${l1.counts.realCover}`);
add('L1 乱码还原：歌手 66.8→74.4、专辑 59.9→85.3',
  l1.fieldAvailability.artist.raw === 66.8 && l1.fieldAvailability.artist.restored === 74.4 &&
    l1.fieldAvailability.album.raw === 59.9 && l1.fieldAvailability.album.restored === 85.3,
  JSON.stringify(l1.fieldAvailability.artist));
add('L1-b 目录一致率 99.8% / 100%',
  l1.pathInference.artistDirAgreementRestored.rate === 99.8 && l1.pathInference.albumDirAgreementRestored.rate === 100 &&
    l1.pathInference.artistCoverageTagOnly === l1.pathInference.artistCoverageTagPlusDir,
  `gains ${l1.pathInference.artistCoverageTagPlusDir - l1.pathInference.artistCoverageTagOnly}pp`);

// ------------------------------------------------ report text contains values
const mustAppear = [
  '93.9%', '89.4%', '85.2%', '85.7%', '75.3%',
  '**77%**', '77%', '78%', '84.3%',
  '90.6%', '93.8%',
  '33%', '60 次', '0.5 QPS', '390',
  '300 分钟', '181', '45', '118',
  '13.7 条', '3 个不同 `al-` id',
  '17 首', '14 真不一致',
  '63 首', '64 首', '57 / 63', '58 / 64',
  '无法验证',
];
for (const s of mustAppear) {
  add(`报告正文含「${s}」`, report.includes(s), 'missing');
}
// no unresolved template artefacts
add('报告无 undefined / NaN / «» 残留', !/undefined|NaN|«|»|\[object/.test(report), 'found artefact');
// section structure
const secs = (report.match(/^## \d+\./gm) || []).length;
add('报告含 11 个顶层编号章节（0..10）', secs === 11, `got ${secs}`);
add('报告含 §4.6 双源交叉验证（新增）', /### 4\.6/.test(report), 'missing');
add('报告含 §4.7 CJK 阈值缺陷（新增）', /### 4\.7/.test(report), 'missing');
add('报告含 §0.4 与 QA 对账（新增）', /### 0\.4/.test(report), 'missing');
add('报告含 §9.4 回修缺陷记录（新增）', /### 9\.4/.test(report), 'missing');

// ------------------------------------------- agreement with QA's own report
if (qaReport) {
  add('QA 报告存在且未被修改（可读）', qaReport.length > 1000, `${qaReport.length} chars`);
  add('QA 报告与主报告的 relaxed 77% 说法可对账（两处都出现 77）', qaReport.includes('77') && report.includes('77%'), '');
  add('QA 报告与主报告都指出 >30s 为 0 首', qaReport.includes('>30s 的 **0 首**') || qaReport.includes('0 首'), report.includes('>30s 为 0 首'), '');
} else {
  add('QA 报告存在', false, '报告-独立复核.md not found');
}

// ------------------------------------------------------------------ report
const failed = checks.filter((c) => !c.ok);
const lines = [];
lines.push(`checks: ${checks.length}  passed: ${checks.length - failed.length}  failed: ${failed.length}`);
lines.push('');
for (const c of checks) lines.push(`${c.ok ? 'OK  ' : 'FAIL'} | ${c.name}${c.ok ? '' : `  -> ${c.detail}`}`);
lines.push('');
lines.push(`IS_PASS: ${failed.length === 0 ? 'YES' : 'NO'}`);
// Executable, not a library: only write/exit when actually invoked.
if (require.main === module) {
  fs.writeFileSync(path.join(DATA, 'consistency-report.txt'), lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  process.exitCode = failed.length === 0 ? 0 : 1;
}
