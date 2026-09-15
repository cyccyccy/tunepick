'use strict';
/**
 * Source Adapter：Navidrome / Subsonic API（开发回退源）
 *
 * 用途：本地开发环境读不到 NAS 的音乐文件系统时，用 Navidrome API 提供同一套接口，
 * 让整条刮削链路能端到端验证（DESIGN §5 Q1）。
 *
 * 注意：Navidrome 的 coverArt 在真实库里 99.5% 是 mf- 占位图（原型实测），
 *       因此本适配器只在前缀为 al- 时才认为有真实封面。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('source:navidrome');

/** 用内置 http 模块请求（不读 HTTP_PROXY，Tailscale 地址必须直连） */
function getJson(urlStr, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 非法: ' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': config.USER_AGENT },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: body.slice(0, 300) }));
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(Object.assign(new Error('响应非 JSON'), { body: body.slice(0, 300) })); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

function api(cmd, extra = {}) {
  const base = config.NAVIDROME_URL.replace(/\/+$/, '');
  const q = new URLSearchParams({
    u: config.NAVIDROME_USER,
    p: config.NAVIDROME_PASS,
    v: '1.16.1',
    c: 'tunepick',
    f: 'json',
    ...extra,
  });
  return `${base}/rest/${cmd}?${q.toString()}`;
}

function create() {
  const cache = { songs: null };

  async function fetchAll() {
    if (cache.songs) return cache.songs;
    const url = api('search3.view', { query: '', songCount: '10000', songOffset: '0', albumCount: '0', artistCount: '0' });
    const t0 = Date.now();
    const j = await getJson(url);
    const r = j['subsonic-response'];
    if (!r || r.status !== 'ok') {
      throw Object.assign(new Error(`Navidrome 返回异常: ${JSON.stringify(r && r.error)}`), { hint: '检查 NAVIDROME_URL / 账号密码与 Tailscale 连通性' });
    }
    const songs = (r.searchResult3 && r.searchResult3.song) || [];
    cache.songs = songs;
    log.info('Navidrome 全量取数完成', { total: songs.length, ms: Date.now() - t0 });
    return songs;
  }

  return {
    kind: 'navidrome',
    root: config.NAVIDROME_URL,

    checkReadOnly() {
      // 远程 API 源不存在本地写入风险
      return { ok: true };
    },

    async enumerate() {
      const songs = await fetchAll();
      return songs.map((s) => {
        const rel = String(s.path || '').replace(/\\/g, '/');
        const depth = rel.split('/').length - 1;
        const ext = (s.suffix || 'mp3').toLowerCase();
        return {
          filePath: rel,
          absPath: rel,
          fileName: rel.split('/').pop() || (s.title + '.' + ext),
          fileExt: ext,
          fileSizeBytes: Number(s.size) || 0,
          fileMtime: s.created ? new Date(s.created).toISOString() : '',
          dirDepth: Math.max(0, depth),
          _raw: s,
        };
      });
    },

    /** 标签映射：Subsonic 字段 → 统一标签对象 */
    async readTags(entry) {
      const s = entry._raw || {};
      // 注意：不可用 s.created 兜底——那是入库时间（扫描时点），不是发行年份。
      // 原型实测年份缺失 86.9%，缺失应留 0 交由 L2 在线源补齐，
      // 否则会以 embed 高优先级写入错误年份并挡住在线源的真实年份。
      const year = Number(s.year) || 0;
      const genre = Array.isArray(s.genres) && s.genres.length ? s.genres[0] : (s.genre || '');
      return {
        title: s.title || '',
        artist: s.artist || '',
        album: s.album || '',
        albumArtist: (s.albumArtists && s.albumArtists[0] && s.albumArtists[0].name) || s.artist || '',
        year,
        genre,
        trackNo: Number(s.track) || 0,
        discNo: Number(s.discNumber) || 0,
        comment: s.comment || '',
        durationSec: Number(s.duration) || 0,
        bitrate: Number(s.bitRate) || 0,
        sampleRate: Number(s.samplingRate) || 0,
        format: (s.suffix || '').toUpperCase() || 'UNKNOWN',
        picture: null,
        lyrics: '',
        _coverArt: s.coverArt || '',
      };
    },

    /** Navidrome 侧不提供内嵌封面字节，标记占位（mf- 前缀为假图，实测结论） */
    hasRealCover(coverArt) {
      return typeof coverArt === 'string' && coverArt.startsWith('al-');
    },

    async readRange(track, rangeHeader) {
      // 通过 Navidrome stream 接口代理（仅开发模式使用）
      const id = (track.legacyIds && track.legacyIds[0] ? track.legacyIds[0].replace(/^nd_tr_/, '') : track.id);
      const url = api('stream.view', { id, maxBitRate: '0' });
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const headers = { 'User-Agent': config.USER_AGENT };
      if (rangeHeader) headers.Range = rangeHeader;
      return new Promise((resolve, reject) => {
        const req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers, timeout: 30000 }, (res) => {
          resolve({
            status: res.statusCode,
            headers: {
              'Content-Length': res.headers['content-length'] || '',
              'Content-Range': res.headers['content-range'] || '',
              'Accept-Ranges': res.headers['accept-ranges'] || 'bytes',
              'Content-Type': res.headers['content-type'] || 'audio/mpeg',
            },
            stream: res,
          });
        });
        req.on('timeout', () => req.destroy(new Error('音频流请求超时')));
        req.on('error', reject);
        req.end();
      });
    },

    async readLocalLrc() { return ''; },   // 远程源无法读本地 .lrc
  };
}

module.exports = { create, getJson, api };
