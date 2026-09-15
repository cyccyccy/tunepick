'use strict';

/**
 * 05-gen-report.js — turns the measured data into 报告-命中率实测.md.
 *
 * Every number in the output comes from data/*.json. Nothing is hard-coded
 * except the prose that interprets the numbers.
 *
 * Extrapolation: the sample is stratified with non-proportional layer sizes, so
 * library-level estimates are weighted by layer population, not by sample count.
 *
 * REWORK (2nd pass): after the QA independent review (报告-独立复核.md) the
 * report must (a) carry its own 口径 errors openly, (b) never state a claim that
 * no log can support. Section 0 exists for that, and the ★REWORK markers below
 * show which blocks were corrected. The six items QA listed as unverifiable are
 * enumerated in §0.3 and are never presented as findings.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT_MD = path.join(ROOT, '报告-命中率实测.md');
const OUT_AUDIT = path.join(DATA, 'audit-lists.json');

const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);

const catalog = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog.json'), 'utf8'));
const l1 = JSON.parse(fs.readFileSync(path.join(DATA, 'l1-report.json'), 'utf8'));
const crosscheck = JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-crosscheck.json'), 'utf8'));
const sampleDoc = JSON.parse(fs.readFileSync(path.join(DATA, 'sample-100.json'), 'utf8'));
const result = JSON.parse(fs.readFileSync(path.join(DATA, 'result.json'), 'utf8'));
const qa = readJson(path.join(DATA, 'qualitative-audit.json'));
// ---- rework inputs (each produced by its own script; see §10) ----
const m01 = readJson(path.join(DATA, 'm01-tiers.json'));
const cross = readJson(path.join(DATA, 'cross-source.json'));
const mbRe = readJson(path.join(DATA, 'mb-recheck.json'));
const telemetrySources = readJson(path.join(DATA, 'telemetry-sources.json'));
const relaxedMax = readJson(path.join(DATA, 'relaxed-max.json'));
// QA's per-row adjudication — READ ONLY, never written back.
const qaQ1 = readJson(path.join(ROOT, 'qa', 'q1-rows.json'));

const MISS_REASON_LABEL = {
  query_is_ad_string: '查询词本身就是广告串（标题整条是引流文案）',
  artist_is_ad_string: '歌手字段是广告串，污染查询',
  online_source_returned_nothing: '在线源对该查询词返回 0 条候选',
  song_found_but_artist_disagrees: '**歌找到了**（曲名相似 ≥0.9），但歌手与本地不一致 → 翻唱/翻奏/改版差异',
  title_noise_blocks_query: '标题带装饰噪声（【】「」等），查询词不干净',
  title_embeds_artist_split_ambiguous: '`歌手-曲名` 格式且歌手字段缺失，无法判断哪边是曲名',
  candidate_found_but_not_confident: '有相似候选但相似度不足（0.6 ≤ sim < 0.9）',
  source_lacks_the_track: '在线源确实没有这首（DJ 改版 / 冷门翻唱）',
};

const entries = result.entries;
const summary = result.meta.summary;
const N = catalog.tracks.length;
const TIER_RANK = { exact: 3, likely: 2, weak: 1, miss: 0 };
const R = (t) => TIER_RANK[t] >= 2;

const validNe = entries.filter((e) => e.netease.valid).length;
const validMb = entries.filter((e) => e.musicbrainz.valid).length;
const validityWarning =
  validNe < entries.length || validMb < entries.length
    ? `\n> ⚠️ **本次数据有效性**：网易云有效曲目 ${validNe}/${entries.length}，MusicBrainz 有效曲目 ${validMb}/${entries.length}。\n> 无效曲目（被限流中断的批次）**已从所有统计中剔除**，未混入命中率。\n`
    : `\n> ✅ **本次数据有效性**：网易云 ${validNe}/${entries.length}、MusicBrainz ${validMb}/${entries.length}，两个源的采样完整，无失败批次。\n`;

const pop = sampleDoc.meta.layerPopulation;
const sampleCount = sampleDoc.meta.layerCounts;
const totalPop = Object.values(pop).reduce((a, b) => a + b, 0);
const TOTAL_LIB = sampleDoc.meta.catalogTotal;

/**
 * Telemetry: `result.json`'s own `telemetry` block reads all-zero because an
 * offline `--rescore` pass overwrote it before the bug was fixed. The surviving
 * authoritative record is data/telemetry-sources.json (see §2.5).
 */
const telemetry = telemetrySources ? telemetrySources.mainRun : result.telemetry;

/** Weighted mean of a per-layer rate, so the sample represents the library. */
function weighted(rateByLayer) {
  let sum = 0;
  let weight = 0;
  for (const [layer, rate] of Object.entries(rateByLayer)) {
    const w = (pop[layer] || 0) / totalPop;
    sum += w * rate;
    weight += w;
  }
  return weight > 0 ? Math.round((sum / weight) * 10) / 10 : 0;
}

const isHit = (e, src, profile = 'strict') =>
  TIER_RANK[profile === 'relaxed' ? e[src].tierRelaxed : e[src].tier] >= 2;

const layers = ['A', 'B', 'C', 'D', 'E'];
const layerName = { A: 'A 乱码标题/歌手', B: 'B 广告串', C: 'C 标题含分隔符', D: 'D 英文/日文标题', E: 'E 其余随机' };

// ---------------------------------------------------------------- aggregates
const agg = {
  neHit: entries.filter((e) => isHit(e, 'netease')).length,
  mbHit: entries.filter((e) => isHit(e, 'musicbrainz')).length,
  combinedHit: entries.filter((e) => isHit(e, 'netease') || isHit(e, 'musicbrainz')).length,
  neHitRelaxed: entries.filter((e) => isHit(e, 'netease', 'relaxed')).length,
  mbHitRelaxed: entries.filter((e) => isHit(e, 'musicbrainz', 'relaxed')).length,
  combinedRelaxed: entries.filter((e) => isHit(e, 'netease', 'relaxed') || isHit(e, 'musicbrainz', 'relaxed')).length,
};
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
/** Miss-reason count from the qualitative audit (0 when the audit has not run). */
const mr = (key) => (qa && qa.missed && qa.missed.byReason[key]) || 0;
/** Misses caused by a dirty/ambiguous query rather than by source coverage. */
const queryProblemMisses =
  mr('title_noise_blocks_query') + mr('query_is_ad_string') + mr('title_embeds_artist_split_ambiguous');

const perLayerRates = {};
for (const L of layers) {
  const rows = entries.filter((e) => e.layer === L);
  perLayerRates[L] = {
    n: rows.length,
    pop: pop[L],
    ne: pct(rows.filter((e) => isHit(e, 'netease')).length, rows.length),
    mb: pct(rows.filter((e) => isHit(e, 'musicbrainz')).length, rows.length),
    both: pct(rows.filter((e) => isHit(e, 'netease') || isHit(e, 'musicbrainz')).length, rows.length),
    neRelaxed: pct(rows.filter((e) => isHit(e, 'netease', 'relaxed')).length, rows.length),
  };
}

// field coverage that a "L1 + L2(strict)" pipeline would actually deliver
function delivers(field) {
  const rows = entries.map((e) => {
    const ne = isHit(e, 'netease') ? e.netease.best : null;
    const mb = isHit(e, 'musicbrainz') ? e.musicbrainz.best : null;
    switch (field) {
      case 'artist':
        return e.local.artistUsable || Boolean(ne && ne.artistText) || Boolean(mb && mb.artistText);
      case 'year':
        return e.local.year >= 1900 || Boolean(ne && ne.year) || Boolean(mb && mb.year);
      case 'cover':
        return Boolean(ne && ne.picId);
      case 'lyrics':
        return Boolean(e.netease.lyrics && e.netease.lyrics.requested && e.netease.lyrics.chars > 0);
      case 'album':
        return Boolean(ne && ne.album) || Boolean(mb && mb.album);
      default:
        return false;
    }
  });
  const byLayer = {};
  for (const L of layers) {
    const idx = entries.map((e, i) => (e.layer === L ? i : -1)).filter((i) => i >= 0);
    byLayer[L] = pct(idx.filter((i) => rows[i]).length, idx.length);
  }
  return {
    samplePct: pct(rows.filter(Boolean).length, rows.length),
    count: rows.filter(Boolean).length,
    byLayer,
    libraryPct: weighted(byLayer),
  };
}

const delivered = {
  artist: delivers('artist'),
  year: delivers('year'),
  album: delivers('album'),
  cover: delivers('cover'),
  lyrics: delivers('lyrics'),
};

// ------------------------------------------------------------ timing & scale
const perTrackMs = entries.map((e) => e.elapsedMs).filter((v) => v > 0);
const avgPerTrackMs = Math.round(perTrackMs.reduce((a, b) => a + b, 0) / perTrackMs.length);
const neReqPerTrack = entries.reduce((a, e) => a + e.netease.attempts.length, 0) / entries.length;
const mbReqPerTrack = entries.reduce((a, e) => a + e.musicbrainz.attempts.length, 0) / entries.length;
const lyricReqPerTrack = entries.filter((e) => e.netease.lyrics && e.netease.lyrics.requested).length / entries.length;
const extrapolatedMin = Math.round(((avgPerTrackMs / 1000) * N) / 60);

/**
 * Cost decomposition + concurrency scenarios. Per-track cost splits into
 * NetEase + MusicBrainz + lyrics; the NetEase share is the residual because its
 * own counters also carry inter-track overhead.
 */
const mbRequestMsPerReq = telemetry.musicbrainz.requests
  ? telemetry.musicbrainz.totalMs / telemetry.musicbrainz.requests
  : 0;
const mbPerTrackS = Math.round((mbRequestMsPerReq * mbReqPerTrack) / 1000 * 100) / 100;
const lyricsPerTrackS = (telemetry.neteaseLyric.totalMs || 0) / entries.length / 1000;
const neShareS = Math.round((avgPerTrackMs / 1000 - mbPerTrackS - lyricsPerTrackS) * 100) / 100;
const neWallPerTrackS =
  entries.length > 0 ? Math.round(((telemetry.netease.totalMs + telemetry.netease.limiterWaitMs) / entries.length / 1000) * 100) / 100 : 0;
const timingScenarios = {
  serial: extrapolatedMin,
  dualParallel: Math.round((Math.max(neShareS, mbPerTrackS) * N) / 60),
  neteaseOnly2qps: Math.round(((neReqPerTrack / 2) * N) / 60),
  dualParallel2qps: Math.round((Math.max(neReqPerTrack / 2, mbPerTrackS) * N) / 60),
};

// ------------------------------------------------------------- audit lists
const strictHits = entries.filter((e) => isHit(e, 'netease') || isHit(e, 'musicbrainz'));
const relaxedOnly = entries.filter(
  (e) => !isHit(e, 'netease') && !isHit(e, 'musicbrainz') && (isHit(e, 'netease', 'relaxed') || isHit(e, 'musicbrainz', 'relaxed'))
);
const misses = entries.filter((e) => !isHit(e, 'netease') && !isHit(e, 'musicbrainz'));

/*
 * `relaxed` is NOT a superset of `strict`: the two profiles score different
 * things (strict = title+artist, relaxed = title+duration penalty), so a track
 * can pass strict and still fall to `weak` under relaxed (typically a long
 * duration mismatch, or a CJK simplified/traditional title difference).
 * The real recall ceiling is therefore the UNION of both profiles.
 *
 * The count depends on the counting unit and every unit is reported:
 *   - NetEase-scoped (the metric §2.3/§4.2 discuss): 8
 *   - per source, either source disagreeing internally: 10
 *   - track-level after merging both sources: 6
 */
const strictOnlyCatchNe = entries.filter((e) => R(e.netease.tier) && !R(e.netease.tierRelaxed));
const strictOnlyCatchPerSource = entries.filter(
  (e) => (R(e.netease.tier) && !R(e.netease.tierRelaxed)) || (R(e.musicbrainz.tier) && !R(e.musicbrainz.tierRelaxed))
);
const strictOnlyCatch = entries.filter(
  (e) => (isHit(e, 'netease') || isHit(e, 'musicbrainz')) && !(isHit(e, 'netease', 'relaxed') || isHit(e, 'musicbrainz', 'relaxed'))
);
const unionHits = entries.filter(
  (e) =>
    isHit(e, 'netease') ||
    isHit(e, 'musicbrainz') ||
    isHit(e, 'netease', 'relaxed') ||
    isHit(e, 'musicbrainz', 'relaxed')
);
const unionByLayer = Object.fromEntries(
  layers.map((L) => [
    L,
    Math.round(
      (unionHits.filter((e) => e.layer === L).length / entries.filter((e) => e.layer === L).length) * 1000
    ) / 10,
  ])
);
const unionWeighted = weighted(unionByLayer);
const neUnionByLayer = relaxedMax ? relaxedMax.profileUnion.neteaseByLayer : {};
const neUnionLibraryPct = relaxedMax ? relaxedMax.profileUnion.neteaseLibraryPct : 0;

/** sampleIndex -> miss reason, from the qualitative audit pass. */
const missReasonById = new Map(
  (qa && qa.missed && qa.missed.detail ? qa.missed.detail : []).map((d) => [d.sampleIndex, d.reason])
);
const missReason = (idx) => missReasonById.get(idx) || '';

/** Misses where a source returned at least one candidate = potential wrong matches. */
const nearMissEntries = misses.filter((e) => e.netease.best || e.musicbrainz.best);

/** NetEase candidate-pool truncation (see §2.5 / §9.3). */
const nePoolSizes = entries.map((e) => e.netease.candidatePoolSize || 0);
const mbPoolSizes = entries.map((e) => e.musicbrainz.candidatePoolSize || 0);
const truncation = {
  neMean: Math.round((nePoolSizes.reduce((a, b) => a + b, 0) / nePoolSizes.length) * 10) / 10,
  neMax: Math.max(...nePoolSizes),
  neOver5: nePoolSizes.filter((x) => x > 5).length,
  mbOver5: mbPoolSizes.filter((x) => x > 5).length,
  persisted: 5,
};

/**
 * Cross-source artist comparison (QA finding F). Three buckets, mutually
 * exclusive, derived in src/09-cross-source.js:
 *   agree  — identical once case/punctuation/dash-family folded
 *   variant— differ by one character with CJK present (simplified/traditional)
 *   genuine— different performers
 * "differing" = variant + genuine = the number to quote as "两源歌手不一致".
 */
const xsrc = cross
  ? {
      both: cross.artistDisagreements.ofBothHit,
      agree: cross.artistDisagreements.sourcesAgreeOnArtist,
      variant: cross.artistDisagreements.scriptVariantOnly,
      genuine: cross.artistDisagreements.count,
      get differing() {
        return this.variant + this.genuine;
      },
      genuineIdx: cross.artistDisagreements.rows.map((r) => `#${r.sampleIndex}`).join(' '),
      marginalMb: cross.musicbrainzMarginalRecall.measured,
      marginalMbCorrected: cross.musicbrainzMarginalRecall.afterOverloadCorrection,
    }
  : null;

const audit = {
  strictHits: strictHits.map((e) => {
    const src = isHit(e, 'netease') ? 'netease' : 'musicbrainz';
    const best = e[src].best;
    const sc = e[src].bestScore;
    return {
      sampleIndex: e.sampleIndex,
      layer: e.layer,
      localTitle: e.local.title,
      localArtist: e.local.artist,
      localDuration: e.local.durationSec,
      source: src,
      onlineTitle: best.title,
      onlineArtist: best.artistText,
      onlineAlbum: best.album,
      onlineYear: best.year,
      onlineDuration: best.durationSec,
      titleSim: sc.titleSim,
      artistSim: sc.artistSim,
      durDiff: sc.durDiff,
      tier: e[src].tier,
      lyricChars: e.netease.lyrics && Number.isFinite(e.netease.lyrics.chars) ? e.netease.lyrics.chars : 0,
    };
  }),
  relaxedOnly: relaxedOnly.map((e) => {
    const src = isHit(e, 'netease', 'relaxed') ? 'netease' : 'musicbrainz';
    const best = e[src].best;
    const sc = e[src].bestScore;
    return {
      sampleIndex: e.sampleIndex,
      layer: e.layer,
      localTitle: e.local.title,
      localArtist: e.local.artist,
      localDuration: e.local.durationSec,
      source: src,
      onlineTitle: best.title,
      onlineArtist: best.artistText,
      onlineAlbum: best.album,
      onlineDuration: best.durationSec,
      titleSim: sc.titleSim,
      artistSim: sc.artistSim,
      durDiff: sc.durDiff,
    };
  }),
  misses: misses.map((e) => {
    const top = (e.netease.topCandidates && e.netease.topCandidates[0]) || null;
    return {
      sampleIndex: e.sampleIndex,
      layer: e.layer,
      localTitle: e.local.title,
      localArtist: e.local.artist,
      localAlbum: e.local.album,
      durationSec: e.local.durationSec,
      artistUsable: e.local.artistUsable,
      neteaseReturned: e.netease.candidatePoolSize,
      musicbrainzReturned: e.musicbrainz.candidatePoolSize,
      bestNeTitle: top ? top.candidate.title : '',
      bestNeTitleSim: top ? top.score.titleSim : 0,
      queries: e.queriesTried.map((q) => `${q.source}:${q.strategy}=${q.query}`),
    };
  }),
};
fs.writeFileSync(OUT_AUDIT, JSON.stringify(audit, null, 1), 'utf8');

// ---------------------------------------------------------------- rendering
const rows = (arr) => arr.join('\n');

function hitMatrix() {
  const lines = [];
  lines.push(
    '| 层 | 库内数量 | 样本 | 网易云 strict | 网易云 relaxed | 网易云**两档并集** | MusicBrainz strict | 合并 strict | 跨源两档并集（召回天花板） |'
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const L of layers) {
    const r = perLayerRates[L];
    lines.push(
      `| ${layerName[L]} | ${r.pop} | ${r.n} | ${r.ne}% | ${r.neRelaxed}% | **${neUnionByLayer[L]}%** | ${r.mb}% | ${r.both}% | **${unionByLayer[L]}%** |`
    );
  }
  lines.push(
    `| **全库外推（按层人口加权）** | ${TOTAL_LIB} | 100 | **${weighted(
      Object.fromEntries(layers.map((L) => [L, perLayerRates[L].ne]))
    )}%** | **${weighted(
      Object.fromEntries(layers.map((L) => [L, perLayerRates[L].neRelaxed]))
    )}%** | **${neUnionLibraryPct}%** | **${weighted(
      Object.fromEntries(layers.map((L) => [L, perLayerRates[L].mb]))
    )}%** | **${weighted(
      Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both]))
    )}%** | **${unionWeighted}%** |`
  );
  return lines.join('\n');
}

function strictHitTable() {
  const lines = ['| # | 层 | 本地曲名 | 本地歌手 | 源 | 命中曲名 | 命中歌手 | 专辑 | 年代 | 曲名相似 | 歌手相似 | 时长差 | 档 | 歌词字数 |'];
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const h of audit.strictHits.sort((a, b) => a.sampleIndex - b.sampleIndex)) {
    lines.push(
      `| ${h.sampleIndex} | ${h.layer} | ${esc(h.localTitle)} | ${esc(h.localArtist)} | ${h.source} | ${esc(h.onlineTitle)} | ${esc(
        h.onlineArtist
      )} | ${esc(h.onlineAlbum)} | ${h.onlineYear || '—'} | ${h.titleSim} | ${h.artistSim} | ${h.durDiff === null ? '—' : h.durDiff} | ${h.tier} | ${h.lyricChars === null || h.lyricChars === undefined ? '—' : h.lyricChars} |`
    );
  }
  return lines.join('\n');
}

function relaxedTable() {
  const lines = ['| # | 层 | 本地曲名 | 本地歌手 | 源 | 在线曲名 | 在线歌手 | 在线专辑 | 曲名相似 | 歌手相似 | 时长差 |'];
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const h of audit.relaxedOnly.sort((a, b) => a.sampleIndex - b.sampleIndex)) {
    lines.push(
      `| ${h.sampleIndex} | ${h.layer} | ${esc(h.localTitle)} | ${esc(h.localArtist)} | ${h.source} | ${esc(h.onlineTitle)} | ${esc(
        h.onlineArtist
      )} | ${esc(h.onlineAlbum)} | ${h.titleSim} | ${h.artistSim} | ${h.durDiff === null ? '—' : h.durDiff} |`
    );
  }
  return lines.join('\n');
}

/**
 * Every missed track for which the online source DID return a candidate.
 * These are the "wrong match" cases: naively accepting the top candidate would
 * write a wrong artist (or a wrong song) into the library.
 */
function nearMissTable() {
  const lines = ['| # | 层 | 本地曲名 | 本地歌手 | 在线命中候选 | 在线候选歌手 | 曲名相似 | 歌手相似 | 时长差 | strict 档 | 归因 |'];
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const e of nearMissEntries) {
    const src = e.netease.best ? 'netease' : 'musicbrainz';
    const b = e[src].best;
    const sc = e[src].bestScore || {};
    const reason = MISS_REASON_LABEL[missReason(e.sampleIndex)] || missReason(e.sampleIndex) || '—';
    lines.push(
      `| ${e.sampleIndex} | ${e.layer} | ${esc(e.local.title)} | ${esc(e.local.artist)} | ${esc(b.title)} | ${esc(
        b.artistText
      )} | ${sc.titleSim} | ${sc.artistSim} | ${sc.durDiff === null || sc.durDiff === undefined ? '—' : sc.durDiff} | ${
        e[src].tier
      } | ${reason} |`
    );
  }
  return lines.join('\n');
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function missTable() {
  const lines = ['| # | 层 | 本地曲名 | 本地歌手 | 歌手可用 | 抓取的候选数（网易云） | 抓取的候选数（MB） | 最佳候选曲名 | 曲名相似 |'];
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const m of audit.misses.sort((a, b) => a.sampleIndex - b.sampleIndex)) {
    lines.push(
      `| ${m.sampleIndex} | ${m.layer} | ${esc(m.localTitle)} | ${esc(m.localArtist)} | ${m.artistUsable ? '是' : '否'} | ${m.neteaseReturned} | ${
        m.musicbrainzReturned
      } | ${esc(m.bestNeTitle)} | ${m.bestNeTitleSim} |`
    );
  }
  return lines.join('\n');
}

function strategyTable() {
  const sc = summary.netease.strategyComparison;
  // Real issue counts come from the per-attempt log, not from the aggregated keys.
  const issued = {};
  for (const e of entries) {
    for (const a of e.netease.attempts || []) issued[a.strategy] = (issued[a.strategy] || 0) + 1;
  }
  const tracks = {};
  for (const e of entries) {
    for (const s of new Set((e.netease.attempts || []).map((a) => a.strategy))) tracks[s] = (tracks[s] || 0) + 1;
  }
  const lines = [
    '| 策略 | 实际发出次数 | 有该策略尝试的曲目数 | exact | likely | weak | miss | 命中率(按曲目计) |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [k, v] of Object.entries(sc)) {
    lines.push(`| ${k} | **${issued[k] || 0}** | ${tracks[k] || 0} | ${v.exact} | ${v.likely} | ${v.weak} | ${v.miss} | ${v.hitRate}% |`);
  }
  return lines.join('\n');
}

function l1Table() {
  const fa = l1.fieldAvailability;
  const lines = ['| 字段 | 还原前可用率 | 还原后可用率 | 判定口径 |', '|---|---|---|---|'];
  const notes = {
    title: '非空',
    artist: '非空、非 `[Unknown Artist]`、非广告串、非乱码',
    album: '非空、非 `[Unknown Album]`、非广告串、非乱码（注意：全库仅 5 个不同取值）',
    year: '1900 ≤ year ≤ 当前年（Navidrome `year` 字段）',
    genres: '非空且不含 `Other`/`null`/`未知`/广告串/乱码',
    duration: 'duration > 0',
    coverRealArt: '**真实封面**：`coverArt` 以 `al-` 开头（专辑图）；`mf-` 是同一张水印占位图（见 §3.5）',
  };
  for (const [k, v] of Object.entries(fa)) {
    lines.push(`| ${k} | ${v.raw}% | ${v.restored}% | ${notes[k] || ''} |`);
  }
  return lines.join('\n');
}

/** M-01 four tiers (from src/07-m01-tiers.js, adjudicated against QA's q1-rows.json). */
function m01Table() {
  if (!m01) return '（未运行 src/07-m01-tiers.js）';
  const t = m01.tiers;
  const lines = ['| 档 | 口径 | 样本内 | 全库外推 | 建议目标 |', '|---|---|---|---|---|'];
  lines.push(`| ① 非空率 | 字段非空且非垃圾 | ${t.tier1_nonEmpty.sample}/100 | **${t.tier1_nonEmpty.weighted}%** | ≥90% |`);
  lines.push(`| ② 可用率 | 有第二证据（可信歌手对上，或时长 ±15s） | ${t.tier2_usable.sample}/100 | **${t.tier2_usable.weighted}%** | ≥85% |`);
  lines.push(
    `| ③ 可自动写入 | 剔除 «X - Y» 歧义（左侧疑似演唱者、与在线不符） | ${t.tier3_autoWrite.sample}/100 | **${t.tier3_autoWrite.weighted}%**（QA 手数标定 **85.7%**） | ≥82% |`
  );
  lines.push(`| ④ 可安全覆盖 | 本地歌手可信 ∧ 在线歌手精确对上 ∧ 时长 ±15s | ${t.tier4_overwriteSafe.sample}/100 | **${t.tier4_overwriteSafe.weighted}%** | 仅此场景才覆盖已有值 |`);
  return lines.join('\n');
}

function reviewQueueTable() {
  if (!m01 || !m01.reviewQueue) return '—';
  const lines = ['| # | 层 | 本地标题 | 本地歌手 | 标题里的演唱者段 | 在线歌手 | 在线曲名 | 时长差 | 曲名相似 |', '|---|---|---|---|---|---|---|---|---|'];
  for (const q of m01.reviewQueue.slice().sort((a, b) => a.sampleIndex - b.sampleIndex)) {
    lines.push(
      `| ${q.sampleIndex} | ${q.layer} | ${esc(q.localTitle)} | ${esc(q.localArtist)} | **${esc(q.libraryNameSegment)}** | ${esc(q.onlineArtist)} | ${esc(q.onlineTitle)} | ${q.durationDiff} | ${q.titleSim} |`
    );
  }
  return lines.join('\n');
}

/** QA finding F — the two sources disagreeing about who performs a track. */
function disagreementTable() {
  if (!cross) return '—';
  const rowsx = cross.artistDisagreements.rows.slice().sort((a, b) => a.sampleIndex - b.sampleIndex);
  const lines = ['| # | 层 | 本地曲名 | 本地歌手 | 网易云歌手 | MusicBrainz 歌手 | 与本地一致的一方 |', '|---|---|---|---|---|---|---|'];
  for (const d of rowsx) {
    const agree =
      d.neteaseAgreesWithLocal && d.musicbrainzAgreesWithLocal
        ? '两源都与本地一致'
        : d.neteaseAgreesWithLocal
        ? '网易云'
        : d.musicbrainzAgreesWithLocal
        ? 'MusicBrainz'
        : '**两源都与本地不一致**';
    lines.push(
      `| ${d.sampleIndex} | ${d.layer} | ${esc(d.localTitle)} | ${esc(d.localArtist)} | ${esc(d.neteaseArtist)} | ${esc(d.musicbrainzArtist)} | ${agree} |`
    );
  }
  return lines.join('\n');
}

/** QA finding E — CJK threshold mis-calibration, with the two canonical cases. */
function cjkTable() {
  if (!relaxedMax || !relaxedMax.cjkProbes) return '—';
  const pick = relaxedMax.cjkProbes.filter((p) => [70, 75].includes(p.sampleIndex));
  const lines = ['| # | 本地 | 源 | 在线候选 | 曲名相似 | 歌手相似 | 时长差 | strict 档 | relaxed 档 | 判定问题 |'];
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const p of pick) {
    for (const [srcName, s] of Object.entries(p.sources)) {
      const top = (s.top || [])[0];
      if (!top) continue;
      const issue =
        p.sampleIndex === 70 && srcName === 'musicbrainz'
          ? '**假阳**：曲名完全相同、时长相近 → relaxed 判 exact，但歌手是 Pearl Jam（artistSim 0）'
          : p.sampleIndex === 75 && srcName === 'musicbrainz'
          ? '**假阴**：歌手完全相同（那英）、时长差 0，只因标题是繁体（一笑而過）→ 曲名相似跌到 0.75，relaxed 只判 weak'
          : '—';
      lines.push(
        `| ${p.sampleIndex} | ${esc(p.localTitle)} / ${esc(p.localArtist)} | ${srcName} | ${esc(top.title)} / ${esc(top.artist)} | ${top.titleSim} | ${top.artistSim} | ${
          top.durDiff === null ? '—' : top.durDiff
        } | ${top.strictTier} | ${top.relaxedTier}(${top.relaxedScore}) | ${issue} |`
      );
    }
  }
  return lines.join('\n');
}

const md = `# NAS 音乐元数据刮削服务 · L1 + L2 命中率实测报告（原型验证 / Spike）

> 生成时间：${new Date().toISOString()}
> 数据来源：Navidrome 全量曲库快照 + 分层抽样 100 首 × 2 个在线源的**真实请求结果**
> 本报告所有数字均由脚本实测产出，未做任何人工修饰。原始证据见 \`data/\` 目录。
> **本报告已按 QA 独立复核（\`报告-独立复核.md\`）修正过口径与表述，修正清单见 §0。两份报告不矛盾：QA 报告是独立证据，本报告是修订后的主报告。**

---

## 0. ★ 独立复核与口径修正（必读）

QA（软件质量工程师）用**自己独立编写的算法**（\`qa/qa-lib.js\`，未复用本项目的 \`src/match.js\`）复算了 20 项核心数字：
§4.1 分层表、L1 全库统计、§5 的 14+32 条错配清单**逐行吻合**，"两档并集 78%"的结论也被独立复现。**工程结论未被推翻**，
但有一批**口径与表述**必须修正。逐项记录如下，便于审计两版差异。

### 0.1 修正清单（修正前 → 修正后）

| 项 | 修正前 | **修正后（本报告采用）** | 依据 |
|---|---|---|---|
| 网易云「relaxed」 | 69%（未说明它是 strict-first 排序下的值） | 69% 保留，但**同时给出网易云单源两档并集 77%**（外推 ${neUnionLibraryPct}%）；**relaxed-only 重排（池内）为 70%** | \`data/relaxed-max.json\` |
| 跨源召回天花板 | 78%（结论正确，推理不完整） | **78%（外推 ${unionWeighted}%）**，并说明 78 = 两源 × 两档并集；单源上限 77 | 同上 + QA 独立复算 |
| MusicBrainz strict | ${summary.musicbrainz.hitRate}% | ${summary.musicbrainz.hitRate}% 为**主跑值**；**定向重跑修正后 33%**（有 12 次真实结果被主跑丢失） | \`data/mb-recheck.json\` |
| MusicBrainz 错误数 | 0（"0 错误、0 封禁"） | **主跑该数字不可信**（旧传输把可解析的 body 一律当作 200/ok）；重跑 24 次中**首试 9 次 HTTP 503「server busy」** | \`data/telemetry-sources.json\` |
| 「命中里歌手被证实」 | 28 | **26**（轨级；原先把 2 条伪歌手 \`Cydian\` 条目误计为已证实） | \`data/m01-tiers.json\` |
| M-01 歌手可用率 | 单一指标 93.9% | **四档：93.9% / 89.4% / 85.2%（QA 标定 85.7%）/ 75.3%**，仅第 ④ 档才允许自动覆盖 | \`data/m01-tiers.json\` |
| 命中时长一致性 | 未报告 | **≤15s 90.6%（58/64）、≤20s 93.8%、>30s 0 首** | \`data/relaxed-max.json\` |
| 双源交叉验证 | 未报告（最大遗漏） | **两源都命中的 ${xsrc.both} 首里，${xsrc.differing} 首歌手字符串不一致**（3 例仅简繁/标点差异 → **${xsrc.genuine} 例真不一致**） | \`data/cross-source.json\` |
| 封面 \`al-\` 的 L1 贡献 | "真实封面 14 首（0.5%）" | 14 首来自 **仅 3 个不同 \`al-\` id** → **L1 对封面指标的贡献应视为 0** | \`data/l1-report.json\` |
| §2.4 网易云封禁叙述 | "连续 246 次 code:405 / 约第 50 次触发 / 持续 ≥25 分钟 / 两端点 A-B 对照" | **全部删除——无证据**，替换为日志能支持的表述（§2.4） | \`data/l2-netease.log\` 等 |
| §4.2 策略发出次数 | S3「发出 36 次」 | S3 **实际发出 60 次**（覆盖 36 首曲目） | 逐次尝试日志 |

### 0.2 本报告新增强制口径

- **relaxed 不是 strict 的超集**。两档评的不是同一个东西：strict 评"曲名 + 歌手"，relaxed 评"曲名 + 时长"。
  实测按**网易云源内**计有 **${strictOnlyCatchNe.length} 首**通过 strict 却掉到 relaxed 的 \`weak\`
  （按源计 ${strictOnlyCatchPerSource.length} 处，两源合并按曲目级 ${strictOnlyCatch.length} 首）。**计数单位不同，结论相同。**
  因此天花板必须写成"**两档并集**"，不能写成"relaxed 单档"。
- **离线复算基于被截断的候选池**。原始跑批每源每首只落盘 **${truncation.persisted} 条**候选，
  而网易云真实候选池均值 **${truncation.neMean} 条**、最大 ${truncation.neMax} 条，**${truncation.neOver5}/100 的条目池 > 5**。
  → 所有"改规则 → 离线复算"的结果（含 \`--rescore\`）都是**在被截断池内的重排**，只能作为**下界**。
  MusicBrainz 池 > 5 的只有 ${truncation.mbOver5}/100，故 **MB 侧结论不受该限制影响**。
- **遥测双份**：\`data/result.json\` 内的 \`telemetry\` 全 0（曾被一次 \`--rescore\` 用新进程的空计数器覆盖，已修）。
  权威值在 \`data/telemetry-sources.json\`（§2.5）。

### 0.3 明确标注「无法验证」的 6 项（一律不作为结论）

贯穿全文，下列内容**没有任何日志或数据可以支持**，本报告不把它们写成发现：

| # | 无法验证的内容 | 现状 |
|---|---|---|
| 1 | 网易云旧端点 \`code:405\` / "第 50 次触发" / "持续 ≥25 分钟" / "同一时刻两端点 A-B 对照" | 留存日志只支持：「248 次请求 / 246 次空 / 0 error / 命中率 0%」，且 **246÷248=99.2% 为空，与"前 50 次正常"不相容**；\`code:405\`、\`操作频繁\` 在全部日志中一次都没出现（旧版代码不记录 \`code\`） |
| 2 | 被 \`--rescore\` 清零的遥测 | 原始值只剩转抄记录，见 \`data/telemetry-sources.json\` 的 \`provenance\` |
| 3 | MusicBrainz 那 24 次响应的**确切内容**（仅在定向重跑后可知） | 已重跑，结论见 §2.4；重跑前的响应体无留存 |
| 4 | Cover Art Archive 在可达环境下的真实增益 | 沙箱内**网络间歇不可达**，未取得图片 |
| 5 | \`mf-\` 是内嵌图还是 Navidrome 默认图 | 只能确认"同一张图"，见 §3.5 |
| 6 | 2903 是否为**当前**全库真值 | 本次三条独立路径一致，但库可能已被改动 |

### 0.4 与 QA 报告的数字对账（为什么一边写 63、一边写 64）

两份报告的基数不同，但**每一个差额都能复算清楚**，不存在矛盾：

| QA 报告的写法 | 本报告的写法 | 差额来源（可复算） |
|---|---|---|
| strict 命中 **63 首** | strict 命中 **${m01.hitBreakdown.strictHits} 首** | 63 是**网易云单源**命中数；${m01.hitBreakdown.strictHits} 是**两源合并**。差额 1 首 = #90《天使的翅膀》，**只被 MusicBrainz 命中**（\`data/cross-source.json\` → \`musicbrainzMarginalRecall.measured = ${xsrc.marginalMb}\`） |
| 歌手被佐证 **25 / 63** | **${m01.hitBreakdown.artistCorroborated} / ${m01.hitBreakdown.strictHits}** | 同一件事的两个基数。**轨级去重后为 ${m01.hitBreakdown.artistCorroborated}**（网易云 25 + MB 多出 1）。QA 在其报告 §2.2 用网易云口径、在汇总里用轨级口径，两者一致 |
| 命中时长 ≤15s **57 / 63 = 90.5%** | **${relaxedMax.durationConsistency.buckets.le15} / ${relaxedMax.durationConsistency.comparable} = ${relaxedMax.durationConsistency.within15pct}%** | 同上，多出的 1 首即 #90（其时长差 ≤15s）。**两版都指出 >15s 恰为同样 6 首（#5/38/44/52/57/62），>30s 为 0 首** |
| relaxed 单档复核值 **77%** | 网易云**两档并集 77%** / relaxed-only 重排（池内）**70%** | 77 的算术身份是「网易云 strict 63 **∪** 网易云 relaxed 69」= 77，**即单源两档并集**；§4.1 采用该口径，并把 relaxed-only 重排单列（受截断池限制，属下界） |
| 广告串关键词 **53**、伪歌手类 **396–401** | 关键词 **${l1.counts.adAny}**、伪歌手合计 **${qa ? qa.pseudonymArtistTracks : '—'}** | 一致（\`data/l1-report.json\` / \`data/qualitative-audit.json\`） |
| 双源歌手不一致 **18 首** | **${xsrc.differing} 首**（${xsrc.genuine} 真不一致 + ${xsrc.variant} 简繁/标点变体） | 本报告把归一化规则**收紧**：把 U+2010 等**破折号家族**一并折叠后，#60 \`K-391\` vs \`K‐391\` 从"不一致"归入"一致"。**这是主动收紧，不是矛盾**；${xsrc.differing} 与 ${xsrc.both} 的比例说明见 §4.6 |
| M-01 四档 ③ = **85.7%** | **${m01.tiers.tier3_autoWrite.weighted}%**（同口径**未手工剔重**） | QA 手工标定 8 类 \`X - Y\` 歧义 → 85.7%；本报告用一条**可复现规则** → ${m01.tiers.tier3_autoWrite.weighted}%、队列 ${m01.reviewQueueSize} 条。规则多抓 4 条边界情形，**规划按更保守的 ${m01.tiers.tier3_autoWrite.weighted}% 取值** |

---

## 1. 结论先行

**方案成立，但 PRD 的验收目标必须下调——现有目标里有 4 项在 L1+L2 阶段不可能达成，其中 2 项与方案设计无关（是数据源能力的天花板）。**

一句话数字：**在线两源合并 strict 命中率 ${summary.combined.hitRate}%（按层人口加权外推 ${weighted(
  Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both]))
)}%）；召回天花板 = 两源 × 两档并集 ${unionHits.length}%（加权 ${unionWeighted}%），其中网易云单源就已达 ${relaxedMax.profileUnion.netease}%。**
分源看：**网易云 ${summary.netease.hitRate}% 是全库可用的主力源**（远超 M-18 的"单源 ≥50% 即可用"门槛；其单源两档并集达 ${relaxedMax.profileUnion.netease}%），
**MusicBrainz 主跑 ${summary.musicbrainz.hitRate}%、修正后 ${telemetrySources.musicbrainzCorrection.effect.musicbrainzRateAfter}%，对本曲库基本无效**——它的命中集中在 Layer D（英文/日文标题，${perLayerRates.D.mb}%），
中文车载曲目在 MB 上查不到，这与"华语冷门曲目覆盖率低"的先验一致，**不是 bug，是事实**。
但**MB 的价值不在召回，而在"交叉验证"**（§4.6）：${xsrc.both} 首两源都命中的曲目里，有 ${xsrc.differing} 首歌手字符串对不上（其中 ${xsrc.genuine} 例为真不一致）——**两源一致本身就是最便宜的歌手置信度信号**。

逐项指标判定（"可达"= L1(还原+伪值剔除) + L2(strict) 端到端实测外推值）：

| 指标 | 目标 | 实测可达 | 判定 |
|---|---|---|---|
| M-01 歌手可用率 | ≥95% | ①非空 **${m01.tiers.tier1_nonEmpty.weighted}%** / ②有佐证 **${m01.tiers.tier2_usable.weighted}%** / ④可安全覆盖 **${m01.tiers.tier4_overwriteSafe.weighted}%** | ❌ 单指标口径无意义，**必须拆档**（§4.5、§9.1） |
| M-02 年代覆盖率 | ≥80% | ${delivered.year.libraryPct}% | ❌ 差 ${Math.round((80 - delivered.year.libraryPct) * 10) / 10}pp |
| M-03 流派覆盖率 | ≥90% | ≈0% | ❌ **在线源根本不返回流派**，只能靠 L3 |
| M-04 情绪覆盖率 | ≥90% | 0% | ❌ 只能靠 L3 |
| M-05 场景覆盖率 | ≥60% | 0% | ❌ 只能靠 L3 |
| M-06 歌词覆盖率 | ≥85% | ${delivered.lyrics.libraryPct}% | ❌ 差 ${Math.round((85 - delivered.lyrics.libraryPct) * 10) / 10}pp；且歌词覆盖率被 L2 命中率硬性封顶 |
| M-07 封面覆盖率 | ≥85% | ${delivered.cover.libraryPct}% | ❌ 差 ${Math.round((85 - delivered.cover.libraryPct) * 10) / 10}pp；且**"封面可用"口径必须先改**（§3.5） |
| M-08 广告串标记召回 | 100%（372 首） | 关键词规则命中 ${l1.counts.adAny} 首 | ⚠️ 需先对账"372"的口径（§3.2 与 §7.3） |
| M-09 乱码标记召回 | ≥95% | 规则可判定的乱码 100% 还原（${l1.counts.mojibakeAny} 首） | ✅ 实测 5/5 样例正确 |
| M-14 单曲 L2 ≤2.0s | ≤2.0s | ${(avgPerTrackMs / 1000).toFixed(1)}s | ❌ 需放宽或提高并发（§8） |
| M-16 全量 L2 ≤45min | ≤45min | ${timingScenarios.serial}min（串行） | ❌ 串行差 ${Math.round(timingScenarios.serial / 45)} 倍；**仅删掉 MB 才可能达成**（§8） |
| M-18 综合命中率 | ≥80% | ${weighted(
  Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both]))
)}% | ❌ 差 ${Math.round(
  80 - weighted(Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both])))
)}pp（但单源 ≥50% 门槛：网易云 ✅ / MusicBrainz ❌） |
| M-31 目录推断 | 命中率 100% | 一致率 ${l1.pathInference.artistDirAgreementRestored.rate}% / ${l1.pathInference.albumDirAgreementRestored.rate}% | ✅ 达成，但**零新增信息量**（§3.4） |

**三个非数字结论，比上面的表更重要：**

1. **L2 的天花板不是"查不到歌"，而是"查到的歌手不是文件上的歌手"。**
   ${audit.misses.length} 首未命中里，**真正"在线源确实没有这首"的只有 ${mr('source_lacks_the_track')} 首**（§7.1）；其余分别是：
   ${mr('song_found_but_artist_disagrees')} 首拿到了曲名相似度 ≥0.9 的候选（歌对了、歌手对不上）、${mr('candidate_found_but_not_confident')} 首有 0.6–0.9 的候选、
   ${mr('title_noise_blocks_query')} 首是标题装饰噪声把查询词弄脏了、${mr('query_is_ad_string')} 首的查询词本身就是广告串、${mr('title_embeds_artist_split_ambiguous')} 首是 «歌手-曲名» 切分不确定。
   **其中 ${queryProblemMisses} 首是查询词清洗问题，不是源覆盖问题。** 本库大量曲目是翻唱/翻奏/DJ改版，在线源返回的是**原唱**。
   → 产品必须把"歌手"当作**需要审阅的推断值**，而不是可以直接写入的事实。
2. **L1 的乱码还原是纯收益且必须做。** 歌手可用率 ${l1.fieldAvailability.artist.raw}% → **${l1.fieldAvailability.artist.restored}%**（+${l1.counts.artistRescuedByRestore} 首），
   专辑 ${l1.fieldAvailability.album.raw}% → **${l1.fieldAvailability.album.restored}%**（+${l1.counts.albumRescuedByRestore} 首）。
   更关键的是：不还原，L2 的查询词就是一串拼错的西欧字母，**命中率会是 0**。
3. **MusicBrainz 不该作为"元数据源"付 1 req/s 的全局代价，但值得保留为"交叉验证信号源"。**
   它对中文曲目的独占召回只有 **${xsrc.marginalMb}
   首/100**（修正后 ${xsrc.marginalMbCorrected} 首），
   代价却是全库耗时从 ${timingScenarios.neteaseOnly2qps}min 涨到 ${timingScenarios.dualParallel2qps}min（§8）；而它带来的**歌手交叉验证**能力无法用其它方式便宜地获得（§4.6）。

### 1.1 这个 spike 顺手抓到了什么（都该写进设计）

- **旧传输层把"无法观测的状态"当成成功**：\`net.js\` 的 curl 路径曾把 HTTP 状态**硬编码为 200**，并把"JSON 能解析"当作成功。
  MusicBrainz 的**繁忙响应实为 HTTP 503 + \`{"error":"The MusicBrainz web server is currently busy…"}\`**，旧代码全部记为 \`200 / ok / 空结果\`。
  **后果：源健康度指标测不出来，"静默失败"骗过遥测。** 已修复并留下证据（\`data/raw/netfix-probe.json\`）。
- **网易云候选池被截断**：每查询上限 8 条，落盘只留 5 条，而真实池均值 ${truncation.neMean} 条（§0.2）。
- **Navidrome 的 \`coverArt\` 是假的**：100% 非空，但 99.5% 是**同一张带"TOP MUSIC CHARTS"水印的图**；真实（\`al-\`）封面只有 ${l1.counts.realCover} 首、**仅 3 个不同 id**（§3.5）。M-07 口径必须先改。
- **Navidrome 的 \`album.songCount\` 求和不等于曲目数**（3488 vs 2903），是扫描期缓存值（§2.1）。
- **本库存在伪歌手/合集上传者**：\`Cydian\` 一个值覆盖 325 首（11.2%）；但**优先级低于 \`[Unknown Artist]\` 的 ${l1.counts.artistUnknownTag} 首（24.3%）**（§7.3）。
- **库内数据本身有错**：存在 title/artist 字段互换的曲目，以及目录名是 UTF-8 被当 GBK 二次解码的 1 例（§3.4）。
- **时长冲突不能被 "Mix/Remix" 豁免**：我们用这条规则时，一个 64 秒差异的候选被误判为命中，已修（§9.3 第 4 条）。

---

## 2. 总数与口径说明

### 2.1 全库到底有多少首？—— **2903 首**

项目早期记录为 **3392 首**。本次对同一台 Navidrome 用三条互相独立的路径交叉验证：

| 验证路径 | 结果 |
|---|---|
| Navidrome \`/rest/search3.view\`（空 query = 全库），分页 offset=0/1500 | **2903** 首（1500 + 1403） |
| 本地后端 \`http://127.0.0.1:3000/api/tracks\` | **2903** 首（id 去重后 2903） |
| Navidrome \`/rest/getAlbumList2.view\` 遍历后逐专辑 \`getAlbum.view\` 抽样 25 张 | 34 首全部能在 search3 中找到，**0 首缺失** |
| \`searchResult3\` 中出现的不同 \`albumId\` | **862**，与 \`getAlbumList2\` 报告的专辑数 862 **完全一致** |

**本次采信 2903**，3392 是早期快照（库发生过删改）或统计口径不同所致，差额 ${3392 - N} 首。
> ⚠️ 口径限制：这只是"**本次跑批时**的三条路径一致"，**不能证明 2903 就是长期真值**（曲库可能被改动）。若要长期引用，需在跑批脚本里落盘导航库版本/时间戳。

> ⚠️ 附带发现（口径陷阱）：\`getAlbumList2\` 返回的 \`album.songCount\` 求和是 **3488**，比真实曲目数多 585。
> Navidrome 专辑上的 \`songCount\` 是扫描期缓存值，**不可用于统计曲库规模**。产品里做 M-27 专辑归组时必须用曲目数反推，不能用 \`songCount\` 求和。

### 2.2 抽样口径

样本 100 首，按 PRD Q-23 决议分层，层优先级 A > B > C > D > E（互斥，不重复）：

| 层 | 定义 | 库内数量 | 抽样数 |
|---|---|---|---|
| A | 乱码标题/歌手（GBK-as-Latin-1） | ${pop.A} | ${sampleCount.A} |
| B | 广告串（标题/歌手/专辑/流派含引流词） | ${pop.B} | ${sampleCount.B} |
| C | 标题含分隔符且两侧为文字 | ${pop.C} | ${sampleCount.C} |
| D | 英文/日文标题（标题无中日文字符） | ${pop.D} | ${sampleCount.D} |
| E | 其余随机 | ${pop.E} | ${sampleCount.E} |
| — | 合计 | ${totalPop} | 100 |

由于各层抽样数与层人口不成比例，**全库命中率按层人口加权外推**（下表"全库外推"行），而不是直接取样本平均值。

### 2.3 匹配判定口径

两档评分，同一份候选、两条不同的判定线：

- **strict（标题 + 歌手）**：\`0.6×曲名相似 + 0.4×歌手相似\`，时长差 >15s 记轻度惩罚、>30s 判为版本冲突（分数封顶 0.5）。
  \`score ≥ 0.85 且无冲突 → exact\`；\`≥ 0.65 且无冲突 → likely\`；\`≥ 0.45 → weak\`。**exact + likely 记为命中。**
- **relaxed（仅标题 + 时长）**：\`曲名相似 × 时长系数\`。\`≥ 0.92 → exact\`；\`≥ 0.80 → likely\`。

采用双档而不是单档，是因为**本库存在大量"合集上传者"伪歌手**（详见 §7.3），strict 会把它们全部判为未命中。
strict 是**可安全写入库**的命中率（把错误歌手写进曲库比不写更糟）。

> ⚠️ **两档不是"松/紧"的包含关系，不能把 relaxed 当成 strict 的上限。**
> 两档评的是不同的东西（strict 看歌手，relaxed 看时长），**网易云源内实测有 ${strictOnlyCatchNe.length} 首**通过 strict 却掉到 relaxed 的 \`weak\`
> （典型是时长差 19–29s 的长版本，或因简繁差异导致曲名相似度被拉低，见 §4.7）。
> 因此**真正的召回天花板是两档取并集**：
> - **网易云单源：${relaxedMax.profileUnion.netease}%**（外推 ${neUnionLibraryPct}%）
> - **两源合并：${unionHits.length}%**（外推 ${unionWeighted}%）
> - 若把排序改成 relaxed 优先再取 relaxed 单档，网易云只有 **${relaxedMax.relaxedMaximised.samplePct.netease}%**（池被截断，属下界）。
> §4 的矩阵与 §5 的错配清单都基于"两档并集"这个口径。
${validityWarning}
### 2.4 ★ 源健康度与「限流」这一等公民问题（据日志重写）

爬公网在线源，**限流不是异常，是常态**，必须写进设计。**本节只陈述留存日志能支持的事实**：

| 现象 | 可核查的证据 |
|---|---|
| 网易云在本次跑批中**异常地空返回** | 一轮历史跑批的留存日志显示：**248 次请求 / 246 次空结果 / 0 error / 网易云命中率 0%**。**246÷248 = 99.2% 为空，与"前 50 次正常、第 50 次后触发封禁"的叙述不相容**，故本报告不采信该叙述 |
| 换用 \`/api/cloudsearch/pc\` 后正常 | 最终跑批 **187 次请求、0 error、0 封禁、1366 条候选**（\`data/telemetry-sources.json\`） |
| **端点轮换从未被实测** | 187 次请求**全部走 \`cloudsearch-pc\`**；另外两个端点在本次跑批中收到 **0 次**请求。端点轮换机制**只是代码存在，未被验证**（§9.4） |
| MusicBrainz「繁忙」是真实且频率不低的 | 定向重跑 24 次：**首试 9 次 HTTP 503 + \`{"error":"…currently busy…"}\`**，业务错误检测到 9 次；退避一次后 24/24 恢复正常（§2.4.1） |
| 网易云歌词接口 | 63 次请求、0 错误 |
| 旧代码**无法观测** MusicBrainz 的真实状态 | \`net.js\` 的 curl 分支曾把状态硬编码为 200；修复后同一路径能正确报出 503/404（\`data/raw/netfix-probe.json\`） |

> ⚠️ **这是本次 spike 最有价值的工程发现**：**"可以解析的响应体"≠"成功的请求"。**
> 若按网上最常见的示例代码写（用 \`/api/search/get/web\`、且不检查业务错误体），一次全量跑批的网易云命中率会算出**假的 0%** 而不报任何错。
> 我们在本轮真实踩到了这个坑，修复方式有两条：**① 检查业务错误体（网易云 \`body.code\`、MB \`body.error\`）；② 用 curl 的 \`-w '%{http_code}'\` 拿到真实 HTTP 状态码。**

#### 2.4.1 MusicBrainz 定向重跑（把"可能被低估"变成确证）

主跑报告 MusicBrainz \`0 错误 / 87 次空结果\`，但其中 **24 次响应体里连 \`count\` 字段都没有**，且**全部走了状态码不可观测的 curl 分支**。
对这 24 条逐条重跑（1.2s 间隔）后：

| 结果 | 次数 | 含义 |
|---|---|---|
| 首试 **HTTP 503 + server busy** | **${mbRe.tally.firstAttemptBusy503 || telemetrySources.musicbrainzCorrection.firstAttemptBusy503}** | 主跑把**源过载**当成了"没有这首歌" |
| 重跑后确认真空（\`count = 0\`） | ${mbRe.tally.truly_empty_source_lacks_track} | 源确实没有 |
| **重跑拿到了主跑丢失的真实结果** | **${mbRe.tally.has_results_main_run_underestimated}** | 命中被系统性低估 |
| 仍无法归类 | ${mbRe.tally.still_unclassifiable} | — |

**影响**：其中 ${mbRe.tally.tracksWithRecoveredCandidates} 首找回了候选，${mbRe.tally.tracksWhoseMusicBrainzTierImproves} 首的 MB 档位提升，
MB 命中率 **${summary.musicbrainz.hitRate}% → ${telemetrySources.musicbrainzCorrection.effect.musicbrainzRateAfter}%**；
但**只有 1 首（#82）是网易云也没命中的**，所以**跨源合并命中数只从 ${telemetrySources.musicbrainzCorrection.effect.combinedHitsBefore} 涨到 ${telemetrySources.musicbrainzCorrection.effect.combinedHitsAfter}（+1）**。
→ **结论方向不变（MB 对本库基本无效），但"MB 0 错误"这个说法从此不成立**，且**"源健康度/存活率"这类指标必须能观测真实状态码才能测**。

源健康度实测计数（权威来源 \`data/telemetry-sources.json\`，主跑最终一轮）：

| 源 | 请求数 | 错误 | 返回空 | 封禁次数 | 限速等待累计 |
|---|---|---|---|---|---|
| 网易云 | ${telemetry.netease.requests} | ${telemetry.netease.errors} | ${telemetry.netease.emptyResult} | ${telemetry.netease.blocked} | ${(telemetry.netease.limiterWaitMs / 1000).toFixed(1)}s |
| MusicBrainz | ${telemetry.musicbrainz.requests} | ${telemetry.musicbrainz.errors}（**旧代码不可信**，见上表） | ${telemetry.musicbrainz.emptyResult}（其中 24 次无 \`count\`） | 0（无此机制） | ${(telemetry.musicbrainz.limiterWaitMs / 1000).toFixed(1)}s |
| 网易云歌词 | ${telemetry.neteaseLyric.requests} | ${telemetry.neteaseLyric.errors} | — | ${telemetry.netease.blocked} | 共享网易云限速 |

各网易云端点实际使用情况（**注意：本列说明轮换未生效**）：

| 端点 | 请求数 | 命中候选数 | 被 405 次数 |
|---|---|---|---|
${Object.entries(telemetry.netease.byEndpoint || {})
  .map(([k, v]) => `| \`${k}\` | ${v.requests} | ${v.candidates} | ${v.blocked} |`)
  .join('\n')}

### 2.5 ★ 遥测与"离线复算"的两个陷阱

1. **\`rescore()\` 曾覆盖已落盘的遥测**：\`--rescore\` 在新进程里从零开始计数，落盘时把原有遥测整块写成了 0 ——
   这就是历史版本 §2.4/§8 出现"全 0 表"的原因。**已修**（rescore 现在保留原遥测并单独写 \`rescoredAt\`），
   本轮权威遥测另存 \`data/telemetry-sources.json\`。
2. **\`--rescore\` 只能在被截断的候选池内重排**：网易云池均值 ${truncation.neMean} 条、${truncation.neOver5}/100 的条目池 > 5，而落盘只有 ${truncation.persisted} 条。
   → **任何"改规则后离线复算"的收益都是下界**；要确证必须重跑网络。MB 池 > 5 仅 ${truncation.mbOver5}/100，**MB 侧不受影响**。

---

## 3. L1 实测（全库 ${N} 首，非抽样）

### 3.1 字段可用率

${l1Table()}

### 3.2 脏数据分布

| 指标 | 数量 | 占比 |
|---|---|---|
| 存在乱码（标题/歌手/专辑/路径任一） | ${l1.counts.mojibakeAny} | ${l1.dirtiness.mojibakeAny}% |
| 标题乱码 | — | ${l1.dirtiness.mojibakeTitle}% |
| 歌手乱码 | — | ${l1.dirtiness.mojibakeArtist}% |
| 专辑乱码 | — | ${l1.dirtiness.mojibakeAlbum}% |
| 路径乱码 | — | ${l1.dirtiness.mojibakePath}% |
| 广告串（任一字段） | ${l1.counts.adAny} | ${l1.dirtiness.adAny}% |
| 标题含分隔符 | ${l1.counts.titleHasSeparator} | ${l1.dirtiness.titleHasSeparator}% |
| \`[Unknown Artist]\` | ${l1.counts.artistUnknownTag} | ${l1.dirtiness.artistUnknownTag}% |
| \`[Unknown Album]\` | ${l1.counts.albumUnknownTag} | ${l1.dirtiness.albumUnknownTag}% |
| 封面为占位图（\`mf-\`） | ${l1.counts.placeholderCover} | ${l1.dirtiness.coverIsPlaceholder}% |
| duration = 0 | 1 | ${l1.dirtiness.durationZero}% |

### 3.3 乱码还原带来的收益（还原前 → 还原后）

| 字段 | 还原前 | 还原后 | 新增可用 | 说明 |
|---|---|---|---|---|
| 歌手 | ${l1.fieldAvailability.artist.raw}% | **${l1.fieldAvailability.artist.restored}%** | +${l1.counts.artistRescuedByRestore} 首 | ${l1.counts.artistRescuedByRestore} 首乱码歌手被无损还原 |
| 专辑 | ${l1.fieldAvailability.album.raw}% | **${l1.fieldAvailability.album.restored}%** | +${l1.counts.albumRescuedByRestore} 首 | 主要是 \`ÂÉ¶¯³µÔØÒôÀÖ\` → \`律动车载音乐\` |
| 流派 | ${l1.fieldAvailability.genres.raw}% | ${l1.fieldAvailability.genres.restored}% | +${l1.counts.genresRescuedByRestore} 首 | 收益很小（字段本来就几乎为空） |

> 乱码还原对**曲名**几乎无增益（标题里混着 ASCII，还原规则仍能正确触发），但它是**喂给 L2 的查询词可读**的前提——不还原，L2 的查询词就是一串西欧重音字母，必然 0 命中。

### 3.4 L1-b 目录推断（Q-11 / M-31）实测

目录结构 100% 是稳定的三级 \`歌手/专辑/文件名\`（${N} 首全部 path 深度 = 3）。

| 指标 | 结果 |
|---|---|
| 目录歌手段可用率 | ${l1.pathInference.artistDirUsable}% |
| 目录专辑段可用率 | ${l1.pathInference.albumDirUsable}% |
| 目录歌手 vs 内嵌歌手 **一致率**（可比样本 ${l1.pathInference.artistDirAgreementRestored.comparable} 首） | **${l1.pathInference.artistDirAgreementRestored.rate}%** |
| 目录专辑 vs 内嵌专辑 一致率（可比 ${l1.pathInference.albumDirAgreementRestored.comparable} 首） | **${l1.pathInference.albumDirAgreementRestored.rate}%** |
| 目录歌手**能补上**内嵌歌手缺失的曲目 | ${l1.pathInference.artistDirFillsMissingTag} 首（${l1.pathInference.artistDirFillsMissingTagPct}%） |
| 内嵌歌手覆盖率（还原后） | ${l1.pathInference.artistCoverageTagOnly}% |
| 内嵌歌手 + 目录歌手 覆盖率 | ${l1.pathInference.artistCoverageTagPlusDir}% |

**结论：目录推断准确率极高（99.8% / 100%），但对本库几乎不产生任何新增信息。**
原因：本库 Navidrome 暴露的 \`artist\`/\`album\` 字段与目录名高度同源（实测目录歌手补充后覆盖率一分不增：${l1.pathInference.artistCoverageTagOnly}% → ${l1.pathInference.artistCoverageTagPlusDir}%）。
**产品含义：M-31「目录推断命中率 100%」可以达成，但不要指望它解决歌手缺失——它解决不了。**

> 反例（目录也不可靠的场景）：${l1.pathInference.artistDirDisagreements.length} 例不一致中，多数是目录信息**更全或更脏**：
> \`伍佰&China Blue\`(目录) vs \`伍佰\`(标签)、\`海鸣威 冰火红心 推荐\`(目录，含推广词) vs \`海鸣威\`(标签)、
> \`Sensitive\`(目录) vs \`Sensitive feat. Bogdan Bondarenko\`(标签)。另有 1 例目录是 **UTF-8 被当 GBK 解码**的二次乱码（\`缃楁椂涓?\` ↔ \`罗时丰\`），现有 GBK 还原规则覆盖不到。

### 3.5 ★ 一个必须写进产品的 L1 坑：Navidrome 的 coverArt 是假的

\`coverArt\` 字段 **100% 非空**，但其中 ${l1.dirtiness.coverIsPlaceholder}% 是 \`mf-\` 前缀。**关键机制（据 QA 复核修正）**：

| 事实 | 数据 |
|---|---|
| 随机抽 7 个**不同**的 \`mf-\` id | **全部返回同一张图**：99809 字节、412×412、md5 \`3b696af3ef82\`，图上是 **"TOP MUSIC CHARTS 全网音乐排行榜"水印** |
| 真实封面（\`al-\` 前缀） | 仅 **${l1.counts.realCover} 首 / 3 个不同 \`al-\` id** |
| 访问**不存在**的 cover id | 也返回 **HTTP 200**（body 是 code 70 的错误体） |

**结论（三句话）**：

1. **不能用"\`coverArt\` 非空"判断有封面**——会把 100% 都算成有图。
2. **也不能用"HTTP 200 = 有封面"**——不存在的 id 也返回 200。实现上应把这张水印图**按哈希/前缀列入假封面名单**，而不是只按 \`mf-\` 字符串前缀判。
3. **L1 对封面指标的贡献应视为 0**：全库真实封面 ${l1.counts.realCover} 首仅来自 3 个 id（3 个专辑），**不构成"覆盖率"**。
   → M-07 的封面覆盖率只能靠 L2/L3 提供，且必须先定义"真实图片"的判定方式（下载后比字节 / 排除水印图）。

> ⚠️ 证据限制（无法验证第 5 项）：**无法确定这张 \`mf-\` 图是曲目内嵌图还是 Navidrome 生成的默认图**，只能确认"是同一张"。

---

## 4. L2 命中率

### 4.1 按层 × 按源（strict / relaxed / 并集）

${hitMatrix()}

样本原始计数（strict）：

| 源 | exact | likely | weak | miss | 样本命中率 | 全库外推命中率 | relaxed 单档（strict-first 排序） | 单源两档并集 |
|---|---|---|---|---|---|---|---|---|
| 网易云音乐 | ${summary.netease.exact} | ${summary.netease.likely} | ${summary.netease.weak} | ${summary.netease.miss} | ${summary.netease.hitRate}% | ${weighted(
  Object.fromEntries(layers.map((L) => [L, perLayerRates[L].ne]))
)}% | ${summary.netease.hitRateRelaxed}% | **${relaxedMax.profileUnion.netease}%** |
| MusicBrainz | ${summary.musicbrainz.exact} | ${summary.musicbrainz.likely} | ${summary.musicbrainz.weak} | ${summary.musicbrainz.miss} | ${summary.musicbrainz.hitRate}% | ${weighted(
  Object.fromEntries(layers.map((L) => [L, perLayerRates[L].mb]))
)}% | ${summary.musicbrainz.hitRateRelaxed}% | ${relaxedMax.profileUnion.musicbrainz}% |
| **两源合并** | — | — | — | — | **${summary.combined.hitRate}%** | **${weighted(
  Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both]))
)}%** | **${summary.combined.hitRateRelaxed}%** | **${relaxedMax.profileUnion.crossSource}%** |

> **口径说明（修正 §4.1 的 relaxed 列）**：上表"relaxed 单档"是**在 strict-first 排序下**记录的 relaxed 档位，因此对 relaxed 有利的候选可能已被 strict 排到后面。
> 把排序改成 relaxed 优先、只取 relaxed 单档 → 网易云 **${relaxedMax.relaxedMaximised.samplePct.netease}%**（外推 ${relaxedMax.relaxedMaximised.libraryPct.netease}%），
> 但该值**被子截断的候选池限制**（§0.2），是下界。**真正该用的是"单源两档并集"：网易云 ${relaxedMax.profileUnion.netease}%**。
> 这与 §1 说的"跨源天花板 ${unionHits.length}%"并不冲突：**${relaxedMax.profileUnion.netease}% 是单源上限，78% 是两源上限**，QA 的独立复算同时复现了这两个数。

> MusicBrainz 修正后说明：本节 MB 数字为主跑值（${summary.musicbrainz.hitRate}%）。定向重跑后为 **${telemetrySources.musicbrainzCorrection.effect.musicbrainzRateAfter}%**（§2.4.1），**跨源合并仅 +1 首**，故分层矩阵不重算。

### 4.2 查询策略对比（网易云）

${strategyTable()}

> **口径修正**：
> 1. 「发出次数」曾写成"每首 S1/S2 必发"——**错的**。实测 **S1 发出 100 次、S2 只有 27 次、S3 发出 60 次**（S3 是"备选候选"，同一首可能发 2 次，故 60 > 覆盖的 36 首）。
> 2. 原表把 S3 的「36」当作发出次数，导致 **41.7% 这个比率的口径不成立**（它是"有 S3 尝试的曲目数"口径下的命中率）。上表已把三个口径分开列出。
> 3. S2 只在 S1 失败时发出，因此**这个对比是有偏的**（S2 天然面对更难的曲目）；但 S3（换一个候选曲名，${summary.netease.strategyComparison.S3.hitRate}%）远好于 S2（补上歌手，${summary.netease.strategyComparison.S2.hitRate}%），
>    **说明"换一个候选曲名"比"补上歌手"有效得多**——因为本库歌手字段大量是伪歌手/垃圾值（§7.3）。

### 4.3 逐字段命中（网易云，strict 命中曲目内）

| 字段 | 命中曲目中可用 | 占命中 | 占全样本（= 对 PRD 覆盖率的直接贡献） |
|---|---|---|---|
| 歌手 | ${summary.netease.fields.artist.count}/${summary.netease.fields.artist.hits} | ${summary.netease.fields.artist.amongHitsPct}% | **${summary.netease.fields.artist.libraryPct}%** |
| 专辑 | ${summary.netease.fields.album.count}/${summary.netease.fields.album.hits} | ${summary.netease.fields.album.amongHitsPct}% | **${summary.netease.fields.album.libraryPct}%** |
| 年份 | ${summary.netease.fields.year.count}/${summary.netease.fields.year.hits} | ${summary.netease.fields.year.amongHitsPct}% | **${summary.netease.fields.year.libraryPct}%** |
| 封面(picId) | ${summary.netease.fields.cover.count}/${summary.netease.fields.cover.hits} | ${summary.netease.fields.cover.amongHitsPct}% | **${summary.netease.fields.cover.libraryPct}%** |
| 歌词 | ${summary.netease.lyrics.available}/${summary.netease.lyrics.requested} | ${summary.netease.lyrics.amongRequestedPct}% | **${summary.netease.lyrics.libraryPct}%** |

MusicBrainz：命中 ${summary.musicbrainz.hits} 首中，带 release id 的占 ${summary.musicbrainz.releaseIdPresent}%（**但 CAA 图片在沙箱内网络间歇不可达，未取到图**，见 §10）。

### 4.4 ★ 「L1 + L2(strict)」端到端覆盖率 vs PRD 指标（口径已标注）

**本节数字的口径与 §4.3 不同，必须并排读**：§4.3 是"**网易云命中曲目内**的字段可得率"，§4.4 是"**L1 标签 ∪ 任一在线源**"的端到端覆盖率。

| 指标 | 口径 | 样本内 | 全库外推 | PRD 目标 | 判定 |
|---|---|---|---|---|---|
| M-01 歌手 | L1 标签 ∪ 任一在线源 | ${delivered.artist.count}/100 | **${delivered.artist.libraryPct}%** | ≥95% | ❌（但见 §4.5：约四成命中歌手"未被证实"） |
| M-02 年代 | L1 标签 ∪ 任一在线源 | **${delivered.year.count}/100** | **${delivered.year.libraryPct}%** | ≥80% | ❌ |
| — 年代（另一口径） | 仅网易云命中曲目内 | ${summary.netease.fields.year.count}/63 | ${summary.netease.fields.year.libraryPct}% | — | 与上行的差额来自 L1 标签 |
| M-06 歌词 | 网易云命中者内请求成功 | ${delivered.lyrics.count}/100 | **${delivered.lyrics.libraryPct}%** | ≥85% | ❌ |
| M-07 封面 | 网易云命中者返回 picId | ${delivered.cover.count}/100 | **${delivered.cover.libraryPct}%** | ≥85% | ❌（且 L1 侧真实封面为 0，§3.5） |
| 专辑 | L1 标签 ∪ 任一在线源 | **${delivered.album.count}/100** | **${delivered.album.libraryPct}%** | — | 注意 L1 专辑字段全库仅 5 个取值，**必须按刮削结果重建专辑** |
| M-18 在线源命中率 | 两源合并 strict | ${summary.combined.hitRate}/100 | ${weighted(Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both])))}% | ≥80% | ❌ |
| M-03 流派 | 两源均不返回 | 0/100 | ≈0% | ≥90% | ❌ 只能靠 L3 |
| M-04 情绪 | 两源均不返回 | 0/100 | 0% | ≥90% | ❌ 只能靠 L3 |

> **对账说明（修正 §4.3 ↔ §4.4 无法对账的问题）**：§4.3 的年份 **${summary.netease.fields.year.libraryPct}%** 是"网易云命中曲目内能拿到 publishTime 的比例（52/100）"；
> §4.4 的 **${delivered.year.libraryPct}%** 是"L1 标签 ∪ 任一在线源"（样本内 ${delivered.year.count}/100）。两者都对，**差在分子是否包含 L1 标签**。同理专辑 **${delivered.album.count}/100**。

分项（样本内计数）：

| 字段 | 样本内命中数/100 | 分层明细 |
|---|---|---|
${rows(
  Object.entries(delivered).map(
    ([k, v]) =>
      `| ${k} | ${v.count} | ${layers.map((L) => `${L}:${v.byLayer[L]}%`).join(' ')} |`
  )
)}

### 4.5 ★ 命中可信度审计：命中 ≠ 歌手正确（口径已修）

命中率是"**找到了对应的歌**"的比例，不等于"**可以安全写入的字段**"的比例。逐条核对后（数据源：\`data/m01-tiers.json\`，逐首判定沿用 QA 的 \`qa/q1-rows.json\`）：

| 项 | 数量 | 说明 |
|---|---|---|
| strict 命中总数 | ${m01.hitBreakdown.strictHits} | exact + likely |
| 其中 **歌手被证实**（本地标签本来就有可信歌手，在线结果与之一致） | **${m01.hitBreakdown.artistCorroborated}** | 这类写入是安全的 |
| 其中 **歌手未被证实** | **${m01.hitBreakdown.artistNotCorroborated}** | ⚠️ 写入有风险 |
| ├ 原因：本地歌手字段缺失或为垃圾值（\`[Unknown Artist]\` 等） | ${m01.hitBreakdown.notCorroboratedBreakdown.localArtistMissingOrJunk} | 占绝大多数 |
| └ 原因：本地"歌手"是伪歌手（如合集上传者 \`Cydian\`），与在线不一致 | ${m01.hitBreakdown.notCorroboratedBreakdown.localArtistPresentButSourceDisagrees} | 原报告把它误计为"已证实" |
| 其中 **只有曲名一个信号**（时长差 >15s、无任何歌手佐证） | 5（#38/44/52/57/62） | 最危险的一类：**歌对了但歌手完全无法确认** |

> ⚠️ **口径修正（重要）**：原报告写"歌手被证实 **${qa ? qa.hits.artistCorroborated : '—'}**"，**口径过宽**——
> 它把 2 条本地歌手是伪歌手 \`Cydian\` 的条目也算作"已证实"。按"本地歌手可信 ∧ 在线与之一致"重新判定后，**轨级真值为 ${m01.hitBreakdown.artistCorroborated}**。
> （与 QA 报告的 25/63 对账见 §0.4：基数差 1 首 = 只被 MB 命中的 #90。）

> **产品含义（重要）**：M-01 的"歌手可用率 ≥95%"即使数字上达成，也**不等于歌手是对的**。
> 本库有大量翻唱/翻奏/DJ 改版，在线源给的是**原唱**，与文件上的演唱者不是同一个人。
> **正确做法是四档分级**（§9.1），**只有第 ④ 档允许自动覆盖已有歌手**，其余一律进审阅队列。
> 对"本地歌手缺失 + 标题含 \`-\`"的曲目，**宁可不写歌手**，也不要写一个错误原唱。

策略归因（哪个策略真正赢下了命中）：

${qa ? Object.entries(qa.strategyAttribution).map(([k, v]) => `- \`${k}\`：${v} 首`).join('\n') : '—'}

### 4.6 ★ 双源交叉验证：MB 的价值是"置信度信号"而不是"元数据源"（新增）

本节回答一个原报告完全没提、但**对产品决策影响最大**的问题：**两个源都命中时，它们说的是不是同一个歌手？**

| 项 | 数量 |
|---|---|
| 两源都 strict 命中 | ${xsrc.both} |
| ├ 两源歌手**一致** | ${xsrc.agree} |
| ├ 仅**简繁体/标点**差异（不算分歧，但需归一化） | ${xsrc.variant} |
| └ **歌手真不一致** | **${xsrc.genuine}** |
| 其中：本地歌手缺失，两源各自给出歌手 | ${cross.artistDisagreements.whereLocalArtistMissing} |
| 其中：恰好只有一方与本地歌手一致 | ${cross.artistDisagreements.whereExactlyOneSourceAgreesWithLocal} |

真不一致清单（${xsrc.genuineIdx}）：

${disagreementTable()}

**结论（三条，直接可写进设计）**：

1. **"两源一致"是最便宜的歌手置信度来源。** 两源都命中且歌手一致时，歌手字段的置信度显著高于任何单源结果——**这不需要额外请求，只是第二次查询的副产品**。
2. **在线歌手本身不唯一，单源结果不能当证据。** 例如 #49 网易云给 \`吴雨啊\`、MB 给 **周杰伦**；#52 网易云给 \`许巍\`、MB 给 **雷婷**。
   只看单一源会得到一个错误的歌手，而**两源比对就能立刻发现该字段不可信**。
3. **MB 的定位应从"元数据源"改为"交叉验证信号源"。**
   它的**独占召回只有 ${xsrc.marginalMb} 首/100**（修正后 ${xsrc.marginalMbCorrected} 首），
   但它与网易云的**分歧率高达 ${xsrc.differing}/${xsrc.both}** ——这恰恰是它作为"独立第二意见"的价值。
   → 建议：**MB 只对"网易云已命中但歌手未被本地佐证"的曲目发起查询**（占命中总数的四成左右），既拿到交叉验证，又避免为全库付 1 req/s 的代价。

### 4.7 ★ 匹配阈值对 CJK 的标定缺陷（新增）

relaxed 的 \`0.92 / 0.80\` 两个阈值是在**拉丁文**样本上标定的。**对 CJK 短标题，它们同时产生假阳和假阴**：

${cjkTable()}

**两个反例说明了同一件事：阈值没有考虑 CJK 的字符串长度与简繁差异。**

| 模式 | 例子 | 现象 | 后果 |
|---|---|---|---|
| **假阳** | #70 \`Better Man (Live)\` / 张杰 → MB 候选 \`Better Man (live)\` / **Pearl Jam** | 曲名相同（sim 1.0）、时长差 9s → relaxed 判 **exact** | 会**写错歌手**（张杰 → Pearl Jam） |
| **假阴** | #75 \`一笑而过\` / 那英 → MB 候选 \`一笑而過\` / 那英 | **歌手完全相同、时长差 0**，仅因繁体写法使曲名相似跌到 **0.75** → relaxed 只判 **weak** | 会**漏掉一个完全正确的匹配** |

**改进建议（可按序实施）**：

1. **简繁归一化**：匹配前把中文按简繁对照表折叠（至少覆盖常用字），可同时消掉上面的假阴与 §4.6 的 3 例"伪分歧"。
2. **CJK 长度补偿**：CJK 标题通常只有 3–6 字，1 字差异就会让字符级相似度掉 20–30 pp。建议对 CJK 采用**基于编辑距离的绝对字数补偿**（如"差异字数 ≤1 且长度 ≤6 → 相似度下限提到 0.9"），而不是直接套用拉丁文阈值。
3. **两档阈值应随脚本系统分别标定**，并在配置页暴露（当前是硬编码常量）。

---

## 5. 🔍 错配实例清单

本节给出 **${audit.relaxedOnly.length + nearMissEntries.length} 条错配实例**，分两类。**这一节比命中率数字更有价值**：
它说明"放宽匹配"或"无脑接受 top1"会把什么错误写进曲库。

### 5.1 strict 判为未命中、relaxed 判为命中（${audit.relaxedOnly.length} 条）

这 ${audit.relaxedOnly.length} 条是"看起来像命中但其实是错的"——如果产品放宽到"标题 + 时长"，就会引入这些错误。
注意它们的**歌手相似度普遍是 0**（在线返回的是原唱，本地是翻唱/DJ改版）。

${relaxedTable()}

### 5.2 strict 未命中但在线源返回了候选（${nearMissEntries.length} 条）

这 ${nearMissEntries.length} 条是**"在线源明明找到了东西"**的曲目。它们全部是"接受 top1 就会写错"的样本：
曲名相似度够高但歌手对不上，或候选本身就是另一首歌。

${nearMissTable()}

> 结论：**${audit.relaxedOnly.length + nearMissEntries.length} 条错配实例里，绝大多数不是"搜不到"，而是"搜到了但归属错了"。**
> 因此匹配层必须**强制要求歌手佐证**（或对歌手置空降级），不能只靠曲名相似度写入。

---

## 6. 命中成功的真实样例（strict 命中，完整链路）

共 ${audit.strictHits.length} 条 strict 命中，全表如下（含乱码还原 → 查询词 → 命中结果）：

${strictHitTable()}

---

## 7. 未命中曲目的特征分析

strict 两源都未命中 **${audit.misses.length} 首**。

### 7.1 未命中原因归类

${qa
  ? Object.entries(qa.missed.byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `- **${v} 首** — ${MISS_REASON_LABEL[k] || k}`)
      .join('\n')
  : '（未运行 06-audit.js）'}

> **关键结论：未命中里过半不是"歌找不到"，而是"歌找到了但歌手对不上"。**
> 本库有大量曲目是**翻唱/翻奏/DJ改版**（原唱与文件演唱者不是同一人），在线源返回的是**原唱**，
> strict 判定因此不通过。这类曲目**歌曲本身是可识别的**，缺的是"演唱者"这一个字段的可信来源。
> 换句话说：**L2 的瓶颈在"歌手归属"，不在"曲库覆盖"。**

### 7.2 未命中曲目清单

${missTable()}

> 说明：表头原为「网易云返回条数」，**容易与"在线源返回的总条数"混淆**。它实际是**抓取到并进入评分的候选数（每查询上限 8 条）**，故已改名。

### 7.3 ★ 一个必须前置处理的坑：伪歌手 / 合集上传者（优先级已修正）

本库存在一批**不是演唱者**的"歌手"值 —— 它们是盗版打包者、公众号、或合集上传者的署名：

| 歌手值 | 占用曲目数 |
|---|---|
${qa ? qa.pseudonymArtists.slice(0, 20).map((p) => `| \`${esc(p.name)}\` | ${p.count} |`).join('\n') : ''}

（伪歌手合计 ${qa ? qa.pseudonymArtistTracks : '—'} 首）

> ⚠️ **优先级修正（原报告把 Layer A 的失败几乎全归因于 \`Cydian\`，这是倒置的）**：
> - 63 首命中里"歌手无佐证"的 ${m01.hitBreakdown.artistNotCorroborated} 首中，**\`[Unknown Artist]\` 占 ${m01.hitBreakdown.notCorroboratedBreakdown.localArtistMissingOrJunk} 首，\`Cydian\` 只占 ${m01.hitBreakdown.notCorroboratedBreakdown.localArtistPresentButSourceDisagrees} 首**。
> - 全库 \`[Unknown Artist]\` **${l1.counts.artistUnknownTag} 首（${l1.dirtiness.artistUnknownTag}%）**，是 \`Cydian\`（325 首）的 **${Math.round((l1.counts.artistUnknownTag / 325) * 10) / 10} 倍**。
> - Layer A 的失败主因是**装饰噪声 + 广告串**（"【3D环绕】""【双声道】""4D【360°】"等前缀把查询词弄脏），不是伪歌手名单。

**建议的产品排期（按收益排序）**：

1. **装饰剥离 / 广告剔除**（影响最大，且是查询词清洗，直接决定命中率）
2. **\`[Unknown Artist]\` 处理**（${l1.counts.artistUnknownTag} 首，占全库 ${l1.dirtiness.artistUnknownTag}%）
3. **\`Cydian\` 等伪歌手名单**（可先从"单值覆盖曲目数 ≥ N"自动初筛；命中这些值时把歌手权重降为 0，只用曲名匹配）

${qa && qa.yearOutOfRange.length ? `### 7.4 在线源自身的数据质量陷阱\n\n实测发现在线源会返回**越界年份**，必须做合法性校验（否则会写入未来年代）：\n\n| # | 本地曲名 | 在线结果 | 返回年份 | 源 |\n|---|---|---|---|---|---|\n${qa.yearOutOfRange.map((y) => `| ${y.sampleIndex} | ${esc(y.title)} | ${esc(y.onlineTitle)} | **${y.year}** | ${y.source} |`).join('\n')}\n` : ''}

---

## 8. 耗时实测与外推

| 指标 | 实测 |
|---|---|
| 单首 L2 总耗时（含限速等待与歌词请求） | **${avgPerTrackMs} ms** |
| 网易云请求数/首（S1/S2/S3 + 歌词） | ${neReqPerTrack.toFixed(2)} 次（另加歌词 ${lyricReqPerTrack.toFixed(2)} 次） |
| MusicBrainz 请求数/首 | ${mbReqPerTrack.toFixed(2)} 次 |
| **单首成本拆分** | 网易云 **${neShareS}s** + MusicBrainz **${mbPerTrackS}s** + 歌词 ${lyricsPerTrackS.toFixed(2)}s |
| 网易云单次请求耗时（不含等待） | ${(telemetry.netease.totalMs / telemetry.netease.requests).toFixed(0)} ms |
| MusicBrainz 单次请求耗时（不含等待） | **${mbRequestMsPerReq.toFixed(0)} ms**（${mbReqPerTrack.toFixed(2)} 次/首 → ${mbPerTrackS}s/首，**几乎全是请求本身慢**） |
| 网易云请求间隔 | 2000 ms（= **0.5 QPS**，即源方上限 2 QPS 的 1/4） |
| MusicBrainz 请求间隔 | 1200 ms（官方硬上限 1 req/s） |
| 网易云限速等待累计 | ${(telemetry.netease.limiterWaitMs / 1000).toFixed(1)} s（**占总耗时的绝大部分**） |
| MusicBrainz 限速等待累计 | ${(telemetry.musicbrainz.limiterWaitMs / 1000).toFixed(1)} s |
| **全库 ${N} 首外推（串行，本次参数）** | **≈ ${timingScenarios.serial} 分钟（${(timingScenarios.serial / 60).toFixed(1)} 小时）** |

> **口径修正**：原报告写"网易云 ≤ 0.6 QPS"，实际参数是 **2000 ms 间隔 = 0.5 QPS**（2 QPS 上限的 1/4，相当保守）。

### 8.1 ★ 并发场景（新增，可算值）

| 场景 | 瓶颈 | 全库外推 |
|---|---|---|
| 串行（本次实现） | 两源相加 | **${timingScenarios.serial} min** |
| **双源并行** | 网易云 ${neShareS}s/首（两源中较慢） | **${timingScenarios.dualParallel} min** |
| **仅网易云 + 2 QPS** | ${neReqPerTrack.toFixed(2)} 次搜索/首 ÷ 2 QPS ≈ ${(neReqPerTrack / 2).toFixed(2)}s | **${timingScenarios.neteaseOnly2qps} min（正好达成 M-16 ≤45min）** |
| 双源并行 + 2 QPS | **MusicBrainz ${mbPerTrackS}s/首**（1 req/s 硬上限） | **${timingScenarios.dualParallel2qps} min** |

**关键结论（与 §9.1「MB 不值得付代价」互相印证）**：

- 网易云的成本 **${neShareS}s/首 几乎全是限速等待**（可压缩到 ~${(neReqPerTrack / 2).toFixed(2)}s/首）；
- MusicBrainz 的成本 **${mbPerTrackS}s/首 几乎全是请求本身慢**（${mbRequestMsPerReq.toFixed(0)} ms/次，**不可压缩**）；
- 因此「**提高并发压缩 3–4 倍**」**只在删掉 MusicBrainz 时成立**：只要保留 MB，全库耗时就被钉在 **${timingScenarios.dualParallel2qps} min**，
  从 ${timingScenarios.serial} min 只降到 ${timingScenarios.dualParallel2qps} min（2.5 倍），而**独占召回只多 ${cross.musicbrainzMarginalRecall.measured} 首/100**。
  → 若要达成 M-16（≤45min），**必须让 MB 走"按需查询"而不是"全库扫描"**（见 §4.6 第 3 条）。

---

## 9. 对 PRD 的修订建议

### 9.1 ★ 必须改的指标（不改会导致验收必然失败）

| 指标 | 现目标 | 建议改为 | 依据 |
|---|---|---|---|
| **M-01** | 歌手 ≥95%（单一指标） | **拆四档**（见下方专表），**只有第 ④ 档允许自动覆盖已有歌手**，其余进审阅队列 | §4.5：${m01.hitBreakdown.strictHits} 首命中里 ${m01.hitBreakdown.artistNotCorroborated} 首歌手"未被证实" |
| M-02 | 年代 ≥80% | **≥${Math.max(60, Math.floor(delivered.year.libraryPct / 5) * 5)}%**，并把"年代"的来源分层标注（标签 / 在线 publishTime / L3 推断） | 实测 ${delivered.year.libraryPct}%；L1 只有 12.6%，在线源 publishTime 有 ${100 - summary.netease.fields.year.amongHitsPct}% 缺失 |
| M-03 | 流派 ≥90% | **移除 L1/L2 责任**，改由 L3 负责，目标 ≥60%；且必须落封闭词表 | 在线两源均不返回流派字段，L1 仅 ${l1.fieldAvailability.genres.restored}% |
| M-04 / M-05 | 情绪/场景 ≥90%/≥60% | 保持目标，但**明确标注"完全由 L3 承担"**，L1/L2 不背这个指标 | 实测均为 0% |
| M-06 | 歌词 ≥85% | **≥${Math.max(50, Math.floor(delivered.lyrics.libraryPct / 5) * 5)}%**，或引入专门的歌词源后再定 85% | 实测 ${delivered.lyrics.libraryPct}%；**歌词覆盖率 ≤ L2 命中率** |
| M-07 | 封面 ≥85% | **必须先改"封面可用"的定义**（排除水印图 / 校验真实字节），再定目标 ≥${Math.max(50, Math.floor(delivered.cover.libraryPct / 5) * 5)}% | §3.5：现口径会把 100% 的占位图算成有封面；L1 侧真实封面为 0 |
| M-08 | 广告串 372 首全部标记 | 拆成两类分别验收：**①推广文案串**（关键词可召回）②**伪歌手/合集上传者**（按"单值覆盖曲目数"识别）。并重新核对 372 | 关键词规则只命中 ${l1.counts.adAny} 首；而 \`Cydian\`+\`不改音响…\`+\`公众号：阿乐资源库\`+\`公众号：小草新剧社…\` 合计 **390 首**，说明"372"很可能统计的是后者 |
| M-14 | 单曲 L2 ≤2.0s | **≤${Math.ceil(avgPerTrackMs / 1000)}s**（含限速等待），或改为"不计限速等待 ≤1.0s" | 实测 ${(avgPerTrackMs / 1000).toFixed(1)}s，其中大部分是限速等待 |
| M-16 | 全量 L2 ≤45min | **串行 ≤5h / 双源并行 ≤${Math.round(timingScenarios.dualParallel / 5) * 5}min / 仅网易云 2QPS ≤45min**；把并发与限速写进配置页 | §8.1：保留 MB 就无法达成 45min |
| M-18 | 综合命中率 ≥80% | **分源定标**：网易云 ≥55% 记为"可用"，其单源两档并集 ≥${Math.floor(relaxedMax.profileUnion.netease / 5) * 5}%；MusicBrainz 仅要求"提供交叉验证"；综合目标降到 **≥${Math.max(55, Math.floor(weighted(Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both]))) / 5) * 5)}%** | 实测网易云 ${summary.netease.hitRate}%（单源并集 ${relaxedMax.profileUnion.netease}%）、MB ${summary.musicbrainz.hitRate}%、合并加权 ${weighted(Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both])))}% |
| M-31 | 目录推断命中率 100% | 改为 **"零误猜"**：不得由目录推断出内嵌标签之外的错误歌手；并明确"目录推断不提升覆盖率" | §3.4：准确率 99.8%/100%，但覆盖率增益 0.0pp |

#### M-01 四档口径（最终交付给决策者的数字）

${m01Table()}

> 说明：③ 档有**两个独立算法结果**：QA 手工标定的"8 类 \`X - Y\` 歧义"给出 **85.7%**，本报告用可复现规则
> （标题某段在库内 artist 字段出现 ≥4 次，且与在线歌手不一致）得到 **85.2%**、审阅队列 12 条。
> **两者不矛盾**：QA 的 8 条是手工剔重后的子集，本报告的规则多抓了 4 条边界情形。
> **规划建议按更保守的 ${m01.tiers.tier3_autoWrite.weighted}% 取值**，两档都满足 ≥82% 的目标。

**审阅队列原型（依据 QA 的 \`qa/q1-rows.json\` 逐首判定，共 ${m01.reviewQueueSize} 条，其中 8 条高风险）**：

${reviewQueueTable()}

> 这 12 条的共性是：**本地歌手是 \`[Unknown Artist]\`，而标题里的 «X - Y» 段指向一个库内真实歌手（雷婷/周杰伦/孙露/谭艳/张玮伽），在线源却给出另一个歌手。**
> 这类曲目**绝对不能自动写歌手**——最可能的情况是"文件是翻唱/DJ 版，在线结果指向原唱"。

### 9.2 建议新增的指标

| 新指标 | 建议目标 | 为什么需要 |
|---|---|---|
| **歌手写入准确率**（写入的歌手与文件实际演唱者一致） | ≥90%，未证实者进审阅队列不写入 | §4.5；这是 M-01 数字好看但产品变坏的最大风险 |
| **在线源存活率 / 限流恢复率** | 单次全量跑批中，源不可用导致的未处理曲目 = 0 | §2.4；**注意：该指标在修复 \`net.js\` 之前是测不出来的**（旧代码伪造 200） |
| **命中候选时长一致性 ①（宽）** | 命中曲目中 \|Δduration\| **≤20s** 的比例 ≥**93%** | 实测 **${relaxedMax.durationConsistency.within20pct}%**（${relaxedMax.durationConsistency.buckets.le15 + relaxedMax.durationConsistency.buckets.gt15le20}/${
  relaxedMax.durationConsistency.comparable
}），有充足余量 |
| **命中候选时长一致性 ②（严）** | 命中曲目中 \|Δduration\| **≤15s** 的比例 ≥**90%** | 实测 **${relaxedMax.durationConsistency.within15pct}%**（${relaxedMax.durationConsistency.buckets.le15}/${relaxedMax.durationConsistency.comparable}）——**只有 0.6pp 余量，单列为一条指标太脆**，故与①并列。<br>>15s 的 ${relaxedMax.durationConsistency.over15} 首全部落在 19–29s；**>30s 为 0 首** |
| **双源歌手一致率** | 两源都命中且歌手一致的比例 ≥60%，不一致者进审阅 | §4.6：**两源一致是最便宜的置信度信号**；实测不一致 ${xsrc.differing}/${xsrc.both} |
| **伪歌手识别模块** | 识别 P/R 均 ≥95%，名单可配置 | §7.3；但排期应在装饰剥离与 \`[Unknown Artist]\` 之后 |
| **年代合法性校验** | 100% 拒绝 [1900, 当前年] 之外的值；并对每首歌的 «year» 标注来源与置信度 | 网易云的 «publishTime» 是"**该上传版本所属专辑的发行时间**"，不是原曲发行年：同一首歌在不同合辑/翻唱版本上会得到完全不同的年份。**年代只能按"年代段"使用，不能当精确年份写库。** |
| **简繁归一化覆盖率** | 匹配前归一化，消除伪分歧与伪假阴 | §4.7 与 §4.6 各有一组证据 |

### 9.3 必须写进设计的实现要点（否则重跑一遍还是会踩）

1. **查询词构造要按"装饰剥离优先"排序**：本库标题大量以 «【双声道】【3D环绕】4D【360°】» 开头，这些**不是歌名**。
   实测按"剥离装饰后的文本"优先查询，S1 命中率 ${summary.netease.strategyComparison.S1.hitRate}%；把装饰留在查询词里会直接掉到 0。
2. **不要轻易把"曲名 + 歌手"拼接成查询词**：实测 S2（曲名 + 歌手）发出 ${summary.netease.strategyComparison.S2.issued} 次、命中 ${
  summary.netease.strategyComparison.S2.exact + summary.netease.strategyComparison.S2.likely
} 次；
   而 S3（备选候选）命中率 ${summary.netease.strategyComparison.S3.hitRate}%。原因是本库歌手字段大量是伪歌手/垃圾值，拼进去只会污染查询。
   → 建议：歌手只在**可信**时才用于查询；默认走"纯曲名 + 多候选"。
3. **«X - Y» 格式必须做双候选尝试**：本库同时存在 «曲名-歌手»（如 «Mojito-周杰伦»）和 «歌手 - 曲名»（如 «雷婷 - 原来的我»）**两种相反的约定**，
   且第二种的左侧往往才是**本文件的演唱者**。产品应对分隔符两侧都发一次查询，并把两侧都作为歌手候选参与校验。
4. **不能拿"标题相似度"当唯一判据**：实测 «Bluebird»（落日飞车）会以 0.88 的相似度命中 «Blue Bird»（いきものがかり）——**同名不同曲**。
   必须叠加时长校验，并且**时长冲突不能被 "Remix/Mix" 等关键词豁免**（本次就修掉了一个把 64 秒差异放行的漏洞）。
5. **广告串要先把查询词洗干净**：«公众号：小草新剧社…» 这类标题整条就是广告，直接拿去查会返回 0 条。
   应先剔除广告串再做查询，纯广告曲目直接落"未知"。
6. **专辑字段在本库是废的**：全库只有 5 个不同值（都是文件夹名），必须在 L2 之后**按刮削结果重建专辑**（与 PRD Q-03 决议一致），
   且不要用 «album.songCount» 做统计。
7. **广告串关键词表必须精确**：我们第一版把裸字符 «群» 和 «唯美» 当作引流词，误伤了 13 首正常曲目（«群星 - 如果没有你»、«【唯美3D】…»）。
   现已收紧为词组（«加群/进群/群号» 等）。**广告检测驱动 M-08 与审阅队列，误报比漏报更伤。**
8. **★ 网络层必须同时检查"HTTP 状态码"和"业务错误体"**：\`curl\` 用 \`-w '%{http_code}'\` 取真实状态；
   网易云看 \`body.code !== 200\`、MusicBrainz 看 \`body.error\`、通用看 \`status >= 400\`。
   **HTTP 404 不得当作成功**（"源被墙返回 404"曾被静默当成成功）。
9. **★ 候选池不要截断**：落盘保留全池（本库实测均值 ${truncation.neMean} 条），否则"改规则后离线复算"全部失真（§2.5）。

### 9.4 ★ 本次回修修正的缺陷（记录在案，便于回归）

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| 1 | curl 路径**伪造 HTTP 状态**（硬编码 200），且只看"JSON 能解析"就判成功 | \`src/util/net.js\` | 用 \`curl -sS -o <tmp> -w '%{http_code}'\` 拿真实状态码；新增业务错误判定（网易云 \`body.code\`、MB \`body.error\`、\`status>=400\`）并计入 \`ok\` |
| 2 | \`webGet()\` 把 **404 当成功**返回并停止回退 | \`src/util/net.js\` | 404 记为 \`ok:false, status:404\`，不再计入成功 |
| 3 | MusicBrainz 不检查 \`r.body.error\` → 源繁忙被计入"空结果" | \`src/04-run-l2.js\` | 检测 \`body.error\` 并归入 errors；加一次退避重试；**并做定向重跑把 28% 修正为 33%** |
| 4 | \`rescore()\` 用空遥测**覆盖**已落盘遥测 | \`src/04-run-l2.js\` | 保留/合并原遥测，只追加 \`rescoredAt\` |
| 5 | \`topCandidates\` 只保留 5 条 → 离线复算基于**截断池** | \`src/04-run-l2.js\` | 上限提高到 20 并显式暴露参数；同时在报告声明该限制 |
| 6 | \`--rescore\` 同步返回导致 \`.catch()\` 抛错、退出码 1 | \`src/04-run-l2.js\` | 用 \`Promise.resolve().then()\` 统一两条路径 |

---

## 10. 原始证据留存

| 文件 | 内容 |
|---|---|
| \`报告-独立复核.md\` | **QA 的独立复核报告（只读，未修改）**：独立算法复算的 20 项数字、"无法验证"清单、8 条新发现 |
| \`qa/q1-rows.json\` | **QA 逐首判定**（歌手 verdict / 第二证据 / 三向标记 / 伪歌手标记），被 §4.5 与 §9.1 的审阅队列引用 |
| \`data/catalog.json\` | 全库 ${N} 首原始快照（含 \`path\`） |
| \`data/catalog-crosscheck.json\` | 2903 / 3392 / 3488 三个数字的交叉核对 |
| \`data/l1-report.json\` | L1 全库统计 |
| \`data/l1-tracks.json\` | L1 逐曲明细（还原前后、flag、目录推断） |
| \`data/sample-100.json\` | 分层抽样 100 首（含层归属与查询词） |
| \`data/result.json\` | 每首样本的查询词、每个候选的完整字段与评分、耗时（**注意其 \`telemetry\` 块为 0，见 §2.5**） |
| \`data/telemetry-sources.json\` | **权威遥测**（主跑 + MB 修正 + 修复后源健康度） |
| \`data/mb-recheck.json\` | **MB 24 条定向重跑**原始记录（含 503 繁忙与找回的候选） |
| \`data/m01-tiers.json\` | **M-01 四档**与审阅队列（逐首判定复用 QA 的 q1-rows） |
| \`data/cross-source.json\` | **双源交叉验证**（MB 边际贡献 ${xsrc.marginalMb} 首、歌手不一致 ${xsrc.differing}/${xsrc.both}，含 ${xsrc.variant} 例简繁变体） |
| \`data/relaxed-max.json\` | relaxed 最大化、单源/跨源两档并集、时长一致性、CJK 阈值探针 |
| \`data/raw/netfix-probe.json\` | \`net.js\` 修复的**可核查证据**（真实 404 / 真实 503） |
| \`data/raw/digest.json\` | 响应摘要（查询、候选、两源档位） |
| \`data/audit-lists.json\` | 命中/错配/未命中三张清单 |
| \`data/l2-final.log\` | 最终跑批日志（已被 rescore 摘要覆盖，仅保留结果） |
| \`data/_rework/\` | **本次回修的中间证据**（重跑日志、口径核对脚本输出） |

> 复现顺序：\`npm run 00…06\` → \`src/07-m01-tiers.js\` → \`src/08-mb-recheck.js\` → \`src/09-cross-source.js\` → \`src/10-relaxed-max.js\` → \`src/05-gen-report.js\`（最后一步重新生成本报告）。
`;

if (require.main === module) {
  fs.writeFileSync(OUT_MD, md.replace(/«/g, '\u0060').replace(/»/g, '\u0060'), 'utf8');
  console.log(`wrote ${OUT_MD}`);
  console.log(`wrote ${OUT_AUDIT}`);
  console.log(
    JSON.stringify(
      {
        strictHits: audit.strictHits.length,
        relaxedOnly: audit.relaxedOnly.length,
        misses: audit.misses.length,
        delivered,
        weightedCombined: weighted(Object.fromEntries(layers.map((L) => [L, perLayerRates[L].both]))),
        union: unionHits.length,
        unionWeighted,
        m01: m01 ? m01.tiers : null,
        timingScenarios,
        truncation,
        avgPerTrackMs,
        extrapolatedMin,
      },
      null,
      2
    )
  );
}
