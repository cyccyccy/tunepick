'use strict';

/**
 * Text normalisation, advertisement-string detection, title splitting and
 * similarity scoring. Pure functions, no I/O.
 */

const { fixGarbled, hasCJK, countCJK } = require('./encoding');

/**
 * Promo / traffic-farming markers seen in this library.
 *
 * Deliberately PRECISE: an earlier version also matched the bare characters
 * `群` and `唯美`, which false-positived 13 legitimate tracks
 * (`群星 - 如果没有你`, `【唯美3D】…`, `【唯美-Make You Feel My Love..】`).
 * Ad detection drives the review queue and the M-08 metric, so a false
 * positive is worse than a miss — broad markers are expressed as phrases.
 */
const AD_KEYWORDS = [
  '公众号',
  '微信公众号',
  '微信',
  '威信',
  'VX',
  'vx',
  'V信',
  '加群',
  '进群',
  '入群',
  '粉丝群',
  '群号',
  '抖音',
  '快手',
  '关注',
  '扫码',
  '扫一扫',
  '添加好友',
  '免费下载',
  '音乐网',
  '车载专用',
  'www.',
  'http',
  '严禁商用',
  '仅供试听',
  '上传',
  '推广',
  '收藏',
  '资源库',
];

/** Separator characters used to glue "曲名-歌手" or "曲名 - 歌手" together. */
const SEPARATORS = [' - ', ' – ', ' — ', '－', '-', '–', '—', '_', '|', '／', '/', '·'];

/** Decorative wrappers that never belong to the real title. */
const DECOR_RE = /[【】\[\]（）()《》<>「」『』〔〕]/g;

/**
 * Normalises a string for comparison:
 * lowercases, folds fullwidth ASCII to halfwidth, drops decoration and
 * collapses every non-alphanumeric/非-CJK run into a single space.
 *
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
  if (!str || typeof str !== 'string') return '';
  let s = fixGarbled(str).normalize('NFKC').toLowerCase();
  s = s.replace(DECOR_RE, ' ');
  s = s.replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, ' ');
  return s.trim().replace(/\s+/g, ' ');
}

/** Drops all whitespace/punctuation — the most aggressive comparison form. */
function squeeze(str) {
  return normalize(str).replace(/\s+/g, '');
}

/**
 * True when the text carries a promo / traffic-farming string.
 * Checked on the mojibake-restored form.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isAdText(str) {
  if (!str || typeof str !== 'string') return false;
  const s = fixGarbled(str);
  return AD_KEYWORDS.some((kw) => s.includes(kw));
}

/**
 * True when the title contains a separator with text on both sides
 * (e.g. `Mojito-周杰伦`). Used for sampling layer C.
 *
 * @param {string} title
 * @returns {boolean}
 */
function hasTitleSeparator(title) {
  if (!title || typeof title !== 'string') return false;
  const s = fixGarbled(title);
  for (const sep of SEPARATORS) {
    const idx = s.indexOf(sep);
    if (idx <= 0) continue;
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + sep.length).trim();
    if (left.length > 0 && right.length > 0) return true;
  }
  return false;
}

/** Removes a leading track-number prefix such as `06 - ` or `35. `. */
function stripTrackPrefix(str) {
  return String(str || '').replace(/^\s*\d{1,3}\s*[.\-_、]\s*/, '').trim();
}

/** Removes decorative brackets but keeps their content (`中【3D环绕】X` -> `中 3D环绕 X`). */
function stripDecorations(str) {
  return String(str || '')
    .replace(/[【】\[\]（）()《》<>「」『』〔〕]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drops LEADING bracketed groups entirely: `【双声道】Love Yourself` -> `Love Yourself`. */
function stripLeadingDecorations(str) {
  let s = String(str || '').trim();
  for (let i = 0; i < 6; i += 1) {
    const next = s.replace(/^[【\[（(《<「『〔][^】\]）)《>」』〕]*[】\]）)》>」』〕]\s*/, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Drops TRAILING bracketed groups: `吉祥飞舞 (DJ阿圣Remix 2018)` -> `吉祥飞舞`. */
function stripTrailingDecorations(str) {
  let s = String(str || '').trim();
  for (let i = 0; i < 6; i += 1) {
    const next = s.replace(/\s*[【\[（(《<「『〔][^】\]）)《>」』〕]*[】\]）)》>」』〕]\s*$/, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Splits a raw title into ordered title / artist candidates.
 *
 * Handles the two conventions present in this library:
 *   - `Mojito-周杰伦`      -> title `Mojito`,    artist candidate `周杰伦`
 *   - `06 - 偏爱`          -> title `偏爱`        (numeric left side ignored)
 * When a known artist is supplied, the side that matches it is treated as the
 * artist and the other side as the title (highest confidence).
 *
 * @param {string} rawTitle
 * @param {string} [knownArtist]
 * @returns {{titleCandidates: string[], artistCandidates: string[]}}
 */
function splitTitle(rawTitle, knownArtist) {
  const raw = stripDecorations(fixGarbled(rawTitle || '')).trim();
  const titleCandidates = [];
  const artistCandidates = [];
  const pushUnique = (arr, v) => {
    const t = String(v || '').trim();
    if (t && !arr.includes(t)) arr.push(t);
  };

  let best = null;
  for (const sep of SEPARATORS) {
    const idx = raw.indexOf(sep);
    if (idx <= 0) continue;
    const left = raw.slice(0, idx).trim();
    const right = raw.slice(idx + sep.length).trim();
    if (!left || !right) continue;
    // Prefer the longest separator (e.g. ` - ` over `-`) for a cleaner split.
    if (!best || sep.length > best.sep.length) best = { sep, left, right };
  }

  if (!best) {
    pushUnique(titleCandidates, raw);
    return { titleCandidates, artistCandidates };
  }

  const { left, right } = best;
  const leftStripped = stripTrackPrefix(left);
  const leftIsTrackNumber = /^[.\-_\s]*\d{1,3}[.\-_]?$/.test(left) || /^\d{1,3}[.\-_]/.test(left);
  const known = squeeze(knownArtist || '');

  if (leftIsTrackNumber) {
    // `10.原子霏 - 吉祥飞舞` is artist-then-title; `06 - 偏爱` is strip-and-keep.
    pushUnique(titleCandidates, right);
  } else if (known && squeeze(leftStripped) === known) {
    pushUnique(artistCandidates, leftStripped);
    pushUnique(titleCandidates, right);
  } else if (known && squeeze(right) === known) {
    pushUnique(artistCandidates, right);
    pushUnique(titleCandidates, leftStripped);
  } else {
    // Default convention in this library: `曲名-歌手`.
    pushUnique(titleCandidates, leftStripped);
    pushUnique(artistCandidates, right);
    // Second guess kept for multi-strategy querying.
    pushUnique(titleCandidates, right);
  }
  pushUnique(titleCandidates, raw);
  return { titleCandidates, artistCandidates };
}

/**
 * Builds the L2 query strings for one track, ordered by expected precision.
 *
 * Ordering rule discovered during the spike: in this library the title very
 * often starts with a bracketed *technical* tag (`【双声道】`, `【3D环绕】`,
 * `4D【360°】`) which is NOT part of the song name. So the decoration-stripped
 * form is tried FIRST, and the raw form later.
 *
 *   S1 = best cleaned title
 *   S2 = best cleaned title + artist
 *   S3 = remaining candidates (alternate split side, bracket variants)
 *
 * @param {{title:string, artist:string}} track
 * @returns {{strategy: string, q: string}[]}
 */
function buildQueries(track) {
  const artist = fixGarbled(track.artist || '').trim();
  const artistUsable = artist && !isAdText(artist) && !isUnknown(artist);
  const knownArtist = artistUsable ? artist : '';
  const rawTitle = fixGarbled(track.title || '');

  const candidates = [];
  const push = (value) => {
    const t = String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—_|/·、.]+/, '')
      .replace(/[\s\-–—_|/·]+$/, '')
      .trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };

  const addVariants = (title) => {
    if (!title) return;
    const { titleCandidates } = splitTitle(title, knownArtist);
    for (const c of titleCandidates) {
      const base = stripTrackPrefix(c);
      push(base);
      push(stripLeadingDecorations(base));
      push(stripTrailingDecorations(stripLeadingDecorations(base)));
    }
  };

  const leadStripped = stripLeadingDecorations(rawTitle);
  if (leadStripped && leadStripped !== rawTitle) addVariants(leadStripped);
  addVariants(rawTitle);

  const out = [];
  const seen = new Set();
  const add = (strategy, q) => {
    const t = String(q || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const key = strategy + '\u0000' + t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ strategy, q: t });
  };

  const primary = candidates[0] || '';
  add('S1', primary);
  if (artistUsable) add('S2', `${primary} ${artist}`);
  for (const c of candidates.slice(1)) add('S3', c);
  if (artistUsable) for (const c of candidates.slice(1)) add('S3', `${c} ${artist}`);
  return out;
}

/** Sentinel values that must never count as "field present". */
const UNKNOWN_TOKENS = [
  '[unknown artist]',
  '[unknown album]',
  'unknown artist',
  'unknown album',
  '未知艺术家',
  '未知专辑',
  '未知',
  'various artists',
  '<unknown>',
];

/**
 * @param {string} str
 * @returns {boolean} true when the value is empty or a placeholder.
 */
function isUnknown(str) {
  if (!str || typeof str !== 'string') return true;
  const s = str.trim().toLowerCase();
  if (!s) return true;
  return UNKNOWN_TOKENS.includes(s);
}

/**
 * Levenshtein edit distance, early-exit bounded (strings here are short).
 * @returns {number}
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

/**
 * Similarity in [0,1] combining edit-distance ratio with containment bonus.
 * Containment matters here because online titles add suffixes such as
 * `(Live)` / `（翻唱）` that must not destroy an otherwise exact match.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
  const x = squeeze(a);
  const y = squeeze(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dist = levenshtein(x, y);
  const ratio = 1 - dist / Math.max(x.length, y.length);
  let score = ratio;
  if (x.length >= 2 && y.length >= 2) {
    if (x.includes(y) || y.includes(x)) {
      const shorter = Math.min(x.length, y.length);
      const longer = Math.max(x.length, y.length);
      score = Math.max(score, 0.75 + 0.25 * (shorter / longer));
    }
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Similarity between two artist strings, tolerant of multi-artist joins
 * (`A/B`, `A、B`, `A feat. B`).
 *
 * @param {string} local
 * @param {string} online
 * @returns {number}
 */
function artistSimilarity(local, online) {
  const partsA = String(local || '')
    .split(/[\/、&,;]|\bfeat\.?\b|\bft\.?\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const partsB = String(online || '')
    .split(/[\/、&,;]|\bfeat\.?\b|\bft\.?\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!partsA.length || !partsB.length) return 0;
  let best = 0;
  for (const a of partsA) {
    for (const b of partsB) best = Math.max(best, similarity(a, b));
  }
  return best;
}

module.exports = {
  AD_KEYWORDS,
  SEPARATORS,
  normalize,
  squeeze,
  isAdText,
  isUnknown,
  hasTitleSeparator,
  stripTrackPrefix,
  stripDecorations,
  stripLeadingDecorations,
  stripTrailingDecorations,
  splitTitle,
  buildQueries,
  similarity,
  artistSimilarity,
  levenshtein,
  hasCJK,
  countCJK,
};
