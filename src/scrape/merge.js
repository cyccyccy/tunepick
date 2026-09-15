'use strict';
/**
 * 字段级回退合并引擎 —— PRD §3.5（回退粒度是「字段」不是「曲目」）
 *
 * 三件套贯穿全链路：
 *   sourceMap       : { field -> 来源 }
 *   fieldConfidence : { field -> 0..1 }
 *   lockedFields    : [field]   人工锁定，所有自动流程跳过
 */

const schema = require('../store/schema');
const vocab = require('./vocab');
const { makeLogger } = require('../logger');

const log = makeLogger('scrape:merge');

/**
 * 来源优先级（数值越大越权威）
 *
 * ⚠️ 顺序必须让在线源高于 L1 推断值：
 *    path(20) < online(25~30) < embed(50)
 *    原型实测「目录推断与内嵌标签同源、覆盖率净增益为 0」，
 *    若把 path 排在 online 之前，L1 的 0.6 低置信推断会把在线源的权威结果全挡住。
 */
const SOURCE_PRIORITY = {
  manual: 100,
  embed: 50,                 // L1-a 内嵌标签（通常可靠）
  'online:netease': 30,
  'online:musicbrainz': 29,
  'online:qq': 28,
  'online:kugou': 27,
  'online:caa': 26,
  'online:douban': 25,
  llm: 22,                   // L3（低于在线源，但高于目录推断）
  path: 20,                  // L1-b 目录推断（仅兜底）
  filename: 10,              // 从文件名/标题拆出的推断（最低）
};

/** 需要按封闭词表校验的字段 */
const VOCAB_FIELDS = {
  genre: 'genre', lang: 'lang', era: 'era',
  mood: 'mood', scene: 'scene',
};

function priorityOf(source) {
  return SOURCE_PRIORITY[source] ?? 15;
}

/** 单值校验：伪值 / 词表越界 一律拒绝 */
function rejects(field, value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    const dim = VOCAB_FIELDS[field];
    if (dim) return !value.every((v) => vocab.inVocab(dim, v));
    return false;
  }
  if (typeof value === 'number') {
    if (field === 'year') return !(value >= 1900 && value <= new Date().getFullYear() + 1);
    return value === 0;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return true;
    if (schema.PSEUDO_VALUES.has(value.trim())) return true;
    const dim = VOCAB_FIELDS[field];
    if (dim && !vocab.inVocab(dim, value)) return true;
    return false;
  }
  return false;
}

/**
 * 把一个候选值写入曲目（字段级）
 * @returns {'accepted'|'locked'|'rejected'|'lower-priority'}
 */
function applyField(track, field, value, source, confidence = 0.5) {
  if ((track.lockedFields || []).includes(field)) return 'locked';
  if (rejects(field, value)) return 'rejected';

  const cur = track.sourceMap?.[field];
  const curConf = Number(track.fieldConfidence?.[field] ?? 0.5);
  if (cur && priorityOf(cur) > priorityOf(source)) {
    // 例外：低置信度的 L1 推断值（目录/文件名，<0.7）允许被显著更可信的结果覆盖
    const enough = Number.isFinite(confidence) && Number(confidence) >= curConf + 0.2;
    if (!(curConf < 0.7 && enough)) return 'lower-priority';
  }

  // R-FB-09：目录推断优先级低于内嵌标签（同字段已有 embed 时 path 不得覆盖）
  if (source === 'path' && cur === 'embed') return 'lower-priority';

  track[field] = value;
  track.sourceMap = track.sourceMap || {};
  track.fieldConfidence = track.fieldConfidence || {};
  track.sourceMap[field] = source;
  track.fieldConfidence[field] = +(confidence ?? 0.5).toFixed(3);
  return 'accepted';
}

/**
 * 批量合并：候选按字段分组后逐个 applyField
 * @param {object} track
 * @param {Array<{field,value,source,confidence}>} candidates
 * @returns {{accepted:string[], skipped:object}}
 */
function mergeFields(track, candidates) {
  const accepted = [];
  const skipped = { locked: [], rejected: [], lowerPriority: [] };

  // 同字段按优先级降序，保证高优先级先写入
  const sorted = [...candidates].sort((a, b) => priorityOf(b.source) - priorityOf(a.source));
  for (const c of sorted) {
    const r = applyField(track, c.field, c.value, c.source, c.confidence);
    if (r === 'accepted') accepted.push(c.field);
    else if (r === 'locked') skipped.locked.push(c.field);
    else if (r === 'rejected') skipped.rejected.push(c.field);
    else skipped.lowerPriority.push(c.field);
  }
  return { accepted, skipped };
}

/**
 * 跨源一致性加成（原型实测结论）：
 *   两源给出相同歌手 → +0.15；不同 → 记冲突并标 needReview
 */
function crossSourceCheck(track, field, values = []) {
  const vals = values.map((v) => String(v || '').trim()).filter(Boolean);
  if (vals.length < 2) return null;
  const uniq = [...new Set(vals)];
  if (uniq.length === 1) {
    const cur = track.fieldConfidence?.[field] ?? 0.5;
    track.fieldConfidence[field] = Math.min(1, +(cur + 0.15).toFixed(3));
    return { agree: true, value: uniq[0] };
  }
  track.fieldConfidence[`${field}Conflict`] = 1;
  track.needReview = true;
  return { agree: false, values: uniq };
}

/**
 * 时长交叉校验（原型实测：>15s 的 6 首全在 19–29s，>30s 为 0）
 * @returns {number} 置信度增量
 */
function durationBoost(localSec, onlineSec) {
  if (!localSec || !onlineSec) return 0;
  const d = Math.abs(localSec - onlineSec);
  if (d <= 15) return 0.05;
  if (d <= 20) return 0;
  return -0.2;
}

/** 整体置信度 = 各已填字段置信度的加权平均（核心字段权重更高） */
const CORE_WEIGHT = { cleanArtist: 3, cleanTitle: 2, year: 2, genre: 2, mood: 1.5, scene: 1, era: 2, coverId: 1, lyrics: 1 };

function recomputeConfidence(track) {
  let sum = 0, w = 0;
  for (const [f, wt] of Object.entries(CORE_WEIGHT)) {
    const c = track.fieldConfidence?.[f];
    const filled = !schema.isPseudo(track[f]);
    if (filled && c !== undefined) { sum += c * wt; w += wt; }
    else if (filled) { sum += 0.5 * wt; w += wt; }
  }
  track.confidence = w ? +(sum / w).toFixed(3) : 0;
  return track.confidence;
}

module.exports = {
  SOURCE_PRIORITY,
  priorityOf,
  rejects,
  applyField,
  mergeFields,
  crossSourceCheck,
  durationBoost,
  recomputeConfidence,
};
