'use strict';
/**
 * Source Adapter：直读本地挂载目录（生产模式）
 * 硬约束：音乐目录严格只读（PRD §9.1）
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const tags = require('../tags');
const { makeLogger } = require('../logger');

const log = makeLogger('source:localfs');

const AUDIO_EXT = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'm4b', 'aac', 'wav', 'wma', 'ape']);

function shouldIgnore(name, relPath) {
  for (const pat of config.IGNORE_PATTERNS) {
    if (pat.startsWith('*/') && pat.endsWith('/*')) {
      const seg = pat.slice(2, -2);
      if (relPath.split(/[\\/]/).includes(seg)) return true;
    } else if (name === pat || relPath.split(/[\\/]/).includes(pat)) {
      return true;
    }
  }
  return false;
}

function walk(dir, root, out, depth = 0, budget = { count: 0 }) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (shouldIgnore(e.name, rel)) continue;

    if (e.isDirectory()) {
      walk(abs, root, out, depth + 1, budget);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      out.push({
        filePath: rel,
        absPath: abs,
        fileName: e.name,
        fileExt: ext,
        fileSizeBytes: st.size,
        fileMtime: st.mtime.toISOString(),
        dirDepth: depth,
      });
      budget.count++;
    }
  }
  return out;
}

function create() {
  const root = config.MUSIC_DIR;

  return {
    kind: 'localfs',
    root,

    /** 只读自检：若音乐目录可写，按 PRD §9.1 必须失败 */
    checkReadOnly() {
      try {
        const probe = path.join(root, '.tunepick-write-probe');
        fs.writeFileSync(probe, 'x');
        fs.unlinkSync(probe);
        return { ok: false, reason: `音乐目录可写（${root}），违反只读约束，拒绝启动` };
      } catch (e) {
        return { ok: true };
      }
    },

    /** 枚举全部音频文件 */
    async enumerate() {
      if (!fs.existsSync(root)) {
        throw Object.assign(new Error(`音乐目录不存在：${root}`), { hint: '检查 MUSIC_DIR 与 Docker 挂载' });
      }
      const t0 = Date.now();
      const files = walk(root, root, [], 0);
      log.info('目录枚举完成', { total: files.length, ms: Date.now() - t0, root });
      return files;
    },

    /** 读取标签 */
    async readTags(entry) {
      let st = null;
      try { st = fs.statSync(entry.absPath); } catch (_) {}
      const t = tags.readTags(entry.absPath, st);
      return t;
    },

    /** 读取字节流（供 /api/stream 只读直通） */
    async readRange(track, rangeHeader) {
      const abs = path.join(root, track.filePath);
      const size = fs.statSync(abs).size;
      if (!rangeHeader || !config.STREAM_RANGE_ENABLED) {
        return { status: 200, headers: { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }, stream: fs.createReadStream(abs) };
      }
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (!m) {
        return { status: 200, headers: { 'Content-Length': String(size) }, stream: fs.createReadStream(abs) };
      }
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end) start = end;
      return {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
        stream: fs.createReadStream(abs, { start, end }),
      };
    },

    /** 读取本地同名 .lrc（决策 #12 第一优先级） */
    async readLocalLrc(track) {
      const abs = path.join(root, track.filePath);
      const base = abs.replace(/\.[^.]+$/, '');
      for (const p of [base + '.lrc', base + '.LRC']) {
        try {
          if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
        } catch (_) { /* ignore */ }
      }
      return '';
    },
  };
}

module.exports = { create, AUDIO_EXT };
