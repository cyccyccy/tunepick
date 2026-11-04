'use strict';
/**
 * QA 回归：NAS 上直接删除音乐文件后，TunePick 曲库必须同步移除该曲目。
 *
 * 复现的 bug（2026-11-04 用户报障）：
 *   用户在 NAS 里删了一批歌，播放端曲库里仍能看到，点播放提示「不能播放」。
 * 根因：src/scan/task.js 的扫描只对磁盘现存文件做 upsert，从不与库内记录做差集；
 *       src/store/db.js 的 _indexRemove 只在 upsert 覆盖时调用、且不清 order，
 *       所以分片 JSON 里的失效记录会永久残留，重启后又被 load() 读回来。
 *
 * 本测试覆盖：
 *   1. 增量扫描后，已删曲目从内存索引消失，且落盘后「重启不复活」（核心）
 *   2. reconcile 必须在增量过滤之前用完整枚举做差集（否则会误删全部）
 *   3. 护栏：枚举为空 / 枚举遗漏但文件仍在 / 待删比例过高 / 抽样试跑 一律不删
 *   4. remove() 不误伤共用「时长|文件名」兜底键的其他曲目
 *
 * 不依赖真实音频文件，注入假 source 并把 _processOne 打桩成 no-op：
 * 本测试只验证删除对账与持久化，不重复验证刮削链路。
 *
 * 运行：node tests/qa-deleted-tracks.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TMP = path.join(__dirname, '..', '.tmp-qa-deleted-tracks');
const MUSIC_DIR = path.join(TMP, 'music');
const TRACKS_DIR = path.join(TMP, 'tracks');

process.env.SKIP_DOT_ENV = '1';
process.env.SOURCE_KIND = 'localfs';
process.env.DATA_DIR = TMP;
process.env.MUSIC_DIR = MUSIC_DIR;
process.env.ONLINE_ENABLED = 'false';
process.env.LLM_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_TOKEN = 'testtoken';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.SCAN_CONCURRENCY = '2';

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(TRACKS_DIR, { recursive: true });

const config = require('../src/config');
const db = require('../src/store/db');
const DB = db.DB;
const task = require('../src/scan/task');

/* ---------------- 工具 ---------------- */

function mkTrack(id, filePath, opts = {}) {
  return {
    id, filePath,
    fileName: path.basename(filePath),
    title: opts.title || path.basename(filePath),
    artist: '测试歌手', album: '测试专辑',
    durationSec: opts.durationSec || 200,
    fileSizeBytes: 1024,
    fileMtime: new Date().toISOString(),
    legacyIds: [],
    createdAt: new Date().toISOString(),
    genre: '', mood: [], scene: [], lang: '', era: '未知',
    coverHash: '', coverId: '', sourceMap: {}, lockedFields: [],
    qualityLevel: 'medium', needReview: false, isGarbled: false, isAd: false,
    lyrics: '', lyricsHasTimeline: false, lyricsSource: '',
  };
}

function mkEntry(filePath) {
  return {
    filePath,
    absPath: path.join(MUSIC_DIR, filePath),
    fileName: path.basename(filePath),
    fileExt: 'flac',
    fileSizeBytes: 1024,
    fileMtime: new Date().toISOString(),
    dirDepth: 0,
  };
}

/** 把单例 db 重置成给定曲目集合，并清掉磁盘分片。 */
function resetDb(tracks) {
  for (const k of Object.keys(db.index)) db.index[k].clear();
  db.order.length = 0;
  db.dirty.clear();
  fs.rmSync(TRACKS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TRACKS_DIR, { recursive: true });
  for (const t of tracks) db.upsert(t);
  db.flush(true);
  db.loadMeta();
}

function mkRun(mode) {
  return {
    taskId: 'run_deleted_tracks_test', mode, stage: 'enumerating',
    done: 0, total: 0, failed: 0,
    startedAt: Date.now(), currentFile: '',
    counters: { l1: 0, l2Hit: 0, l2Miss: 0, l3: 0, lyrics: 0, cover: 0, ad: 0, garbled: 0, removed: 0 },
    opts: {},
  };
}

function useFakeSrc(entries, mode) {
  task.src = { kind: 'localfs', root: MUSIC_DIR, enumerate: async () => entries };
  task.run = mkRun(mode);
  task.state = 'running';
  task.cursor = 0;
  task._stopFlag = false;
  task._protect = new Map();
  task._processOne = async () => ({});   // 本测试只关心对账，不跑刮削
  task.listeners.clear();
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('  PASS  ' + name);
}

/* ---------------- 准备物理文件 ---------------- */
for (const f of ['a.flac', 'b.flac', 'c.flac']) {
  fs.writeFileSync(path.join(MUSIC_DIR, f), 'fake-audio-' + f);
}

async function main() {
  /* ---------------- 场景 1：核心 + 重启不复活 ---------------- */
  await check('增量扫描移除已删曲目，且落盘后重启不复活', async () => {
    resetDb([
      mkTrack('tp_a001', 'a.flac'),
      mkTrack('tp_b002', 'b.flac'),
      mkTrack('tp_c003', 'gone/gone.flac'),   // 物理文件不存在 = 用户删掉的歌
    ]);
    assert.strictEqual(db.all().length, 3);
    assert.ok(fs.readFileSync(path.join(TRACKS_DIR, 'shard-c.json'), 'utf8').includes('tp_c003'));

    useFakeSrc([mkEntry('a.flac'), mkEntry('b.flac')], 'incremental');
    await task._execute({ mode: 'incremental', useL2: false, useL3: false });

    assert.strictEqual(task.run.counters.removed, 1, '应只移除 1 首');
    assert.strictEqual(task.run.reconcile.skipped, '');
    assert.strictEqual(db.all().length, 2, '内存索引应剩 2 首');
    assert.strictEqual(db.byPath('gone/gone.flac'), null);
    assert.strictEqual(db.index.byId.has('tp_c003'), false);

    // 关键：重新载入分片，确认旧记录没有卷土重来
    db.flush(true);
    assert.ok(!fs.readFileSync(path.join(TRACKS_DIR, 'shard-c.json'), 'utf8').includes('tp_c003'));
    const fresh = new DB();
    fresh.load();
    assert.strictEqual(fresh.all().length, 2, '重启后不能被删掉的歌复活');
    assert.strictEqual(fresh.byPath('gone/gone.flac'), null);
    assert.notStrictEqual(fresh.byPath('a.flac'), null);
    assert.notStrictEqual(fresh.byPath('b.flac'), null);
    assert.strictEqual(fresh.size(), 2);
  });

  /* ---------------- 场景 2：护栏 —— 枚举为空 ---------------- */
  await check('枚举为空（疑似挂载丢失）时拒绝删库', () => {
    resetDb([
      mkTrack('tp_a001', 'a.flac'),
      mkTrack('tp_b002', 'b.flac'),
      mkTrack('tp_c003', 'gone/x.flac'),
    ]);
    useFakeSrc([], 'full');
    const r = task._reconcileDeleted([]);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.skipped, 'empty-enumeration');
    assert.strictEqual(db.all().length, 3);
  });

  /* ---------------- 场景 3：护栏 —— 枚举遗漏但文件仍在 ---------------- */
  await check('existsSync 二次确认：枚举遗漏但文件仍在时不误删', () => {
    resetDb([
      mkTrack('tp_a001', 'a.flac'),
      mkTrack('tp_b002', 'b.flac'),
      mkTrack('tp_c003', 'c.flac'),   // 物理存在，但故意不出现在枚举里
    ]);
    useFakeSrc([mkEntry('a.flac')], 'full');
    const r = task._reconcileDeleted([mkEntry('a.flac')]);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(db.all().length, 3);
    assert.notStrictEqual(db.byPath('b.flac'), null);
    assert.notStrictEqual(db.byPath('c.flac'), null);
  });

  /* ---------------- 场景 4：护栏 —— 待删比例过高 ---------------- */
  await check('待删比例超过阈值时拒绝执行（防 MUSIC_DIR 配错清库）', () => {
    resetDb([
      mkTrack('tp_a001', 'a.flac'),
      mkTrack('tp_b002', 'gone/b.flac'),
      mkTrack('tp_c003', 'gone/c.flac'),
      mkTrack('tp_d004', 'gone/d.flac'),
    ]);
    config.RECONCILE_MAX_DELETE_RATIO = 0.5;   // 3/4 = 0.75 > 0.5
    useFakeSrc([mkEntry('a.flac')], 'full');
    const r = task._reconcileDeleted([mkEntry('a.flac')]);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.skipped, 'ratio-guard');
    assert.strictEqual(r.pending, 3);
    assert.strictEqual(db.all().length, 4);
  });

  /* ---------------- 场景 5：抽样试跑不改库 ---------------- */
  await check('sample 模式跳过删除对账', () => {
    resetDb([mkTrack('tp_a001', 'a.flac'), mkTrack('tp_c003', 'gone/x.flac')]);
    useFakeSrc([mkEntry('a.flac')], 'sample');
    const r = task._reconcileDeleted([mkEntry('a.flac')]);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.skipped, 'sample');
    assert.strictEqual(db.all().length, 2);
  });

  /* ---------------- 场景 6：remove() 不误伤共享兜底键 ---------------- */
  await check('删除同「时长|文件名」曲目时，另一条的兜底索引仍可用', () => {
    resetDb([
      mkTrack('tp_a001', 'a/song.flac', { durationSec: 233 }),
      mkTrack('tp_b002', 'b/song.flac', { durationSec: 233 }),
    ]);
    const key = '233|song.flac';
    assert.ok(db.index.byDurPath.has(key));
    assert.strictEqual(db.remove(db.byPath('a/song.flac')), true);
    assert.strictEqual(db.all().length, 1);
    const survivor = db.resolve(key);
    assert.ok(survivor, '兜底解析不能因为删掉同键曲目而失效');
    assert.strictEqual(survivor.filePath, 'b/song.flac');
  });

  console.log('\nqa-deleted-tracks: ' + passed + ' 组断言全部通过');
}

main().catch((e) => {
  console.error('\nqa-deleted-tracks FAILED:', (e && e.stack) || e);
  process.exitCode = 1;
});
