'use strict';
/**
 * QA 回归：扫描期间事件循环不被饿死（用户报障「页面不停加载 + 看不到进度」）
 *
 * 根因：src/scan/task.js 的 _execute() 主循环里，所有 await 等到的都是
 *      「已经同步算完」的 Promise —— src.readTags() 内部是 fs.readSync（同步 I/O），
 *      db.flush() 是同步写盘。整段循环只在微任务队列里打转，事件循环进不了
 *      poll / check 阶段 → 扫描期间 HTTP 服务完全不响应，进度也推不出去。
 * 修复：主批次循环末尾 + 抽样读标签循环里 await yieldToEventLoop()（setImmediate）。
 *
 * 本测试不依赖真实音乐文件：注入一个假 source adapter，让 readTags 做
 * **真正的同步忙等**（等价于 fs.readSync 的行为特征），然后测三件事：
 *   1. 扫描进行中，真实 http.createServer() 能不能在 ≤2s 内收到并响应请求（页面能加载）
 *   2. 扫描进行中，进度能不能被外部定时器**递增地**观测到（进度看得见）
 *   3. 扫描真的在跑（running=true / total>0 / 忙等真的发生 / 最终 done===total）
 *      —— 防止「根本没跑起来」造成的假绿
 *
 * 另外第 9 节覆盖同源修复的另一半：src/source/local-fs.js 的 walk() 改为 async
 * 并在每个子目录递归后让出事件循环（目录枚举同样是全同步 readdirSync + statSync）。
 * 该节用合成的慢速目录树（打桩 fs.readdirSync/statSync 模拟 NAS 上毫秒级 stat），
 * 不落任何真实音频文件。
 *
 * 变异验证（证明本测试测到了点子上，不是恒真断言）：
 *   QA_NO_YIELD=1 node tests/qa-scan-eventloop.test.js
 *   该开关把 src/scan/task.js 与 src/source/local-fs.js 里的 yieldToEventLoop()
 *   原地替换成 Promise.resolve()（假装让出），期望：第 5、6、7、9 组断言变红。
 *   替换在内存里做（Module._compile），src 源文件一个字节都不改。
 *
 * 运行：node tests/qa-scan-eventloop.test.js
 */

process.env.SKIP_DOT_ENV = '1';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SOURCE_KIND = 'localfs';
process.env.MUSIC_DIR = require('path').join(__dirname, '..', '.tmp-qa-scanevloop', 'music-notexist');
process.env.DATA_DIR = require('path').join(__dirname, '..', '.tmp-qa-scanevloop');
process.env.PORT = '18291';
process.env.LOG_LEVEL = 'error';
process.env.ONLINE_ENABLED = 'false';   // 关 L2，避免真实联网
process.env.LLM_ENABLED = 'false';      // 关 L3
process.env.SCAN_CONCURRENCY = '2';     // 每批 2 首 → 每批同步阻塞 80ms
process.env.CHECKPOINT_EVERY = '20';

const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');

const DATA_DIR = process.env.DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 场景参数 ---------- */
const TOTAL = 80;                 // 条目数
const BUSY_MS = 40;               // 每条 readTags 的同步忙等（等价于 fs.readSync）
const HTTP_BUDGET_MS = 2000;      // 「页面能加载」的响应预算
const LAG_BUDGET_MS = 500;        // 事件循环最大卡顿预算
const BASELINE_LAG_MS = 300;      // 空载时的卡顿上限（环境自检哨兵）
const MIN_PROGRESS_STEPS = 3;     // 至少观测到几个递增的进度值
const MIN_PROBES = 3;             // 扫描期间至少成功响应几次 HTTP
/* ---- 第 9 节参数：合成慢速目录树 ---- */
const TREE_DIRS = 60;             // 子目录数（每个子目录递归后应让出一次）
const TREE_AUDIO_PER_DIR = 4;     // 每目录音频文件数
const TREE_TOTAL = TREE_DIRS * TREE_AUDIO_PER_DIR;
const READDIR_MS = 4;             // 每次 readdirSync 的同步耗时（模拟 NAS/SMB 的毫秒级 stat）
const ENUM_LAG_BUDGET_MS = 200;   // 枚举期间定时器最大卡顿预算

/** 变异开关：把 yieldToEventLoop() 换成 Promise.resolve()（假装让出） */
const NO_YIELD = process.env.QA_NO_YIELD === '1';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}

/* =====================================================================
 * 加载被测模块：正常版 / 变异版（变异在内存里做，src 源文件一个字节都不改）
 *   变异 = 把 yieldToEventLoop() 的 setImmediate 实现换成 Promise.resolve()
 * ===================================================================== */
const SRC_TASK = path.join(__dirname, '..', 'src', 'scan', 'task.js');
const SRC_LOCALFS = path.join(__dirname, '..', 'src', 'source', 'local-fs.js');

const YIELD_RE = /function yieldToEventLoop\(\) \{\s*return new Promise\(\(resolve\) => setImmediate\(resolve\)\);\s*\}/;
const YIELD_MUT = 'function yieldToEventLoop() {\n  return Promise.resolve();\n}';

function loadModule(absPath) {
  if (!NO_YIELD) return require(absPath);
  const original = fs.readFileSync(absPath, 'utf8');
  const mutated = original.replace(YIELD_RE, YIELD_MUT);
  if (mutated === original) {
    throw new Error('变异失败：未在 ' + absPath + ' 中匹配到 yieldToEventLoop 的 setImmediate 实现');
  }
  // 用变异后的源码编译一个独立模块实例（相对 require 仍按原目录解析）
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.path = path.dirname(absPath);
  if (Module._nodeModulePaths) m.paths = Module._nodeModulePaths(m.path);
  m._compile(mutated, absPath);
  return m.exports;
}

const task = loadModule(SRC_TASK);

/* =====================================================================
 * 注入假 source adapter（task.js 里是 const source = require('../source')，
 * 然后 this.src = source.create() —— 改写 create 即可注入）
 * ===================================================================== */
let busyCalls = 0;
let createCalls = 0;

const fakeSource = {
  kind: 'qa-fake',

  async enumerate() {
    const out = [];
    for (let i = 0; i < TOTAL; i++) {
      out.push({
        filePath: `歌手${i % 7}/专辑${i % 5}/track-${String(i).padStart(3, '0')}.mp3`,
        absPath: '',
        fileName: `track-${i}.mp3`,
        fileExt: 'mp3',
        fileSizeBytes: 1024 * 1024 + i,
        fileMtime: new Date().toISOString(),
        dirDepth: 2,
      });
    }
    return out;
  },

  /** 真正的同步忙等 —— 这就是 fs.readSync 的行为特征 */
  async readTags() {
    busyCalls++;
    const t0 = Date.now();
    while (Date.now() - t0 < BUSY_MS) { /* 同步阻塞，占满事件循环 */ }
    return {
      title: '晴天', artist: '周杰伦', album: '叶惠美', year: 2003,
      format: 'MP3', bitrate: 320, sampleRate: 44100, durationSec: 269,
    };
  },
};

const sourceModule = require('../src/source');
sourceModule.create = function qaFakeCreate() { createCalls++; return fakeSource; };

/* =====================================================================
 * 工具
 * ===================================================================== */
const config = require('../src/config');
config.ensureDirs();
const db = require('../src/store/db');
db.load();   // _persistRun() 会写 db.meta，必须先 load

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

/** 轮询等待；第一次判定是同步的，不依赖事件循环是否空闲 */
async function waitFor(pred, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 打一次真实 HTTP 请求（真实 socket，不是假 res） */
function probe(port) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/probe', method: 'GET', timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - t0 }));
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('probe 超时')));
    req.end();
  });
}

/* =====================================================================
 * 主流程
 * ===================================================================== */
(async () => {
  console.log(NO_YIELD
    ? '\n== QA 扫描事件循环回归（变异模式：yieldToEventLoop → Promise.resolve）=='
    : '\n== QA 扫描事件循环回归（正常模式：setImmediate 让出）==');

  /* ---------- 0. 起真 HTTP 服务 ---------- */
  let hitsWhileRunning = 0;
  let scanning = false;
  const server = http.createServer((req, res) => {
    if (scanning) hitsWhileRunning++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await listen(server);
  const port = server.address().port;

  const idle = await probe(port);
  ok('空载基线：HTTP 服务本身可用（200）', idle.status === 200, String(idle.status));

  /* ---------- 1. 事件循环卡顿采样器（全程运行） ---------- */
  const lags = [];
  const baselineLags = [];
  const progressSamples = [];
  let lastTick = Date.now();
  const sampler = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick;
    lastTick = now;
    if (scanning) {
      lags.push(lag);
      const s = task.status();
      progressSamples.push({ done: s.done, total: s.total, running: s.running, state: s.state });
    } else {
      baselineLags.push(lag);
    }
  }, 50);

  // 先采一段空载基线，证明「机器本身不慢」，避免环境抖动被误判成饿死
  await new Promise((r) => setTimeout(r, 400));
  const baselineMax = baselineLags.length ? Math.max(...baselineLags) : Infinity;
  ok(`空载基线：定时器无卡顿（最大间隔 ${baselineMax}ms ≤ ${BASELINE_LAG_MS}ms）`,
    baselineMax <= BASELINE_LAG_MS, String(baselineMax));

  /* ---------- 2. 启动扫描 ---------- */
  const scanT0 = Date.now();
  const accepted = await task.start({ mode: 'full', force: true, useL2: false, useL3: false });
  scanning = true;

  ok('注入生效：ScanTask 用的是假 source（kind=qa-fake）',
    !!task.src && task.src.kind === 'qa-fake', task.src ? String(task.src.kind) : 'null');
  ok('注入生效：source.create() 被调用过', createCalls === 1, String(createCalls));
  ok('start() 接受任务', accepted && accepted.accepted === true, JSON.stringify(accepted));

  // 哨兵：必须确认扫描真的在跑，否则后面的「能响应」可能是「根本没跑」造成的假绿
  const started = await waitFor(() => {
    const s = task.status();
    return s.running === true && s.total > 0;
  }, 3000);
  ok(`扫描确实已启动（running=true 且 total=${TOTAL} > 0）`, started,
    JSON.stringify({ running: task.status().running, total: task.status().total }));
  ok('枚举数量正确', task.status().total === TOTAL, String(task.status().total));

  /* ---------- 3. 扫描期间：一边打 HTTP，一边等扫描结束 ---------- */
  const isScanning = () => task.status().state === 'running';
  const probeResults = [];
  const probeLoop = (async () => {
    while (isScanning()) {
      const r = await probe(port).catch((e) => ({ status: 0, body: '', ms: -1, err: e.message }));
      probeResults.push(Object.assign({}, r, { answeredWhileRunning: isScanning() }));
      if (!isScanning()) break;
      await new Promise((r2) => setTimeout(r2, 120));
    }
  })();

  const finished = await waitFor(() => !isScanning(), 60000);
  await probeLoop;
  scanning = false;
  clearInterval(sampler);
  const scanMs = Date.now() - scanT0;

  ok('扫描在超时前结束', finished === true, 'waitFor 超时');

  /* ---------- 4. 忙等真的发生了（不是空跑） ---------- */
  console.log('\n== 4. 哨兵：扫描是真的在干同步阻塞活 ==');
  ok(`readTags 忙等被调用 ${TOTAL} 次`, busyCalls === TOTAL, String(busyCalls));
  ok(`扫描耗时 ${scanMs}ms ≥ ${Math.round(TOTAL * BUSY_MS * 0.7)}ms（忙等真的阻塞了）`,
    scanMs >= TOTAL * BUSY_MS * 0.7, String(scanMs));

  /* ---------- 5. 结论 1：扫描期间页面能加载 ---------- */
  console.log('\n== 5. 扫描进行中，HTTP 服务仍然响应（页面能加载）==');
  const answeredRunning = probeResults.filter((r) => r.answeredWhileRunning && r.status === 200);
  const maxLatency = probeResults.length ? Math.max(...probeResults.map((r) => r.ms)) : -1;
  ok(`扫描期间 HTTP 至少响应 ${MIN_PROBES} 次（实际 ${answeredRunning.length} 次，服务端收到 ${hitsWhileRunning} 次）`,
    answeredRunning.length >= MIN_PROBES,
    JSON.stringify(probeResults.slice(0, 3)));
  ok(`扫描期间单次 HTTP 延迟 ≤ ${HTTP_BUDGET_MS}ms（实测最大 ${maxLatency}ms）`,
    answeredRunning.length > 0 && maxLatency > 0 && maxLatency <= HTTP_BUDGET_MS, String(maxLatency));
  ok('扫描期间服务端确实收到了请求（不是「扫完了才收到」）',
    hitsWhileRunning >= MIN_PROBES, String(hitsWhileRunning));

  /* ---------- 6. 结论 2：扫描期间进度可见且递增 ---------- */
  console.log('\n== 6. 扫描进行中，进度能被外部观测到且递增（进度看得见）==');
  const runningSamples = progressSamples.filter((s) => s.running === true);
  const doneValues = [];
  for (const s of runningSamples) {
    if (doneValues[doneValues.length - 1] !== s.done) doneValues.push(s.done);
  }
  const strictlyRising = doneValues.length >= 2 && doneValues.every((v, i) => i === 0 || v > doneValues[i - 1]);
  ok(`扫描期间采到 ${progressSamples.length} 次进度（运行中 ${runningSamples.length} 次）`,
    runningSamples.length >= 2, String(progressSamples.length));
  ok(`进度出现 ≥${MIN_PROGRESS_STEPS} 个递增的 done 值（实际 ${doneValues.length} 个：${doneValues.slice(0, 8).join('→')}${doneValues.length > 8 ? '→…' : ''}）`,
    doneValues.length >= MIN_PROGRESS_STEPS && strictlyRising, JSON.stringify(doneValues.slice(0, 12)));
  ok('进度中间态确实落在 (0, total) 之间（不是「0 直接跳到 80」）',
    doneValues.some((v) => v > 0 && v < TOTAL), JSON.stringify(doneValues.slice(0, 12)));

  /* ---------- 7. 结论 3：事件循环没有被饿死（定时器卡顿） ---------- */
  console.log('\n== 7. 扫描进行中，事件循环仍在运转（定时器不饿死）==');
  const maxLag = lags.length ? Math.max(...lags) : -1;
  ok(`扫描期间定时器最大卡顿 ≤ ${LAG_BUDGET_MS}ms（实测 ${maxLag}ms，共 ${lags.length} 次采样）`,
    lags.length > 0 && maxLag > 0 && maxLag <= LAG_BUDGET_MS, String(maxLag));

  /* ---------- 8. 收尾：扫描真的跑完了 ---------- */
  console.log('\n== 8. 扫描完整跑完（不是被打断）==');
  const st = task.status();
  ok('最终状态 = completed', st.state === 'completed', String(st.state));
  ok(`done === total（${st.done}/${st.total}）`, st.done === TOTAL && st.total === TOTAL, `${st.done}/${st.total}`);
  ok('无失败条目', st.failed === 0, String(st.failed));
  ok('曲库真的入库了', db.size() === TOTAL, String(db.size()));

  /* ---------- 9. 同源修复的另一半：目录枚举 walk() 也不饿死事件循环 ---------- */
  console.log('\n== 9. 目录枚举（local-fs.walk）期间事件循环仍在运转 ==');
  server.close();

  // 合成一棵「慢速」目录树：打桩 readdirSync/statSync，模拟 NAS/SMB 上毫秒级的目录 I/O。
  // 不落任何真实音频文件，也就没有大批量文件需要清理。
  const musicRoot = path.join(DATA_DIR, 'music');
  fs.mkdirSync(musicRoot, { recursive: true });
  const tree = new Map();                       // 目录绝对路径 → 子项
  const kids = [];
  for (let d = 0; d < TREE_DIRS; d++) {
    const name = 'dir' + String(d).padStart(3, '0');
    kids.push({ name, dir: true });
    tree.set(path.join(musicRoot, name), [
      { name: 'track-a.mp3', dir: false },
      { name: 'track-b.flac', dir: false },
      { name: 'track-c.m4a', dir: false },
      { name: 'track-d.ogg', dir: false },
      { name: 'cover.jpg', dir: false },        // 非音频，应被 AUDIO_EXT 过滤掉
    ]);
  }
  tree.set(musicRoot, kids);

  const realReaddir = fs.readdirSync;
  const realStat = fs.statSync;
  const realExists = fs.existsSync;
  let readdirCalls = 0;
  const busy = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { /* 同步阻塞 */ } };
  fs.readdirSync = function stubReaddir(p) {
    readdirCalls++;
    busy(READDIR_MS);
    const node = tree.get(p);
    if (!node) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
    return node.map((x) => ({ name: x.name, isDirectory: () => x.dir, isFile: () => !x.dir }));
  };
  fs.statSync = function stubStat() { busy(0.2); return { size: 1234567, mtime: new Date() }; };

  // 统计「让出次数」= walk 内部对 setImmediate 的真实调用次数
  const realSetImmediate = global.setImmediate;
  let immCount = 0;
  global.setImmediate = function countedSetImmediate(fn, ...a) { immCount++; return realSetImmediate(fn, ...a); };

  const enumTicks = [];
  let enumLast = Date.now();
  const enumSampler = setInterval(() => {
    const now = Date.now();
    enumTicks.push(now - enumLast);
    enumLast = now;
  }, 5);
  await new Promise((r) => setTimeout(r, 30));   // 让采样器先转起来
  const tickBase = enumTicks.length;

  const localfs = loadModule(SRC_LOCALFS);
  config.MUSIC_DIR = musicRoot;
  const enumT0 = Date.now();
  const files = await localfs.create().enumerate();
  const enumMs = Date.now() - enumT0;

  clearInterval(enumSampler);
  global.setImmediate = realSetImmediate;
  fs.readdirSync = realReaddir;
  fs.statSync = realStat;
  fs.existsSync = realExists;

  const ticksDuringEnum = enumTicks.length - tickBase;
  const enumLags = enumTicks.slice(tickBase);
  const maxEnumLag = enumLags.length ? Math.max(...enumLags) : -1;
  ok(`枚举到全部 ${TREE_TOTAL} 个音频文件（非音频被过滤）`,
    files.length === TREE_TOTAL, String(files.length));
  ok(`枚举耗时 ${enumMs}ms（readdirSync ${readdirCalls} 次 × ${READDIR_MS}ms —— 确实在做同步 I/O）`,
    readdirCalls === TREE_DIRS + 1 && enumMs >= TREE_DIRS * READDIR_MS * 0.5,
    `readdir=${readdirCalls} ms=${enumMs}`);
  ok(`枚举期间外部定时器仍被调度（${ticksDuringEnum} 次，要求 ≥3）`,
    ticksDuringEnum >= 3, String(ticksDuringEnum));
  ok(`枚举期间定时器最大卡顿 ≤ ${ENUM_LAG_BUDGET_MS}ms（实测 ${maxEnumLag}ms）`,
    enumLags.length > 0 && maxEnumLag > 0 && maxEnumLag <= ENUM_LAG_BUDGET_MS, String(maxEnumLag));
  ok(`walk 每递归一个子目录就让出一次（setImmediate ${immCount} 次 ≥ ${TREE_DIRS}）`,
    immCount >= TREE_DIRS, String(immCount));

  /* ---------- 10. 清理 ---------- */
  await new Promise((r) => setTimeout(r, 50));
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('QA 脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
