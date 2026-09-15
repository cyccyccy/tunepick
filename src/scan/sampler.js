'use strict';
/**
 * 分层抽样 —— PRD Q-23 裁决
 *
 * 本库脏数据分布极不均匀（372 首广告串、22.1% 标题带分隔符、25.5% 乱码），
 * 纯随机抽样会让质量报告过于乐观，误导「是否跑全量」的决策。
 */

const enc = require('../util/encoding');
const T = require('../util/text');

const LAYERS = [
  { key: 'A', name: '乱码标题/歌手', quota: 20 },
  { key: 'B', name: '广告串', quota: 15 },
  { key: 'C', name: '标题含分隔符', quota: 25 },
  { key: 'D', name: '英文/日文标题', quota: 15 },
  { key: 'E', name: '其余随机', quota: 25 },
];

function classify(entry, tags) {
  const title = tags.title || entry.fileName || '';
  const artist = tags.artist || '';
  if (enc.looksGarbled(title) || enc.looksGarbled(artist)) return 'A';
  if (T.isAdText(title) || T.isAdText(artist)) return 'B';
  if (T.hasTitleSeparator(title)) return 'C';
  if (!T.hasCJK(title)) return 'D';
  return 'E';
}

/**
 * 分层抽样
 * @param {Array} entries 文件条目
 * @param {Array} tagsList 与 entries 一一对应的标签
 * @param {number} size 目标样本量
 * @returns {{samples:Array, distribution:object}}
 */
function sample(entries, tagsList, size = 100) {
  const buckets = { A: [], B: [], C: [], D: [], E: [] };
  for (let i = 0; i < entries.length; i++) {
    buckets[classify(entries[i], tagsList[i] || {})].push(i);
  }

  const total = entries.length;
  const out = [];
  const distribution = {};

  for (const layer of LAYERS) {
    const pool = buckets[layer.key];
    // 按层人口比例缩放配额，但至少取 1 层样本（若该层非空）
    const quota = Math.min(pool.length, Math.max(1, Math.round(layer.quota * (size / 100))));
    const picked = pickRandom(pool, quota);
    distribution[layer.key] = { name: layer.name, pool: pool.length, picked: picked.length };
    for (const idx of picked) out.push({ ...entries[idx], _layer: layer.key });
  }

  // 补足到 size（从 E 层与剩余池补充）
  if (out.length < size) {
    const used = new Set(out.map((s) => s.filePath));
    const rest = [];
    for (const key of ['E', 'C', 'D', 'A', 'B']) {
      for (const idx of buckets[key]) {
        if (!used.has(entries[idx].filePath)) rest.push(idx);
      }
    }
    for (const idx of pickRandom(rest, size - out.length)) {
      out.push({ ...entries[idx], _layer: classify(entries[idx], tagsList[idx] || {}) });
    }
  }

  return {
    samples: out.slice(0, size),
    distribution,
    population: total,
  };
}

function pickRandom(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(n, a.length)));
}

module.exports = { sample, classify, LAYERS };
