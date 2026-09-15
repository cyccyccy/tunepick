'use strict';
/**
 * 鉴权 —— PRD §6 鉴权说明（Q-09）
 * /api/*    ：Authorization: Bearer <AUTH_TOKEN>
 * 管理界面   ：HTTP Basic（ADMIN_USER / ADMIN_PASSWORD），与 API Token 分离（FR-78）
 * /api/health：免鉴权
 * AUTH_TOKEN 为空时：不拒绝启动，但仅允许 127.0.0.1 访问（FR-79）
 */

const config = require('../config');

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLocal(req) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return LOCAL_IPS.has(ip);
}

/** API 鉴权（Bearer） */
function checkApi(req) {
  // 空 Token：仅本机
  if (!config.AUTH_TOKEN) return isLocal(req);
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  return m[1].trim() === config.AUTH_TOKEN;
}

/** 管理界面鉴权（Basic） */
function checkAdmin(req) {
  if (!config.ADMIN_USER || !config.ADMIN_PASSWORD) return isLocal(req);
  const h = req.headers.authorization || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return decoded.slice(0, i) === config.ADMIN_USER && decoded.slice(i + 1) === config.ADMIN_PASSWORD;
}

function unauthorized(res, kind = 'api') {
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(kind === 'admin' ? { 'WWW-Authenticate': 'Basic realm="TunePick Admin"' } : {}),
  });
  res.end(JSON.stringify({
    ok: false,
    error: kind === 'admin' ? '需要管理界面账号密码' : '需要有效的访问令牌',
    hint: kind === 'admin' ? '设置 ADMIN_USER / ADMIN_PASSWORD 环境变量' : '在请求头携带 Authorization: Bearer <AUTH_TOKEN>',
  }));
}

/** 是否需要警告：Token 为空 */
function authWarning() {
  if (!config.AUTH_TOKEN) return '未设置 AUTH_TOKEN，服务仅允许本机访问';
  if (!config.ADMIN_USER || !config.ADMIN_PASSWORD) return '未设置管理界面账号，管理页仅允许本机访问';
  return '';
}

module.exports = { checkApi, checkAdmin, unauthorized, isLocal, authWarning };
