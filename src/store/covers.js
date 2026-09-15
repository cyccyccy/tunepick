'use strict';
/**
 * 封面存储 —— PRD §4.4
 * 二进制不入库，落盘数据目录；库内只存 coverId + 元信息
 * 尺寸档位：原图(0) + 300px 缩略图（DESIGN D-01：内嵌封面无 JPEG 解码器，缩略图不可用 → 回落原图）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('store:covers');

/** 已知占位图 hash（原型实测：Navidrome 的 mf- 图 2889 个 id 字节全同） */
const PLACEHOLDER_HASHES = new Set([
  '3b696af3ef82',   // Navidrome "TOP MUSIC CHARTS" 水印图（md5 前 12）
]);

const SIZE_RE = /^\d+$/;

function dir() { return config.paths.covers; }
function fileFor(coverId, size) { return path.join(dir(), `${coverId}_${size || 0}.img`); }

function ensureDir() {
  try { fs.mkdirSync(dir(), { recursive: true }); } catch (_) {}
}

function hashOf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 当前封面目录占用（MB） */
function usageMB() {
  try {
    let total = 0;
    for (const f of fs.readdirSync(dir())) {
      try { total += fs.statSync(path.join(dir(), f)).size; } catch (_) {}
    }
    return +(total / 1024 / 1024).toFixed(2);
  } catch (_) { return 0; }
}

function withinBudget() {
  return usageMB() < config.COVER_CACHE_MAX_MB;
}

/** 探测图片类型与尺寸（JPEG / PNG 最小解析） */
function sniff(buf) {
  if (buf.length < 12) return { mime: 'image/jpeg', width: 0, height: 0 };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', width: 0, height: 0, ext: 'jpg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: 'png' };
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', width: 0, height: 0, ext: 'webp' };
  }
  return { mime: 'image/jpeg', width: 0, height: 0, ext: 'jpg' };
}

/** 下载字节（支持 http/https；走环境变量代理由 fetch 自动处理时用 fetch，否则内置模块） */
async function download(urlStr, timeoutMs = 15000) {
  const u = new URL(urlStr);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
        headers: { 'User-Agent': config.USER_AGENT, Accept: 'image/*' }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(new URL(res.headers.location, urlStr).toString(), timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('timeout', () => req.destroy(new Error('封面下载超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 默认缩略图 URL 构造：仅网易云图床支持服务端缩放 */
function defaultThumbUrlFn(url, size) {
  if (!/music\.126\.net\//.test(url)) return null;
  return `${url}${url.includes('?') ? '&' : '?'}param=${size}y${size}`;
}

/**
 * 保存封面（来自在线 URL）
 * @param {string} url    原图 URL
 * @param {function} [thumbUrlFn] 按尺寸生成 URL 的函数（网易云支持 ?param=300y300）
 * @returns {Promise<{coverId,mime,width,height,hash,sizes,source}|null>}
 */
async function saveFromUrl(url, thumbUrlFn) {
  if (!url || !withinBudget()) return null;
  ensureDir();
  try {
    const buf = await download(url);
    if (!buf || buf.length < 512) return null;
    const saved = await saveFromBuffer(buf, 'online');
    if (!saved) return null;

    // 缩略图：网易云支持服务端缩放（?param=300y300），零依赖下这是唯一能真实
    // 产出 300px 档位的方式；取不到则静默跳过，由 read() 回落原图。
    const fn = thumbUrlFn || defaultThumbUrlFn;
    if (fn) {
      for (const s of config.COVER_THUMB_SIZES) {
        const u = fn(url, s);
        if (u && (await saveSize(u, saved.coverId, s))) saved.sizes.push(s);
      }
    }
    return saved;
  } catch (e) {
    log.debug('封面下载失败', { url: url.slice(0, 80), error: e.message });
    return null;
  }
}

/**
 * 保存封面（来自字节）
 * @param {Buffer} buf
 * @param {string} source embedded | online
 */
async function saveFromBuffer(buf, source = 'embedded') {
  if (!buf || buf.length < 512) return null;
  ensureDir();

  const hash = hashOf(buf);
  if (PLACEHOLDER_HASHES.has(hash.slice(0, 12))) {
    log.debug('识别为占位图，已丢弃', { hash: hash.slice(0, 12) });
    return null;
  }

  const info = sniff(buf);
  const coverId = 'cv_' + hash.slice(0, 12);
  const sizes = [0];

  // 原图落盘
  try {
    fs.writeFileSync(fileFor(coverId, 0), buf);
  } catch (e) {
    log.error('封面写入失败', { coverId, error: e.message });
    return null;
  }

  // 缩略图：在线源直取（零依赖无法本地缩放 JPEG）
  if (source === 'online' && config.COVER_THUMB_SIZES.length) {
    // 由调用方负责传入已带尺寸参数的 URL，见 saveFromUrl 的 thumbUrlFn
  }

  return {
    coverId,
    mime: info.mime,
    width: info.width || 0,
    height: info.height || 0,
    hash: 'sha1:' + hash.slice(0, 16),
    sizes,
    source,
  };
}

/** 单独保存某个尺寸档位（如网易云 ?param=300y300 直取的缩略图） */
async function saveSize(url, coverId, size) {
  if (!url || !size) return false;
  try {
    const buf = await download(url);
    if (!buf || buf.length < 256) return false;
    fs.writeFileSync(fileFor(coverId, size), buf);
    return true;
  } catch (_) { return false; }
}

/**
 * 读取封面（PRD §4.4 回落链）
 * ?size=300 → 精确命中 → 回落 300 → 回落原图 → 占位图
 */
function read(coverId, size) {
  ensureDir();
  const want = SIZE_RE.test(String(size)) ? parseInt(size, 10) : NaN;

  // ① 精确命中
  if (Number.isFinite(want) && want > 0) {
    const p = fileFor(coverId, want);
    if (fs.existsSync(p)) return { path: p, mime: sniff(fs.readFileSync(p).slice(0, 32)).mime };
    // ② 未命中 → 回落到第一个可用缩略图档位
    for (const s of config.COVER_THUMB_SIZES) {
      const p2 = fileFor(coverId, s);
      if (fs.existsSync(p2)) return { path: p2, mime: sniff(fs.readFileSync(p2).slice(0, 32)).mime };
    }
  }
  // ③ 回落原图
  const p0 = fileFor(coverId, 0);
  if (fs.existsSync(p0)) return { path: p0, mime: sniff(fs.readFileSync(p0).slice(0, 32)).mime };
  return null;
}

module.exports = {
  saveFromUrl, saveFromBuffer, saveSize, read, sniff, hashOf,
  usageMB, withinBudget, PLACEHOLDER_HASHES, download, fileFor,
};
