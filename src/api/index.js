'use strict';
/**
 * 路由表
 * 兼容层（对齐现有 App）+ 管理端点 + Web 页面
 */

const compat = require('./compat');
const admin = require('./admin');
const auth = require('./auth');
const stream = require('./stream');
const web = require('../web/router');
const { makeLogger } = require('../logger');
const config = require('../config');

const log = makeLogger('api');

const json = admin.json;

/**
 * @returns {Promise<boolean>} true 表示已处理
 */
async function route(req, res, method, pathname, url) {
  // ---------- 免鉴权 ----------
  if (pathname === '/api/health') return admin.health(res), true;

  // ---------- Web 管理界面（HTTP Basic）----------
  if (!pathname.startsWith('/api/')) {
    if (!auth.checkAdmin(req)) return auth.unauthorized(res, 'admin'), true;
    return web.route(req, res, pathname, url);
  }

  // ---------- API（Bearer）----------
  if (!auth.checkApi(req)) return auth.unauthorized(res, 'api'), true;

  const P = pathname;

  /* ===== 扫描 ===== */
  if (P === '/api/scan/start' && method === 'POST') return admin.scanStart(req, res), true;
  if (P === '/api/scan/sample' && method === 'POST') return admin.scanSample(req, res), true;
  if (P === '/api/scan/promote' && method === 'POST') return admin.promote(res), true;
  if (P === '/api/scan/pause' && method === 'POST') return admin.scanPause(res), true;
  if (P === '/api/scan/resume' && method === 'POST') return admin.scanResume(res), true;
  if (P === '/api/scan/cancel' && method === 'POST') return admin.scanCancel(res), true;
  if (P === '/api/scan/status') return admin.scanStatus(res), true;
  if (P === '/api/scan/sample-report') return admin.sampleReport(res), true;
  if (P === '/api/scan/probe-report') return admin.probeReport(res), true;
  if (P === '/api/scan/logs') return admin.scanLogs(res, url), true;
  if (P === '/api/scan/history') return admin.scanHistory(res), true;
  {
    const m = /^\/api\/scan\/track\/(.+)$/.exec(P);
    if (m && method === 'POST') return admin.rescanTrack(req, res, decodeURIComponent(m[1])), true;
  }

  /* ===== id 映射 ===== */
  if (P === '/api/idmap/import' && method === 'POST') return admin.idmapImport(req, res), true;
  if (P === '/api/idmap/status') return admin.idmapStatus(res), true;

  /* ===== 检索 ===== */
  if (P === '/api/facets') return admin.facets(res), true;
  if (P === '/api/tracks/filter') return admin.filter(res, url), true;
  if (P === '/api/review/queue') return admin.reviewQueue(res, url), true;
  if (P === '/api/stats/coverage') return admin.statsCoverage(res), true;
  if (P === '/api/export') return admin.exportData(res, url), true;

  /* ===== 修改 ===== */
  if (P === '/api/tracks/batch' && method === 'POST') return admin.batchUpdate(req, res), true;
  {
    const m = /^\/api\/tracks\/([^/]+)\/unlock$/.exec(P);
    if (m && method === 'POST') return admin.unlockTrack(req, res, decodeURIComponent(m[1])), true;
  }
  {
    const m = /^\/api\/tracks\/([^/]+)$/.exec(P);
    if (m && method === 'PATCH') return admin.patchTrack(req, res, decodeURIComponent(m[1])), true;
    if (m && method === 'GET') return compat.track(res, decodeURIComponent(m[1])), true;
  }

  /* ===== 数据源 / LLM ===== */
  if (P === '/api/sources' && method === 'GET') return admin.sources(res), true;
  if (P === '/api/sources' && method === 'PATCH') return admin.patchSources(req, res), true;
  {
    const m = /^\/api\/sources\/([^/]+)\/test$/.exec(P);
    if (m && method === 'POST') return admin.testSource(req, res, decodeURIComponent(m[1])), true;
  }
  if (P === '/api/llm/config' && method === 'GET') return admin.llmConfig(res), true;
  if (P === '/api/llm/config' && method === 'PATCH') return admin.patchLlmConfig(req, res), true;
  if (P === '/api/llm/models') return admin.llmModels(res), true;
  if (P === '/api/llm/test' && method === 'POST') return admin.llmTest(req, res), true;
  if (P === '/api/tags/rerun-stale' && method === 'POST') return admin.rerunStale(req, res), true;

  /* ===== 兼容层 ===== */
  if (P === '/api/library') return compat.library(res), true;
  if (P === '/api/albums') return compat.albums(res), true;
  if (P === '/api/playlists') return compat.playlists(res), true;
  if (P === '/api/search') return compat.search(res, url), true;
  if (P === '/api/ai/playlist' && method === 'POST') return compat.aiPlaylist(res), true;
  if (P === '/api/tracks') return compat.tracks(res, url), true;

  {
    const m = /^\/api\/album\/(.+)$/.exec(P);
    if (m) return compat.album(res, decodeURIComponent(m[1])), true;
  }
  {
    const m = /^\/api\/playlist\/(.+)$/.exec(P);
    if (m) return compat.playlist(res, decodeURIComponent(m[1])), true;
  }
  {
    const m = /^\/api\/track\/([^/]+)\/lyric$/.exec(P);
    if (m) return compat.lyric(res, decodeURIComponent(m[1])), true;
  }
  {
    const m = /^\/api\/cover\/([^/]+)$/.exec(P);
    if (m) return admin.cover(res, decodeURIComponent(m[1]), url.searchParams.get('size')), true;
  }
  // 注意顺序：先匹配 /api/tracks 下的子资源，再匹配 /api/tracks/:id 详情，
  // 否则会与 /api/tracks/filter、/api/tracks/batch 冲突。
  {
    const m = /^\/api\/tracks\/([^/]+)\/unlock$/.exec(P);
    if (m && method === 'POST') { await admin.unlockTrack(req, res, decodeURIComponent(m[1])); return true; }
  }
  {
    const m = /^\/api\/tracks\/([^/]+)$/.exec(P);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PATCH') { await admin.patchTrack(req, res, id); return true; }
      if (method === 'GET') return compat.track(res, id), true;
    }
  }
  {
    const m = /^\/api\/scan\/track\/([^/]+)$/.exec(P);
    if (m && method === 'POST') { await admin.rescanTrack(req, res, decodeURIComponent(m[1])); return true; }
  }
  {
    const m = /^\/api\/sources\/([^/]+)\/test$/.exec(P);
    if (m && method === 'POST') { await admin.testSource(req, res, decodeURIComponent(m[1])); return true; }
  }
  {
    const m = /^\/api\/stream\/(.+)$/.exec(P);
    if (m) { await stream.handle(req, res, decodeURIComponent(m[1])); return true; }
  }

  return json(res, { ok: false, error: `接口不存在：${method} ${P}`, hint: '检查请求路径与 HTTP 方法' }, 404), true;
}

module.exports = { route };
