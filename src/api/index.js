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
const sqmusic = require('./sqmusic');
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

  // ---------- 登录页（免鉴权）：写入 tp_token Cookie 后跳回主页 ----------
  if (pathname === '/login' || pathname === '/login.html') {
    web.route(req, res, '/login.html', url);
    return true;
  }

  // ---------- Web 管理界面（Cookie 令牌 / Bearer / Basic 任一）----------
  if (!pathname.startsWith('/api/')) {
    if (!auth.checkWeb(req)) {
      // 浏览器请求 → 跳登录页，避免原生 Basic 弹窗与前端令牌弹窗循环互踢
      if ((req.headers.accept || '').includes('text/html')) {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-cache' });
        res.end();
        return true;
      }
      auth.unauthorized(res, 'admin');
      return true;
    }
    return web.route(req, res, pathname, url);
  }

  /* ===== /api/stream/* ：全站唯一放宽鉴权的一处 =====
   * ⚠️ 必须排在下面「统一的 checkApi」之前，否则 Cookie 请求会先被 401 拦掉，
   *    这里的放宽就成了死代码（实测踩过）。
   * 规则：Bearer 有效 **或** Cookie tp_token 有效 → 放行；两者都无效 → 仍然 401。
   * 原因：浏览器 <audio src="/api/stream/xxx"> 只会带同域 Cookie，
   *       不会附加 Authorization 头，沿用 checkApi（只认 Bearer）播放必然 401。
   * 其余 /api/* 一律仍走下面的 checkApi，行为完全不变。
   */
  {
    const m = /^\/api\/stream\/(.+)$/.exec(pathname);
    if (m) {
      const cookieToken = auth.cookieToken(req);
      const cookieOk = !!(config.AUTH_TOKEN && cookieToken && cookieToken === config.AUTH_TOKEN);
      if (!auth.checkApi(req) && !cookieOk) return auth.unauthorized(res, 'api'), true;
      await stream.handle(req, res, decodeURIComponent(m[1]));
      return true;
    }
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

  /* ===== SqMusic 在线搜歌下载（可选集成，未启用时返回 503 优雅降级）===== */
  if (P === '/api/sqmusic/status') return sqmusic.status(res), true;
  if (P === '/api/sqmusic/search' && method === 'POST') { await sqmusic.search(req, res); return true; }
  if (P === '/api/sqmusic/download' && method === 'POST') { await sqmusic.download(req, res); return true; }
  if (P === '/api/sqmusic/tasks') { await sqmusic.tasks(res); return true; }
  if (P === '/api/sqmusic/dir') { await sqmusic.dir(res); return true; }
  if (P === '/api/sqmusic/preview' && method === 'POST') { await sqmusic.preview(req, res); return true; }
  if (P === '/api/sqmusic/downloaded') { await sqmusic.downloaded(res, url); return true; }
  if (P === '/api/sqmusic/test' && method === 'POST') { await sqmusic.ping(res); return true; }

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
  return json(res, { ok: false, error: `接口不存在：${method} ${P}`, hint: '检查请求路径与 HTTP 方法' }, 404), true;
}

module.exports = { route };
