'use strict';
/** verify-claims.js — 逐条核对报告 §5.1 / §5.2 清单是否真实存在于数据中 */
const fs = require('fs');
const R = 'D:/AI/WorkBuddy/2026-08-27-23-46-21/nas-music-scraper/prototype';
const result = JSON.parse(fs.readFileSync(R + '/data/result.json', 'utf8'));
const md = fs.readFileSync(R + '/报告-命中率实测.md', 'utf8');
const entries = new Map(result.entries.map((e) => [e.sampleIndex, e]));
const q1 = require('./q1-rows.json');
const mbIdx = new Set(q1.mbHits.map((r) => r.sampleIndex));
const suspicious = [35, 41, 42, 45, 48, 49, 54, 59];
console.log('MB 命中轨:', JSON.stringify([...mbIdx].sort((a, b) => a - b)));
console.log('8 首疑似错配中同时有 MB 命中的:', JSON.stringify(suspicious.filter((i) => mbIdx.has(i))));
const combinedB = q1.combinedRows.filter((r) => (r.ne && r.ne.B) || (r.mb && r.mb.B)).length;
const combinedBp = q1.combinedRows.filter((r) => !suspicious.includes(r.sampleIndex) && ((r.ne && r.ne.B) || (r.mb && r.mb.B))).length;
console.log('合并口径 B =', combinedB, ' B′（剔除 8 首）=', combinedBp);

// 解析 §5.1 / §5.2 表格
const lines = md.split(/\r?\n/);
const idx51 = lines.findIndex((l) => l.includes('### 5.1'));
const idx52 = lines.findIndex((l) => l.includes('### 5.2'));
const idx6 = lines.findIndex((l) => l.includes('## 6.'));
const rowsOf = (a, b) => lines.slice(a, b).filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => l.split('|').map((x) => x.trim()).filter((x, i, arr) => !(i === 0 || i === arr.length - 1)));
const r51 = rowsOf(idx51, idx52);
const r52 = rowsOf(idx52, idx6);
console.log('\n§5.1 解析到行数:', r51.length, ' §5.2:', r52.length);

const relax = result.meta.summary.relaxedUpside;
console.log('\n=== §5.1 逐行核对（对照 summary.relaxedUpside，n=' + relax.length + '）===');
for (const row of r51) {
  const i = Number(row[0]);
  const [ts, as_, dd] = [row[8], row[9], row[10]];
  const hit = relax.find((x) => x.sampleIndex === i);
  const ok = hit && String(hit.titleSim) === ts && String(hit.artistSim) === as_ && (dd === '—' || String(hit.durDiff) === dd);
  console.log('  #' + i + ' 报告(' + ts + ',' + as_ + ',' + dd + ') 数据(' + (hit ? hit.titleSim + ',' + hit.artistSim + ',' + hit.durDiff : 'NOT-FOUND') + ') ' + (ok ? 'OK' : 'MISMATCH'));
}
console.log('\n§5.2 表头: ' + JSON.stringify(r52[0]));

// §5.2 核对：top-1 候选是否与之相符
console.log('\n=== §5.2 逐行核对（对照 entry.netease.topCandidates）===');
let ok52 = 0, bad52 = [];
for (const row of r52) {
  const i = Number(row[0]);
  const e = entries.get(i);
  if (!e) {
    bad52.push({ i, why: 'no entry' });
    continue;
  }
  const ts = row[6];
  const as_ = row[7];
  const dd = row[8];
  const cands = (e.netease.topCandidates || []).map((x) => x.score);
  const strictTier = row[9];
  const match = cands.some((s) => String(s.titleSim) === ts && String(s.artistSim) === as_ && (dd === '—' ? s.durDiff === null : String(s.durDiff) === dd));
  const tierOk = e.netease.tier === strictTier;
  if (match && tierOk) ok52 += 1;
  else bad52.push({ i, ts, as_, dd, strictTier, dataTier: e.netease.tier, candScores: cands.map((c) => c.titleSim + '/' + c.artistSim + '/' + c.durDiff + '/' + c.strict.tier) });
}
console.log('§5.2 相符: ' + ok52 + '/' + r52.length);
console.log('不符条目: ' + JSON.stringify(bad52, null, 1));
