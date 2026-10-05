'use strict';

/**
 * GBK / Latin-1 mojibake detection and lossless restoration.
 *
 * Root cause in this library: GBK bytes were decoded as Latin-1 (ISO-8859-1) at
 * some point in the tagging pipeline, so every Chinese character became two
 * Latin-1 characters in the U+00A0..U+00FF range. The original bytes are still
 * recoverable: latin1-encode -> decode as gb18030.
 *
 * Verified pairs (all correct):
 *   ÂÉ¶¯³µÔØÒôÀÖ            -> 律动车载音乐
 *   ½­ÖÇÃñ                 -> 江智民
 *   Í«ÀÖ-Ê°Èþ              -> 瞳乐-拾叁
 *   ¹«ÖÚºÅ£ºÐ¡²ÝÐÂ¾çÉç      -> 公众号：小草新剧社
 *   ÖÐ¡¾3D»·ÈÆ¡¿I Need...  -> 中【3D环绕】I Need a Good One
 */

const CJK_RANGES = [
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xf900, 0xfaff], // CJK compatibility ideographs
];

/** Latin-1 supplement high half — the fingerprint of GBK-as-Latin-1 mojibake. */
const LATIN1_HIGH_MIN = 0xa0;
const LATIN1_HIGH_MAX = 0xff;

/** GB18030 superset of GBK; handles the whole library's byte range. */
let gbDecoder = null;
try {
  gbDecoder = new TextDecoder('gb18030', { fatal: false });
} catch (err) {
  // Node built without full ICU — everything degrades to "never garbled".
  gbDecoder = null;
}

/** Counts CJK ideographs (surrogate-safe). */
function countCJK(str) {
  if (!str) return 0;
  let n = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    for (const [lo, hi] of CJK_RANGES) {
      if (c >= lo && c <= hi) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/** Counts characters inside U+00A0..U+00FF. */
function countLatin1High(str) {
  if (!str) return 0;
  let n = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c >= LATIN1_HIGH_MIN && c <= LATIN1_HIGH_MAX) n += 1;
  }
  return n;
}

/** True when `str` contains any CJK ideograph. */
function hasCJK(str) {
  return countCJK(str) > 0;
}

/** 判定所需的最小高位字符占比（评审发现 #6：原规则误伤拉丁文本）。 */
const HIGH_RATIO_MIN = 0.5;

/** 还原结果中至少要有这么多 CJK 字符，才认为「确实还原出了中文」。 */
const RESTORED_CJK_MIN = 2;

/**
 * 高位字符的「候选乱码区间」占比。
 *
 * 为什么不用「整串占比」：真实串常是中英混排（如 `ÖÐ¡¾3D»·ÈÆ¡¿I Need a Good One`），
 * 尾部一大段正常 ASCII 会把整串占比稀释到 0.5 以下，导致漏还原。
 * 所以只统计「首、末个高位字符之间」的那段（即可能被 GBK 编码覆盖的区间）。
 *
 * 例：`Mötley Crüe` → 区间 `ötley Crü`，占比 2/9 ≈ 0.22 → 不是乱码；
 *     `ÖÐ¡¾3D»·ÈÆ¡¿...` → 区间 `ÖÐ¡¾3D»·ÈÆ¡¿`，占比 10/12 ≈ 0.83 → 是乱码。
 *
 * @param {string} str
 * @returns {number} 0..1
 */
function highSpanRatio(str) {
  let first = -1;
  let last = -1;
  let i = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c >= LATIN1_HIGH_MIN && c <= LATIN1_HIGH_MAX) {
      if (first === -1) first = i;
      last = i;
    }
    i += 1;
  }
  if (first === -1) return 0;
  let high = 0;
  for (let j = first; j <= last; j += 1) {
    const c = str.codePointAt(j);
    if (c >= LATIN1_HIGH_MIN && c <= LATIN1_HIGH_MAX) high += 1;
  }
  return high / (last - first + 1);
}

/** 至少要有这么多个「相邻高位字节对」——真正的 GBK 双字节序列指纹。 */
const ADJACENT_HIGH_PAIRS_MIN = 2;

/**
 * 统计相邻高位字符对（s[i] 与 s[i+1] 都在 U+00A0..U+00FF）的个数。
 *
 * 这是 GBK 双字节序列最硬的指纹：常用汉字在 GB2312 里首字节 0xB0–0xF7、
 * 尾字节 0xA1–0xFE，**两个字节都落在高位区且紧邻**。
 * 而拉丁词的高位字符是稀疏重音字母，前后都是 ASCII（如 `Mötley` 的 ö 后跟 t），
 * 相邻对数为 0。某些密集重音词（`Þórðurinn` / `Ágætis byrjun`）即使占比过线，
 * 也因为没有足够的相邻高位对而被挡住。
 *
 * @param {string} str
 * @returns {number}
 */
function countAdjacentHighPairs(str) {
  if (!str || str.length < 2) return 0;
  let n = 0;
  const codes = [];
  for (const ch of str) codes.push(ch.codePointAt(0));
  for (let i = 0; i + 1 < codes.length; i += 1) {
    const a = codes[i];
    const b = codes[i + 1];
    if (a >= LATIN1_HIGH_MIN && a <= LATIN1_HIGH_MAX && b >= LATIN1_HIGH_MIN && b <= LATIN1_HIGH_MAX) {
      n += 1;
    }
  }
  return n;
}

/**
 * Decides whether `str` is GBK-as-Latin-1 mojibake.
 *
 * Rule (deliberately conservative — a false positive destroys a good tag):
 *   1. every character must survive a latin1 round-trip (all code points
 *      <= 0xFF) — otherwise mixed content would be corrupted, not restored;
 *   2. at least 2 characters in U+00A0..U+00FF (one GBK char == 2 such bytes);
 *   3. 高位字符占比 >= 0.5 —— 真实 GBK 乱码串几乎全由高位字节构成，而
 *      拉丁词（`Mötley Crüe` / `Björk Guðmundsdóttir` / `Håkon Øvreås` /
 *      `Plácido Domingo` / `Céline Dion` / `Motörhead`）的高位字符是稀疏的
 *      重音字母，占比普遍 < 0.35。（评审发现 #6：旧规则只要「>=2 个高位字符」
 *      就放行，实测把上述 6 个拉丁词全部破坏。）
 *   4. 至少 2 个「相邻高位字节对」（GBK 双字节序列指纹）——占比门槛之外再
 *      加一道结构性门槛，挡住密集重音的拉丁词（`Þórðurinn`、`Ágætis byrjun`）；
 *   5. re-decoding as gb18030 must produce >= 2 CJK ideographs, must strictly
 *      increase the CJK count, and must not introduce U+FFFD replacement
 *      characters.
 *
 * @param {string} str
 * @returns {boolean}
 */
function looksGarbled(str) {
  if (!gbDecoder || typeof str !== 'string' || str.length === 0) return false;

  const high = countLatin1High(str);
  if (high < 2) return false;

  for (const ch of str) {
    if (ch.codePointAt(0) > 0xff) return false;
  }

  // 高位字符占比门槛：把稀疏重音字母（拉丁人名/乐队名）挡在外面
  if (highSpanRatio(str) < HIGH_RATIO_MIN) return false;
  // 结构门槛：真乱码的字节是成对紧邻的高位字节
  if (countAdjacentHighPairs(str) < ADJACENT_HIGH_PAIRS_MIN) return false;

  let bytes;
  try {
    bytes = Buffer.from(str, 'latin1');
  } catch (err) {
    return false;
  }
  const decoded = gbDecoder.decode(bytes);

  if (decoded.includes('\uFFFD')) return false;
  // 必须真的还原出 >= 2 个汉字，否则只是「字节重组」而非乱码还原
  if (countCJK(decoded) < RESTORED_CJK_MIN) return false;
  if (countCJK(decoded) <= countCJK(str)) return false;
  return true;
}

/**
 * Restores GBK-as-Latin-1 mojibake. Returns the input unchanged when the
 * heuristic does not fire, so it is always safe to call.
 *
 * @param {string} str
 * @returns {string}
 */
function fixGarbled(str) {
  if (!looksGarbled(str)) return str;
  const decoded = gbDecoder.decode(Buffer.from(str, 'latin1'));
  // gb18030 maps a few byte pairs onto fullwidth punctuation; keep as-is.
  return decoded.normalize('NFC');
}

/**
 * Applies fixGarbled to every string in an array.
 * @param {string[]} arr
 * @returns {string[]}
 */
function fixGarbledList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => (typeof v === 'string' ? fixGarbled(v) : v));
}

module.exports = {
  looksGarbled,
  fixGarbled,
  fixGarbledList,
  hasCJK,
  countCJK,
  countLatin1High,
};
