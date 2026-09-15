#!/usr/bin/env node
'use strict';
/**
 * TunePick 服务入口
 * 单容器：REST API（兼容层 + 管理端点）+ Web 管理界面
 */

const http = require('http');
const { URL } = require('url');

const config = require('./config');
const db = require('./store/db');
const logger = require('./logger');
const source = require('./source');
const { route } = require('./api');
const { makeLogger } = require('./logger');

const log = makeLogger('server');

// 代理说明：全局 fetch 会沿用 HTTP_PROXY 环境变量（外网源网易云 / MusicBrainz 需要它）；
// 内置 http 模块不读代理环境变量，因此访问 Tailscale 上的 Navidrome 天然直连，无需额外处理。
// ⚠️ 不要设置 NO_PROXY='*'，那会同时掐断外网源的代理通道。

config.ensureDirs();
db.load();

// ---------- 源类型校验 + 只读自检（PRD §9.1）----------
// ⚠️ 必须先校验枚举值：若 SOURCE_KIND 拼错（如写成 "local-fs"），
//    直接比对 'localfs' 会导致自检被静默跳过 —— 只读硬约束形同虚设。
const VALID_KINDS = ['localfs', 'navidrome'];
if (!VALID_KINDS.includes(config.SOURCE_KIND)) {
  log.error('未知的 SOURCE_KIND：' + config.SOURCE_KIND, VALID_KINDS);
  console.error(`[FATAL] 未知的 SOURCE_KIND="${config.SOURCE_KIND}"，可选值：${VALID_KINDS.join(' | ')}（注意是 localfs，不是 local-fs）`);
  process.exit(1);
}
if (config.SOURCE_KIND === 'localfs') {
  try {
    const ro = source.create().checkReadOnly();
    if (ro && ro.ok === false) {
      log.error('启动自检失败：' + ro.reason);
      process.exit(1);
    }
  } catch (e) {
    log.warn('只读自检跳过', { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    res.writeHead(400); return res.end('bad request');
  }
  const pathname = decodeURIComponent(url.pathname);

  // CORS（便于本地调试与第三方客户端）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const handled = await route(req, res, req.method, pathname, url);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '接口不存在' }));
    }
  } catch (e) {
    log.error('请求处理异常', { path: pathname, error: e.message });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '服务内部错误：' + e.message, hint: '查看日志页获取详情' }));
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > 3000) log.warn('慢请求', { path: pathname, ms });
  }
});

// 端口占用必须立即退出：否则残留进程会继续周期性回写旧数据，
// 把新进程刚清空的库又覆盖回去（曾导致「数据清不掉」的假象）。
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log.error('端口已被占用，服务退出', { port: config.PORT, host: config.HOST });
    console.error(`[FATAL] 端口 ${config.PORT} 已被占用，请先停止旧进程`);
    process.exit(1);
  }
  log.error('服务异常', { code: e.code, error: e.message });
});

server.listen(config.PORT, config.HOST, () => {
  log.info('TunePick 已启动', {
    port: config.PORT,
    source: config.SOURCE_KIND,
    musicDir: config.MUSIC_DIR,
    dataDir: config.DATA_DIR,
    tracks: db.size(),
    authMode: config.authMode(),
    llm: config.llmConfigured() ? 'configured' : 'not-configured',
    vocab: config.VOCAB_VERSION,
  });
  if (!config.AUTH_TOKEN) log.warn('未设置 AUTH_TOKEN，仅允许 127.0.0.1 访问');
});

// ---------- 优雅退出（PRD §8.3）----------
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('收到退出信号，正在收尾', { sig });
  try { require('./scan/task').cancel(); } catch (_) {}
  try { db.flush(true); db.saveMeta(); } catch (_) {}
  server.close(() => {
    log.info('已优雅退出');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => log.error('未捕获异常', { error: e.message, stack: (e.stack || '').split('\n')[1] || '' }));
process.on('unhandledRejection', (r) => log.error('未处理 Promise 拒绝', { reason: String(r) }));

module.exports = { server };
