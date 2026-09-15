'use strict';
/**
 * Web 管理界面静态路由（PRD §7）
 * 界面本身由 HTTP Basic 保护；页面内数据请求走 /api/*，由前端携带 Bearer
 */

const fs = require('fs');
const path = require('path');

const WEB_DIR = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res, body, type, status = 200) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function route(req, res, pathname) {
  // 统一入口：所有页面返回 index.html，由前端 hash 路由分发
  const name = pathname === '/' || pathname === '' ? 'index.html'
    : pathname.replace(/^\/+/, '');

  if (name === 'index.html' || !name.includes('.')) {
    const p = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(p)) return send(res, fs.readFileSync(p), MIME['.html']);
    return send(res, '<h1>界面文件缺失</h1>', MIME['.html'], 500);
  }

  const p = path.join(WEB_DIR, path.basename(name));      // 防目录穿越
  if (!p.startsWith(WEB_DIR) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return send(res, JSON.stringify({ ok: false, error: '资源不存在' }), MIME['.json'], 404);
  }
  const ext = path.extname(p).toLowerCase();
  return send(res, fs.readFileSync(p), MIME[ext] || 'application/octet-stream');
}

module.exports = { route };
