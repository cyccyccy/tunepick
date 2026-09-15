'use strict';
/**
 * L2：在线刮削编排
 *
 * 流程：构造查询词 → 逐源查询（限速）→ 候选打分 → 跨源一致性校验 → 取歌词/封面
 *
 * 实测基线（原型）：网易云 strict 63%（唯一主力源）、MusicBrainz 28%（中文曲库基本无效，作交叉验证）
 */

const T = require('../util/text');
const match = require('./match');
const merge = require('./merge');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('scrape:l2');

const REGISTRY = {
  netease: () => require('./sources/netease'),
  musicbrainz: () => require('./sources/musicbrainz'),
  caa: () => require('./sources/caa'),
};

function enabledSources(list) {
  const names = (list || config.ONLINE_SOURCES || []).filter((n) => n !== 'caa'); // caa 由 MB 结果驱动，不单独搜索
  return names.map((n) => (REGISTRY[n] ? { name: n, mod: REGISTRY[n]() } : null)).filter(Boolean);
}

/**
 * 单曲 L2 刮削
 * @param {object} track 已完成 L1 的曲目
 * @param {object} opts  { sources, wantLyrics, wantCover }
 * @returns {Promise<object>} { fields:[], lyrics, coverUrl, coverSize, meta }
 */
async function scrape(track, opts = {}) {
  const out = {
    fields: [],
    lyrics: '',
    lyricsSource: '',
    cover: null,
    meta: { queries: [], perSource: {}, tier: 'miss' },
  };

  // 已有本地歌词时不重复在线获取（决策 #12：本地 .lrc > 内嵌 > 在线）
  const needLyrics = opts.wantLyrics !== false && !track.lyrics;
  const needCover = opts.wantCover !== false && !track.coverId;

  const local = match.localView({ ...track, duration: track.durationSec });
  // ⚠️ buildQueries 返回的是 {strategy, q} 对象数组，必须取出字符串。
  //    直接把对象传给搜索会变成查询 "[object Object]"，源会返回默认热门列表而非匹配结果。
  const queries = T.buildQueries(track)
    .slice(0, 3)
    .map((x) => (typeof x === 'string' ? x : (x && (x.q || x.value)) || ''))
    .filter(Boolean);
  out.meta.queries = queries;

  const perSource = {};
  const allCandidates = [];

  for (const src of enabledSources(opts.sources)) {
    const collected = [];
    let bestForSource = null;

    for (const q of queries) {
      let raw = [];
      try {
        raw = await src.mod.search(q, 8);
      } catch (e) {
        log.debug('源查询失败', { source: src.name, q, error: e.message });
        continue;
      }
      if (!raw.length) continue;

      const cands = raw.map((r) => {
        // _src 保留源归一化行（含 picUrl 等 match 层不传递的字段）
        if (src.name === 'netease') { const c = match.fromNetease(r._raw || r, q); c._src = r; return c; }
        if (src.name === 'musicbrainz') { const c = match.fromMusicBrainz(r._raw || r, q); c._src = r; return c; }
        return null;
      }).filter(Boolean);

      collected.push(...cands);
      const picked = match.pickBest(local, cands);
      if (picked.best && ['exact', 'likely'].includes(picked.bestScore.strict.tier)) {
        bestForSource = picked;
        break;                      // 已拿到可靠结果，不再试后续查询词
      }
      if (!bestForSource && picked.best) bestForSource = picked;
    }

    if (!bestForSource || !bestForSource.best) {
      perSource[src.name] = { hit: false, tier: 'miss' };
      continue;
    }

    const score = bestForSource.bestScore;
    const tier = score.strict.tier;
    perSource[src.name] = {
      hit: ['exact', 'likely'].includes(tier),
      tier,
      score: score.strict.score,
      title: bestForSource.best.title,
      artist: bestForSource.best.artistText || (bestForSource.best.artists || [])[0] || '',
      album: bestForSource.best.album || '',
      year: bestForSource.best.year || 0,
      _raw: bestForSource.best,
      _src: bestForSource.best._src || null,
    };
    allCandidates.push({ source: src.name, result: perSource[src.name] });

    if (tier === 'miss') continue;

    const confidence = clampConfidence(score.strict.score);
    push(out.fields, track, 'cleanTitle', bestForSource.best.title, `online:${src.name}`, confidence);
    const artistVal = bestForSource.best.artistText || (bestForSource.best.artists || [])[0] || '';
    if (artistVal) push(out.fields, track, 'cleanArtist', artistVal, `online:${src.name}`, confidence);
    if (bestForSource.best.album) push(out.fields, track, 'album', bestForSource.best.album, `online:${src.name}`, confidence);
    if (bestForSource.best.year) push(out.fields, track, 'year', bestForSource.best.year, `online:${src.name}`, confidence - 0.1);

    out.meta.tier = bestTier(out.meta.tier, tier);
  }

  // ---------- 跨源一致性（最便宜的歌手正确率信号）----------
  const artistVals = allCandidates.map((c) => c.result.artist).filter(Boolean);
  if (artistVals.length >= 2) {
    const chk = merge.crossSourceCheck(track, 'cleanArtist', artistVals);
    out.meta.artistCross = chk;
  }

  // ---------- 歌词与封面（网易云为主）----------
  const ne = allCandidates.find((c) => c.source === 'netease');
  if (ne) {
    // _src 是 netease.js 归一化行（含 picUrl）；match 候选对象只有 picId
    const raw = ne.result._src || ne.result._raw;
    if (needLyrics && raw && raw.id) {
      try {
        const lrc = await require('./sources/netease').lyric(raw.id);
        if (lrc && lrc.trim().length > 10) {
          out.lyrics = require('./l1').sanitizeLyrics(lrc);
          out.lyricsSource = 'online:netease';
        }
      } catch (_) { /* 歌词失败不影响主体 */ }
    }
    if (needCover && raw && raw.picUrl) {
      out.cover = { url: raw.picUrl, source: 'online:netease' };
    }
  }

  // ---------- CAA 兜底封面（由 MusicBrainz release id 驱动）----------
  if (!out.cover && config.ONLINE_SOURCES.includes('caa')) {
    const mb = allCandidates.find((c) => c.source === 'musicbrainz');
    const relId = mb && mb.result._raw && mb.result._raw.mbReleaseId;
    if (relId) {
      try {
        const pic = await require('./sources/caa').lookup(relId);
        if (pic && pic.url) out.cover = { url: pic.thumb500 || pic.url, source: 'online:caa' };
      } catch (_) { /* ignore */ }
    }
  }

  out.meta.perSource = perSource;
  return out;
}

function push(arr, track, field, value, source, confidence) {
  if (merge.rejects(field, value)) return;
  arr.push({ field, value, source, confidence: clampConfidence(confidence) });
}

function clampConfidence(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, +n.toFixed(3)));
}

const TIER_ORDER = { miss: 0, weak: 1, likely: 2, exact: 3 };
function bestTier(a, b) {
  return (TIER_ORDER[b] || 0) > (TIER_ORDER[a] || 0) ? b : a;
}

/** 各源统计（供 /api/sources） */
function sourceStats() {
  const out = {};
  for (const name of Object.keys(REGISTRY)) {
    if (!config.ONLINE_SOURCES.includes(name)) continue;
    try {
      const mod = REGISTRY[name]();
      out[name] = { enabled: true, ...mod.getStats() };
    } catch (_) { out[name] = { enabled: true }; }
  }
  return out;
}

module.exports = { scrape, sourceStats, enabledSources, REGISTRY };
