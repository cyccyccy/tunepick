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

/**
 * Decides whether `str` is GBK-as-Latin-1 mojibake.
 *
 * Rule (deliberately conservative — a false positive destroys a good tag):
 *   1. at least 2 characters in U+00A0..U+00FF (one GBK char == 2 such bytes);
 *   2. no characters that cannot survive a latin1 round-trip
 *      (i.e. all code points <= 0xFF) — otherwise mixed content would be
 *      corrupted rather than restored;
 *   3. re-decoding as gb18030 must strictly increase the CJK count
 *      and must not introduce U+FFFD replacement characters.
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

  let bytes;
  try {
    bytes = Buffer.from(str, 'latin1');
  } catch (err) {
    return false;
  }
  const decoded = gbDecoder.decode(bytes);

  if (decoded.includes('\uFFFD')) return false;
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
