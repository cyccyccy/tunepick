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

    /* 单块隔离：任何一个元数据块解析失败都不得连带作废**已经解析出来的结果**。
     * 现实教训就是 PICTURE —— 它一度因缺少边界检查而抛 RangeError，
     * 而调用方（tags/index.js）是整体 try/catch，一次抛错会把前面
     * 已经算好的 durationSec / title / artist 全部丢掉，降级成「仅文件名」，
     * 落库后是 durationSec=0 —— 与本解析器另一处 STREAMINFO 偏移 bug 的症状**一模一样**，
     * 会被误判成「修复没生效」。宁可丢一块封面，不可丢整份标签。 */
    try {
      if (type === 0) {                       // STREAMINFO → 时长
        // STREAMINFO body 布局（body 已跳过 4 字节块头）：
        //   0-1 minBlockSize | 2-3 maxBlockSize | 4-6 minFrameSize | 7-9 maxFrameSize
        //   10-12 采样率（20bit，body[12] 高 4 位收尾）| 12 低 4 位起声道数(3bit) + 位深(5bit)
        //   13 低 4 位 + 14-17 共 36bit = totalSamples
        // 注意 JS 的 << 32 等于 << 0，必须用乘法接高 4 位（原代码正是踩了这个 + 偏移错两重坑）
        // ⚠️ 长度不足 18 字节（即读不到 body[17]）时**一律不解析**：
        //   块头声明的 size 大于实际读到的字节数（文件被截断 / 头部读取窗口不足）时，
        //   body[13..17] 全是 undefined，而 JS 位运算会把 undefined 当 0 处理 ——
        //   结果不是 NaN，而是**静默算出一个看起来合法的值**。实测（44100Hz / 270s 的样本）：
        //     12 字节 → sampleRate=44096（错）、durationSec=0（错）
        //     13-14 字节 → sampleRate=44100（对）、durationSec=0（错）
        //     17 字节 → 少读一个字节，采样数少 184，靠四舍五入才碰巧仍是 270
        //   这类值是有限数，能过 Number.isFinite，会**直接写进 db**，比 NaN 更难发现。
        //   所以长度不够就什么都不设，由调用方（tags/index.js 的 base）兜成 0：
        //   宁可缺字段，不可造数据。
        if (body.length >= 18) {
          const totalSamplesLo = (body[14] << 24) | (body[15] << 16) | (body[16] << 8) | body[17];
          const totalSamples = (body[13] & 0x0f) * 0x100000000 + (totalSamplesLo >>> 0);
          const sampleRate = (body[10] << 12) | (body[11] << 4) | ((body[12] >> 4) & 0x0f);
          if (sampleRate > 0) {
            out.durationSec = Math.round(totalSamples / sampleRate);
            out.sampleRate = sampleRate;
          }
        }
      } else if (type === 4) {                // VORBIS_COMMENT
        Object.assign(out, parseVorbisComment(body));
      } else if (type === 6) {                // PICTURE
        const pic = parseFlacPicture(body);
        if (pic) out.picture = pic;
      }
    } catch (_) { /* 单个元数据块损坏：跳过它，保留其余字段 */ }

    off += 4 + size;
    if (isLast) break;
  }
  return out;
}

function parseFlacPicture(b) {
  if (b.length < 32) return null;
  /* PICTURE 的四个长度字段（mimeLen / descLen / 定长 16 字节 / dataLen）来自文件，
   * 任何一个是"说谎"的值都会把读指针推到 body 之外 —— readUInt32BE 会抛 RangeError，
   * 异常一路抛到 tags/index.js 的整体 try/catch，连累已经解析好的 STREAMINFO（时长）。
   * 这里**用边界检查而不是 try/catch**：异常捕获会把真正的编码错误一起吞掉，
   * 而逐段校验能明确指出"这段长度越界了"，且对合法封面零影响。 */
  let p = 4;                                     // type(4)
  if (p + 4 > b.length) return null;
  const mimeLen = b.readUInt32BE(p); p += 4;
  if (p + mimeLen > b.length) return null;       // mime 长度越界
  const mime = b.slice(p, p + mimeLen).toString('latin1'); p += mimeLen;
  if (p + 4 > b.length) return null;
  const descLen = b.readUInt32BE(p); p += 4;
  if (p + descLen > b.length) return null;       // 描述长度越界（真会炸的一种：descLen 说谎）
  p += descLen;
  if (p + 16 > b.length) return null;            // w(4) h(4) depth(4) colors(4)
  p += 16;
  if (p + 4 > b.length) return null;
  const dataLen = b.readUInt32BE(p); p += 4;
  if (p + dataLen > b.length) return null;       // 图片数据长度越界
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
    // 单包隔离：同 parseFlac，一个包坏不影响其它包
    try {
      if (pk[0] === 0x01 && pk.slice(1, 7).toString('latin1') === 'vorbis') {
        // identification header → 采样率。必须至少 16 字节才够读到 offset 12 起的 4 字节，
        // 短包（实测 10 字节）会抛 RangeError: must be <= 6. Received 12
        if (pk.length >= 16) {
          const sampleRate = pk.readUInt32LE(12);
          if (sampleRate > 0) out.sampleRate = sampleRate;
        }
      } else if (pk[0] === 0x03 && pk.slice(1, 7).toString('latin1') === 'vorbis') {
        Object.assign(out, parseVorbisComment(pk.slice(7)));
      }
    } catch (_) { /* 单包损坏则跳过 */ }
  }
  return out;
}

function normalizeNumbers(o) {
  if (o.year) { const m = String(o.year).match(/(\d{4})/); o.year = m ? parseInt(m[1], 10) : 0; }
  if (o.trackNo) { const m = String(o.trackNo).match(/(\d+)/); o.trackNo = m ? parseInt(m[1], 10) : 0; }
  if (o.discNo) { const m = String(o.discNo).match(/(\d+)/); o.discNo = m ? parseInt(m[1], 10) : 0; }
}

module.exports = { parseFlac, parseOgg, parseVorbisComment };
