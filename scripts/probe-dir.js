'use strict';
/**
 * 目录结构探测（PRD FR-68）—— 真机验证的第一步，无需 Docker、不写任何文件。
 *
 * 用途：
 *   1. 在 NAS 上先把音乐目录挂进容器前，跑这个看目录长什么样
 *   2. 验证 local-fs 源能否正确扫描到文件、标签能否解析
 *   3. 产出「层级深度分布 / 疑似歌手目录数 / 扁平占比 / 目录推断是否生效」
 *
 * 用法：
 *   node scripts/probe-dir.js <音乐目录> [抽样首数]
 *   node scripts/probe-dir.js /volume1/music 200
 *
 * 只读：全程只读，绝不写入任何文件。
 */
const path = require('path');

const dir = process.argv[2];
const sampleSize = parseInt(process.argv[3], 10) || 100;

if (!dir) {
  console.error('用法: node scripts/probe-dir.js <音乐目录> [抽样首数]');
  process.exit(1);
}

const fs = require('fs');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.ape', '.wav']);

function walk(dirPath, depth, out, budget) {
  if (out.length >= budget.files) return;
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (out.length >= budget.files) break;
    const p = path.join(dirPath, e.name);
    if (e.isDirectory()) walk(p, depth + 1, out, budget);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push({ abs: p, depth });
    }
  }
}

console.log(`探测目录: ${dir}`);
console.log('只读扫描中（最多 20000 个文件）...\n');

const found = [];
walk(path.resolve(dir), 0, found, { files: 20000 });

if (!found.length) {
  console.error('未找到任何音频文件。请确认：');
  console.error('  1. 目录路径是否正确');
  console.error('  2. 容器内路径是否是挂载后的路径（如 /music，而不是 NAS 原路径）');
  console.error('  3. 目录权限是否可读');
  process.exit(2);
}

// ---- 层级深度分布 ----
const depthDist = {};
for (const f of found) depthDist[f.depth] = (depthDist[f.depth] || 0) + 1;

// ---- 相对路径结构（判断 歌手/专辑/文件 还是扁平）----
const rel = found.map((f) => path.relative(path.resolve(dir), f.abs).split(path.sep));
const twoLevel = rel.filter((r) => r.length >= 3).length;   // 歌手/专辑/文件
const oneLevel = rel.filter((r) => r.length === 2).length;  // 歌手/文件
const flat = rel.filter((r) => r.length === 1).length;      // 完全扁平

console.log('=== 扫描结果 ===');
console.log(`音频文件总数（本次上限内）: ${found.length}`);
console.log(`  完全扁平 (文件直接在根)      : ${flat}  (${(flat / found.length * 100).toFixed(1)}%)`);
console.log(`  一级目录 (歌手/文件)         : ${oneLevel}  (${(oneLevel / found.length * 100).toFixed(1)}%)`);
console.log(`  两级目录 (歌手/专辑/文件)    : ${twoLevel}  (${(twoLevel / found.length * 100).toFixed(1)}%)`);
console.log('  层级深度分布:', JSON.stringify(depthDist));

// ---- 目录推断是否可用 ----
const canInfer = twoLevel + oneLevel;
console.log(`\n=== 目录推断（L1-b）可用性 ===`);
console.log(`可用于推断歌手的文件: ${canInfer} (${(canInfer / found.length * 100).toFixed(1)}%)`);
if (canInfer === 0) {
  console.log('⚠️  目录完全扁平，目录推断不会生效（优雅降级，不会报错）');
  console.log('   歌手/专辑只能靠内嵌标签与在线刮削，预计覆盖率会明显偏低。');
} else {
  // 疑似歌手目录数（第一层目录去重）
  const topDirs = new Set(rel.filter((r) => r.length >= 2).map((r) => r[0]));
  console.log(`疑似歌手目录数（第一层去重）: ${topDirs.size}`);
  console.log(`样例: ${[...topDirs].slice(0, 8).join(' | ')}`);
}

// ---- 抽样解析标签，验证解析器是否工作 ----
console.log(`\n=== 抽样标签解析（${Math.min(sampleSize, found.length)} 首）===`);
const tags = require(path.resolve(__dirname, '..', 'src', 'tags'));
const enc = require(path.resolve(__dirname, '..', 'src', 'util', 'encoding'));

const step = Math.max(1, Math.floor(found.length / Math.min(sampleSize, found.length)));
const picked = found.filter((_, i) => i % step === 0).slice(0, sampleSize);

let ok = 0, gar = 0, noTitle = 0, noArtist = 0, err = 0;
const samples = [];
for (const f of picked) {
  try {
    const t = tags.readTags(f.abs);
    if (!t) { err++; continue; }
    ok++;
    const rawTitle = t.title || '';
    const rawArtist = t.artist || '';
    if (enc.looksGarbled(rawTitle) || enc.looksGarbled(rawArtist)) gar++;
    if (!rawTitle.trim()) noTitle++;
    if (!rawArtist.trim() || /^\[?unknown artist\]?$/i.test(rawArtist.trim())) noArtist++;
    if (samples.length < 6) {
      samples.push({
        file: path.basename(f.abs).slice(0, 36),
        title: (enc.fixGarbled(rawTitle) || '(空)').slice(0, 26),
        artist: (enc.fixGarbled(rawArtist) || '(空)').slice(0, 20),
        album: (enc.fixGarbled(t.album || '') || '(空)').slice(0, 20),
        year: t.year || 0,
      });
    }
  } catch (e) { err++; }
}

console.log(`解析成功: ${ok} / ${picked.length}${err ? `，失败 ${err}` : ''}`);
console.log('⚠️  以下统计的是**原始内嵌标签**。L1 层还会做两级兜底，所以这里的"无曲名/无歌手"不等于最终缺失：');
console.log('     1) 曲名为空 → 用文件名兜底（src/scrape/l1.js: t.title = title || stripExt(fileName)）');
console.log('     2) 歌手为空 → 用目录层级或「曲名-歌手」拆分推断');
console.log(`  无曲名: ${noTitle} (${(noTitle / Math.max(1, ok) * 100).toFixed(1)}%)`);
console.log(`  无歌手: ${noArtist} (${(noArtist / Math.max(1, ok) * 100).toFixed(1)}%)`);
console.log(`  疑似乱码: ${gar} (${(gar / Math.max(1, ok) * 100).toFixed(1)}%)  ← 可用 GBK 还原`);

if (samples.length) {
  console.log('\n样例（已做乱码还原）:');
  for (const s of samples) {
    console.log(`  ${s.file}`);
    console.log(`     title=${s.title} | artist=${s.artist} | album=${s.album} | year=${s.year}`);
  }
}

console.log('\n=== 结论 ===');
if (err === picked.length) {
  console.log('❌ 标签解析全部失败 —— 解析器有问题，或文件不可读。请先解决再部署。');
  process.exit(3);
}
console.log('✅ 目录可读、标签可解析。可以直接部署，或继续用本脚本确认更大样本。');
