'use strict';
/**
 * 定时增量扫描调度器（2026-11-04 新增）。
 *
 * 决策变更：PRD 决策 #11 / Q-15 原本规定「服务不内置定时器，定时交给
 * fnOS 计划任务 curl」。但 NAS 上直接删除音乐文件后，若没有任何扫描触发，
 * scan/task.js::_reconcileDeleted() 就永远不会执行，播放端会一直列出已删
 * 歌曲并提示播放失败。按用户 2026-11-04 明确要求，改为服务内置、可关闭的
 * 周期增量扫描（默认 15 分钟）；设 SCAN_SCHEDULE_ENABLED=false 即可退回
 * 纯外部调度（fnOS 计划任务调用 POST /api/scan/start）。
 *
 * 约束：
 *  · 只在 localfs 源启用（其它源没有本地文件可枚举，删除对账无意义）。
 *  · running / paused 一律跳过：task.start() 只拦 RUNNING，暂停态启动会
 *    重置 this.run 与 cursor，导致断点续跑数据丢失。
 *  · 启动后延迟首跑，避开容器刚拉起时的挂载抖动与初始化竞争。
 *  · timer 全部 unref()，不阻止进程退出；shutdown() 里显式 clear。
 *  · 只触发增量扫描：删除对账在「完整枚举之后、增量过滤之前」执行，
 *    不需要另写对账逻辑；RECONCILE_* 护栏仍然生效。
 */
const config = require('../config');
const { makeLogger } = require('../logger');
const log = makeLogger('scan:scheduler');

const state = {
  enabled: false,
  intervalMs: 0,
  bootDelayMs: 0,
  timer: null,
  bootTimer: null,
  startedAt: 0,
  nextAt: 0,
  lastAt: 0,
  lastTaskId: '',
  lastResult: 'never',
  triggers: 0,
  skipped: 0,
  failures: 0,
};

function status() {
  return {
    enabled: state.enabled,
    intervalMin: Math.round((state.intervalMs / 60000) * 100) / 100,
    startedAt: state.startedAt,
    nextAt: state.nextAt,
    lastAt: state.lastAt,
    lastTaskId: state.lastTaskId,
    lastResult: state.lastResult,
    triggers: state.triggers,
    skipped: state.skipped,
    failures: state.failures,
  };
}

function skip(reason, extra) {
  state.skipped += 1;
  state.lastResult = 'skipped: ' + reason;
  log.info('跳过本次定时增量扫描', Object.assign({ reason }, extra || {}));
}

/** 单次触发。抽成公开函数便于回归测试直接调用。 */
function tick() {
  if (!state.enabled) return;
  state.nextAt = Date.now() + state.intervalMs;
  let task;
  try { task = require('./task'); }
  catch (e) {
    state.failures += 1;
    state.lastResult = 'error: ' + e.message;
    log.warn('扫描模块加载失败', { error: e.message });
    return;
  }

  const st = (task.status && task.status()) || {};
  if (st.running || st.state === 'paused') {
    return skip(st.running ? 'running' : 'paused', { state: st.state });
  }

  Promise.resolve(task.start({ mode: 'incremental' }))
    .then((r) => {
      if (!r || r.accepted === false || !r.taskId) {
        state.failures += 1;
        state.lastResult = 'not-accepted: ' + ((r && r.reason) || 'no taskId');
        log.warn('定时扫描未受理', { reason: state.lastResult });
        return;
      }
      state.lastAt = Date.now();
      state.lastTaskId = r.taskId;
      state.lastResult = 'accepted';
      state.triggers += 1;
      log.info('定时增量扫描已触发', { taskId: r.taskId, intervalMin: status().intervalMin });
    })
    .catch((e) => {
      state.failures += 1;
      state.lastResult = 'error: ' + e.message;
      log.warn('定时增量扫描启动失败', { error: e.message });
    });
}

function stop() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  if (state.bootTimer) { clearTimeout(state.bootTimer); state.bootTimer = null; }
  state.enabled = false;
  state.nextAt = 0;
}

/**
 * 启动调度。opts 仅供测试覆盖：{ enabled, intervalMs, bootDelayMs, sourceKind }。
 * @returns {boolean} 是否真的启用了定时器
 */
function start(opts = {}) {
  stop();
  // 一次 start() 视为新一轮调度：计数与上次结果从零开始，便于 status() 排障。
  state.triggers = 0;
  state.skipped = 0;
  state.failures = 0;
  state.lastAt = 0;
  state.lastTaskId = '';
  state.lastResult = 'never';
  const intervalMin = opts.intervalMs !== undefined
    ? opts.intervalMs / 60000
    : Math.max(0, Number(config.SCAN_SCHEDULE_INTERVAL_MIN) || 0);
  const intervalMs = opts.intervalMs !== undefined
    ? Math.max(1, Number(opts.intervalMs) || 1)
    : Math.max(1, Math.round(intervalMin * 60000));
  const bootDelayMs = opts.bootDelayMs !== undefined
    ? Math.max(0, Number(opts.bootDelayMs) || 0)
    : Math.max(0, Number(config.SCAN_SCHEDULE_BOOT_DELAY_SEC) || 0) * 1000;
  const sourceKind = opts.sourceKind || config.SOURCE_KIND;
  const enabled = opts.enabled !== undefined
    ? !!opts.enabled
    : (!!config.SCAN_SCHEDULE_ENABLED && sourceKind === 'localfs' && intervalMin > 0);

  state.intervalMs = intervalMs;
  state.bootDelayMs = Math.min(bootDelayMs, intervalMs);
  state.startedAt = Date.now();
  state.enabled = enabled;

  if (!enabled) {
    log.info('定时增量扫描未启用', {
      enabled: config.SCAN_SCHEDULE_ENABLED,
      sourceKind,
      intervalMin: config.SCAN_SCHEDULE_INTERVAL_MIN,
      hint: 'SCAN_SCHEDULE_ENABLED=false 可关闭，或改用 fnOS 计划任务调用 /api/scan/start',
    });
    return false;
  }

  state.timer = setInterval(tick, intervalMs);
  if (state.timer.unref) state.timer.unref();
  state.nextAt = Date.now() + state.bootDelayMs;
  state.bootTimer = setTimeout(() => {
    state.bootTimer = null;
    tick();
  }, state.bootDelayMs);
  if (state.bootTimer.unref) state.bootTimer.unref();
  log.info('定时增量扫描已启用', {
    intervalMin: Math.round(intervalMin * 100) / 100,
    bootDelaySec: Math.round(state.bootDelayMs / 1000),
    firstAt: new Date(state.nextAt).toISOString(),
    sourceKind,
  });
  return true;
}

module.exports = { start, stop, status, tick };
