'use strict';

/**
 * qa-lib.js — QA 独立复算用的文本工具。
 *
 * 刻意不复用 src/match.js / src/util/text.js 的任何评分逻辑：
 *   - 标题相似度用 LCS 比值 + 字符多重集 Jaccard + 包含式奖励（与 match.js 的
 *     Levenshtein+包含 是两套不同的算法族）；
 *   - 歌手判定用自写的「规范化相等 / 包含 / 编辑比值 / CJK 近形」四级量表。
 * 本文件只做判定，不改动任何原始数据。
 */

// ---------------------------------------------------------------- normalize
const DECOR_RE = /[【】\[\]（）()《》<>「」『』〔〕]/g;

/** 我的规范化：全角折半角、去装饰、非字母数字/非中日韩字符折空格、压缩空白。 */
function norm(s) {
  if (s === null || s === undefined || typeof s !== 'string') return '';
  let t = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  t = t.replace(DECOR_RE, ' ').toLowerCase();
  t = t.replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** 去掉全部空白，用于"完全一致"比较。 */
function sq(s) {
  return norm(s).replace(/\s+/g, '');
}

function isCJKChar(ch) {
  const c = ch.codePointAt(0);
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff);
}

function hasCJK(s) {
  return /[\u4e00-\u9fff\u3040-\u30ff]/.test(String(s || ''));
}

// ------------------------------------------------------------ my own metrics
/** 最长公共子序列长度（自写，滚动数组）。 */
function lcsLen(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = ca === b.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return prev[b.length];
}

/** 字符多重集 Jaccard：交集大小 / 并集大小。 */
function charJaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const m = new Map();
  for (const ch of a) m.set(ch, (m.get(ch) || 0) + 1);
  let inter = 0;
  let bLen = 0;
  const m2 = new Map();
  for (const ch of b) m2.set(ch, (m2.get(ch) || 0) + 1);
  for (const [ch, n] of m2.entries()) {
    bLen += n;
    inter += Math.min(n, m.get(ch) || 0);
  }
  const union = a.length + bLen - inter;
  return union ? inter / union : 0;
}

/**
 * 我的标题相似度（与 match.js 不同族）：
 *   max( LCS比值, 字符Jaccard, 包含奖励(0.72+0.28*短/长) )
 */
function myTitleSim(a, b) {
  const x = sq(a);
  const y = sq(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lcs = lcsLen(x, y) / Math.max(x.length, y.length);
  const jac = charJaccard(x, y);
  let cont = 0;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) {
    const s = Math.min(x.length, y.length);
    const l = Math.max(x.length, y.length);
    cont = 0.72 + 0.28 * (s / l);
  }
  return Math.min(1, Math.max(lcs, jac, cont));
}

/** 拆分多歌手串。 */
function artistParts(s) {
  return String(s || '')
    .split(/[\/、&,;＋+]|\bfeat\.?\b|\bft\.?\b/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 歌手判定四级量表。返回 {verdict, ratio, reason}
 *   exact : 规范化后完全相等，或一方完整包含另一方
 *   near  : 同一书写体系的近似写法（中文错别字/简繁、英文拼写差异）
 *   none  : 其余（含"完全无关的两个拉丁名恰好编辑距离小"的情况会被单独标注）
 */
function artistVerdict(localArtist, onlineArtistText) {
  const A = artistParts(localArtist).map(sq).filter(Boolean);
  const B = artistParts(onlineArtistText).map(sq).filter(Boolean);
  if (!A.length || !B.length) return { verdict: 'none', ratio: 0, reason: 'empty' };
  let best = { verdict: 'none', ratio: 0, reason: 'no-pair' };
  for (const a of A) {
    for (const b of B) {
      if (a === b) return { verdict: 'exact', ratio: 1, reason: 'equal' };
      if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) {
        if (best.verdict !== 'exact') best = { verdict: 'exact', ratio: 0.95, reason: 'containment' };
      }
      const l = lcsLen(a, b) / Math.max(a.length, b.length);
      const j = charJaccard(a, b);
      const sameScript = hasCJK(a) === hasCJK(b);
      const sameLen = a.length === b.length;
      const shared = [...new Set(a)].filter((ch) => b.includes(ch)).length;
      let v = 'none';
      let reason = 'unrelated';
      if (sameScript && sameLen && a.length <= 4 && hasCJK(a) && shared >= 1 && l >= 0.5) {
        v = 'near';
        reason = `cjk-variant(shared=${shared},lcs=${l.toFixed(2)})`;
      } else if (sameScript && !hasCJK(a) && (l >= 0.75 || j >= 0.75)) {
        v = 'near';
        reason = `latin-close(lcs=${l.toFixed(2)},jac=${j.toFixed(2)})`;
      }
      const score = Math.max(l, j);
      if (v === 'near' && best.verdict !== 'exact') best = { verdict: 'near', ratio: score, reason };
      else if (v === 'none' && best.verdict === 'none' && score > best.ratio) best = { verdict: 'none', ratio: score, reason };
    }
  }
  return best;
}

/** 工程师报告 §7.3 使用的伪歌手标记（我独立复现同一名单口径，便于对齐）。 */
const PSEUDONYM_MARKERS = [
  /公众号/,
  /微信/,
  /抖音/,
  /快手/,
  /资源库/,
  /上传/,
  /推广/,
  /收藏/,
  /音乐驿站/,
  /群/,
  /不改音响/,
  /提升.*音质/,
  /^Cydian$/,
  /^DJ\s/i,
];

function isPseudoArtist(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  if (/^\[?unknown/i.test(s) || s === '未知' || s === '未知艺术家') return true;
  return PSEUDONYM_MARKERS.some((re) => re.test(s));
}

module.exports = {
  norm,
  sq,
  hasCJK,
  isCJKChar,
  lcsLen,
  charJaccard,
  myTitleSim,
  artistParts,
  artistVerdict,
  isPseudoArtist,
  PSEUDONYM_MARKERS,
};
