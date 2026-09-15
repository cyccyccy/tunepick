'use strict';
/**
 * 封闭词表 vocab-v2 —— PRD §4.2
 * 取值沿用 music-player/backend/ai-vocab.js，本版 scene 10→12、FLAGS 6→7
 */

const VOCAB_VERSION = 'vocab-v2';

const VOCAB = {
  mood: ['怀旧', '伤感', '治愈', '浪漫', '励志', '欢快', '慵懒', '孤独', '热血', '宁静', '思念', '释然'],
  genre: ['流行', '民谣', '摇滚', '古风', '电子', '舞曲', '说唱', 'R&B', '爵士', '轻音乐', '民族', '乡村', '粤语流行', 'DJ串烧', '其他'],
  scene: ['深夜驾驶', '高速长途', '城市通勤', '周末自驾', '雨天', '黄昏', '海边', '聚会', '专注工作', '睡前', '夜晚独处', '运动健身'],
  lang: ['国语', '粤语', '闽南语', '英语', '日语', '韩语', '纯音乐', '其他'],
  era: ['80s及更早', '90s', '2000s', '2010s', '2020s', '未知'],
};

/** 特殊标记（布尔字段，非词表值） */
const FLAGS = ['isAd', 'isGarbled', 'isLive', 'isRemix', 'isInstrumental', 'isShort', 'isCover'];

/** 各维度选值数量约束 */
const CARDINALITY = {
  mood: [1, 3],
  scene: [0, 3],
  genre: [1, 1],
  lang: [1, 1],
  era: [1, 1],
};

/** 缺失回落值（V-02） */
const FALLBACK = { genre: '其他', lang: '其他', era: '未知' };

const set = (arr) => new Set(arr);
const SETS = Object.fromEntries(Object.entries(VOCAB).map(([k, v]) => [k, set(v)]));

/** 校验单个取值是否在词表内 */
function inVocab(dim, value) {
  const s = SETS[dim];
  return !!s && s.has(value);
}

/**
 * 校验并清洗标签结果（V-01 ~ V-07）
 * @returns {{ok:boolean, tags:object, dropped:string[], reason?:string}}
 */
function validate(raw = {}) {
  const tags = {};
  const dropped = [];

  // 单选维度
  for (const dim of ['genre', 'lang', 'era']) {
    const v = raw[dim];
    if (v === undefined || v === null || v === '') continue;
    if (inVocab(dim, v)) tags[dim] = v;
    else dropped.push(`${dim}=${v}`);
  }

  // 多选维度
  for (const dim of ['mood', 'scene']) {
    let arr = raw[dim];
    if (typeof arr === 'string') arr = [arr];
    if (!Array.isArray(arr)) continue;
    const [min, max] = CARDINALITY[dim];
    const kept = arr.filter((v) => (inVocab(dim, v) ? true : (dropped.push(`${dim}=${v}`), false)));
    const uniq = [...new Set(kept)].slice(0, max);
    if (uniq.length >= min) tags[dim] = uniq;
    else if (uniq.length > 0) tags[dim] = uniq; // 少于下限也保留（scene 允许 0）
  }

  // 数值维度（V-04：夹紧 1-5，非数字回落 3）
  for (const dim of ['energy', 'valence']) {
    const v = raw[dim];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    tags[dim] = Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 3;
  }

  // V-03：mood 为空且 genre 为「其他」→ 模型没看懂，不落库
  const noMood = !tags.mood || tags.mood.length === 0;
  const genreOther = !tags.genre || tags.genre === '其他';
  if (noMood && genreOther) {
    return { ok: false, tags: {}, dropped, reason: 'V-03: mood 为空且 genre 为其他，视为模型未理解' };
  }

  return { ok: true, tags, dropped };
}

/** 缺失回落（V-02） */
function applyFallback(tags = {}) {
  for (const [dim, fb] of Object.entries(FALLBACK)) {
    if (!tags[dim]) tags[dim] = fb;
  }
  return tags;
}

/** 年份 → 年代（era）映射 */
function yearToEra(year) {
  const y = Number(year);
  if (!Number.isFinite(y) || y <= 0) return '未知';
  if (y < 1990) return '80s及更早';
  if (y < 2000) return '90s';
  if (y < 2010) return '2000s';
  if (y < 2020) return '2010s';
  return '2020s';
}

module.exports = {
  VOCAB_VERSION,
  VOCAB,
  FLAGS,
  CARDINALITY,
  FALLBACK,
  inVocab,
  validate,
  applyFallback,
  yearToEra,
};
