'use strict';
/**
 * FLAC / OGG 解析（零依赖）
 * FLAC: "fLaC" + metadata blocks；block 0=STREAMINFO（时长）, 4=VORBIS_COMMENT, 6=PICTURE
 * OGG:  OggS 页；第 1 页含 Vorbis 首部，第 2 页起为 comment / setup
 */

const KEYMAP = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumArtist',
  DATE: 'year', GENRE: 'genre', TRACKNUMBER: 'trackNo', DISCNUMBER: 'discNo',
  TRACKTOTAL: 'trackTotal', COMMENT: 'comment', LYRICS: 'lyrics', UNSYNCEDLYRICS: 'lyrics',
};

/* ---------------- FLAC ---------------- */

function parseFlac(buf) {
  if (buf.slice(0, 4).toString('latin1') !== 'fLaC') return null;
  let off = 4;
  const out = { format: 'FLAC' };

  while (off + 4 <= buf.length) {
    const header = buf[off];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const body = buf.slice(off + 4, off + 4 + size);

    if (type === 0) {                       // STREAMINFO → 时长
      const totalSamples = ((body[3] & 0x0f) << 32) | (body[4] << 24) | (body[5] << 16) | (body[6] << 8) | body[7];
      const sampleRate = (body[10] << 12) | (body[11] << 4) | ((body[12] >> 4) & 0x0f);
      if (sampleRate > 0) {
        out.durationSec = Math.round(totalSamples / sampleRate);
        out.sampleRate = sampleRate;
      }
    } else if (type === 4) {                // VORBIS_COMMENT
      Object.assign(out, parseVorbisComment(body));
    } else if (type === 6) {                // PICTURE
      const pic = parseFlacPicture(body);
      if (pic) out.picture = pic;
    }

    off += 4 + size;
    if (isLast) break;
  }
  return out;
}

function parseFlacPicture(b) {
  if (b.length < 32) return null;
  let p = 4;                                     // type(4)
  const mimeLen = b.readUInt32BE(p); p += 4;
  const mime = b.slice(p, p + mimeLen).toString('latin1'); p += mimeLen;
  const descLen = b.readUInt32BE(p); p += 4 + descLen;
  p += 16;                                       // w(4) h(4) depth(4) colors(4)
  const dataLen = b.readUInt32BE(p); p += 4;
  const data = b.slice(p, p + dataLen);
  if (data.length < 64) return null;
  return { mime: mime || 'image/jpeg', data, picType: 3 };
}

/* ---------------- Vorbis Comment（FLAC 与 OGG 共用） ---------------- */

function parseVorbisComment(b) {
  // 有些调用点传入的是去掉类型字节后的内容，这里容错处理
  let p = 0;
  const out = {};
  try {
    const vendorLen = b.readUInt32LE(p);
    p += 4 + vendorLen;
    const count = b.readUInt32LE(p); p += 4;
    for (let i = 0; i < count && p + 4 <= b.length; i++) {
      const len = b.readUInt32LE(p); p += 4;
      if (p + len > b.length) break;
      const entry = b.slice(p, p + len).toString('utf8');
      p += len;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      const k = entry.slice(0, eq).toUpperCase();
      const v = entry.slice(eq + 1);
      const key = KEYMAP[k];
      if (key) out[key] = v;
      else out[k] = v;
    }
  } catch (_) { /* 注释块损坏则忽略 */ }
  normalizeNumbers(out);
  return out;
}

/* ---------------- OGG ---------------- */

function parseOgg(buf) {
  if (buf.slice(0, 4).toString('latin1') !== 'OggS') return null;
  const out = { format: 'OGG' };
  let off = 0;
  const packets = [];

  while (off + 27 <= buf.length) {
    if (buf.slice(off, off + 4).toString('latin1') !== 'OggS') break;
    const segCount = buf[off + 26];
    const segTable = buf.slice(off + 27, off + 27 + segCount);
    let dataLen = 0;
    for (const s of segTable) dataLen += s;
    const dataStart = off + 27 + segCount;
    const data = buf.slice(dataStart, dataStart + dataLen);
    if (data.length) packets.push(data);
    off = dataStart + dataLen;
    if (packets.length >= 3) break;    // identification / comment / setup 足够
  }

  for (const pk of packets) {
    if (pk[0] === 0x01 && pk.slice(1, 7).toString('latin1') === 'vorbis') {
      // identification header → 采样率
      const sampleRate = pk.readUInt32LE(12);
      if (sampleRate > 0) out.sampleRate = sampleRate;
    } else if (pk[0] === 0x03 && pk.slice(1, 7).toString('latin1') === 'vorbis') {
      Object.assign(out, parseVorbisComment(pk.slice(7)));
    }
  }
  return out;
}

function normalizeNumbers(o) {
  if (o.year) { const m = String(o.year).match(/(\d{4})/); o.year = m ? parseInt(m[1], 10) : 0; }
  if (o.trackNo) { const m = String(o.trackNo).match(/(\d+)/); o.trackNo = m ? parseInt(m[1], 10) : 0; }
  if (o.discNo) { const m = String(o.discNo).match(/(\d+)/); o.discNo = m ? parseInt(m[1], 10) : 0; }
}

module.exports = { parseFlac, parseOgg, parseVorbisComment };
