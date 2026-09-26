'use strict';
/**
 * 单元：/api/v1/sqmusic/tasks 的 progress 语义补全（src/api/v1-sq.js → taskLite）
 *
 * 真机取证：SqMusic **不提供真实下载进度**，success 任务的 progress 恒为 0，
 *   对调用方是「下载完成 = 0%」这种明显错误的语义。
 * 现已在 API 层归一化（normalizeProgress）：
 *   success → 100（已完成就是 100%，不管上游给什么）
 *   其余状态 → 保留上游值，夹到 [0, 99]（非 success 状态不允许出现 100%）
 *
 * 为什么走单元而不是起真服务：这里验的是**纯映射**，且 taskLite 已由模块导出，
 *   起 HTTP 只是给同一段纯函数套一层 socket 噪声；
 *   协议转换 / 鉴权 / 错误码等真机行为由 tests/qa-v1-sqmusic.test.js 覆盖，不重复。
 *
 * 覆盖：
 *   A. success → 100（上游给 0 / 给中途值 30 / 给脏值 / 给 100 四种输入都不变）
 *   B. running：保留上游值；上游给 100 → 夹到 99；负数 → 0；缺字段 → 0
 *   C. waiting / error：同样不得出现 100%
 *   D. 不变量：progress 恒为有限数字；非 success 恒 < 100
 *
 * 运行：node tests/unit-v1-sq-progress.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
process.env.LOG_LEVEL = 'error';

const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', '.tmp-unit-progress');
process.env.DATA_DIR = TMP_DIR;
process.env.MUSIC_DIR = path.join(TMP_DIR, 'music-notexist');
process.env.PORT = '18399';

// 纯映射测试不会真的发请求；给个不可达地址，若真被访问会以 unreachable 暴露出来
process.env.SQ_ENABLED = 'true';
process.env.SQ_BASE_URL = 'http://127.0.0.1:9';
process.env.SQ_USERNAME = 'admin';
process.env.SQ_PASSWORD = 'admin';
process.env.SQ_TIMEOUT_MS = '1000';

fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const v1sq = require('../src/api/v1-sq');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

/** 造一条服务层已归一化的任务，走真实 taskLite */
function tl(o) {
  return v1sq.taskLite(Object.assign({
    id: 't1', name: '测试曲目', artist: '测试歌手', album: '测试专辑',
  }, o));
}

/* ==========================================================================
 * A. success → 100（真机 bug 本体）
 * ========================================================================== */
console.log('\nA. success 状态一律 100（真机 bug：原本恒为 0）');

eq('success + 上游 progress=0 → 100（真机实际场景）',
  tl({ status: 'success', progress: 0 }).progress, 100);
eq('success + 上游 progress=30 → 100（不因中途值回退）',
  tl({ status: 'success', progress: 30 }).progress, 100);
eq('success + 上游 progress=100 → 100（幂等）',
  tl({ status: 'success', progress: 100 }).progress, 100);
eq('success + 脏值 progress="abc" → 100',
  tl({ status: 'success', progress: 'abc' }).progress, 100);
eq('success + 缺失 progress → 100',
  tl({ status: 'success' }).progress, 100);
eq('success 的 status 字段本身不被改',
  tl({ status: 'success', progress: 0 }).status, 'success');

/* ==========================================================================
 * B. running：保留上游值，但夹到 [0, 99]
 * ========================================================================== */
console.log('\nB. running（服务层 downloading）保留上游值并夹到 0..99');

eq('downloading 的 status 翻译为 running',
  tl({ status: 'downloading', progress: 42 }).status, 'running');
eq('running + 上游 progress=42 → 42（原样保留）',
  tl({ status: 'downloading', progress: 42 }).progress, 42);
eq('running + 上游 progress=0 → 0（SqMusic 不提供进度时的诚实值）',
  tl({ status: 'downloading', progress: 0 }).progress, 0);
eq('running + 上游 progress=100 → 99（非 success 不允许 100%）',
  tl({ status: 'downloading', progress: 100 }).progress, 99);
eq('running + 上游 progress=137 → 99（超限夹紧）',
  tl({ status: 'downloading', progress: 137 }).progress, 99);
eq('running + 负数 progress=-8 → 0',
  tl({ status: 'downloading', progress: -8 }).progress, 0);
eq('running + 缺失 progress → 0',
  tl({ status: 'downloading' }).progress, 0);
eq('running + 脏值 progress="x" → 0',
  tl({ status: 'downloading', progress: 'x' }).progress, 0);
eq('running + 字符串数字 "57" → 57',
  tl({ status: 'downloading', progress: '57' }).progress, 57);

/* ==========================================================================
 * C. waiting / error 同样不得出现 100%
 * ========================================================================== */
console.log('\nC. waiting / error 同样不得 100%');

eq('waiting + 上游 progress=100 → 99',
  tl({ status: 'waiting', progress: 100 }).progress, 99);
ok('waiting 的 progress 不等于 100',
  tl({ status: 'waiting', progress: 100 }).progress !== 100,
  String(tl({ status: 'waiting', progress: 100 }).progress));
eq('waiting + 上游 progress=13 → 13',
  tl({ status: 'waiting', progress: 13 }).progress, 13);
eq('error + 上游 progress=7 → 7',
  tl({ status: 'error', progress: 7 }).progress, 7);
eq('error + 上游 progress=100 → 99',
  tl({ status: 'error', progress: 100 }).progress, 99);

/* ==========================================================================
 * D. 不变量
 * ========================================================================== */
console.log('\nD. 不变量');

{
  const inputs = [undefined, null, 0, 1, 42, 99, 100, 137, -5, '0', 'abc', '', NaN, 3.7];
  const statuses = ['waiting', 'downloading', 'success', 'error'];
  let allFinite = true;
  let nonSuccessLeak = '';
  let badSample = '';
  for (const st of statuses) {
    for (const p of inputs) {
      const out = tl({ status: st, progress: p });
      if (typeof out.progress !== 'number' || !Number.isFinite(out.progress)) {
        allFinite = false;
        badSample = `status=${st} progress=${String(p)} → ${String(out.progress)}`;
      }
      if (st !== 'success' && out.progress >= 100) {
        nonSuccessLeak = `status=${st} progress=${String(p)} → ${out.progress}`;
      }
    }
  }
  ok('progress 恒为有限数字（14 种输入 × 4 种状态全遍历）', allFinite, badSample);
  ok('非 success 状态恒不出现 >=100%（100% 是完成态专属信号）', !nonSuccessLeak, nonSuccessLeak);

  // success 侧的不变量：无论输入如何都必须是 100
  let successAlways100 = true;
  let successBad = '';
  for (const p of inputs) {
    const out = tl({ status: 'success', progress: p });
    if (out.progress !== 100) { successAlways100 = false; successBad = `progress=${String(p)} → ${out.progress}`; }
  }
  ok('success 状态恒为 100（14 种输入全遍历）', successAlways100, successBad);
}

{
  // 归一化不能污染派生字段
  const t = tl({
    status: 'success', progress: 0,
    bitrateKbps: 320, durationSec: 300,
    startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:30.000Z',
  });
  eq('进度归一化后 sizeBytesEst 仍按码率×时长计算', t.sizeBytesEst, Math.round(320 * 1000 / 8 * 300));
  eq('进度归一化后 elapsedSec 仍为 30', t.elapsedSec, 30);
  eq('进度归一化后 speedBpsEst 仍按体积/耗时计算', t.speedBpsEst, Math.round(t.sizeBytesEst / 30));
}

/* ========================================================================== */
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结果 */ }

console.log('\n' + '─'.repeat(60));
console.log(`unit-v1-sq-progress: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
