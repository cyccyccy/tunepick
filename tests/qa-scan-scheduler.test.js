'use strict';
/**
 * QA 回归：定时增量扫描调度器（2026-11-04 新增）。
 *
 * 覆盖：
 *   1. 默认配置（开启 / 15 分钟 / 启动延迟 60 秒）与 status() 字段契约
 *   2. running / paused 时一律跳过，绝不调用 task.start()（保护断点）
 *   3. 空闲时以 { mode:'incremental' } 触发，并记录 taskId / triggers
 *   4. accepted:false、start 抛异常时只记失败，不抛出、不算成功
 *   5. 真实 setInterval 自动触发 + stop() 后不再触发
 *   6. 开关关闭 / 非 localfs 源不启用
 *
 * 运行：node tests/qa-scan-scheduler.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, '..', '.tmp-qa-scan-scheduler');
const MUSIC_DIR = path.join(TMP, 'music');

process.env.SKIP_DOT_ENV = '1';
process.env.SOURCE_KIND = 'localfs';
process.env.DATA_DIR = TMP;
process.env.MUSIC_DIR = MUSIC_DIR;
process.env.ONLINE_ENABLED = 'false';
process.env.LLM_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(MUSIC_DIR, { recursive: true });

const config = require('../src/config');
const task = require('../src/scan/task');
const scheduler = require('../src/scan/scheduler');
const logger = require('../src/logger');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass += 1; }
  catch (e) { console.log('  FAIL  ' + name + ' :: ' + e.message); fail += 1; }
}

const realStatus = task.status;
const realStart = task.start;
let calls = [];
let nextResult = { accepted: true, taskId: 'run_test0001', state: 'running' };
let fakeState = { state: 'idle', running: false };
function patch() {
  task.status = () => fakeState;
  task.start = (opts) => {
    calls.push(opts);
    if (nextResult instanceof Error) return Promise.reject(nextResult);
    return Promise.resolve(nextResult);
  };
}
function restore() { task.status = realStatus; task.start = realStart; }
function reset() {
  calls = [];
  fakeState = { state: 'idle', running: false };
  nextResult = { accepted: true, taskId: 'run_test0001', state: 'running' };
  scheduler.stop();
}

async function main() {
  console.log('=== 定时增量扫描调度器回归 ===');

  check('默认配置：开启 / 15 分钟 / 启动延迟 60 秒', () => {
    assert.strictEqual(config.SCAN_SCHEDULE_ENABLED, true);
    assert.strictEqual(config.SCAN_SCHEDULE_INTERVAL_MIN, 15);
    assert.strictEqual(config.SCAN_SCHEDULE_BOOT_DELAY_SEC, 60);
  });

  check('status() 字段契约完整，初始为未启用', () => {
    const s = scheduler.status();
    for (const k of ['enabled', 'intervalMin', 'startedAt', 'nextAt', 'lastAt',
      'lastTaskId', 'lastResult', 'triggers', 'skipped', 'failures']) {
      assert.ok(Object.prototype.hasOwnProperty.call(s, k), '缺字段 ' + k);
    }
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.lastResult, 'never');
  });

  patch();

  // --- 1. running 跳过 ---
  reset(); patch();
  scheduler.start({ enabled: true, intervalMs: 100000, bootDelayMs: 100000 });
  fakeState = { state: 'running', running: true };
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  check('扫描进行中：跳过且不调用 task.start()', () => {
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(scheduler.status().skipped, 1);
    assert.ok(scheduler.status().lastResult.indexOf('running') >= 0);
  });

  // --- 2. paused 跳过（start() 自身不拦 paused，会重置断点）---
  reset(); patch();
  scheduler.start({ enabled: true, intervalMs: 100000, bootDelayMs: 100000 });
  fakeState = { state: 'paused', running: false };
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  check('扫描暂停中：跳过且不调用 task.start()', () => {
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(scheduler.status().skipped, 1);
    assert.ok(scheduler.status().lastResult.indexOf('paused') >= 0);
  });

  // --- 3. 正常触发 ---
  reset(); patch();
  scheduler.start({ enabled: true, intervalMs: 100000, bootDelayMs: 100000 });
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  check('空闲：以 incremental 模式触发并记录 taskId', () => {
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { mode: 'incremental' });
    const s = scheduler.status();
    assert.strictEqual(s.triggers, 1);
    assert.strictEqual(s.lastTaskId, 'run_test0001');
    assert.strictEqual(s.lastResult, 'accepted');
    assert.ok(s.lastAt > 0);
  });

  // --- 4. 未受理 ---
  reset(); patch();
  scheduler.start({ enabled: true, intervalMs: 100000, bootDelayMs: 100000 });
  nextResult = { accepted: false, reason: '已有任务在运行中', state: 'running' };
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  check('accepted:false：记为失败，不算触发成功', () => {
    const s = scheduler.status();
    assert.strictEqual(s.triggers, 0);
    assert.strictEqual(s.failures, 1);
    assert.ok(s.lastResult.indexOf('not-accepted') >= 0);
  });

  // --- 5. start 抛异常 ---
  reset(); patch();
  scheduler.start({ enabled: true, intervalMs: 100000, bootDelayMs: 100000 });
  nextResult = new Error('boom');
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  check('start 抛异常：不冒泡、只记失败', () => {
    const s = scheduler.status();
    assert.strictEqual(s.failures, 1);
    assert.ok(s.lastResult.indexOf('boom') >= 0);
  });

  // --- 6. 真实定时器自动触发 + stop 后停止 ---
  reset(); patch();
  const started = scheduler.start({ enabled: true, intervalMs: 20, bootDelayMs: 5 });
  assert.strictEqual(started, true);
  await new Promise((r) => setTimeout(r, 130));
  const beforeStop = scheduler.status().triggers;
  check('真实 setInterval 会自动触发多次', () => {
    assert.ok(beforeStop >= 2, '实际触发 ' + beforeStop + ' 次');
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((o) => o && o.mode === 'incremental'));
  });
  scheduler.stop();
  await new Promise((r) => setTimeout(r, 70));
  check('stop() 后不再触发，状态复位', () => {
    assert.strictEqual(scheduler.status().triggers, beforeStop);
    assert.strictEqual(scheduler.status().enabled, false);
    assert.strictEqual(scheduler.status().nextAt, 0);
  });

  // --- 7. 开关 / 源类型 ---
  reset(); patch();
  check('enabled:false 不启用定时器', () => {
    assert.strictEqual(scheduler.start({ enabled: false, intervalMs: 20, bootDelayMs: 5 }), false);
    assert.strictEqual(scheduler.status().enabled, false);
  });
  check('非 localfs 源默认不启用', () => {
    assert.strictEqual(scheduler.start({ sourceKind: 'navidrome' }), false);
    assert.strictEqual(scheduler.status().enabled, false);
  });
  check('localfs 且配置默认开启时启用，间隔 15 分钟', () => {
    assert.strictEqual(scheduler.start(), true);
    const s = scheduler.status();
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.intervalMin, 15);
    assert.ok(s.nextAt > s.startedAt);
  });
  scheduler.stop();

  // --- 8. 日志可查（生产 LOG_LEVEL=info 时；这里只验证不抛错）---
  check('logger.read 可查询且不抛错', () => {
    const lines = logger.read({ tail: 20, q: '定时增量扫描' });
    assert.ok(Array.isArray(lines));
  });

  restore();
  scheduler.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('=== 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ===');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  restore();
  console.error('ERR', e && e.stack);
  process.exit(1);
});
