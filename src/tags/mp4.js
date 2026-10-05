'use strict';
/**
 * MP4 / M4A 解析（零依赖）
 * moov > mvhd → 时长；moov > udta > meta > ilst > ©nam/©ART/©alb/©day/©gen/trkn/disk/covr
 */

const ILST_MAP = {
  '©nam': 'title', '©ART': 'artist', '©art': 'artist',
  '©alb': 'album', '©day': 'year', '©gen': 'genre',
  'aART': 'albumArtist', '©too': 'encoder',
};

/**
 * 判断 4 字节 box type 是否可信。
 * MP4 约定 type 为 4 个可打印 ASCII 字符；Apple 的 ilst 键以 0xA9（'©'）打头，
 * 所以 0xA9 必须放行 —— 否则会把 ©nam / ©ART / ©alb / ©day / covr 全部当成垃圾。
 * @param {string} type
 * @returns {boolean}
 */
function isPlausibleBoxType(type) {
  if (typeof type !== 'string' || type.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const c = type.charCodeAt(i);
    if ((c >= 0x20 && c <= 0x7e) || c === 0xa9) continue;   // 0xa9 = '©'
    return false;
  }
  return true;
}

/** 遍历一层 boxes，回调 (type, body, offset) */
function walk(buf, start, end, cb) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    let headerSize = 8;
    if (size === 1) {                       // 64 位扩展：largesize(8) 紧跟在 type 之后
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      // size=0 的语义是「本 box 一直延伸到末尾」。若连这里的 type 都不可信，
      // 说明区间起点本身就错位了（典型：把 full box 的 version/flags 当成了 box 头），
      // 此时再吞掉整个剩余区间只会让后面的查找全部落空 —— 直接停止。
      if (!isPlausibleBoxType(type)) break;
      size = end - off;
    }
    if (!Number.isFinite(size) || size < headerSize || off + size > end) break;
    cb(type, buf.slice(off + headerSize, off + size), off);
    off += size;
  }
}

/**
 * meta 是否为 full box：body 前 4 字节是 version/flags（iTunes/ffmpeg 恒为 0）。
 * 判别条件：body 起点 4 字节为 0，且之后 4 字节（第一个子 box 的 type）可信。
 * 部分老工具写的 meta 没有 version/flags（body 起点就是子 box 的 size，非 0），
 * 该形态必须原样保留。
 * @param {Buffer} buf
 * @param {{start:number,end:number}} r meta 的内容区间
 * @returns {boolean}
 */
function isMetaFullBox(buf, r) {
  if (r.start + 12 > r.end) return false;
  if (buf.readUInt32BE(r.start) !== 0) return false;
  return isPlausibleBoxType(buf.slice(r.start + 8, r.start + 12).toString('latin1'));
}

function findBoxPath(buf, path) {
  let range = { start: 0, end: buf.length };
  for (const want of path) {
    let found = null;
    walk(buf, range.start, range.end, (type, body, off) => {
      if (found || type !== want) return;
      // 头部长度：64 位 box 是 16（size + type + largesize），其余是 8（size + type）
      const headerSize = buf.readUInt32BE(off) === 1 ? 16 : 8;
      found = { start: off + headerSize, end: off + headerSize + body.length };
    });
    if (!found) return null;
    // meta 是 full box 时子 box 从 version/flags 之后开始
    if (want === 'meta' && isMetaFullBox(buf, found)) found.start += 4;
    range = found;
  }
  return range;
}

function parseMvhd(buf) {
  const r = findBoxPath(buf, ['moov', 'mvhd']);
  if (!r) return null;
  const b = buf.slice(r.start, r.end);
  if (b.length < 20) return null;
  const version = b[0];
  let timescale, duration;
  if (version === 1) {
    timescale = b.readUInt32BE(20);
    duration = Number(b.readBigUInt64BE(24));
  } else {
    timescale = b.readUInt32BE(12);
    duration = b.readUInt32BE(16);
  }
  if (!timescale) return null;
  return { durationSec: Math.round(duration / timescale) };
}

/** ilst data atom 的已知 typeIndicator */
const DATA_TYPES = new Set([1, 2, 13, 14, 21]);

/** 给 box body 补一个标准 8 字节头（size + type），便于按「含头整箱」约定解析 */
function withBoxHeader(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/**
 * 解析 data atom（**入参必须含 8 字节头**）
 * 布局：size(4) 'data'(4) typeIndicator(4) locale(4) value
 * typeIndicator：1=UTF-8  2=UTF-16BE  13=JPEG  14=PNG  21=BE int
 * @param {Buffer} buf
 * @returns {{kind:string,value:*,mime?:string}|null}
 */
function parseDataAtom(buf) {
  if (buf.length < 16) return null;
  let typeInd = buf.readUInt32BE(8);
  let valueOff = 16;
  // 容错：个别工具在 typeIndicator 前多写 4 个字节（多余的保留字段 / 伪 version）。
  // 仅当标准偏移读到的值不是已知类型、且右移 4 字节后是已知类型时才让位，
  // 标准布局（typeInd 合法）完全不受影响。
  if (!DATA_TYPES.has(typeInd) && buf.length >= 20 && DATA_TYPES.has(buf.readUInt32BE(12))) {
    typeInd = buf.readUInt32BE(12);
    valueOff = 20;
  }
  const value = buf.slice(valueOff);
  switch (typeInd) {
    case 1: return { kind: 'text', value: value.toString('utf8').replace(/\0+$/, '') };
    // Node 无 utf16be：UTF-16BE 先交换字节序，再按 utf16le 解
    case 2: return { kind: 'text', value: Buffer.from(value).swap16().toString('utf16le').replace(/\0+$/, '') };
    case 13: return { kind: 'image', mime: 'image/jpeg', value };
    case 14: return { kind: 'image', mime: 'image/png', value };
    case 21: return { kind: 'int', value };
    default: return { kind: 'text', value: value.toString('utf8').replace(/\0+$/, '') };
  }
}

function parseIlst(buf, range) {
  const out = {};
  walk(buf, range.start, range.end, (type, body) => {
    // 标记类 atom（trkn/disk）内部还有 data atom
    let parsed = null;
    walk(body, 0, body.length, (t2, b2) => {
      if (t2 !== 'data' || parsed) return;
      // walk 给的是 body，而 parseDataAtom 的约定是「含 8 字节头的整箱」，补回头再解析
      parsed = parseDataAtom(withBoxHeader('data', b2));
    });
    if (!parsed) {
      // 直接就是 data box 的情况
      if (body.slice(4, 8).toString('latin1') === 'data') parsed = parseDataAtom(body);
    }
    if (!parsed) return;

    if (type === 'covr' && parsed.kind === 'image') {
      out.picture = { mime: parsed.mime, data: parsed.value, picType: 3 };
      return;
    }
    if (type === 'trkn' && parsed.kind === 'int') {
      out.trackNo = parsed.value.length >= 4 ? parsed.value.readUInt16BE(2) : 0;
      return;
    }
    if (type === 'disk' && parsed.kind === 'int') {
      out.discNo = parsed.value.length >= 4 ? parsed.value.readUInt16BE(2) : 0;
      return;
    }
    if (parsed.kind === 'text') {
      const key = ILST_MAP[type] || type;
      out[key] = parsed.value;
    }
  });
  return out;
}

function parse(buf) {
  if (buf.length < 12) return null;
  // ftyp 通常在开头
  const hasFtyp = buf.slice(4, 8).toString('latin1') === 'ftyp';
  const hasMoov = buf.indexOf(Buffer.from('moov', 'latin1')) >= 0;
  if (!hasFtyp && !hasMoov) return null;

  const out = { format: 'M4A' };
  const mv = parseMvhd(buf);
  if (mv) out.durationSec = mv.durationSec;

  // meta 是 full box 时 body 前 4 字节是 version/flags，findBoxPath 已处理
  const ilstRange = findBoxPath(buf, ['moov', 'udta', 'meta', 'ilst']);
  if (ilstRange) {
    let r = ilstRange;
    // 容错重扫：正常情况下 r.start 就是 ilst 的 body 起点，
    // 其前 4 字节（box header 的 type 字段）应该是 'ilst'；不是则说明
    // box 树推导与实际字节不一致（破损文件），按魔数再定位一次。
    if (buf.slice(Math.max(0, r.start - 4), r.start).toString('latin1') !== 'ilst') {
      const idx = buf.indexOf(Buffer.from('ilst', 'latin1'), Math.max(0, r.start - 32));
      if (idx >= 0) {
        // 兜底区间优先用 findBoxPath 算出的 end —— 不再用 20000 魔数截断，
        // 否则大 ilst（往往 >20KB）里靠后的 atom（常是 covr 封面）会被静默丢弃
        const end = r.end > idx + 4
          ? Math.min(r.end, buf.length)
          : Math.min(idx + 4 + 20000, buf.length);
        r = { start: idx + 4, end };
      }
    }
    Object.assign(out, parseIlst(buf, r));
  }

  if (out.year) { const m = String(out.year).match(/(\d{4})/); out.year = m ? parseInt(m[1], 10) : 0; }
  return out;
}

module.exports = { parse, walk, parseMvhd };
