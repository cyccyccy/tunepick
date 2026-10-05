'use strict';
/**
 * 单元：MP4(M4A) / ID3(MP3) 解析器评审修复回归
 *
 * 范围：只覆盖 src/tags/mp4.js 与 src/tags/id3.js 本轮修复的 8 项发现。
 * 方法：**不提交任何二进制 fixture**（真机音频文件既不便入库也不可复核），
 *   在测试里按 MP4 / ID3v2 规范逐字节拼 Buffer 再喂给真实解析器。
 *   规范理解偏了或实现偏了都会红 —— 这是唯一能长期守住字节偏移的写法。
 *
 * 覆盖：
 *   MP4
 *   A. meta full box（P0）：标准 iTunes/ffmpeg 布局下标签 100% 丢失
 *   B. data atom 偏移错（清单外附带修复）：值 ≥ 8 字节的文本被截 8 字节
 *   C. 大 ilst（>20KB）尾部 atom 被魔数 20000 截断
 *   D. typeInd=2 UTF-16BE 被当 UTF-16LE 解
 *   E. 64 位扩展 size（size===1）子 box 起点错 8 字节
 *   F. walk 的 size===0 防御（垃圾 type 不得吞掉整个区间）
 *   ID3
 *   G. unsynchronisation（v2.3 标签级 / v2.4 帧级 + 标签级）
 *   H. enc=2 UTF-16BE 解码
 *   I. APIC 描述串 UTF-16 奇数长度导致整张封面被丢
 *   J. mp3Duration：ID3v2 footer 漏 10 字节 / 负 audioBytes
 *
 * ⚠️ 构造 fixture 的陷阱（改本文件前先读）：
 *   1. MP4 的 data atom 规范布局是 `size(4) 'data'(4) typeInd(4) locale(4) value`
 *      —— **没有**第 5 个字段。评审给的复现里 payload 前面多写了 4 个字节
 *      （12+len 而非 8+len），属跑偏的 fixture；本文件两种都测，
 *      规范布局走主断言，跑偏布局走容错断言（解析器已能兼容）。
 *   2. '©nam' 的 '©' 在 latin1 下是单字节 0xA9，四字节 type 必须整体放行，
 *      否则 walk 的打印字符防御会把 Apple 的键全部当成垃圾。
 *   3. ID3 的 unsync 只影响**内容**，不影响帧尺寸：v2.3/v2.4 帧头里记的 size
 *      都是「反同步之后」的长度，所以先按原 size 切片、再反解内容才是对的。
 *   4. mp3Duration 的 10 字节偏移差异在整数秒上通常看不出来
 *      （10 字节 @128kbps = 0.0006s），要让断言有鉴别力必须把
 *      audioBytes 顶在 Math.round 的 .5 边界上（本文件取 32kbps / 401996B）。
 *
 * 运行：node tests/unit-mp4-id3-fixes.test.js
 */

const mp4 = require('../src/tags/mp4');
const id3 = require('../src/tags/id3');

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
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ==========================================================================
 * MP4 构造工具
 * ========================================================================== */

/** 32 位 box：size(4) type(4) payload */
function box(type, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + payload.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, payload]);
}

/** 64 位 box：size=1(4) type(4) largesize(8) payload */
function box64(type, payload) {
  const h = Buffer.alloc(16);
  h.writeUInt32BE(1, 0);
  h.write(type, 4, 'latin1');
  h.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([h, payload]);
}

/**
 * 规范布局的 data atom：size(4) 'data'(4) typeInd(4) locale(4) value
 * @param {number} typeInd 1=UTF-8 2=UTF-16BE 13=JPEG 14=PNG 21=BE int
 * @param {Buffer} value
 */
function dataAtom(typeInd, value) {
  const ti = Buffer.alloc(4);
  ti.writeUInt32BE(typeInd, 0);
  return box('data', Buffer.concat([ti, Buffer.alloc(4), value]));
}

/** UTF-16BE 字节串（Node 无 utf16be，用 utf16le 交换字节序得到） */
function utf16be(s) {
  return Buffer.from(s, 'utf16le').swap16();
}

/** version 0 的 mvhd：timescale @body[12..16]、duration @body[16..20] */
function mvhdBox(timescale, duration) {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(0, 0);            // version(1) + flags(3)
  b.writeUInt32BE(timescale, 12);
  b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
}

/** ilst：若干 (键, dataAtom) */
function ilstBox(atoms) {
  return box('ilst', Buffer.concat(atoms));
}

/** 标准 full box 形态的 meta：version/flags(4) + hdlr + ilst */
function metaFullBox(ilst) {
  return box('meta', Buffer.concat([Buffer.alloc(4), box('hdlr', Buffer.alloc(24)), ilst]));
}

/** 老工具形态的 meta：body 直接就是 ilst（无 version/flags） */
function metaPlainBox(ilst) {
  return box('meta', ilst);
}

/** 完整 M4A（ftyp + moov[mvhd + udta[meta]]）；moov64=true 时用 64 位 box 头 */
function makeM4a(meta, opts) {
  const o = opts || {};
  const moovBody = Buffer.concat([mvhdBox(o.timescale || 1000, o.duration || 270000), box('udta', meta)]);
  const moov = o.moov64 ? box64('moov', moovBody) : box('moov', moovBody);
  return Buffer.concat([box('ftyp', Buffer.alloc(8)), moov]);
}

const NAM = box('©nam', dataAtom(1, Buffer.from('晴天', 'utf8')));
const ART = box('©ART', dataAtom(1, Buffer.from('周杰伦', 'utf8')));

/* ==========================================================================
 * A. meta full box（P0）
 * ========================================================================== */
console.log('\nA. meta full box —— 标准 iTunes/ffmpeg 布局（P0）');

{
  const f = makeM4a(metaFullBox(ilstBox([NAM, ART])));
  const t = mp4.parse(f);
  ok('[A1] 解析结果非 null', !!t, String(t));
  eq('[A1] moov>udta>meta(full)>ilst：title === 晴天', t && t.title, '晴天');
  eq('[A1] moov>udta>meta(full)>ilst：artist === 周杰伦', t && t.artist, '周杰伦');
  eq('[A1] mvhd 时长不受影响：270000/1000 → 270s', t && t.durationSec, 270);
  eq('[A1] format 标记', t && t.format, 'M4A');
}

{
  // 老工具形态（meta 无 version/flags）：修复前后都必须能解，属于回归哨兵
  const t = mp4.parse(makeM4a(metaPlainBox(ilstBox([NAM, ART]))));
  eq('[A2] 老工具 meta（无 version/flags）：title === 晴天', t && t.title, '晴天');
  eq('[A2] 老工具 meta（无 version/flags）：artist === 周杰伦', t && t.artist, '周杰伦');
}

{
  // 评审原始复现：payload 前面多了 4 个字节（跑偏 fixture），走解析器容错分支
  const d2 = (i, v) => box('data', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, i]), Buffer.alloc(4), v]));
  const ilst = ilstBox([
    box('©nam', d2(1, Buffer.from('晴天', 'utf8'))),
    box('©ART', d2(1, Buffer.from('周杰伦', 'utf8'))),
  ]);
  const metaFull = box('meta', Buffer.concat([Buffer.alloc(4), box('hdlr', Buffer.alloc(24)), ilst]));
  const f = Buffer.concat([
    box('ftyp', Buffer.alloc(8)),
    box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), box('udta', metaFull)])),
  ]);
  const t = mp4.parse(f);
  eq('[A3] 评审原始 fixture（payload 多 4 字节）：title === 晴天', t && t.title, '晴天');
  eq('[A3] 评审原始 fixture（payload 多 4 字节）：artist === 周杰伦', t && t.artist, '周杰伦');
}

/* ==========================================================================
 * B. data atom 偏移错（清单外附带修复）
 *    旧代码把 data box 的 body 当「含头整箱」喂给 parseDataAtom，
 *    于是 typeInd 读到 value 的头 4 字节、value 被切掉前 8 字节；
 *    只有 value < 8 字节时因长度防御落到另一条分支才碰巧正确。
 * ========================================================================== */
console.log('\nB. data atom 偏移（值 ≥ 8 字节的文本被截 8 字节）');

{
  const t = mp4.parse(makeM4a(metaFullBox(ilstBox([
    box('©nam', dataAtom(1, Buffer.from('晴天晴天晴天', 'utf8'))),   // 18 字节
    box('©ART', dataAtom(1, Buffer.from('周杰伦', 'utf8'))),          // 9 字节
  ]))));
  eq('[B1] 18 字节标题完整解出（旧实现丢前 8 字节）', t && t.title, '晴天晴天晴天');
  eq('[B2] 9 字节艺术家完整解出（旧实现只剩末字节）', t && t.artist, '周杰伦');
}

{
  const t = mp4.parse(makeM4a(metaFullBox(ilstBox([
    box('©alb', dataAtom(1, Buffer.from('叶惠美', 'utf8'))),
    box('©day', dataAtom(1, Buffer.from('2003-07-31', 'utf8'))),
  ]))));
  eq('[B3] ©alb 完整解出', t && t.album, '叶惠美');
  eq('[B4] ©day 归一化成年份 2003', t && t.year, 2003);
}

{
  const img = Buffer.alloc(300, 0x41);
  const t = mp4.parse(makeM4a(metaFullBox(ilstBox([box('covr', dataAtom(13, img))]))));
  ok('[B5] covr(JPEG) 被解析为 picture', !!(t && t.picture), JSON.stringify(t && t.picture && t.picture.mime));
  eq('[B6] 图片字节长度完整（300）', t && t.picture && t.picture.data.length, 300);
  eq('[B7] 图片首字节正确（未被偏移切掉）', t && t.picture && t.picture.data[0], 0x41);
}

/* ==========================================================================
 * C. 大 ilst（>20KB）尾部 atom 被魔数 20000 截断
 * ========================================================================== */
console.log('\nC. 大 ilst：尾部 atom 不得被 20000 魔数截断');

{
  const filler = box('free', Buffer.alloc(21000));
  const big = ilstBox([NAM, filler, ART]);
  ok('[C0] 用例前提：ilst 体积 > 20000', big.length > 20000, String(big.length));

  // C1：老工具 meta —— 隔离 #2（旧代码靠 ilst 魔数兜底并截断到 20000）
  const t1 = mp4.parse(makeM4a(metaPlainBox(big)));
  eq('[C1] 大 ilst 头部 ©nam 仍解出', t1 && t1.title, '晴天');
  eq('[C1] 大 ilst 尾部 ©ART 必须解出（旧实现被 20000 截断）', t1 && t1.artist, '周杰伦');

  // C2：标准 full meta —— #1 + #2 叠加
  const t2 = mp4.parse(makeM4a(metaFullBox(big)));
  eq('[C2] full meta + 大 ilst：©nam 解出', t2 && t2.title, '晴天');
  eq('[C2] full meta + 大 ilst：尾部 ©ART 解出', t2 && t2.artist, '周杰伦');
}

/* ==========================================================================
 * D. typeInd=2（UTF-16BE）
 * ========================================================================== */
console.log('\nD. typeInd=2 必须按 UTF-16BE 解（旧实现按 UTF-16LE，中日文全乱）');

{
  const t = mp4.parse(makeM4a(metaFullBox(ilstBox([
    box('©nam', dataAtom(2, utf16be('晴天'))),
    box('©ART', dataAtom(2, utf16be('周杰伦'))),
  ]))));
  eq('[D1] UTF-16BE 标题', t && t.title, '晴天');
  eq('[D2] UTF-16BE 艺术家', t && t.artist, '周杰伦');
  ok('[D3] 不得含解码残留空字符', !!(t && t.title) && t.title.indexOf('\0') === -1, JSON.stringify(t && t.title));
}

/* ==========================================================================
 * E. 64 位扩展 size（size===1）
 * ========================================================================== */
console.log('\nE. 64 位扩展 size：子 box 起点必须 +16 而不是 +8');

{
  const t = mp4.parse(makeM4a(metaFullBox(ilstBox([NAM, ART])), { moov64: true }));
  eq('[E1] 64 位 moov：title 解出（旧实现起点差 8 字节 → 全丢）', t && t.title, '晴天');
  eq('[E2] 64 位 moov：artist 解出', t && t.artist, '周杰伦');
  eq('[E3] 64 位 moov：mvhd 时长仍为 270s', t && t.durationSec, 270);
}

/* ==========================================================================
 * F. walk 的 size===0 防御
 * ========================================================================== */
console.log('\nF. walk：size===0 且 type 非可打印 ASCII 时必须停止，不得吞掉整个区间');

{
  // 首 4 字节 size=0，紧接着 4 字节 type 是垃圾（典型：把 full box 的
  // version/flags 当成了 box 头）。旧实现会把剩余区间整个交给回调。
  const buf = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    box('moov', Buffer.alloc(8)),
  ]);
  let called = 0;
  const types = [];
  mp4.walk(buf, 0, buf.length, (type) => { called++; types.push(type); });
  eq('[F1] 垃圾 type + size=0：回调 0 次（旧实现 1 次）', called, 0);
  ok('[F2] 且未把 moov 误报出来', types.indexOf('moov') === -1, JSON.stringify(types));
}

{
  // size===0 且 type 合法（含 0xA9 '©'）：必须照旧放行
  const buf = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0xa9, 0x6e, 0x61, 0x6d]),   // '©nam'
    Buffer.alloc(4),
  ]);
  const types = [];
  mp4.walk(buf, 0, buf.length, (type) => { types.push(type); });
  eq('[F3] size=0 + type=©nam（含 0xA9）：仍被访问，不被误判为垃圾', types.length, 1);
  eq('[F4] 且 type 原样保留', types[0], '©nam');
}

{
  // 常规 32 位 box 序列（ilst 的 body 内部）：防御不得误伤
  const ilst = ilstBox([NAM, ART]);
  const types = [];
  mp4.walk(ilst, 8, ilst.length, (type) => { types.push(type); });
  eq('[F5] 常规 32 位 box 序列照旧遍历', types.length, 2);
  eq('[F6] 第一个是 ©nam', types[0], '©nam');
  eq('[F7] 第二个是 ©ART', types[1], '©ART');
}

/* ==========================================================================
 * ID3 构造工具
 * ========================================================================== */

/** synchsafe 编码（每字节 7 位） */
function ss(v) {
  return Buffer.from([(v >> 21) & 0x7f, (v >> 14) & 0x7f, (v >> 7) & 0x7f, v & 0x7f]);
}

function id3Header(ver, flags, size) {
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1');
  h[3] = ver; h[4] = 0; h[5] = flags;
  ss(size).copy(h, 6);
  return h;
}

function id3Footer(ver, flags, size) {
  const f = Buffer.alloc(10);
  f.write('3DI', 0, 'latin1');
  f[3] = ver; f[4] = 0; f[5] = flags;
  ss(size).copy(f, 6);
  return f;
}

/** @param {number} flags 帧 flags（v2.3/v2.4 含义不同） */
function frame(ver, id, flags, data) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  if (ver === 4) ss(data.length).copy(h, 4);
  else h.writeUInt32BE(data.length, 4);
  h[8] = (flags >> 8) & 0xff;
  h[9] = flags & 0xff;
  return Buffer.concat([h, data]);
}

function tag(ver, flags, frames, withFooter) {
  const body = Buffer.concat(frames);
  const parts = [id3Header(ver, flags, body.length), body];
  if (withFooter) parts.push(id3Footer(ver, flags, body.length));
  return Buffer.concat(parts);
}

/** 文本帧：enc + payload */
function textFrame(ver, id, enc, payload, flags) {
  return frame(ver, id, flags || 0, Buffer.concat([Buffer.from([enc]), payload]));
}

const FFL = String.fromCharCode(0xff);   // 0xFF 在 latin1 下是 'ÿ'

/* ==========================================================================
 * G. unsynchronisation
 * ========================================================================== */
console.log('\nG. unsynchronisation（0xFF 0x00 → 0xFF）');

{
  // v2.4 帧级：帧 flags & 0x0002
  const data = Buffer.concat([Buffer.from([0]), Buffer.from([0x41, 0xff, 0x00, 0x42])]);
  const t = id3.parse(tag(4, 0x00, [frame(4, 'TIT2', 0x0002, data)]));
  eq('[G1] v2.4 帧级 unsync：文本还原为 AÿB', t && t.title, 'A' + FFL + 'B');
  ok('[G2] v2.4 帧级 unsync：不得残留空字符', !!(t && t.title) && t.title.indexOf('\0') === -1,
    JSON.stringify(t && t.title));
}

{
  // v2.3 标签级：tag header flags & 0x80（旧代码读的是帧 flags，恒 0 → 死代码）
  const data = Buffer.concat([Buffer.from([0]), Buffer.from([0x41, 0xff, 0x00, 0x42])]);
  const t = id3.parse(tag(3, 0x80, [frame(3, 'TIT2', 0x0000, data)]));
  eq('[G3] v2.3 标签级 unsync：文本还原为 AÿB', t && t.title, 'A' + FFL + 'B');
  ok('[G4] v2.3 标签级 unsync：不得残留空字符', !!(t && t.title) && t.title.indexOf('\0') === -1,
    JSON.stringify(t && t.title));
}

{
  // v2.4 标签级：tag header flags & 0x80 表示所有帧都已反同步
  const data = Buffer.concat([Buffer.from([0]), Buffer.from([0x41, 0xff, 0x00, 0x42])]);
  const t = id3.parse(tag(4, 0x80, [frame(4, 'TIT2', 0x0000, data)]));
  eq('[G5] v2.4 标签级 unsync：文本还原为 AÿB', t && t.title, 'A' + FFL + 'B');
}

{
  // 0xFF 0x00 0x00 应还原成 0xFF 0x00（只吞一个 0x00）
  const data = Buffer.concat([Buffer.from([0]), Buffer.from([0x41, 0xff, 0x00, 0x00, 0x42])]);
  const t = id3.parse(tag(4, 0x00, [frame(4, 'TIT2', 0x0002, data)]));
  eq('[G6] 0xFF0000 → 0xFF00（只吞一个转义 0x00）',
    t && t.title, 'A' + FFL + String.fromCharCode(0x00) + 'B');
}

{
  // 回归：无 unsync 的 v2.3 / v2.4，结果必须与修复前完全一致
  const t3 = id3.parse(tag(3, 0x00, [
    textFrame(3, 'TIT2', 0, Buffer.from('Hello', 'latin1')),
    textFrame(3, 'TPE1', 0, Buffer.from('Artist', 'latin1')),
    textFrame(3, 'TALB', 0, Buffer.from('Album', 'latin1')),
    textFrame(3, 'TRCK', 0, Buffer.from('7', 'latin1')),
    textFrame(3, 'TYER', 0, Buffer.from('2003', 'latin1')),
  ]));
  eq('[G7] v2.3 无 unsync：title', t3 && t3.title, 'Hello');
  eq('[G8] v2.3 无 unsync：artist', t3 && t3.artist, 'Artist');
  eq('[G9] v2.3 无 unsync：album', t3 && t3.album, 'Album');
  eq('[G10] v2.3 无 unsync：trackNo 归一化', t3 && t3.trackNo, 7);
  eq('[G11] v2.3 无 unsync：year 归一化', t3 && t3.year, 2003);

  const t4 = id3.parse(tag(4, 0x00, [
    textFrame(4, 'TIT2', 0, Buffer.from('Hello', 'latin1')),
    textFrame(4, 'TDRC', 0, Buffer.from('2003-07-31', 'latin1')),
  ]));
  eq('[G12] v2.4 无 unsync：title', t4 && t4.title, 'Hello');
  eq('[G13] v2.4 无 unsync：year 归一化', t4 && t4.year, 2003);
}

{
  // 核对结论：v2.4 帧尺寸本就是 syncsafe、v2.3 是普通大端 32 位
  const big300 = Buffer.alloc(300, 0x41);
  const t4 = id3.parse(tag(4, 0x00, [textFrame(4, 'TIT2', 0, big300)]));
  eq('[G14] v2.4 帧 size 走 syncsafe：300 字节文本完整', t4 && t4.title && t4.title.length, 300);
  const t3 = id3.parse(tag(3, 0x00, [textFrame(3, 'TIT2', 0, big300)]));
  eq('[G15] v2.3 帧 size 走普通大端：300 字节文本完整', t3 && t3.title && t3.title.length, 300);
}

/* ==========================================================================
 * H. enc=2 UTF-16BE
 * ========================================================================== */
console.log('\nH. ID3 enc=2 必须按 UTF-16BE 解');

{
  const t = id3.parse(tag(3, 0x00, [
    frame(3, 'TIT2', 0, Buffer.concat([Buffer.from([2]), utf16be('晴天')])),
    frame(3, 'TPE1', 0, Buffer.concat([Buffer.from([2]), utf16be('周杰伦')])),
  ]));
  eq('[H1] enc=2 标题', t && t.title, '晴天');
  eq('[H2] enc=2 艺术家', t && t.artist, '周杰伦');
}

{
  // 回归：enc=1（UTF-16 + BOM）与 enc=3（UTF-8）保持原行为
  const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('晴天', 'utf16le')]);
  const t1 = id3.parse(tag(3, 0x00, [frame(3, 'TIT2', 0, Buffer.concat([Buffer.from([1]), bom]))]));
  eq('[H3] enc=1（UTF-16LE + BOM）回归', t1 && t1.title, '晴天');
  const t2 = id3.parse(tag(3, 0x00, [textFrame(3, 'TIT2', 3, Buffer.from('晴天', 'utf8'))]));
  eq('[H4] enc=3（UTF-8）回归', t2 && t2.title, '晴天');
  const t3 = id3.parse(tag(3, 0x00, [textFrame(3, 'TIT2', 0, Buffer.from('Hello', 'latin1'))]));
  eq('[H5] enc=0（ISO-8859-1）回归', t3 && t3.title, 'Hello');
}

/* ==========================================================================
 * I. APIC：描述串 UTF-16 奇数长度不得整张封面被丢
 * ========================================================================== */
console.log('\nI. APIC 描述串终止符找不到时不得丢封面');

/** 拼 APIC 帧：enc(1) + mime + 0x00 + picType(1) + desc + 终止符 + 图片 */
function apicFrame(enc, desc, img) {
  const term = (enc === 1 || enc === 2) ? Buffer.from([0, 0]) : Buffer.from([0]);
  const body = Buffer.concat([
    Buffer.from([enc]),
    Buffer.from('image/jpeg', 'latin1'),
    Buffer.from([0]),
    Buffer.from([3]),                 // picType = 封面
    desc, term, img,
  ]);
  return frame(3, 'APIC', 0, body);
}

{
  const img = Buffer.alloc(200, 0x41);
  // 描述串 13 字节（奇数）：BOM(2) + 'cover' 的 UTF-16LE(10) + 1 个残留字节
  const desc = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('cover', 'utf16le'),
    Buffer.from([0x41]),
  ]);
  ok('[I0] 用例前提：描述串字节数为奇数', desc.length % 2 === 1, String(desc.length));
  const t = id3.parse(tag(3, 0x00, [apicFrame(1, desc, img)]));
  ok('[I1] 奇数长度描述串：封面不被丢弃（旧实现整帧 return null）', !!(t && t.picture),
    JSON.stringify(t && t.picture && t.picture.mime));
  eq('[I2] 图片字节流起点正确（长度 200）', t && t.picture && t.picture.data.length, 200);
  eq('[I3] 图片首字节正确', t && t.picture && t.picture.data[0], 0x41);
  eq('[I4] 图片末字节正确', t && t.picture && t.picture.data[199], 0x41);
  eq('[I5] picType === 3', t && t.picture && t.picture.picType, 3);
  eq('[I6] mime 正确', t && t.picture && t.picture.mime, 'image/jpeg');
}

{
  // 回归：正常 APIC（enc=0）照旧解析
  const img = Buffer.alloc(200, 0x41);
  const t = id3.parse(tag(3, 0x00, [apicFrame(0, Buffer.from('cover', 'latin1'), img)]));
  eq('[I7] 正常 APIC（enc=0）：图片长度 200', t && t.picture && t.picture.data.length, 200);
  eq('[I8] 正常 APIC（enc=0）：首字节正确', t && t.picture && t.picture.data[0], 0x41);
}

{
  // 回归：图片 < 64 字节仍视为无效（阈值保持不变）
  const t = id3.parse(tag(3, 0x00, [apicFrame(0, Buffer.from('cover', 'latin1'), Buffer.alloc(32, 0x41))]));
  ok('[I9] 图片 < 64 字节：仍判为无效（阈值未动）', !(t && t.picture), JSON.stringify(t && t.picture));
}

/* ==========================================================================
 * J. mp3Duration
 * ========================================================================== */
console.log('\nJ. mp3Duration：ID3v2 footer 偏移 / 越界防御');

/** 32kbps / 44100Hz 的 MPEG1 Layer3 帧头（bitrate index=1, sr index=0） */
const FRAME_HDR = Buffer.from([0xff, 0xfb, 0x10, 0x00]);
/** 90 字节数据的 TIT2 帧 → 整帧 100 字节 */
const TIT2_100 = frame(3, 'TIT2', 0, Buffer.concat([Buffer.from([0]), Buffer.alloc(89)]));

{
  // ① 带 footer（tag header flags & 0x10）：音频起点应再 +10
  //    鉴别人为构造：audioBytes 顶在 Math.round 的 .5 边界上 ——
  //    401996B @32kbps = 100.499s → 100；多算 10 字节 = 100.5015s → 101
  const fileSize = 402116;                 // = 120(tag+footer) + 401996
  const buf = Buffer.concat([
    id3Header(3, 0x10, 100), TIT2_100, id3Footer(3, 0x10, 100), FRAME_HDR,
  ]);
  eq('[J0] 用例前提：带 footer 的 tag 共 120 字节', buf.length, 124);
  const r = id3.mp3Duration(buf, fileSize);
  eq('[J1] 带 footer：bitrate 32', r.bitrate, 32);
  eq('[J2] 带 footer：sampleRate 44100', r.sampleRate, 44100);
  eq('[J3] 带 footer：音频起点 +10 → 100s（旧实现 101s）', r.durationSec, 100);
}

{
  // 回归：无 footer 时偏移必须原样不动
  const fileSize = 402106;                 // = 110(tag) + 401996
  const buf = Buffer.concat([id3Header(3, 0x00, 100), TIT2_100, FRAME_HDR]);
  const r = id3.mp3Duration(buf, fileSize);
  eq('[J4] 无 footer：仍是 100s（回归哨兵）', r.durationSec, 100);
}

{
  // ② tag 尺寸超过已读头窗口：读不到就是 0，绝不伪造、也不许越界循环
  const buf = Buffer.concat([id3Header(3, 0x00, 1000000), Buffer.alloc(16)]);
  const r = id3.mp3Duration(buf, 1000016);
  eq('[J5] tag 超过头窗口：durationSec 保持 0', r.durationSec, 0);
  eq('[J6] tag 超过头窗口：bitrate 保持 0', r.bitrate, 0);
}

{
  // ② 附带：tag 尺寸撒谎（比文件还大）时 audioBytes 为负，不得返回负时长
  const buf = Buffer.concat([id3Header(3, 0x00, 3000), Buffer.alloc(3000), FRAME_HDR]);
  const r = id3.mp3Duration(buf, 100);
  eq('[J7] audioBytes 为负时不返回负时长（旧实现 -1）', r.durationSec, 0);
}

{
  // 回归：无 ID3 标签的裸 MP3
  const r = id3.mp3Duration(Buffer.concat([FRAME_HDR, Buffer.alloc(100)]), 401996);
  eq('[J8] 无 ID3：401996B @32kbps → 100s', r.durationSec, 100);
}

/* ========================================================================== */
console.log('\n' + '─'.repeat(60));
console.log(`unit-mp4-id3-fixes: ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
}
process.exit(fail ? 1 : 0);
