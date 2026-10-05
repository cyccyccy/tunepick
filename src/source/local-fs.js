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

/**
 * 扩展名 → Content-Type
 * 未知扩展名返回 ''：由调用方（src/api/stream.js）回落到 application/octet-stream，
 * 避免这里给出比调用方更差的值。
 */
const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  m4b: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  aac: 'audio/aac',
  ape: 'audio/x-ape',
};

/** 按扩展名取 Content-Type（未知返回 ''） */
function mimeFor(ext) {
  return MIME_BY_EXT[String(ext == null ? '' : ext).toLowerCase()] || '';
}

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

/**
 * 让出事件循环一次。
 * 目录枚举是全同步的（readdirSync + statSync），上千个文件走完之前事件循环进不了
 * poll/check 阶段，HTTP 服务照样不响应 —— 与扫描主循环是同一个根因。
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 路径包含校验（P0：路径穿越防护）
 *
 * track.filePath 是入库时的相对路径，但 PATCH /api/tracks/:id 历史上允许改它，
 * 攻击者可以把它写成 ../../../../etc/passwd 再 GET /api/stream/<id> 读宿主任意文件。
 * 因此**读取前一律重新做一次包含校验**，不信任库里的值。
 *
 * @param {string} root     音乐根目录（绝对路径）
 * @param {string} filePath 库内相对路径
 * @returns {string} 解析后的绝对路径
 * @throws {Error} 越出 root 时抛错，带 status=400（上层据此回 400 而不是 500）
 */
function resolveWithinRoot(root, filePath) {
  const rel = String(filePath == null ? '' : filePath);
  if (!rel) {
    throw Object.assign(new Error('曲目缺少 filePath，无法读取'), { status: 400, code: 'bad-path' });
  }
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw Object.assign(
      new Error(`文件路径越出音乐目录（${rel}），已拒绝访问`),
      { status: 400, code: 'path-traversal' },
    );
  }
  return abs;
}

/**
 * 递归枚举目录
 * @param {string} dir      当前目录
 * @param {string} root     音乐根目录
 * @param {Array}  out      结果收集数组
 * @param {number} [depth]  当前深度
 * @param {{count:number}} [budget] 计数（供上层统计）
 * @param {Set<string>} [visited] 已递归过的真实路径（防符号链接环）
 */
async function walk(dir, root, out, depth = 0, budget = { count: 0 }, visited = new Set()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  let filesHere = 0;
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (shouldIgnore(e.name, rel)) continue;

    // 符号链接：Dirent.isDirectory()/isFile() 对软链一律 false，
    // NAS 上大量目录是用软链组织的，不处理会整片目录丢失。
    // 用 statSync（跟随链接）判定真实类型；stat 失败（断链）直接跳过。
    // isSymbolicLink 做能力检测：某些测试/包装对象是普通结构，没有该方法。
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()) {
      try {
        const st = fs.statSync(abs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (_) {
        continue;                                  // 断链：跳过，不能让整库枚举失败
      }
    }

    if (isDir) {
      // 防环：软链互相指向会无限递归，按真实路径去重
      let real = abs;
      try { real = fs.realpathSync(abs); } catch (_) { real = abs; }
      if (visited.has(real)) continue;
      visited.add(real);
      await walk(abs, root, out, depth + 1, budget, visited);
      // 每进出一个子目录让出一次：避免整棵目录树一次性同步走完
      await yieldToEventLoop();
    } else if (isFile) {
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
      // 扁平大目录（几万个文件塞在同一层）时，单层的 statSync 循环同样是一整段
      // 无让出的同步阻塞 —— 按条目分批让出，把卡顿切成碎片而不是一次性冻住服务
      if (++filesHere % 500 === 0) await yieldToEventLoop();
    }
  }
  return out;
}

function create() {
  const root = config.MUSIC_DIR;

  return {
    kind: 'localfs',
    root,

    /**
     * 只读自检：若音乐目录可写，按 PRD §9.1 必须失败
     *
     * ⚠️ 不再用「写探针文件再删」的老办法：
     *    1) root 用户即使只读挂载也可能写成功 → 误判成「可写」而拒绝启动（或反之）；
     *    2) 探针写成功但 unlink 失败时会在音乐目录里留垃圾文件，违反只读约束。
     *    accessSync(W_OK) 语义等价（EROFS / EACCES 都会抛错）且无任何副作用。
     */
    checkReadOnly() {
      try {
        fs.accessSync(root, fs.constants.W_OK);
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
      const files = await walk(root, root, [], 0, { count: 0 }, new Set());
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

    /**
     * 读取字节流（供 /api/stream 只读直通）
     * @param {object} track        库内曲目
     * @param {string} rangeHeader  原始 Range 头
     */
    async readRange(track, rangeHeader) {
      const abs = resolveWithinRoot(root, track.filePath);
      const size = fs.statSync(abs).size;
      const contentType = mimeFor(track.fileExt || path.extname(abs).slice(1));

      // 空文件：直接 200 + Content-Length 0（否则 size-1 会算出 -1，Range 计算全乱）
      if (size === 0) {
        return {
          status: 200,
          headers: {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': '0',
            'Accept-Ranges': 'bytes',
          },
          stream: fs.createReadStream(abs),
        };
      }

      if (!rangeHeader || !config.STREAM_RANGE_ENABLED) {
        return {
          status: 200,
          headers: {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
          },
          stream: fs.createReadStream(abs),
        };
      }

      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (!m) {
        return {
          status: 200,
          headers: {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
          },
          stream: fs.createReadStream(abs),
        };
      }

      let start;
      let end;
      const hasStart = m[1] !== '';
      const hasEnd = m[2] !== '';

      if (!hasStart && hasEnd) {
        // 后缀区间 bytes=-N：语义是「最后 N 字节」，不是「从头到 N」
        const n = parseInt(m[2], 10);
        if (!Number.isFinite(n) || n <= 0) {
          return {
            status: 200,
            headers: {
              'Content-Type': contentType || 'application/octet-stream',
              'Content-Length': String(size),
              'Accept-Ranges': 'bytes',
            },
            stream: fs.createReadStream(abs),
          };
        }
        end = size - 1;
        start = Math.max(0, size - n);
      } else {
        start = hasStart ? parseInt(m[1], 10) : 0;
        end = hasEnd ? parseInt(m[2], 10) : size - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= size) end = size - 1;
        if (start > end) start = end;
      }

      return {
        status: 206,
        headers: {
          'Content-Type': contentType || 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
        stream: fs.createReadStream(abs, { start, end }),
      };
    },

    /** 读取本地同名 .lrc（决策 #12 第一优先级） */
    async readLocalLrc(track) {
      const abs = resolveWithinRoot(root, track.filePath);
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

module.exports = { create, AUDIO_EXT, resolveWithinRoot, mimeFor };
