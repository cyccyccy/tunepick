'use strict';
/**
 * ID3v2.3 / v2.4 解析（零依赖）
 * 帧映射：TIT2→title  TPE1→artist  TALB→album  TDRC/TYER→year
 *         TCON→genre  TRCK→trackNo  TPOS→discNo  TPE2→albumArtist
 *         APIC→内嵌封面  USLT→内嵌歌词
 */

const TAGS = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumArtist',
  TDRC: 'year', TYER: 'year', TDOR: 'origYear', TCON: 'genre',
  TRCK: 'trackNo', TPOS: 'discNo', COMM: 'comment',
};

/** synchsafe 整数（每字节 7 位）→ 普通整数 */
function synchsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) |
         ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function be32(buf, off) {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

/** 按 encoding byte 解码文本 */
function decodeText(buf, enc) {
  try {
    if (enc === 1) {           // UTF-16 with BOM
      let s = buf.toString('utf16le');
      if (s.charCodeAt(0) === 0xfeff || s.charCodeAt(0) === 0xfffe) s = s.slice(1);
      return s.replace(/\0+$/, '');
    }
    if (enc === 2) return buf.toString('utf16le').replace(/\0+$/, ''); // UTF-16BE（Node 无 utf16be，近似）
    if (enc === 3) return buf.toString('utf8').replace(/\0+$/, '');
    return buf.toString('latin1').replace(/\0+$/, '');                 // 0 = ISO-8859-1
  } catch (_) {
    return buf.toString('utf8').replace(/\0+$/, '');
  }
}

/** 找以 0 结尾的 C 字符串（按编码可能是 1 或 2 字节 0） */
function findZero(buf, start, enc) {
  const step = enc === 1 || enc === 2 ? 2 : 1;
  for (let i = start; i + step - 1 < buf.length; i += step) {
    if (step === 1) { if (buf[i] === 0) return i; }
    else if (buf[i] === 0 && buf[i + 1] === 0) return i;
  }
  return -1;
}

function parseFrameBody(id, data) {
  if (data.length === 0) return null;
  const enc = data[0];

  // 内嵌图片
  if (id === 'APIC') {
    let p = 1;
    const zero = findZero(data, p, 0);
    if (zero < 0) return null;
    const mime = data.slice(p, zero).toString('latin1');
    p = zero + 1;
    const picType = data[p] || 0;    // 3 = 封面（front cover）
    p += 1;
    const descEnd = findZero(data, p, enc);
    if (descEnd < 0) return null;
    p = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
    const img = data.slice(p);
    if (img.length < 64) return null;   // 太小的图视为无效
    return { picture: { mime: mime || 'image/jpeg', data: img, picType } };
  }

  // 内嵌歌词
  if (id === 'USLT') {
    if (data.length < 5) return null;
    const p = 4;                          // enc(1) + lang(3)
    const descEnd = findZero(data, p, enc);
    if (descEnd < 0) return null;
    const textStart = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
    return { lyrics: decodeText(data.slice(textStart), enc) };
  }

  // 普通文本帧
  return { text: decodeText(data.slice(1), enc) };
}

/**
 * 从缓冲区解析 ID3v2
 * @param {Buffer} buf 整个文件（或至少前 64KB + 标签区）
 * @returns {object|null}
 */
function parse(buf) {
  if (buf.length < 10 || buf.slice(0, 3).toString('latin1') !== 'ID3') return null;

  const ver = buf[3];                       // 3 = v2.3, 4 = v2.4
  const flags = buf[5];
  const size = synchsafe(buf, 6);
  let off = 10;

  // 扩展头（v2.4 flag 0x40）
  if (ver === 4 && (flags & 0x40)) {
    const extSize = synchsafe(buf, off);
    off += extSize;
  }

  const end = Math.min(10 + size, buf.length);
  const out = { _version: ver };

  while (off + 10 <= end) {
    const id = buf.slice(off, off + 4).toString('latin1');
    if (!/^[A-Z0-9]{4}$/.test(id)) break;   // 遇到非法帧 ID，标签区结束

    let fsize;
    if (ver === 4) fsize = synchsafe(buf, off + 4);
    else fsize = be32(buf, off + 4);
    if (!Number.isFinite(fsize) || fsize <= 0 || fsize > buf.length) break;

    const fflags = (buf[off + 8] << 8) | buf[off + 9];
    const dataStart = off + 10;
    const dataEnd = Math.min(dataStart + fsize, end);

    // 压缩/加密帧跳过
    const compressed = ver === 4 ? (fflags & 0x0008) : (fflags & 0x0080);
    if (!compressed) {
      let data = buf.slice(dataStart, dataEnd);
      // 反同步（v2.3 flag 0x80 / v2.4 整标签 flag 0x80）
      if (ver === 3 && (fflags & 0x0080)) {
        data = Buffer.from(data.toString('latin1').replace(/\xff\x00/g, '\xff'), 'latin1');
      }
      try {
        const r = parseFrameBody(id, data);
        if (r) {
          if (r.picture) out.picture = r.picture;
          if (r.lyrics) out.lyrics = r.lyrics;
          if (r.text !== undefined) {
            const key = TAGS[id];
            if (key) out[key] = r.text;
            else out[id] = r.text;
          }
        }
      } catch (_) { /* 单帧失败不影响整体 */ }
    }

    off = dataEnd;
  }

  // 数值字段规整
  if (out.year) {
    const m = String(out.year).match(/(\d{4})/);
    out.year = m ? parseInt(m[1], 10) : 0;
  }
  if (out.trackNo) {
    const m = String(out.trackNo).match(/(\d+)/);
    out.trackNo = m ? parseInt(m[1], 10) : 0;
  }
  if (out.discNo) {
    const m = String(out.discNo).match(/(\d+)/);
    out.discNo = m ? parseInt(m[1], 10) : 0;
  }
  return out;
}

/**
 * MP3 时长估算（CBR）：首帧 bitrate + 文件大小
 * 有 Xing/Info 头时更准，此处用 CBR 近似（DESIGN D-02）
 */
function mp3Duration(buf, fileSize) {
  // 跳过 ID3v2
  let off = 0;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') {
    off = 10 + synchsafe(buf, 6);
  }
  const BR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const SR = [44100, 48000, 32000];
  for (let i = off; i + 4 <= Math.min(buf.length, off + 200000); i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const b = buf[i + 2];
      const brIdx = (b >> 4) & 0x0f;
      const srIdx = (b >> 2) & 0x03;
      const bitrate = BR[brIdx];
      const sampleRate = SR[srIdx];
      if (!bitrate || !sampleRate) continue;
      const padding = (b >> 1) & 0x01;
      // 估算时长（秒）
      const audioBytes = fileSize - off;
      return { durationSec: Math.round(audioBytes * 8 / (bitrate * 1000)), bitrate, sampleRate, _padding: padding };
    }
  }
  return { durationSec: 0, bitrate: 0, sampleRate: 0 };
}

module.exports = { parse, mp3Duration, synchsafe, decodeText };
