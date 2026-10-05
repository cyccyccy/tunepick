'use strict';
/**
 * 路由表
 * 兼容层（对齐现有 App）+ 管理端点 + Web 页面
 *
 * ⚠️ 路径解码约定：http 层（src/server.js）已经对 pathname 做过**一次** decodeURIComponent，
 *    本模块**绝不能再解第二次** —— 二次解码会把 %252e%252e 变成 ..，
 *    等于给路径穿越开了一扇窗（配合封面目录读可有限逃逸）。
 */

const compat = require('./compat');
const admin = require('./admin');
const auth = require('./auth');
const stream = require('./stream');
const web = require('../web/router');
const sqmusic = require('./sqmusic');
const v1 = require('./v1');
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
      await stream.handle(req, res, m[1]);
      return true;
    }
  }

  // ---------- API（Bearer）----------
  if (!auth.checkApi(req)) return auth.unauthorized(res, 'api'), true;

  const P = pathname;

  /* ===== 对外开放 API v1（Bearer 鉴权，与其他 /api/* 一致）=====
   * 说明：v1.route 内部自带 404 / 500 处理（统一 {ok:false,error:{code}} 包），
   *      因此这里直接 return true，不要落到文件末尾的兜底 404。
   */
  if (P.startsWith('/api/v1/')) { await v1.route(req, res, method, P, url); return true; }

  /* ===== 扫描 =====
   * ⚠️ 下面这些 handler 全是 async：必须 await，不能写成
   *    `return admin.xxx(req, res), true`（逗号表达式）。
   *    那样返回的只是 Promise，异常会变成 unhandledRejection，
   *    响应永远发不出去，客户端挂死到超时。
   */
  if (P === '/api/scan/start' && method === 'POST') { await admin.scanStart(req, res); return true; }
  if (P === '/api/scan/sample' && method === 'POST') { await admin.scanSample(req, res); return true; }
  if (P === '/api/scan/promote' && method === 'POST') { await admin.promote(res); return true; }
  if (P === '/api/scan/pause' && method === 'POST') { await admin.scanPause(res); return true; }
  if (P === '/api/scan/resume' && method === 'POST') { await admin.scanResume(res); return true; }
  if (P === '/api/scan/cancel' && method === 'POST') { await admin.scanCancel(res); return true; }
  if (P === '/api/scan/status') { await admin.scanStatus(res); return true; }
  if (P === '/api/scan/sample-report') { await admin.sampleReport(res); return true; }
  if (P === '/api/scan/probe-report') { await admin.probeReport(res); return true; }
  if (P === '/api/scan/logs') { await admin.scanLogs(res, url); return true; }
  if (P === '/api/scan/history') { await admin.scanHistory(res); return true; }
  {
    const m = /^\/api\/scan\/track\/(.+)$/.exec(P);
    if (m && method === 'POST') { await admin.rescanTrack(req, res, m[1]); return true; }
  }

  /* ===== id 映射 ===== */
  if (P === '/api/idmap/import' && method === 'POST') { await admin.idmapImport(req, res); return true; }
  if (P === '/api/idmap/status') { await admin.idmapStatus(res); return true; }

  /* ===== 检索 ===== */
  if (P === '/api/facets') { await admin.facets(res); return true; }
  if (P === '/api/tracks/filter') { await admin.filter(res, url); return true; }
  if (P === '/api/review/queue') { await admin.reviewQueue(res, url); return true; }
  if (P === '/api/stats/coverage') { await admin.statsCoverage(res); return true; }
  if (P === '/api/export') { await admin.exportData(res, url); return true; }

  /* ===== 修改 ===== */
  if (P === '/api/tracks/batch' && method === 'POST') { await admin.batchUpdate(req, res); return true; }
  {
    const m = /^\/api\/tracks\/([^/]+)\/unlock$/.exec(P);
    if (m && method === 'POST') { await admin.unlockTrack(req, res, m[1]); return true; }
  }
  // 注意顺序：先匹配 /api/tracks 下的子资源，再匹配 /api/tracks/:id 详情，
  // 否则会与 /api/tracks/filter、/api/tracks/batch 冲突。
  {
    const m = /^\/api\/tracks\/([^/]+)$/.exec(P);
    if (m) {
      if (method === 'PATCH') { await admin.patchTrack(req, res, m[1]); return true; }
      if (method === 'GET') return compat.track(res, m[1]), true;
      return json(res, { ok: false, error: `接口不存在：${method} ${P}`, hint: '检查请求路径与 HTTP 方法' }, 404), true;
    }
  }

  /* ===== 数据源 / LLM ===== */
  if (P === '/api/sources' && method === 'GET') { await admin.sources(res); return true; }
  if (P === '/api/sources' && method === 'PATCH') { await admin.patchSources(req, res); return true; }
  {
    const m = /^\/api\/sources\/([^/]+)\/test$/.exec(P);
    if (m && method === 'POST') { await admin.testSource(req, res, m[1]); return true; }
  }
  if (P === '/api/llm/config' && method === 'GET') { await admin.llmConfig(res); return true; }
  if (P === '/api/llm/config' && method === 'PATCH') { await admin.patchLlmConfig(req, res); return true; }
  if (P === '/api/llm/models') { await admin.llmModels(res); return true; }
  if (P === '/api/llm/test' && method === 'POST') { await admin.llmTest(req, res); return true; }
  if (P === '/api/tags/rerun-stale' && method === 'POST') { await admin.rerunStale(req, res); return true; }

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
    if (m) return compat.album(res, m[1]), true;
  }
  {
    const m = /^\/api\/playlist\/(.+)$/.exec(P);
    if (m) return compat.playlist(res, m[1]), true;
  }
  {
    const m = /^\/api\/track\/([^/]+)\/lyric$/.exec(P);
    if (m) return compat.lyric(res, m[1]), true;
  }
  {
    const m = /^\/api\/cover\/([^/]+)$/.exec(P);
    if (m) return admin.cover(res, m[1], url.searchParams.get('size')), true;
  }

  return json(res, { ok: false, error: `接口不存在：${method} ${P}`, hint: '检查请求路径与 HTTP 方法' }, 404), true;
}

module.exports = { route };
