'use strict';
/**
 * 本轮代码评审修复的回归测试（**只新增，不修改任何既有测试**）
 *
 * 覆盖：
 *   1  P0 路径穿越（local-fs 包含校验 + admin PATCH 字段黑名单）
 *   1a Range 后缀语义 / 空文件 / Content-Type
 *   1d walk 符号链接
 *   1e checkReadOnly 用 accessSync
 *   4  封面流 error 监听
 *   5  covers.usageMB 60s 缓存
 *   6  previewCache 容量上限
 *   7  曲库配对一次建索引（不再每条 db.filter）
 *   8  coverId 白名单
 *   9  logger tail=0
 *   10 /api/export compact + CSV BOM/CRLF
 *   11 401 重登 CAS + status() 账号掩码
 *   12 LLM endpoint 协议白名单
 *
 * ⚠️ 设计约束：不开端口、不写 data/ 目录、不依赖外网。
 *    临时目录一律建在项目内 .tmp-unit-* 并在结束时删除。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Readable, PassThrough } = require('stream');

/* ==========================================================================
 * 迷你断言器
 * ========================================================================== */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' → ' + (e && e.message));
    console.log('  ✗ ' + name + ' → ' + (e && e.message));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' → ' + (e && e.message));
    console.log('  ✗ ' + name + ' → ' + (e && e.message));
  }
}

function eq(name, actual, expected) {
  check(name, () => assert.strictEqual(actual, expected));
}

/* ==========================================================================
 * 测试替身
 * ========================================================================== */

/** 假的 http.ServerResponse */
function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    destroyed: false,
    ended: false,
    writeHead(s, h) { this.status = s; this.headers = h || {}; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers = this.headers || {}; this.headers[k] = v; },
    end(b) { this.ended = true; if (b !== undefined) this.body += b; return this; },
    destroy() { this.destroyed = true; return this; },
  };
}

/**
 * 真流版假响应：用于「需要 pipe() 的用例」（封面直通）。
 * plain 对象的假 res 没有 .on()，pipe 会直接报 dest.on is not a function。
 */
function fakeStreamRes() {
  const res = new PassThrough();
  res.status = 0;
  res.headers = null;
  res.headersSent = false;
  res.body = '';
  res.writeHead = function writeHead(s, h) { this.status = s; this.headers = h || {}; this.headersSent = true; return this; };
  const origEnd = res.end.bind(res);
  res.end = function end(b) { if (b !== undefined) this.body += b; return origEnd(b); };
  res.on('data', () => {});                 // 丢弃数据，避免背压堆积卡住
  return res;
}

/** 假的 http.IncomingMessage（带 JSON body） */
function fakeReq(obj) {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  const r = new Readable({
    read() { this.push(body); this.push(null); },
  });
  r.headers = { 'content-type': 'application/json' };
  r.method = 'PATCH';
  return r;
}

/** 解析假响应的 JSON body */
function jsonOf(res) {
  try { return JSON.parse(res.body); } catch (_) { return null; }
}

/* ==========================================================================
 * 临时目录
 * ========================================================================== */

const TMP = fs.mkdtempSync(path.join(__dirname, '.tmp-unit-'));
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);

const MUSIC_DIR = path.join(TMP, 'music');
const COVER_DIR = path.join(TMP, 'covers');
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(path.join(MUSIC_DIR, 'sub'), { recursive: true });
fs.mkdirSync(COVER_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

// 正常音频（1000 字节 'A'）
fs.writeFileSync(path.join(MUSIC_DIR, 'sub', 'a.mp3'), Buffer.alloc(1000, 0x41));
fs.writeFileSync(path.join(MUSIC_DIR, 'sub', 'a.lrc'), '[00:01.00]hello');
// 空文件
fs.writeFileSync(path.join(MUSIC_DIR, 'zero.flac'), Buffer.alloc(0));
// 无扩展名音频
fs.writeFileSync(path.join(MUSIC_DIR, 'weird.xyz'), Buffer.alloc(32, 0x43));
// 音乐目录外的机密文件（穿越目标）
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP-SECRET', 'utf8');
// 软链目录（NAS 上常见的组织方式）
let symlinkOk = true;
try {
  fs.symlinkSync(OUTSIDE, path.join(MUSIC_DIR, 'linked'), 'junction');
} catch (e) {
  symlinkOk = false;     // 无权限创建软链（Windows 常见）→ 相关用例跳过
}

/* ==========================================================================
 * 1. P0 路径穿越 + Range 语义 + Content-Type（src/source/local-fs.js）
 * ========================================================================== */

async function testLocalFs() {
  console.log('\n== 1. local-fs：路径穿越 / Range / Content-Type ==');
  const config = require('../src/config');
  const localfs = require('../src/source/local-fs');
  const origMusic = config.MUSIC_DIR;
  config.MUSIC_DIR = MUSIC_DIR;
  const src = localfs.create();

  // —— 1) 路径穿越：readRange ——
  await checkAsync('readRange 拒绝 ../ 越界（抛 400）', async () => {
    let err = null;
    try { await src.readRange({ filePath: '../outside/secret.txt', fileExt: 'mp3' }); } catch (e) { err = e; }
    assert.ok(err, '应当抛错但没抛');
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.code, 'path-traversal');
  });

  await checkAsync('readRange 拒绝绝对路径逃逸', async () => {
    let err = null;
    try { await src.readRange({ filePath: path.join(OUTSIDE, 'secret.txt'), fileExt: 'mp3' }); } catch (e) { err = e; }
    assert.ok(err, '应当抛错但没抛');
    assert.strictEqual(err.status, 400);
  });

  await checkAsync('readLocalLrc 拒绝 ../ 越界', async () => {
    let err = null;
    try { await src.readLocalLrc({ filePath: '../outside/secret.txt' }); } catch (e) { err = e; }
    assert.ok(err, '应当抛错但没抛');
    assert.strictEqual(err.status, 400);
  });

  await checkAsync('库内正常路径仍可读（不误伤）', async () => {
    const r = await src.readRange({ filePath: 'sub/a.mp3', fileExt: 'mp3' }, null);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['Content-Length'], '1000');
  });

  await checkAsync('readLocalLrc 正常读取同名 .lrc', async () => {
    const txt = await src.readLocalLrc({ filePath: 'sub/a.mp3' });
    assert.strictEqual(txt, '[00:01.00]hello');
  });

  // —— 1a) Range 后缀语义 bytes=-500 ——
  await checkAsync('bytes=-500 返回最后 500 字节（而非前 501）', async () => {
    const r = await src.readRange({ filePath: 'sub/a.mp3', fileExt: 'mp3' }, 'bytes=-500');
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers['Content-Range'], 'bytes 500-999/1000');
    assert.strictEqual(r.headers['Content-Length'], '500');
  });

  await checkAsync('bytes=0-99 仍返回前 100 字节', async () => {
    const r = await src.readRange({ filePath: 'sub/a.mp3', fileExt: 'mp3' }, 'bytes=0-99');
    assert.strictEqual(r.headers['Content-Range'], 'bytes 0-99/1000');
  });

  await checkAsync('bytes=900- 返回末尾 100 字节', async () => {
    const r = await src.readRange({ filePath: 'sub/a.mp3', fileExt: 'mp3' }, 'bytes=900-');
    assert.strictEqual(r.headers['Content-Range'], 'bytes 900-999/1000');
  });

  // —— 1b) size === 0 ——
  await checkAsync('空文件返回 200 + Content-Length 0（不出 -1）', async () => {
    const r = await src.readRange({ filePath: 'zero.flac', fileExt: 'flac' }, 'bytes=0-10');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['Content-Length'], '0');
    assert.ok(!/-1/.test(String(r.headers['Content-Range'])), '出现了 -1：' + r.headers['Content-Range']);
  });

  // —— 1c) Content-Type ——
  await checkAsync('按扩展名补 Content-Type（mp3 → audio/mpeg）', async () => {
    const r = await src.readRange({ filePath: 'sub/a.mp3', fileExt: 'mp3' }, null);
    assert.strictEqual(r.headers['Content-Type'], 'audio/mpeg');
  });
  await checkAsync('flac → audio/flac；未知扩展名 → application/octet-stream', async () => {
    const r1 = await src.readRange({ filePath: 'zero.flac', fileExt: 'flac' }, null);
    assert.strictEqual(r1.headers['Content-Type'], 'audio/flac');
    const r2 = await src.readRange({ filePath: 'weird.xyz', fileExt: 'xyz' }, null);
    assert.strictEqual(r2.headers['Content-Type'], 'application/octet-stream');
  });

  // —— 1e) checkReadOnly ——
  console.log('\n== 1e. checkReadOnly 用 accessSync（无副作用）==');
  check('可写目录 → ok:false（拒绝启动）', () => {
    const r = localfs.create().checkReadOnly();       // MUSIC_DIR 当前是可写的临时目录
    assert.strictEqual(r.ok, false);
  });
  check('自检后音乐目录里没有探针残留文件', () => {
    const left = fs.readdirSync(MUSIC_DIR).filter((f) => f.includes('write-probe'));
    assert.strictEqual(left.length, 0, '残留：' + left.join(','));
  });
  check('目录不存在 → 视为不可写（ok:true，不抛）', () => {
    config.MUSIC_DIR = path.join(TMP, 'no-such-dir');
    const r = localfs.create().checkReadOnly();
    assert.strictEqual(r.ok, true);
    config.MUSIC_DIR = MUSIC_DIR;
  });

  // —— 1d) walk 符号链接 ——
  console.log('\n== 1d. walk 收录符号链接目录 ==');
  if (!symlinkOk) {
    console.log('  - 跳过：当前环境无法创建符号链接');
  } else {
    fs.writeFileSync(path.join(OUTSIDE, 'b.mp3'), Buffer.alloc(10, 0x42));
    await checkAsync('软链目录下的音频被收录', async () => {
      const files = await localfs.create().enumerate();
      const rels = files.map((f) => f.filePath);
      assert.ok(rels.includes('sub/a.mp3'), '普通子目录丢了：' + rels.join(','));
      assert.ok(rels.includes('linked/b.mp3'), '软链目录没被收录：' + rels.join(','));
    });
    await checkAsync('软链成环不会无限递归（有防环保护）', async () => {
      try { fs.symlinkSync(MUSIC_DIR, path.join(MUSIC_DIR, 'loop'), 'junction'); } catch (_) { /* 可能无权限 */ }
      const files = await Promise.race([
        localfs.create().enumerate(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('枚举超时（疑似死循环）')), 15000)),
      ]);
      assert.ok(Array.isArray(files));
    });
  }

  config.MUSIC_DIR = origMusic;
}

/* ==========================================================================
 * 4 / 5 / 8. 封面（admin.cover 流错误 + covers 缓存与白名单）
 * ========================================================================== */

async function testCovers() {
  console.log('\n== 4/5/8. 封面：流错误监听 / usageMB 缓存 / coverId 白名单 ==');
  const config = require('../src/config');
  const covers = require('../src/store/covers');
  const admin = require('../src/api/admin');
  const origCoverDir = config.paths.covers;
  config.paths.covers = COVER_DIR;

  // —— 8) coverId 白名单 ——
  fs.writeFileSync(path.join(COVER_DIR, 'cv_aaaaaaaaaaaa_0.img'), Buffer.alloc(2048, 0x47));
  check('合法 coverId 正常读取', () => {
    const found = covers.read('cv_aaaaaaaaaaaa', 0);
    assert.ok(found && found.path.endsWith('cv_aaaaaaaaaaaa_0.img'), JSON.stringify(found));
  });
  check('穿越型 coverId 被拒（../../etc/passwd）', () => {
    assert.strictEqual(covers.read('../../etc/passwd', 0), null);
  });
  check('二次解码逃逸型 coverId 被拒（..%2f..%2f）', () => {
    assert.strictEqual(covers.read('..%2f..%2fetc%2fpasswd', 0), null);
  });
  check('空 / 非字符串 coverId 被拒', () => {
    assert.strictEqual(covers.read('', 0), null);
    assert.strictEqual(covers.read(null, 0), null);
  });
  check('isSafeCoverId 认得真实格式 cv_<hex12>', () => {
    assert.strictEqual(covers.isSafeCoverId('cv_0fe6a1212b15'), true);
    assert.strictEqual(covers.isSafeCoverId('cv_0FE6A1212B15'), true);
    assert.strictEqual(covers.isSafeCoverId('cv_zzz'), false);
  });

  // —— 5) usageMB 60s 缓存 ——
  // 用 MB 级文件，避免 0.00MB 四舍五入导致「变更后数值不变」的假阳性
  fs.writeFileSync(path.join(COVER_DIR, 'cv_aaaaaaaaaaaa_300.img'), Buffer.alloc(3 * 1024 * 1024, 0x47));
  covers.invalidateUsageCache();
  const v1 = covers.usageMB();
  fs.writeFileSync(path.join(COVER_DIR, 'cv_bbbbbbbbbbbb_0.img'), Buffer.alloc(3 * 1024 * 1024, 0x47));
  const v2 = covers.usageMB();
  eq('60s 内复用缓存（新增文件后统计值不变）', v2, v1);
  covers.invalidateUsageCache();
  const v3 = covers.usageMB();
  check('手动失效后重新统计（值变大）', () => {
    assert.ok(v3 > v1, `v3=${v3} 应大于 v1=${v1}`);
  });

  // —— 4) 封面流 error 监听 ——
  await checkAsync('createReadStream 报错时 destroy 响应（不再 uncaughtException）', async () => {
    const origCRS = fs.createReadStream;
    fs.createReadStream = () => {
      const s = new Readable({ read() { this.destroy(new Error('EISDIR: illegal operation on a directory')); } });
      return s;
    };
    try {
      const res = fakeStreamRes();
      admin.cover(res, 'cv_aaaaaaaaaaaa', null);
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(res.destroyed, true, '响应未被 destroy，客户端会挂死');
    } finally {
      fs.createReadStream = origCRS;
    }
  });

  check('占位图分支不受影响', () => {
    const res = fakeRes();
    admin.cover(res, 'placeholder', null);
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('<svg'), '不是占位 svg');
  });

  config.paths.covers = origCoverDir;
}

/* ==========================================================================
 * 9. logger tail=0
 * ========================================================================== */

function testLogger() {
  console.log('\n== 9. logger tail=0 ==');
  const logger = require('../src/logger');
  const log = logger.makeLogger('unit-test');
  for (let i = 0; i < 5; i++) log.info('填充日志 ' + i);

  eq('tail=0 返回空数组（不是全部）', logger.read({ tail: 0 }).length, 0);
  check('tail=3 只返回 3 条', () => {
    assert.strictEqual(logger.read({ tail: 3 }).length, 3);
  });
  check('非法 tail 回落默认 200', () => {
    assert.ok(logger.read({ tail: 'abc' }).length <= 200);
  });
  check('tail 大于环形缓冲上限时被夹住', () => {
    assert.ok(logger.read({ tail: 99999 }).length <= 2000);
  });
}

/* ==========================================================================
 * 1 / 10 / 12. admin：PATCH 黑名单 / export / LLM endpoint
 * ========================================================================== */

async function testAdmin() {
  console.log('\n== 1. admin PATCH 字段黑名单（P0）==');
  const db = require('../src/store/db');
  const schema = require('../src/store/schema');
  const admin = require('../src/api/admin');

  const track = schema.newTrack({ id: 'T1', filePath: 'music/a.mp3' });
  track.fileExt = 'mp3';                    // newTrack 不推导扩展名，手动置一个用于断言「未被改写」
  const origResolve = db.resolve;
  const origUpsert = db.upsert;
  const origFlush = db.flush;
  db.resolve = () => track;
  db.upsert = () => {};
  db.flush = () => 0;

  try {
    await checkAsync('PATCH filePath 被拒（其余字段照常）', async () => {
      const res = fakeRes();
      await admin.patchTrack(
        fakeReq({ filePath: '../../../../etc/passwd', genre: '摇滚' }),
        res,
        'T1',
      );
      const b = jsonOf(res);
      assert.strictEqual(track.filePath, 'music/a.mp3', 'filePath 被改了！');
      assert.ok(!b.updated.includes('filePath'), 'updated 里出现了 filePath');
      assert.ok(b.denied.includes('filePath'), 'denied 未回传：' + JSON.stringify(b));
      assert.ok(b.updated.includes('genre'), '正常字段被误伤：' + JSON.stringify(b));
      assert.strictEqual(res.status, 200, '不能整体 400，批量编辑会全挂');
    });

    await checkAsync('PATCH 其余黑名单字段（fileName/fileExt/fileSizeBytes/fileMtime/dirDepth）全被拒', async () => {
      const res = fakeRes();
      await admin.patchTrack(
        fakeReq({ fileName: 'x', fileExt: 'exe', fileSizeBytes: 1, fileMtime: 'x', dirDepth: 9, id: 'HACK' }),
        res,
        'T1',
      );
      const b = jsonOf(res);
      for (const k of ['fileName', 'fileExt', 'fileSizeBytes', 'fileMtime', 'dirDepth', 'id']) {
        assert.ok(b.denied.includes(k), k + ' 未被拒：' + JSON.stringify(b));
      }
      assert.strictEqual(track.fileExt, 'mp3', 'fileExt 被改了（PATCH 前手动置的值）');
    });

    await checkAsync('batchUpdate 同样拒绝 filePath', async () => {
      const t2 = schema.newTrack({ id: 'T2', filePath: 'music/b.mp3' });
      db.resolve = (id) => (id === 'T2' ? t2 : track);
      const res = fakeRes();
      await admin.batchUpdate(fakeReq({ ids: ['T1', 'T2'], patch: { filePath: '../../etc/passwd', genre: '流行' } }), res);
      const b = jsonOf(res);
      assert.strictEqual(t2.filePath, 'music/b.mp3', 'filePath 被改了！');
      assert.ok(b.denied.includes('filePath'), JSON.stringify(b));
      assert.strictEqual(t2.genre, '流行', '正常字段没写入：' + JSON.stringify(b));
      assert.strictEqual(b.updatedCount, 2);
      db.resolve = () => track;
    });
  } finally {
    db.resolve = origResolve;
    db.upsert = origUpsert;
    db.flush = origFlush;
  }

  // —— 10) export ——
  console.log('\n== 10. /api/export compact + CSV BOM/CRLF ==');
  const origFilter = db.filter;
  db.filter = () => ({ items: [{ id: 'T1', title: '后来', artist: '刘若英', genre: '流行' }], total: 1 });
  try {
    check('JSON 导出为 compact（无缩进）', () => {
      const res = fakeRes();
      admin.exportData(res, new URL('http://x/api/export'));
      assert.ok(!res.body.includes('\n  '), '仍有 pretty 缩进');
      assert.ok(!res.body.includes('": '), '仍有 pretty 空格');
      const parsed = jsonOf(res);
      assert.strictEqual(parsed.total, 1);
    });
    check('CSV 以 BOM 开头且行尾为 CRLF', () => {
      const res = fakeRes();
      admin.exportData(res, new URL('http://x/api/export?format=csv'));
      assert.ok(res.body.startsWith('\uFEFF'), '缺少 UTF-8 BOM（Excel 会乱码）');
      assert.ok(res.body.includes('\r\n'), '缺少 CRLF');
      assert.ok(!/(^|[^\r])\n/.test(res.body), '存在裸 LF 行尾');
      assert.ok(res.body.includes('"刘若英"'), 'CSV 内容不对：' + res.body.slice(0, 120));
    });
  } finally {
    db.filter = origFilter;
  }

  // —— 12) LLM 配置写入入口：2026-10-01 起停用，任何写入都被拒（不再接入任何 LLM）——
  console.log('\n== 12. LLM 配置入口已停用 ==');
  const config = require('../src/config');
  const origEndpoint = config.LLM_ENDPOINT;
  try {
    const cases = ['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi', 'not a url',
      'http://192.168.1.9:11434/v1', 'https://api.openai.com/v1'];
    await checkAsync('任何 endpoint 写入都被拒（410，且配置不被改写）', async () => {
      for (const bad of cases) {
        const res = fakeRes();
        await admin.patchLlmConfig(fakeReq({ endpoint: bad }), res);
        assert.strictEqual(res.status, 410, bad + ' 未被拦截：' + res.body);
        assert.strictEqual(jsonOf(res).disabled, true, res.body);
        assert.strictEqual(config.LLM_ENDPOINT, origEndpoint, 'endpoint 不应被改写：' + bad);
      }
    });
    await checkAsync('llmTest 不再向外部地址发起请求（410）', async () => {
      const res = fakeRes();
      await admin.llmTest(fakeReq({}), res);
      assert.strictEqual(res.status, 410, res.body);
      assert.strictEqual(jsonOf(res).disabled, true, res.body);
    });
    await checkAsync('llmConfigured() 恒 false（L3 层永不生效）', async () => {
      assert.strictEqual(config.LLM_ENABLED, false, 'LLM 开关应硬关');
      const srvCfg = require('../src/config');
      assert.strictEqual(typeof srvCfg.llmConfigured === 'function' ? srvCfg.llmConfigured() : null, false);
    });
  } finally {
    config.LLM_ENDPOINT = origEndpoint;
  }
}

/* ==========================================================================
 * 6 / 11. service/sqmusic：previewCache 有界 / 401 CAS / status 掩码
 * ========================================================================== */

async function testSqmusicService() {
  console.log('\n== 6/11. SqMusic：试听缓存有界 / 401 CAS / 账号掩码 ==');
  const net = require('../src/util/net');
  const config = require('../src/config');
  const sq = require('../src/service/sqmusic');
  const origRaw = net.rawRequest;
  const origEnabled = config.SQ_ENABLED;
  const origUser = config.SQ_USERNAME;
  config.SQ_ENABLED = true;
  config.SQ_USERNAME = 'administrator';

  /** 造一个客户端 + 可控的 net.rawRequest 桩 */
  function makeClient(handler) {
    net.rawRequest = handler;
    return new sq.SqMusicClient({
      baseUrl: 'http://127.0.0.1:59999',
      username: 'u',
      password: 'p',
      timeoutMs: 1000,
    });
  }

  try {
    // —— 11) status 掩码 ——
    check('status() 不再明文返回账号', () => {
      const st = sq.status();
      assert.notStrictEqual(st.username, 'administrator');
      assert.ok(st.username.includes('*'), '未掩码：' + st.username);
    });

    // —— 6) previewCache 有界 ——
    await checkAsync('试听缓存达到上限后淘汰最老的（不再无界增长）', async () => {
      let calls = 0;
      const c = makeClient(async (url) => {
        calls++;
        const u = String(url);
        if (u.includes('/api/config/login')) {
          return { status: 200, text: JSON.stringify({ code: 200, data: { tokenValue: 'TOK' } }) };
        }
        if (u.includes('searchSong')) {
          return {
            status: 200,
            text: JSON.stringify({
              code: 200,
              data: { records: [{ id: '1', name: '后来', artistName: '刘若英', brTypes: ['KW_MP3_320'] }] },
            }),
          };
        }
        return { status: 200, text: JSON.stringify({ code: 200, data: { url: 'http://x/1.mp3', plugBrTypeId: 'KW_MP3_320' } }) };
      });
      // 先塞一条进搜索缓存（preview 依赖它）
      await c.search('后来');
      const key = 'kw:1';

      await c.preview({ key, brType: 'KW_MP3_320' });      // 第 1 次：miss
      const afterMiss = calls;
      await c.preview({ key, brType: 'KW_MP3_320' });      // 第 2 次：命中缓存，不应再发请求
      assert.strictEqual(calls, afterMiss, '缓存未生效，第 2 次仍在请求');

      // 灌入 600 个不同 key（避开 KW_MP3_320，防止与上面那条撞车），触发淘汰（上限 500，一次淘汰 250）
      for (let i = 0; i < 600; i++) await c.preview({ key, brType: 'KW_MP3_' + (1000 + i) });

      const before = calls;
      await c.preview({ key, brType: 'KW_MP3_320' });      // 最早那条应已被淘汰 → 必然重新请求
      assert.strictEqual(calls, before + 1, '最老的条目没被淘汰（仍命中缓存 → 说明 Map 无界增长）');
      assert.ok(afterMiss > 0);
    });

    // —— 11) 401 CAS ——
    await checkAsync('401 重登：期间已有并发请求刷新 token 时不清掉新 token（CAS）', async () => {
      let n = 0;
      const c = new sq.SqMusicClient({ baseUrl: 'http://127.0.0.1:59999', username: 'u', password: 'p', timeoutMs: 1000 });
      c.token = 'OLD';
      net.rawRequest = async () => {
        n++;
        if (n === 1) {
          c.token = 'NEW-BY-OTHER-REQUEST';            // 模拟「401 返回期间别的请求已重登成功」
          return { status: 401, text: '{"code":401}' };
        }
        return { status: 200, text: '{"code":200,"data":{}}' };
      };
      await c._request('GET', '/api/config/version');
      assert.strictEqual(c.token, 'NEW-BY-OTHER-REQUEST', '把别人刚拿到的新 token 清掉了');
    });

    await checkAsync('401 重登：无人刷新时照常清空并重登（常规路径不回归）', async () => {
      const c = new sq.SqMusicClient({ baseUrl: 'http://127.0.0.1:59999', username: 'u', password: 'p', timeoutMs: 1000 });
      c.token = 'STALE';
      net.rawRequest = async (url) => {
        if (String(url).includes('/api/config/login')) {
          return { status: 200, text: '{"code":200,"data":{"tokenValue":"FRESH-TOKEN"}}' };
        }
        if (c.token === 'STALE') return { status: 401, text: '{"code":401}' };
        return { status: 200, text: '{"code":200,"data":{}}' };
      };
      await c._request('GET', '/api/config/version');
      assert.strictEqual(c.token, 'FRESH-TOKEN', '未触发重登：' + c.token);
    });
  } finally {
    net.rawRequest = origRaw;
    config.SQ_ENABLED = origEnabled;
    config.SQ_USERNAME = origUser;
  }
}

/* ==========================================================================
 * 7. 曲库配对：一次建索引，不再每条 db.filter
 * ========================================================================== */

async function testLibraryMatcher() {
  console.log('\n== 7. 曲库配对：一次建索引（O(N+M)）==');
  const db = require('../src/store/db');
  const sqApi = require('../src/api/sqmusic');
  const origAll = db.all;
  const origFilter = db.filter;

  const t1 = { id: 'T1', title: '后来', cleanTitle: '后来', artist: '刘若英', cleanArtist: '刘若英', filePath: 'a.mp3', fileSizeBytes: 100 };
  const t2 = { id: 'T2', title: '稻香', cleanTitle: '稻香', artist: '周杰伦', cleanArtist: '周杰伦', filePath: 'b.mp3', fileSizeBytes: 200 };

  try {
    let filterCalls = 0;
    db.all = () => [t1, t2];
    db.filter = () => { filterCalls++; return { items: [t1, t2] }; };

    const m = sqApi.createLibraryMatcher();
    eq('建索引只查一次库（旧实现每条一次）', filterCalls, 1);
    check('歌名+歌手对得上 → 命中', () => {
      assert.strictEqual(m('后来', '刘若英').id, 'T1');
    });
    check('歌手对不上不误配', () => {
      assert.strictEqual(m('后来', '周杰伦'), null);
    });
    check('歌名对不上不误配', () => {
      assert.strictEqual(m('稻香', '刘若英'), null);
    });
    check('包含式匹配兜底仍生效（「后来的我们」→「后来」）', () => {
      assert.strictEqual(m('后来的我们', '刘若英').id, 'T1');
    });
    eq('后续配对不再查库（索引复用，仍只查过 1 次）', filterCalls, 1);

    // 兼容：db.filter 被桩替换成只返回部分曲目时，索引以它为准（既有测试正是这么桩的）
    filterCalls = 0;
    db.filter = () => { filterCalls++; return { items: [t1] }; };
    check('db.filter 桩替换仍生效（既有测试依赖）', () => {
      assert.strictEqual(sqApi.matchTrackInLibrary('后来', '刘若英').id, 'T1');
      assert.strictEqual(sqApi.matchTrackInLibrary('后来', '周杰伦'), null);
      assert.strictEqual(sqApi.matchTrackInLibrary('稻香', '刘若英'), null);
    });

    // 空库：回落旧路径，不炸
    db.filter = () => ({ items: [], total: 0 });
    check('空库不炸且返回 null', () => {
      assert.strictEqual(sqApi.matchTrackInLibrary('后来', '刘若英'), null);
    });
  } finally {
    db.all = origAll;
    db.filter = origFilter;
  }
}

/* ==========================================================================
 * 主流程
 * ========================================================================== */

(async function main() {
  console.log('=== unit-api-fixes：本轮评审修复回归测试 ===');
  await testLocalFs();
  await testCovers();
  testLogger();
  await testAdmin();
  await testSqmusicService();
  await testLibraryMatcher();

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  cleanup();
  process.exit(fail ? 1 : 0);
})();
