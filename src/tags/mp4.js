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

/** 遍历一层 boxes，回调 (type, body, offset) */
function walk(buf, start, end, cb) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    let headerSize = 8;
    if (size === 1) {                       // 64 位扩展
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (!Number.isFinite(size) || size < headerSize || off + size > end) break;
    cb(type, buf.slice(off + headerSize, off + size), off);
    off += size;
  }
}

function findBoxPath(buf, path) {
  let range = { start: 0, end: buf.length };
  for (const want of path) {
    let found = null;
    walk(buf, range.start, range.end, (type, body, off) => {
      if (!found && type === want) {
        // 该 box 内容起始（含 header）
        found = { start: off + (body.length === 0 ? 8 : 8), end: off + (body.length + (buf.readUInt32BE(off) === 1 ? 16 : 8)) };
      }
    });
    if (!found) return null;
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

function parseDataAtom(buf) {
  // data box: size(4) 'data'(4) typeIndicator(4) locale(4) value
  if (buf.length < 16) return null;
  const typeInd = buf.readUInt32BE(8);
  const value = buf.slice(16);
  switch (typeInd) {
    case 1: return { kind: 'text', value: value.toString('utf8') };
    case 2: return { kind: 'text', value: value.toString('utf16le').replace(/\0+$/, '') };
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
      if (t2 === 'data' && !parsed) parsed = parseDataAtom(b2.length >= 16 ? b2 : Buffer.concat([Buffer.alloc(0), b2]));
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

  // meta 前有一个 version/flags(4) 头，跳过
  const ilstRange = findBoxPath(buf, ['moov', 'udta', 'meta', 'ilst']);
  if (ilstRange) {
    let r = ilstRange;
    // meta 的内容前 4 字节是 version/flags 时，ilst 定位会偏移，这里做容错重扫
    if (buf.slice(r.start, r.start + 4).toString('latin1') !== 'ilst') {
      const idx = buf.indexOf(Buffer.from('ilst', 'latin1'), r.start - 32);
      if (idx >= 0) r = { start: idx + 4, end: Math.min(idx + 4 + 20000, buf.length) };
    }
    Object.assign(out, parseIlst(buf, r));
  }

  if (out.year) { const m = String(out.year).match(/(\d{4})/); out.year = m ? parseInt(m[1], 10) : 0; }
  return out;
}

module.exports = { parse, walk, parseMvhd };
