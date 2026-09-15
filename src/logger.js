'use strict';
/**
 * 结构化日志 —— PRD §8.5
 * 输出到 stdout，同时在内存保留环形缓冲供 Web 日志页读取（/api/scan/logs）
 */

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 2000;
const ring = [];

let minLevel = LEVELS[config.LOG_LEVEL] || LEVELS.info;

function setLevel(lv) {
  if (LEVELS[lv] !== undefined) minLevel = LEVELS[lv];
}

function emit(level, mod, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    t: new Date().toISOString(),
    level,
    mod,
    msg,
    ...(fields || {}),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  const extra = Object.keys(fields || {}).length
    ? ' ' + JSON.stringify(fields)
    : '';
  const line = `[${entry.t}] [${level.toUpperCase()}] [${mod}] ${msg}${extra}`;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  return entry;
}

function makeLogger(mod) {
  return {
    debug: (m, f) => emit('debug', mod, m, f),
    info: (m, f) => emit('info', mod, m, f),
    warn: (m, f) => emit('warn', mod, m, f),
    error: (m, f) => emit('error', mod, m, f),
    child: (sub) => makeLogger(`${mod}:${sub}`),
  };
}

/** 供日志页读取：支持 tail / level / 关键字过滤 */
function read({ tail = 200, level = '', q = '' } = {}) {
  let out = ring;
  if (level) {
    const min = LEVELS[level] || 0;
    out = out.filter((e) => (LEVELS[e.level] || 0) >= min);
  }
  if (q) {
    const k = q.toLowerCase();
    out = out.filter(
      (e) => e.msg.toLowerCase().includes(k) ||
        (e.mod || '').toLowerCase().includes(k) ||
        JSON.stringify(e).toLowerCase().includes(k)
    );
  }
  const n = Math.max(0, Math.min(parseInt(tail, 10) || 200, RING_MAX));
  return out.slice(-n);
}

module.exports = { makeLogger, log: makeLogger('app'), read, setLevel };
