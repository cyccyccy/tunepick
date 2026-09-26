'use strict';
/**
 * 单元：FLAC STREAMINFO 时长解析（src/tags/flac.js）
 *
 * 背景（真机取证，非推理）：线上曲库 2907 首里 FLAC 共 12 首，**12 首时长全部 <30s**。
 *   晴天（真机新下载）  现有解析 4s   / 规范手算 270s / 上游值 269s
 *   断桥残雪（已入库）  现有解析 0s   / 规范手算 227s / 上游值 227s
 * 根因两重：
 *   1) 字节偏移错 —— totalSamples 在 body[13] 低 4 位 + body[14..17]，
 *      旧代码却去读 body[3..7]（minFrameSize / maxFrameSize 区间）。
 *   2) `(x & 0x0f) << 32` 在 JS 里位移量取模 32，`<< 32` 等价 `<< 0`，高 4 位被吞掉。
 *
 * 方法：**不提交任何二进制 fixture**，在测试里按 FLAC 规范逐位拼出 34 字节 STREAMINFO
 *   再喂给真实解析器。理由：二进制 fixture 只能证明「这几个文件当时是对的」，
 *   而手工拼装把位布局写在测试代码里 —— 规范理解偏了或实现偏了都会红。
 *
 * 覆盖：
 *   A. 真机两组取样（270s / 227s）
 *   B. 两组 >2^32 采样（高 4 位 =1 与 =15），专杀 `<< 32` 折叠那个坑
 *      —— 只测小文件（高 4 位恒为 0）是**抓不到**这个坑的
 *   C. 不同采样率（96kHz）确认除数路径没被写死成 44100
 *   D. 旧 bug 回归诱饵：minFrameSize 取真机同量级值 688，
 *      旧公式在这组字节上正好算出真机那个 4s，新实现必须是 270s
 *   E. 采样率解析（body[10..12]）未被本次改动波及
 *   F. 截断 STREAMINFO 的长度防御（body.length < 18 一律不解析）
 *      —— 守门：12 / 13 / 14 / 17 字节（加保护前会算出 44096 / 0 / 0 / 270 这些"看起来合法"的值）
 *      —— 哨兵：8 / 10 字节（加保护前本来就不解析，绿不代表有鉴别力）
 *
 * ⚠️ 构造 fixture 的陷阱（都是真踩过的，改本文件时先读一遍）：
 *   1. Vorbis 打包顺序必须是 vendorLen(4) + vendor + count(4) + entries(len + 串)。
 *      写成「Buffer.alloc(4) + 带长度前缀的 vendor」会让 count 读成垃圾 → 标题全丢，
 *      表现为「解析成功但字段为空」，很容易误判成解析器的问题。
 *   2. 魔法串是 'vorbis'（6 字节）。写成 'vorb' 会**静默跳过分支**
 *      —— 表现为「居然没抛异常」，极易被误读成「这条路径是安全的」。
 *      所以：**下任何负面结论之前，先确认分支真的进了**。
 *   3. 超过 32bit 的整数一律不许用位移：JS 的位移量取模 32，
 *      `x << 32` 等价于 `x << 0`、`x >>> 35` 等价于 `x >>> 3`。
 *      接高 4 位只能用乘法（见 src/tags/flac.js 的 totalSamples）。
 *   4. 判「守门」还是「哨兵」，标准是**把实现改回旧写法后这条会不会红**；
 *      不会红的只能标哨兵，别混进守门里充数。
 *
 * 运行：node tests/unit-flac-streaminfo.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFlac } = require('../src/tags/flac');
const { readTags } = require('../src/tags/index');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

/* ==========================================================================
 * 合成 STREAMINFO（按规范逐位拼装）
 * ========================================================================== */

/** 写 24bit 大端 */
function writeUInt24(b, off, v) {
  b[off] = (v >> 16) & 0xff;
  b[off + 1] = (v >> 8) & 0xff;
  b[off + 2] = v & 0xff;
  return b;
}

/**
 * 拼 34 字节 STREAMINFO body
 * @param {object} o
 * @param {number} o.totalSamples 36bit，允许超过 2^32
 * @param {number} o.sampleRate  20bit，如 44100 / 96000
 * @param {number} [o.channels=2]
 * @param {number} [o.bps=16]
 * @param {number} [o.minBlockSize=4096]
 * @param {number} [o.maxBlockSize=4096]
 * @param {number} [o.minFrameSize=1024]
 * @param {number} [o.maxFrameSize=8192]
 * @returns {Buffer}
 */
function makeStreamInfo(o) {
  const totalSamples = o.totalSamples;
  const sampleRate = o.sampleRate;
  const channels = o.channels == null ? 2 : o.channels;
  const bps = o.bps == null ? 16 : o.bps;
  const minBlockSize = o.minBlockSize == null ? 4096 : o.minBlockSize;
  const maxBlockSize = o.maxBlockSize == null ? 4096 : o.maxBlockSize;
  const minFrameSize = o.minFrameSize == null ? 1024 : o.minFrameSize;
  const maxFrameSize = o.maxFrameSize == null ? 8192 : o.maxFrameSize;

  const b = Buffer.alloc(34);

  // 0-1 minBlockSize / 2-3 maxBlockSize
  b.writeUInt16BE(minBlockSize, 0);
  b.writeUInt16BE(maxBlockSize, 2);
  // 4-6 minFrameSize / 7-9 maxFrameSize（24bit）
  writeUInt24(b, 4, minFrameSize);
  writeUInt24(b, 7, maxFrameSize);

  // 10-12 采样率 20bit：body[10] 高 8 位、body[11] 中 8 位、body[12] 高 4 位收尾
  b[10] = (sampleRate >> 12) & 0xff;
  b[11] = (sampleRate >> 4) & 0xff;
  // body[12]：高 4 位 = 采样率低 4 位；接 3bit 声道数(channels-1)、1bit 位深最高位
  b[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | (((bps - 1) >> 4) & 0x01);
  // body[13]：高 4 位 = 位深低 4 位；低 4 位 = totalSamples 的 35..32 位
  b[13] = (((bps - 1) & 0x0f) << 4) | (Math.floor(totalSamples / 0x100000000) & 0x0f);
  // 14-17 totalSamples 的 31..0 位
  b.writeUInt32BE(totalSamples % 0x100000000, 14);
  // 18-33 MD5：全 0 即可，解析器不读
  return b;
}

/** 包成最小 FLAC 文件头："fLaC" + 块头(最后一块, type=0) + body */
function makeFlac(body) {
  const head = Buffer.from('fLaC', 'latin1');
  const blk = Buffer.alloc(4);
  blk[0] = 0x80;                    // 1<<7 = 最后一个元数据块；type 0 = STREAMINFO
  writeUInt24(blk, 1, body.length);
  return Buffer.concat([head, blk, body]);
}

/**
 * 旧实现的错误公式（逐字保留，仅用于证明测试用例具备鉴别力）
 * 注意 `(x & 0x0f) << 32` 在 JS 中位移量取模 32，等价于 `<< 0`。
 */
function oldTotalSamples(body) {
  return ((body[3] & 0x0f) << 32) | (body[4] << 24) | (body[5] << 16) | (body[6] << 8) | body[7];
}

/* ==========================================================================
 * A. 真机两组取样
 * ========================================================================== */
console.log('\nA. 真机取样（晴天 270s / 断桥残雪 227s）');

// 晴天：44100 × 270 = 11,907,000（< 2^32，高 4 位 = 0）
{
  const t = parseFlac(makeFlac(makeStreamInfo({ totalSamples: 11907000, sampleRate: 44100 })));
  eq('晴天 totalSamples=11,907,000 / 44100 → 270s（旧实现为 4s）', t && t.durationSec, 270);
  eq('晴天 sampleRate 解析正确', t && t.sampleRate, 44100);
}

// 断桥残雪：44100 × 227 = 10,010,700（< 2^32）
{
  const t = parseFlac(makeFlac(makeStreamInfo({ totalSamples: 10010700, sampleRate: 44100 })));
  eq('断桥残雪 totalSamples=10,010,700 / 44100 → 227s（旧实现为 0s）', t && t.durationSec, 227);
}

/* ==========================================================================
 * B. >2^32 采样：专杀 `<< 32` 折叠坑
 * ========================================================================== */
console.log('\nB. 超过 2^32 采样（高 4 位非 0）');

// 高 4 位 = 1：44100 × 100000 = 4,410,000,000（> 2^32 = 4,294,967,296）
{
  const total = 4410000000;
  ok('用例前提：4,410,000,000 > 2^32', total > 0x100000000, String(total));
  const t = parseFlac(makeFlac(makeStreamInfo({ totalSamples: total, sampleRate: 44100 })));
  eq('totalSamples=4,410,000,000（高 4 位=1）/ 44100 → 100000s', t && t.durationSec, 100000);
}

// 高 4 位 = 15（36bit 取值上限）：44100 × 1,460,874 = 64,424,543,400
{
  const total = 64424543400;
  const hi = Math.floor(total / 0x100000000);
  ok('用例前提：高 4 位 = 15', hi === 15, '实际高 4 位=' + hi);
  const t = parseFlac(makeFlac(makeStreamInfo({ totalSamples: total, sampleRate: 44100 })));
  eq('totalSamples=64,424,543,400（高 4 位=15）/ 44100 → 1460874s', t && t.durationSec, 1460874);
  ok('结果未丢精度（有限数且 > 2^32/44100）',
    Number.isFinite(t.durationSec) && t.durationSec > 97391, String(t.durationSec));
}

/* ==========================================================================
 * C. 不同采样率
 * ========================================================================== */
console.log('\nC. 采样率 96kHz（除数路径未被写死）');

{
  // 96000 × 180 = 17,280,000
  const t = parseFlac(makeFlac(makeStreamInfo({ totalSamples: 17280000, sampleRate: 96000 })));
  eq('totalSamples=17,280,000 / 96000 → 180s', t && t.durationSec, 180);
  eq('sampleRate 解析为 96000', t && t.sampleRate, 96000);
}

/* ==========================================================================
 * D. 旧 bug 回归诱饵：真机同量级 minFrameSize 不得再影响结果
 * ========================================================================== */
console.log('\nD. 旧 bug 回归诱饵（minFrameSize=688 在旧公式下正是真机那个 4s）');

{
  const body = makeStreamInfo({
    totalSamples: 11907000,
    sampleRate: 44100,
    minBlockSize: 4096,
    maxBlockSize: 4096,
    minFrameSize: 688,        // 真机同量级；旧公式误读成 688<<8 = 176,128
    maxFrameSize: 30000,
  });
  const oldNs = oldTotalSamples(body);
  eq('鉴别力自检：旧公式在同一 buffer 上确实得出 176,128 采样', oldNs, 176128);
  eq('鉴别力自检：即真机那个 4s', Math.round(oldNs / 44100), 4);

  const t = parseFlac(makeFlac(body));
  eq('新实现不受诱饵字节影响 → 270s', t && t.durationSec, 270);
}

/* ==========================================================================
 * E. 基本形态
 * ========================================================================== */
console.log('\nE. 基本形态');

{
  const t = parseFlac(makeFlac(makeStreamInfo({ totalSamples: 11907000, sampleRate: 44100 })));
  eq('format 标记为 FLAC', t && t.format, 'FLAC');
  ok('durationSec 是有限正整数', Number.isFinite(t.durationSec) && t.durationSec > 0, String(t.durationSec));
}

{
  const bad = parseFlac(Buffer.from('RIFF0000', 'latin1'));
  ok('非 fLaC 头返回 null（不抛异常）', bad === null, String(bad));
}

/* ==========================================================================
 * F. 截断 STREAMINFO 的长度防御（body.length < 18 一律不解析）
 * ========================================================================== */
console.log('\nF. 截断 STREAMINFO 的长度防御');
{
  // 真值样本：44100Hz / 270s
  const full = makeStreamInfo({ totalSamples: 11907000, sampleRate: 44100 });

  // ---- 守门段：加保护前会算出「看起来合法」的错误值，保护后必须什么都不设 ----
  {
    // 12 字节：旧行为 sampleRate=44096（错）、durationSec=0（错）
    const t = parseFlac(makeFlac(full.slice(0, 12)));
    ok('[守门] 12 字节：不得设置 durationSec（旧行为伪造 0）',
      t.durationSec === undefined, String(t.durationSec));
    ok('[守门] 12 字节：不得设置 sampleRate（旧行为伪造 44096）',
      t.sampleRate === undefined, String(t.sampleRate));
  }
  for (const n of [13, 14]) {
    // 13 / 14 字节：旧行为 sampleRate 对，但 durationSec 被伪造为 0
    const t = parseFlac(makeFlac(full.slice(0, n)));
    ok(`[守门] ${n} 字节：不得设置 durationSec（旧行为伪造 0）`,
      t.durationSec === undefined, String(t.durationSec));
  }
  {
    // 17 字节：差最后一个字节，旧行为少算 184 采样，靠四舍五入才碰巧仍是 270
    const t = parseFlac(makeFlac(full.slice(0, 17)));
    ok('[守门] 17 字节：不得设置 durationSec（旧行为靠四舍五入碰巧得 270）',
      t.durationSec === undefined, String(t.durationSec));
  }

  // ---- 哨兵段：加保护前本来就不解析，绿不代表有鉴别力，单独标注 ----
  for (const n of [8, 10]) {
    const t = parseFlac(makeFlac(full.slice(0, n)));
    ok(`[哨兵] ${n} 字节：不设置 durationSec（保护前亦如此）`,
      t.durationSec === undefined, String(t.durationSec));
  }

  // ---- 边界：18 字节恰好够，必须解析正确（防御不能把合法样本也挡掉）----
  {
    const t = parseFlac(makeFlac(full.slice(0, 18)));
    eq('[边界] 18 字节恰好够：durationSec 应为 270', t.durationSec, 270);
    eq('[边界] 18 字节恰好够：sampleRate 应为 44100', t.sampleRate, 44100);
  }

  // ---- 关键不变量：绝不出现 NaN / null ----
  {
    let dirty = '';
    for (let n = 0; n <= 34; n++) {
      const t = parseFlac(makeFlac(full.slice(0, n)));
      const d = t && t.durationSec;
      if (d !== undefined && (Number.isNaN(d) || d === null)) dirty = `N=${n} → ${String(d)}`;
    }
    ok('[不变量] 0..34 字节全长度扫描：durationSec 绝不出现 NaN / null', !dirty, dirty);
  }

  // ---- 端到端：走 tags/index.js 的 base 兜底，落库值必须是 0 ----
  {
    const dir = path.join(os.tmpdir(), 'tp-unit-flac-trunc');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'truncated.flac');
    try {
      fs.writeFileSync(file, makeFlac(full.slice(0, 10)));
      const tags = readTags(file);
      eq('[端到端] 10 字节截断文件：readTags 的 durationSec === 0', tags.durationSec, 0);
      eq('[端到端] 10 字节截断文件：readTags 的 sampleRate === 0', tags.sampleRate, 0);
      ok('[端到端] durationSec 不是 NaN', !Number.isNaN(tags.durationSec), String(tags.durationSec));
      ok('[端到端] JSON 序列化后仍是 0 而不是 null',
        JSON.parse(JSON.stringify({ durationSec: tags.durationSec })).durationSec === 0,
        JSON.stringify(tags.durationSec));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结果 */ }
    }
  }
}

/* ==========================================================================
 * G. PICTURE / OGG 的健壮性：坏块不得连带丢失已解析的真实数据
 *
 * 背景（QA 独立发现 + 二次确认）：`parseFlacPicture` 原本没有任何边界检查，
 * 一旦某个长度字段"说谎"（如 descLen 声明 1000 但 body 只有几十字节），
 * readUInt32BE 会抛 RangeError，异常穿过 parseFlac 抵达 tags/index.js 的整体
 * try/catch —— **连累已经在它之前解析好的 STREAMINFO 时长一起作废**，
 * 落库成 durationSec=0。这个症状与本轮修复的偏移 bug **完全一致**，
 * 上线后会被误判成「修复没生效」。所以必须进来不会因为一片垃圾封面丢整份标签。
 *
 * 判别力：**把 src/tags/flac.js 的 per-block try/catch 与边界检查同时撤掉，
 * 下面 G2/G3/G4/G5 会立刻红**（ParamError 上抛 → 字段全空）。
 * ========================================================================== */

/** 拼 Vorbis Comment body：vendorLen(4) + vendor + count(4) + [len(4) + 串] */
function makeVorbisBody(entries) {
  const vendor = Buffer.from('tunepick', 'utf8');
  const head = Buffer.alloc(4 + vendor.length + 4);
  head.writeUInt32LE(vendor.length, 0);
  vendor.copy(head, 4);
  head.writeUInt32LE(entries.length, 4 + vendor.length);
  const parts = [head];
  for (const e of entries) {
    const s = Buffer.from(e, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(s.length, 0);
    parts.push(len, s);
  }
  return Buffer.concat(parts);
}

/**
 * 拼 PICTURE body
 * @param {object} o 允许通过 lie.descLen / lie.mimeLen / lie.dataLen 注入"说谎"的长度
 */
function makePictureBody(o) {
  const mimeStr = o.mime == null ? 'image/jpeg' : o.mime;
  const descStr = o.desc == null ? 'cover' : o.desc;
  const data = o.data || Buffer.alloc(200, 0x41);
  const mime = Buffer.from(mimeStr, 'latin1');
  const desc = Buffer.from(descStr, 'utf8');
  const buf = Buffer.alloc(4 + 4 + mime.length + 4 + desc.length + 16 + 4 + data.length);
  let p = 0;
  buf.writeUInt32BE(3, p); p += 4;                       // picType = 3（封面）
  buf.writeUInt32BE((o.lie && o.lie.mimeLen) != null ? o.lie.mimeLen : mime.length, p); p += 4;
  mime.copy(buf, p); p += mime.length;
  buf.writeUInt32BE((o.lie && o.lie.descLen) != null ? o.lie.descLen : desc.length, p); p += 4;
  desc.copy(buf, p); p += desc.length;
  p += 16;                                              // w / h / depth / colors
  buf.writeUInt32BE((o.lie && o.lie.dataLen) != null ? o.lie.dataLen : data.length, p); p += 4;
  data.copy(buf, p);
  return buf;
}

/** 拼任意块序列：blocks = [{ type, body }] */
function makeFlacBlocks(blocks) {
  const parts = [Buffer.from('fLaC', 'latin1')];
  blocks.forEach((b, i) => {
    const h = Buffer.alloc(4);
    h[0] = (i === blocks.length - 1 ? 0x80 : 0) | (b.type & 0x7f);
    writeUInt24(h, 1, b.body.length);
    parts.push(h, b.body);
  });
  return Buffer.concat(parts);
}

function buildSong(pictureLie) {
  const si = makeStreamInfo({ totalSamples: 44100 * 270, sampleRate: 44100 });
  const vc = makeVorbisBody(['TITLE=晴天', 'ARTIST=周杰伦', 'ALBUM=叶惠美']);
  const pic = makePictureBody(pictureLie ? { lie: pictureLie } : {});
  return makeFlacBlocks([
    { type: 0, body: si },
    { type: 4, body: vc },
    { type: 6, body: pic },
  ]);
}

function testPicture() {
  /* ---- G1. 合法封面必须照旧能解析出来（回归哨兵：边界检查不能误挡正常文件）---- */
  {
    const t = parseFlac(buildSong(null));
    eq('[G1] 合法 PICTURE：durationSec 仍是 270', t && t.durationSec, 270);
    eq('[G1] 合法 PICTURE：title 正常', t && t.title, '晴天');
    ok('[G1] 合法 PICTURE：picture 仍被解析出来', !!(t && t.picture), JSON.stringify(t && t.picture && t.picture.mime));
  }

  /* ---- G2. descLen 说谎（QA 的复现用例）→ 真实数据必须活下来 ---- */
  {
    let t = null; let threw = null;
    try { t = parseFlac(buildSong({ descLen: 1000 })); } catch (e) { threw = e.message; }
    ok('[G2] descLen 说谎：parseFlac 不抛异常', !threw, threw);
    eq('[G2] descLen 说谎：durationSec 仍是 270', t && t.durationSec, 270);
    eq('[G2] descLen 说谎：title 仍是晴天', t && t.title, '晴天');
    eq('[G2] descLen 说谎：artist 仍是周杰伦', t && t.artist, '周杰伦');
    ok('[G2] descLen 说谎：picture 被丢弃而不是带崩全局', t && !t.picture, JSON.stringify(t && t.picture));
  }

  /* ---- G3. mimeLen 说谎 ---- */
  {
    let t = null; let threw = null;
    try { t = parseFlac(buildSong({ mimeLen: 99999 })); } catch (e) { threw = e.message; }
    ok('[G3] mimeLen 说谎：不抛异常', !threw, threw);
    eq('[G3] mimeLen 说谎：durationSec 仍是 270', t && t.durationSec, 270);
    eq('[G3] mimeLen 说谎：title 仍是晴天', t && t.title, '晴天');
  }

  /* ---- G4. dataLen 说谎 ---- */
  {
    let t = null; let threw = null;
    try { t = parseFlac(buildSong({ dataLen: 0xffffff })); } catch (e) { threw = e.message; }
    ok('[G4] dataLen 说谎：不抛异常', !threw, threw);
    eq('[G4] dataLen 说谎：durationSec 仍是 270', t && t.durationSec, 270);
    eq('[G4] dataLen 说谎：artist 仍是周杰伦', t && t.artist, '周杰伦');
  }

  /* ---- G5. 端到端（走 tags/index.js readTags）：坏封面文件落库值必须是对的 ---- */
  {
    const dir = path.join(os.tmpdir(), 'tp-unit-flac-picture');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'badpicture.flac');
    try {
      fs.writeFileSync(file, buildSong({ descLen: 1000 }));
      const tags = readTags(file);
      eq('[G5] 端到端：readTags 的 durationSec === 270（不是退化成 0）', tags.durationSec, 270);
      eq('[G5] 端到端：readTags 的 sampleRate === 44100', tags.sampleRate, 44100);
      eq('[G5] 端到端：readTags 的 title === 晴天', tags.title, '晴天');
      eq('[G5] 端到端：readTags 的 artist === 周杰伦', tags.artist, '周杰伦');
      ok('[G5] 端到端：没有退化成「仅文件名」', tags.title !== '' && tags.durationSec !== 0,
        JSON.stringify({ t: tags.title, d: tags.durationSec }));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结果 */ }
    }
  }

  /* ---- G6. OGG：短 identification 包不得抛 RangeError ---- */
  {
    const { parseOgg } = require('../src/tags/flac');
    const id = Buffer.concat([Buffer.from([0x01]), Buffer.from('vorbis', 'latin1'), Buffer.alloc(3)]);  // 仅 10 字节
    const head = Buffer.alloc(27);
    Buffer.from('OggS', 'latin1').copy(head, 0);
    head[26] = 1;                       // 1 段
    head[27 - 1] = 0;                   // 占位，段表写在 27 位之后
    const seg = Buffer.from([id.length]);
    const buf = Buffer.concat([head, seg, id]);
    let threw = null; let t = null;
    try { t = parseOgg(buf); } catch (e) { threw = e.message; }
    ok('[G6] OGG 10 字节短包：不抛 RangeError', !threw, threw);
    ok('[G6] OGG 短包：sampleRate 未被编造（保持缺失）', t && t.sampleRate === undefined, JSON.stringify(t && t.sampleRate));
  }
}
testPicture();

/* ========================================================================== */
console.log('\n' + '─'.repeat(60));
console.log(`unit-flac-streaminfo: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
