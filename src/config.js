'use strict';
/**
 * 配置中心 —— PRD §8.3 环境变量清单（37 项）
 * 所有配置必须经本模块读取，禁止在业务代码里散落 process.env
 */

const path = require('path');
const fs = require('fs');

/**
 * 极简 .env 加载（零依赖，不引入 dotenv）。
 * 仅填充「进程环境里尚未定义」的变量 —— 真实环境变量（Docker/K8s 注入）优先。
 * 与 PRD §8.3「环境变量清单」的覆盖顺序一致：显式环境变量 > .env > 内置默认。
 */
(function loadDotEnv() {
  if (process.env.SKIP_DOT_ENV === '1') return;
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '.env'),
  ].filter(Boolean);
  for (const f of candidates) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return; // 只用第一个命中的文件
  }
})();

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}
function list(name, def) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const DATA_DIR = str('DATA_DIR', path.resolve(__dirname, '..', 'data'));

const config = {
  // ---- 基础 ----
  MUSIC_DIR: str('MUSIC_DIR', '/music'),
  DATA_DIR,
  PORT: int('PORT', 8090),
  HOST: str('HOST', '0.0.0.0'),
  TZ: str('TZ', 'Asia/Shanghai'),
  NODE_ENV: str('NODE_ENV', 'production'),

  // ---- 鉴权（Q-09）----
  AUTH_TOKEN: str('AUTH_TOKEN', ''),
  ADMIN_USER: str('ADMIN_USER', ''),
  ADMIN_PASSWORD: str('ADMIN_PASSWORD', ''),

  // ---- 源适配 ----
  SOURCE_KIND: str('SOURCE_KIND', 'localfs'), // localfs | navidrome
  NAVIDROME_URL: str('NAVIDROME_URL', ''),
  NAVIDROME_USER: str('NAVIDROME_USER', ''),
  NAVIDROME_PASS: str('NAVIDROME_PASS', ''),

  // ---- 扫描 ----
  SCAN_CONCURRENCY: int('SCAN_CONCURRENCY', 4),
  IGNORE_PATTERNS: list('IGNORE_PATTERNS', ['@eaDir', '.DS_Store', '@Recycle']),
  CHECKPOINT_EVERY: int('CHECKPOINT_EVERY', 20),
  VOCAB_VERSION: str('VOCAB_VERSION', 'vocab-v2'),

  // ---- L1-b 目录推断（Q-11）----
  PATH_INFER_ENABLED: bool('PATH_INFER_ENABLED', true),
  PATH_INFER_MIN_DEPTH: int('PATH_INFER_MIN_DEPTH', 2),
  SAMPLE_SIZE: int('SAMPLE_SIZE', 100),

  // ---- L2 在线源 ----
  ONLINE_ENABLED: bool('ONLINE_ENABLED', true),
  ONLINE_SOURCES: list('ONLINE_SOURCES', ['netease', 'musicbrainz', 'caa']),
  ONLINE_QPS: num('ONLINE_QPS', 1),
  ONLINE_CONCURRENCY: int('ONLINE_CONCURRENCY', 2),
  ONLINE_TIMEOUT_MS: int('ONLINE_TIMEOUT_MS', 8000),
  ONLINE_CACHE_TTL_DAYS: int('ONLINE_CACHE_TTL_DAYS', 7),
  USER_AGENT: str('USER_AGENT', 'TunePick/1.0 (personal NAS library manager)'),

  // ---- 封面（Q-07）----
  COVER_THUMB_SIZES: list('COVER_THUMB_SIZES', ['300']).map((s) => parseInt(s, 10)).filter(Boolean),
  COVER_CACHE_MAX_MB: int('COVER_CACHE_MAX_MB', 500),
  STREAM_RANGE_ENABLED: bool('STREAM_RANGE_ENABLED', true),

  // ---- SqMusic 在线搜歌下载（可选集成，默认关闭）----
  // ⚠️ 总开关是 SQ_ENABLED：false 时 /api/sqmusic/* 全部返回 503「未启用」，
  //    前端显示引导页，不会报错崩溃。
  SQ_ENABLED: bool('SQ_ENABLED', false),
  // 同 docker 网络时填容器名（如 http://sqmusic_main:8099）；
  // SqMusic 跑在宿主、TunePick 在 docker 里时填宿主 IP（如 http://192.168.2.107:8099）
  SQ_BASE_URL: str('SQ_BASE_URL', 'http://sqmusic_main:8099'),
  SQ_USERNAME: str('SQ_USERNAME', 'admin'),
  SQ_PASSWORD: str('SQ_PASSWORD', 'admin'),
  // 可用音源：kw(酷我) / kg(酷狗) / qq / netease
  SQ_PLUGINS: list('SQ_PLUGINS', ['kw', 'kg', 'qq', 'netease']),
  // 默认码率；留空 = 由 SqMusic 自动选最高（推荐）
  SQ_BR_TYPE: str('SQ_BR_TYPE', ''),
  // 下载任务成功后自动触发一次增量扫描入库
  SQ_AUTO_SCAN: bool('SQ_AUTO_SCAN', true),
  SQ_TIMEOUT_MS: int('SQ_TIMEOUT_MS', 15000),

  // ---- L3 LLM ----
  LLM_ENABLED: bool('LLM_ENABLED', true),
  LLM_PROVIDER: str('LLM_PROVIDER', 'deepseek'),
  LLM_ENDPOINT: str('LLM_ENDPOINT', ''),
  LLM_API_KEY: str('LLM_API_KEY', ''),
  LLM_MODEL: str('LLM_MODEL', ''),
  LLM_BATCH_SIZE: int('LLM_BATCH_SIZE', 8),
  LLM_CONCURRENCY: int('LLM_CONCURRENCY', 3),
  LLM_TIMEOUT_MS: int('LLM_TIMEOUT_MS', 120000),
  LLM_MAX_TOKENS: int('LLM_MAX_TOKENS', 16384),
  LLM_SEND_PATH: bool('LLM_SEND_PATH', false),
  LLM_CONFIDENCE_THRESHOLD: num('LLM_CONFIDENCE_THRESHOLD', 0.6),

  // ---- 日志 ----
  LOG_LEVEL: str('LOG_LEVEL', 'info'),
  LOG_MAX_MB: int('LOG_MAX_MB', 100),
};

/** 派生路径 */
config.paths = {
  data: DATA_DIR,
  tracks: path.join(DATA_DIR, 'tracks'),
  covers: path.join(DATA_DIR, 'covers'),
  meta: path.join(DATA_DIR, 'meta.json'),
  cache: path.join(DATA_DIR, 'cache'),
  logs: path.join(DATA_DIR, 'logs'),
};

/** 确保数据目录存在 */
function ensureDirs() {
  for (const p of Object.values(config.paths)) {
    if (p.endsWith('.json')) continue;
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) { /* ignore */ }
  }
  try { fs.mkdirSync(path.dirname(config.paths.meta), { recursive: true }); } catch (_) {}
}

/** 是否配置了 LLM（决定 L3 是否启用） */
function llmConfigured() {
  return !!(config.LLM_API_KEY && config.LLM_API_KEY.trim());
}

/** 鉴权模式（供 /api/health 暴露） */
function authMode() {
  if (config.AUTH_TOKEN) return 'bearer';
  return 'localhost-only';
}

module.exports = config;
module.exports.ensureDirs = ensureDirs;
module.exports.llmConfigured = llmConfigured;
module.exports.authMode = authMode;
