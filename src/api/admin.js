'use strict';
/**
 * 管理端点 —— PRD §6.3（新增能力）
 */

const fs = require('fs');
const path = require('path');
const db = require('../store/db');
const schema = require('../store/schema');
const covers = require('../store/covers');
const config = require('../config');
const l2 = require('../scrape/l2');
const l3 = require('../scrape/l3');
const llm = require('../scrape/llm-client');
const vocab = require('../scrape/vocab');
const merge = require('../scrape/merge');
const l1 = require('../scrape/l1');
const task = require('../scan/task');
const logger = require('../logger');
const { makeLogger } = require('../logger');

const log = makeLogger('api:admin');

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ==================== 扫描 ==================== */

async function scanStart(req, res) {
  const body = await readBody(req).then((b) => (b.length ? JSON.parse(b.toString('utf8')) : {})).catch(() => ({}));
  const r = await task.start({
    mode: body.mode || 'full',
    sampleSize: body.sampleSize,
    force: body.force,
    sources: body.sources,
    useL2: body.useL2,
    useL3: body.useL3,
  });
  return json(res, r);
}

async function scanSample(req, res) {
  const body = await readBody(req).then((b) => (b.length ? JSON.parse(b.toString('utf8')) : {})).catch(() => ({}));
  const r = await task.start({
    mode: 'sample',
    sampleSize: body.size || config.SAMPLE_SIZE,
    useL2: body.useL2,
    useL3: body.useL3,
  });
  return json(res, { ...r, sampleSize: body.size || config.SAMPLE_SIZE });
}

/** 试跑质量报告（Q-14） */
function sampleReport(res) {
  const run = db.meta.lastRun;
  const all = db.all();
  const sampled = all.filter((t) => t.scrapeStage && t.scrapeStage !== 'L1_only');
  const c = db.coverage();
  const stats = l2.sourceStats();
  const report = {
    available: !!(run && run.mode === 'sample'),
    taskId: run?.taskId || '',
    mode: run?.mode || '',
    population: run?.population || all.length,
    sampled: sampled.length || all.length,
    distribution: run?.distribution || {},
    coverage: c.coveragePct,
    quality: c.quality,
    sourceStats: stats,
    llm: { configured: llm.configured(), provider: llm.current().provider, model: llm.current().model },
    elapsedMs: run ? (run.finishedAt || Date.now()) - run.startedAt : 0,
    perTrackMs: run?.done ? +(((run.finishedAt || Date.now()) - run.startedAt) / run.done).toFixed(0) : 0,
    estimateFullMs: run?.done
      ? Math.round(((run.finishedAt || Date.now()) - run.startedAt) / run.done * (run.population || all.length))
      : 0,
  };
  return json(res, { report });
}

/** 目录结构探测报告（Q-11） */
function probeReport(res) {
  const all = db.all();
  const depthDist = {};
  let flat = 0;
  const artistDirs = new Set();
  let inferred = 0;
  for (const t of all) {
    depthDist[t.dirDepth] = (depthDist[t.dirDepth] || 0) + 1;
    if ((t.dirDepth || 0) < config.PATH_INFER_MIN_DEPTH) flat++;
    const parts = (t.filePath || '').split('/');
    if (parts.length >= 3) artistDirs.add(parts[0]);
    if (t.sourceMap && t.sourceMap.album === 'path') inferred++;
    if (t.sourceMap && t.sourceMap.cleanArtist === 'path') inferred++;
  }
  return json(res, {
    report: {
      total: all.length,
      depthDistribution: depthDist,
      flatFiles: flat,
      flatRatio: all.length ? +(flat / all.length * 100).toFixed(1) : 0,
      suspectedArtistDirs: artistDirs.size,
      pathInferApplied: inferred,
      pathInferEnabled: config.PATH_INFER_ENABLED,
      minDepth: config.PATH_INFER_MIN_DEPTH,
    },
  });
}

function scanStatus(res) { return json(res, task.status()); }
function scanPause(res) { return json(res, task.pause()); }
function scanResume(res) { return json(res, task.resume()); }
function scanCancel(res) { return json(res, task.cancel()); }
function scanHistory(res) { return json(res, { runs: task.history() }); }

function scanLogs(res, url) {
  const lines = logger.read({
    tail: url.searchParams.get('tail') || 200,
    level: url.searchParams.get('level') || '',
    q: url.searchParams.get('q') || '',
  });
  return json(res, { lines, total: lines.length });
}

/** 单曲重刮 */
async function rescanTrack(req, res, id) {
  const t = db.resolve(id);
  if (!t) return json(res, { ok: false, error: '曲目不存在' }, 404);
  try {
    const r = await l2.scrape(t, { wantLyrics: true, wantCover: true });
    const { accepted } = merge.mergeFields(t, r.fields);
    if (r.lyrics && !t.lyrics) {
      t.lyrics = r.lyrics;
      t.lyricsSource = r.lyricsSource;
      t.lyricsHasTimeline = /\[\d{1,2}:\d{2}/.test(r.lyrics);
    }
    if (r.cover && r.cover.url && !t.coverId) {
      const saved = await covers.saveFromUrl(r.cover.url);
      if (saved) {
        t.coverId = saved.coverId; t.coverMime = saved.mime; t.coverHash = saved.hash;
        t.coverSource = r.cover.source; t.coverSizes = saved.sizes;
      }
    }
    merge.recomputeConfidence(t);
    schema.finalize(t);
    t.scrapeStage = 'L2_done';
    db.upsert(t);
    db.flush(true);
    return json(res, { ok: true, updated: accepted, meta: r.meta });
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
}

/** 试跑转全量（跳过已完成的） */
async function promote(res) {
  const r = await task.start({ mode: 'incremental' });
  return json(res, { ...r, skipped: db.all().filter((t) => t.scrapeStage !== 'L1_only').length });
}

/* ==================== id 映射（Q-01 / FR-74/75） ==================== */

async function idmapImport(req, res) {
  const buf = await readBody(req);
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let matched = 0, unmatched = 0;
  const unmatchedIds = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith('legacyid')) continue;      // 跳过表头
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const legacyId = parts[0].trim();
    const relPath = parts.slice(1).join(',').trim().replace(/^"|"$/g, '');
    const t = db.byPath(relPath);
    if (t) {
      if (!t.legacyIds.includes(legacyId)) t.legacyIds.push(legacyId);
      db.upsert(t);
      matched++;
    } else {
      unmatched++;
      if (unmatchedIds.length < 200) unmatchedIds.push(legacyId);
    }
  }
  db.flush(true);
  db.meta.idmap = { importedAt: new Date().toISOString(), matched, unmatched };
  db.saveMeta();
  return json(res, { matched, unmatched, unmatchedIds });
}

function idmapStatus(res) {
  const all = db.all();
  const mapped = all.filter((t) => (t.legacyIds || []).length > 0).length;
  return json(res, { mapped, total: all.length, lastImport: db.meta.idmap || null });
}

/* ==================== 封面 ==================== */

function cover(res, coverId, size) {
  if (coverId === 'placeholder') {
    const svg = placeholderSvg();
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'public, max-age=86400' });
    return res.end(svg);
  }
  const found = covers.read(coverId, size);
  if (!found) return cover(res, 'placeholder', size);
  let len = 0;
  try { len = fs.statSync(found.path).size; } catch (_) { return cover(res, 'placeholder', size); }
  res.writeHead(200, {
    'Content-Type': found.mime,
    'Content-Length': len,
    'Cache-Control': 'public, max-age=604800',
  });
  // ⚠️ 必须监听 error：EISDIR / EACCES / 文件被删等会让 createReadStream 异步报错，
  //    没有监听时它变成 uncaughtException，且响应头已发出但 body 永不到达 → 客户端挂死。
  const rs = fs.createReadStream(found.path);
  rs.on('error', (e) => {
    log.warn('封面读取失败', { coverId, error: e && e.message });
    try { res.destroy(); } catch (_) { /* 已断开 */ }
  });
  return rs.pipe(res);
}

function placeholderSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
<rect width="300" height="300" fill="#1c1c1e"/>
<circle cx="150" cy="120" r="46" fill="none" stroke="#3a3a3c" stroke-width="8"/>
<path d="M104 168v34a46 46 0 0 0 92 0v-34" fill="none" stroke="#3a3a3c" stroke-width="8"/>
<text x="150" y="252" font-family="sans-serif" font-size="18" fill="#5a5a5c" text-anchor="middle">暂无封面</text>
</svg>`;
}

/* ==================== 检索 / 审阅 ==================== */

function facets(res) { return json(res, db.facets()); }

function filter(res, url) {
  const p = url.searchParams;
  const r = db.filter({
    q: p.get('q') || '', genre: p.get('genre') || '', mood: p.get('mood') || '',
    scene: p.get('scene') || '', lang: p.get('lang') || '', era: p.get('era') || '',
    albumGroup: p.get('albumGroup') || '',
    needReview: p.get('needReview') === 'true' ? true : p.get('needReview') === 'false' ? false : null,
    quality: p.get('quality') || '',
    sort: p.get('sort') || 'title', order: p.get('order') || 'asc',
    limit: parseInt(p.get('limit'), 10) || 50, offset: parseInt(p.get('offset'), 10) || 0,
  });
  return json(res, { ...r, items: r.items.map(require('./compat').compat) });
}

function reviewQueue(res, url) {
  const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
  const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
  const all = db.all().filter((t) => t.needReview);
  const reasons = all.map((t) => {
    const r = [];
    if (t.isAd) r.push('广告/引流');
    if (t.isGarbled) r.push('乱码');
    if ((t.confidence || 0) < 0.6) r.push('低置信度');
    if (t.fieldConfidence?.cleanArtistConflict) r.push('歌手冲突');
    if (schema.isPseudo(t.cleanArtist) && schema.isPseudo(t.artist)) r.push('歌手缺失');
    if (!t.genre) r.push('流派缺失');
    return r.join(' / ') || '待确认';
  });
  return json(res, {
    total: all.length,
    items: all.slice(offset, offset + limit).map((t, i) => ({
      ...require('./compat').compat(t),
      reviewReason: reasons[offset + i] || '',
      confidence: t.confidence,
    })),
  });
}

/**
 * 人工修正**不可写**的字段黑名单（P0 安全）
 *
 * 这些字段描述「文件在哪里、是什么」，一旦可改：
 *   PATCH {"filePath":"../../../../etc/passwd"} + GET /api/stream/<id> = 读宿主任意文件。
 * 只读直通的设计前提就是库内 filePath 可信，因此这里必须把它钉死。
 * 命中黑名单只拒绝**该字段**，其余字段照常写入（不能整体 400，否则批量编辑会全军覆没）。
 */
const PATCH_DENY_FIELDS = new Set([
  'id', 'filePath', 'fileName', 'fileExt', 'fileSizeBytes', 'fileMtime', 'dirDepth',
]);

/** 人工修正（自动锁定） */
async function patchTrack(req, res, id) {
  const t = db.resolve(id);
  if (!t) return json(res, { ok: false, error: '曲目不存在' }, 404);
  const body = await readBody(req).then((b) => JSON.parse(b.toString('utf8'))).catch(() => ({}));
  const updated = [];
  const denied = [];
  for (const [k, v] of Object.entries(body)) {
    if (PATCH_DENY_FIELDS.has(k)) { denied.push(k); continue; }
    if (k === 'id' || !schema.FIELD_NAMES.includes(k)) continue;
    t[k] = v;
    if (!t.lockedFields.includes(k)) t.lockedFields.push(k);
    t.sourceMap[k] = 'manual';
    t.fieldConfidence[k] = 1;
    updated.push(k);
  }
  if (body.manualNote) t.manualNote = body.manualNote;
  if (updated.includes('year')) t.era = vocab.yearToEra(t.year);
  merge.recomputeConfidence(t);
  schema.finalize(t);
  db.upsert(t);
  db.flush(true);
  if (denied.length) log.warn('已忽略不可修改字段', { id, denied });
  return json(res, { ok: true, updated, lockedFields: t.lockedFields, denied });
}

async function unlockTrack(req, res, id) {
  const t = db.resolve(id);
  if (!t) return json(res, { ok: false, error: '曲目不存在' }, 404);
  const body = await readBody(req).then((b) => JSON.parse(b.toString('utf8'))).catch(() => ({}));
  if (Array.isArray(body.fields) && body.fields.length) {
    t.lockedFields = t.lockedFields.filter((f) => !body.fields.includes(f));
  } else {
    t.lockedFields = [];
  }
  db.upsert(t); db.flush(true);
  return json(res, { ok: true, lockedFields: t.lockedFields });
}

async function batchUpdate(req, res) {
  const body = await readBody(req).then((b) => JSON.parse(b.toString('utf8'))).catch(() => ({}));
  const ids = body.ids || [];
  const patch = body.patch || {};
  // 与 patchTrack 同一套黑名单：文件位置类字段不允许批量改（见 PATCH_DENY_FIELDS 注释）
  const denied = Object.keys(patch).filter((k) => PATCH_DENY_FIELDS.has(k));
  const fields = Object.entries(patch).filter(([k]) => !PATCH_DENY_FIELDS.has(k));
  let n = 0;
  for (const id of ids) {
    const t = db.resolve(id);
    if (!t) continue;
    for (const [k, v] of fields) {
      if (!schema.FIELD_NAMES.includes(k) || k === 'id') continue;
      t[k] = v;
      if (!t.lockedFields.includes(k)) t.lockedFields.push(k);
      t.sourceMap[k] = 'manual';
      t.fieldConfidence[k] = 1;
    }
    merge.recomputeConfidence(t);
    schema.finalize(t);
    db.upsert(t);
    n++;
  }
  db.flush(true);
  if (denied.length) log.warn('批量修改已忽略不可修改字段', { denied, count: ids.length });
  return json(res, { ok: true, updatedCount: n, denied });
}

/* ==================== 数据源 / LLM ==================== */

function sources(res) {
  const stats = l2.sourceStats();
  const list = Object.entries(stats).map(([name, s]) => ({
    name,
    enabled: config.ONLINE_SOURCES.includes(name),
    qps: config.ONLINE_QPS,
    ...s,
  }));
  return json(res, { sources: list, globalEnabled: config.ONLINE_ENABLED, qps: config.ONLINE_QPS });
}

async function patchSources(req, res) {
  const body = await readBody(req).then((b) => JSON.parse(b.toString('utf8'))).catch(() => ({}));
  if (Array.isArray(body.sources)) {
    config.ONLINE_SOURCES = body.sources.filter((s) => s.enabled !== false).map((s) => s.name || s);
  }
  if (body.globalEnabled !== undefined) config.ONLINE_ENABLED = !!body.globalEnabled;
  if (body.qps !== undefined) config.ONLINE_QPS = Number(body.qps) || 1;
  db.meta.sources = { enabled: config.ONLINE_SOURCES, qps: config.ONLINE_QPS, updatedAt: new Date().toISOString() };
  db.saveMeta();
  return sources(res);
}

async function testSource(req, res, name) {
  const mod = l2.REGISTRY[name] && l2.REGISTRY[name]();
  if (!mod || !mod.test) return json(res, { ok: false, error: '未知数据源：' + name }, 404);
  const r = await mod.test();
  return json(res, { name, ...r });
}

function llmConfig(res) {
  const c = llm.current();
  const key = c.apiKey || '';
  return json(res, {
    provider: c.provider,
    providerName: c.name,
    endpoint: c.endpoint,
    model: c.model,
    configured: llm.configured(),
    enabled: config.LLM_ENABLED,
    apiKeyMasked: key ? key.slice(0, 6) + '****' + key.slice(-4) : '',
    vocabVersion: vocab.VOCAB_VERSION,
    batchSize: config.LLM_BATCH_SIZE,
    sendPath: config.LLM_SEND_PATH,
  });
}

async function patchLlmConfig(req, res) {
  // 2026-10-01 起停用：LLM 写入入口关闭，避免通过接口回填密钥重新连上外部模型。
  return json(res, {
    ok: false,
    error: 'LLM 配置已停用（2026-10-01）：不再接入任何 LLM',
    disabled: true,
  }, 410);
  const body = await readBody(req).then((b) => JSON.parse(b.toString('utf8'))).catch(() => ({}));
  if (body.provider) config.LLM_PROVIDER = body.provider;
  if (body.endpoint) {
    // SSRF / Key 外送防线（只卡协议，不卡 IP 段）：
    //   file:// gopher:// data:// 之类能把本地文件读出去或把 API Key 送到非 HTTP 端点。
    //   内网 IP **不拦** —— 用户自建局域网 LLM（如 http://192.168.1.9:11434）是合法场景。
    const raw = String(body.endpoint).trim();
    let u = null;
    try { u = new URL(raw); } catch (_) { u = null; }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      return json(res, {
        ok: false,
        error: `endpoint 协议不合法：${raw.slice(0, 120)}`,
        hint: '仅允许 http:// 或 https://（自建局域网 LLM 同样受支持，但必须是这两个协议）',
      }, 400);
    }
    config.LLM_ENDPOINT = raw;
  }
  if (body.model) config.LLM_MODEL = body.model;
  if (body.apiKey !== undefined) config.LLM_API_KEY = body.apiKey;
  if (body.enabled !== undefined) config.LLM_ENABLED = !!body.enabled;
  if (body.batchSize) config.LLM_BATCH_SIZE = Number(body.batchSize) || 8;
  if (body.sendPath !== undefined) config.LLM_SEND_PATH = !!body.sendPath;
  db.meta.llm = {
    provider: config.LLM_PROVIDER, model: config.LLM_MODEL,
    endpoint: config.LLM_ENDPOINT, updatedAt: new Date().toISOString(),
  };
  db.saveMeta();
  return llmConfig(res);
}

function llmModels(res) { return json(res, { models: llm.listModels() }); }

async function llmTest(req, res) {
  // 2026-10-01 起停用：连通性自检会真的往模型端点打请求，直接掐掉。
  return json(res, {
    ok: false,
    error: 'LLM 已停用（2026-10-01）：不向任何外部地址发起请求',
    disabled: true,
  }, 410);
}

/** 按词表/模型版本重刷旧标签（FR-73） */
async function rerunStale(req, res) {
  const body = await readBody(req).then((b) => JSON.parse(b.toString('utf8'))).catch(() => ({}));
  const target = db.all().filter((t) => {
    if (body.force) return true;
    return !t.modelVersion || !String(t.modelVersion).includes(vocab.VOCAB_VERSION);
  });
  let queued = 0, skippedLocked = 0;
  const runnable = target.filter((t) => {
    const allLocked = ['genre', 'mood', 'scene', 'lang', 'era'].every((f) => (t.lockedFields || []).includes(f));
    if (allLocked) { skippedLocked++; return false; }
    return true;
  });
  if (runnable.length && llm.configured()) {
    const results = await l3.inferBatch(runnable.slice(0, body.limit || 500));
    for (const t of runnable.slice(0, body.limit || 500)) {
      const raw = results.get(t.id);
      if (!raw) continue;
      l3.apply(t, raw);
      merge.recomputeConfidence(t);
      schema.finalize(t);
      db.upsert(t);
      queued++;
    }
    db.flush(true);
  }
  return json(res, { queued, skippedLocked, stale: target.length, vocabVersion: vocab.VOCAB_VERSION });
}

/* ==================== 统计 / 导出 ==================== */

function statsCoverage(res) { return json(res, db.coverage()); }

function exportData(res, url) {
  const format = url.searchParams.get('format') || 'json';
  const { items } = db.filter({ limit: 100000 });
  if (format === 'csv') {
    const cols = ['id', 'title', 'cleanTitle', 'artist', 'cleanArtist', 'album', 'year', 'era', 'genre', 'lang', 'durationSec', 'confidence', 'qualityLevel'];
    const rows = [cols.join(',')].concat(
      items.map((t) => cols.map((c) => {
        const v = Array.isArray(t[c]) ? t[c].join(' ') : (t[c] ?? '');
        return `"${String(v).replace(/"/g, '""')}"`;
      }).join(','))
    );
    // CRLF + BOM：Excel 直接双击打开不乱码（UTF-8 无 BOM 时 Excel 按本地编码解，中文全糊）
    const body = '\uFEFF' + rows.join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="tunepick-export.csv"',
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }
  // ⚠️ 不 pretty：全库 22MB 缩进后体积翻倍且 stringify 明显变慢，
  //    export 是给程序/存档用的，人读性由导入方负责。
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), total: items.length, tracks: items });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  return res.end(body);
}

function health(res) {
  return json(res, {
    status: 'ok',
    tracks: db.size(),
    llmConfigured: llm.configured(),
    vocabVersion: vocab.VOCAB_VERSION,
    scanState: task.state,
    authMode: config.authMode(),
    authWarning: require('./auth').authWarning(),
    sourceKind: config.SOURCE_KIND,
    coverUsageMB: covers.usageMB(),
    uptimeSec: Math.round(process.uptime()),
  });
}

module.exports = {
  scanStart, scanSample, sampleReport, probeReport, scanStatus, scanPause,
  scanResume, scanCancel, scanHistory, scanLogs, rescanTrack, promote,
  idmapImport, idmapStatus, cover, facets, filter, reviewQueue,
  patchTrack, unlockTrack, batchUpdate, sources, patchSources, testSource,
  llmConfig, patchLlmConfig, llmModels, llmTest, rerunStale,
  statsCoverage, exportData, health, readBody, json,
};
