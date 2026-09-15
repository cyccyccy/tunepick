'use strict';
/**
 * 扫描任务引擎 —— DESIGN §3.3 状态机
 * 支持：手动触发 / 可中断 / 断点续跑 / 进度反馈 / 抽样试跑
 */

const crypto = require('crypto');
const config = require('../config');
const db = require('../store/db');
const schema = require('../store/schema');
const covers = require('../store/covers');
const source = require('../source');
const l1 = require('../scrape/l1');
const l2 = require('../scrape/l2');
const l3 = require('../scrape/l3');
const merge = require('../scrape/merge');
const sampler = require('./sampler');
const { makeLogger } = require('../logger');

const log = makeLogger('scan');

const STATE = {
  IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused',
  COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
};

class ScanTask {
  constructor() {
    this.state = STATE.IDLE;
    this.run = null;
    this.queue = [];
    this.cursor = 0;
    this.timers = null;
    this.src = null;
    this.listeners = new Set();
    this._stopFlag = false;
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this.status()); } catch (_) {} } }

  status() {
    if (!this.run) return { state: this.state, running: false, done: 0, total: 0, failed: 0 };
    const done = this.run.done;
    const elapsed = (Date.now() - this.run.startedAt) / 1000;
    const speed = elapsed > 0 ? done / elapsed : 0;
    const remain = Math.max(0, this.run.total - done);
    return {
      taskId: this.run.taskId,
      state: this.state,
      running: this.state === STATE.RUNNING,
      mode: this.run.mode,
      stage: this.run.stage,
      done,
      total: this.run.total,
      failed: this.run.failed,
      percent: this.run.total ? +((done / this.run.total) * 100).toFixed(1) : 0,
      etaSec: speed > 0 ? Math.round(remain / speed) : null,
      speedPerSec: +speed.toFixed(2),
      currentFile: this.run.currentFile || '',
      startedAt: new Date(this.run.startedAt).toISOString(),
      counters: this.run.counters || {},
    };
  }

  /**
   * 启动扫描
   * @param {object} opts {mode, force, sampleSize, sources, wantLyrics, wantCover, useL3}
   */
  async start(opts = {}) {
    if (this.state === STATE.RUNNING) {
      return { accepted: false, reason: '已有任务在运行中', state: this.state };
    }
    const mode = opts.mode || 'full';
    const taskId = 'run_' + crypto.randomBytes(4).toString('hex');

    this.src = source.create();
    this.run = {
      taskId,
      mode,
      stage: 'enumerating',
      done: 0,
      total: 0,
      failed: 0,
      startedAt: Date.now(),
      currentFile: '',
      counters: { l1: 0, l2Hit: 0, l2Miss: 0, l3: 0, lyrics: 0, cover: 0, ad: 0, garbled: 0 },
      opts,
    };
    this.state = STATE.RUNNING;
    this.cursor = 0;
    this._stopFlag = false;

    log.info('扫描任务启动', { taskId, mode, source: this.src.kind });
    this._emit();

    // 异步执行，不阻塞 API 响应
    this._execute(opts).catch((e) => {
      log.error('扫描任务异常终止', { taskId, error: e.message });
      this.state = STATE.FAILED;
      this.run.error = e.message;
      this._persistRun();
      this._emit();
    });

    return { accepted: true, taskId, state: this.state };
  }

  async _execute(opts) {
    const r = this.run;

    // ---------- 1. 枚举 ----------
    let entries = await this.src.enumerate();
    this.run.stage = 'reading';
    this._emit();

    // ---------- 2. 增量判定 ----------
    if (r.mode === 'incremental') {
      entries = entries.filter((e) => {
        const old = db.byPath(e.filePath);
        return !old || old.fileMtime !== e.fileMtime || old.fileSizeBytes !== e.fileSizeBytes;
      });
    }

    // ---------- 3. 抽样试跑 ----------
    if (r.mode === 'sample') {
      const size = opts.sampleSize || config.SAMPLE_SIZE;
      const tagsList = [];
      for (const e of entries) {
        try { tagsList.push(await this.src.readTags(e)); } catch (_) { tagsList.push({}); }
      }
      const s = sampler.sample(entries, tagsList, size);
      entries = s.samples;
      r.distribution = s.distribution;
      r.population = s.population;
      r.sampleSize = entries.length;
      log.info('分层抽样完成', { picked: entries.length, distribution: s.distribution });
    }

    r.total = entries.length;
    r.stage = 'scraping';
    this._emit();

    // ---------- 4. 逐首处理 ----------
    const concurrency = Math.max(1, config.SCAN_CONCURRENCY);
    const batchForL3 = [];

    for (let i = this.cursor; i < entries.length; ) {
      if (this._stopFlag) break;
      if (this.state === STATE.PAUSED) { await sleep(200); continue; }
      if (this.state === STATE.CANCELLED) break;

      const slice = entries.slice(i, i + concurrency);
      await Promise.all(slice.map(async (entry) => {
        try {
          await this._processOne(entry, opts, batchForL3);
          r.done++;
          r.counters.l1++;
        } catch (e) {
          r.failed++;
          r.done++;
          log.warn('单曲处理失败', { file: entry.filePath, error: e.message });
        }
      }));

      i += slice.length;
      this.cursor = i;

      // ---------- L3 分批 ----------
      if (opts.useL3 !== false && batchForL3.length >= config.LLM_BATCH_SIZE) {
        await this._runL3(batchForL3.splice(0, batchForL3.length));
      }

      // ---------- checkpoint ----------
      if (i % config.CHECKPOINT_EVERY === 0 || i >= entries.length) {
        db.flush();
        this._persistRun();
      }
      this._emit();
    }

    // 收尾 L3
    if (batchForL3.length && opts.useL3 !== false && this.state === STATE.RUNNING) {
      await this._runL3(batchForL3.splice(0, batchForL3.length));
    }

    db.flush();
    this._persistRun();

    if (this.state === STATE.RUNNING) {
      this.state = STATE.COMPLETED;
      log.info('扫描任务完成', {
        taskId: r.taskId, done: r.done, failed: r.failed,
        ms: Date.now() - r.startedAt, counters: r.counters,
      });
    }
    this._persistRun();
    this._emit();
  }

  /** 处理单曲：L1 → 合并 → L2 → 歌词 → 封面 → finalize */
  async _processOne(entry, opts, batchForL3) {
    const r = this.run;
    r.currentFile = entry.filePath;

    const tags = await this.src.readTags(entry);
    const fresh = l1.process(entry, tags);

    // 与已有记录合并：保留 lockedFields 与人工修正
    const existing = db.byPath(entry.filePath);
    let track = fresh;
    if (existing) {
      track = existing;
      for (const k of schema.FIELD_NAMES) {
        if (k === 'id' || k === 'createdAt') continue;
        if ((track.lockedFields || []).includes(k)) continue;
        if (!schema.isPseudo(fresh[k]) && (schema.isPseudo(track[k]) || !track.sourceMap?.[k])) {
          track[k] = fresh[k];
        }
      }
      for (const k of ['fileSizeBytes', 'fileMtime', 'durationSec', 'bitrate', 'sampleRate', 'format']) {
        track[k] = fresh[k];
      }
    }

    // ---------- 歌词：本地 .lrc > 内嵌 > 在线 ----------
    if (!track.lyrics && this.src.readLocalLrc) {
      try {
        const localLrc = await this.src.readLocalLrc(track);
        if (localLrc && localLrc.trim().length > 10) {
          track.lyrics = l1.sanitizeLyrics(localLrc);
          track.lyricsHasTimeline = /\[\d{1,2}:\d{2}/.test(track.lyrics);
          track.lyricsSource = 'local-lrc';
          merge.applyField(track, 'lyrics', track.lyrics, 'embed', 0.95);
          r.counters.lyrics++;
        }
      } catch (_) { /* ignore */ }
    }

    // ---------- L2 在线刮削 ----------
    if (config.ONLINE_ENABLED && opts.useL2 !== false) {
      try {
        const res = await l2.scrape(track, {
          sources: opts.sources,
          wantLyrics: !track.lyrics,
          wantCover: !track.coverId,
        });
        if (res.fields && res.fields.length) {
          const { accepted } = merge.mergeFields(track, res.fields);
          if (accepted.length) r.counters.l2Hit++;
          else r.counters.l2Miss++;
        } else {
          r.counters.l2Miss++;
        }
        if (res.lyrics && !track.lyrics) {
          track.lyrics = res.lyrics;
          track.lyricsHasTimeline = /\[\d{1,2}:\d{2}/.test(res.lyrics);
          track.lyricsSource = res.lyricsSource;
          merge.applyField(track, 'lyrics', res.lyrics, res.lyricsSource, 0.8);
          r.counters.lyrics++;
        }
        if (res.cover && res.cover.url && !track.coverId) {
          const saved = await covers.saveFromUrl(res.cover.url);
          if (saved) {
            track.coverId = saved.coverId;
            track.coverMime = saved.mime;
            track.coverWidth = saved.width;
            track.coverHeight = saved.height;
            track.coverHash = saved.hash;
            track.coverSource = res.cover.source;
            track.coverSizes = saved.sizes;
            r.counters.cover++;
          }
        }
        track.scrapeStage = 'L2_done';
      } catch (e) {
        log.debug('L2 失败', { file: entry.filePath, error: e.message });
        r.counters.l2Miss++;
      }
    }

    if (track.isAd) r.counters.ad++;
    if (track.isGarbled) r.counters.garbled++;

    // ---------- 年代映射 ----------
    if (track.year > 0 && (!track.era || track.era === '未知')) {
      const era = require('../scrape/vocab').yearToEra(track.year);
      merge.applyField(track, 'era', era, track.sourceMap?.year || 'embed', 0.8);
    }

    merge.recomputeConfidence(track);
    schema.finalize(track);
    db.upsert(track);

    if (opts.useL3 !== false) batchForL3.push(track);
    return track;
  }

  /** L3 批量推断 */
  async _runL3(batch) {
    if (!batch.length) return;
    if (!config.LLM_ENABLED || !require('../scrape/llm-client').configured()) return;
    try {
      const results = await l3.inferBatch(batch);
      for (const t of batch) {
        const raw = results.get(t.id);
        if (!raw) continue;
        l3.apply(t, raw);
        merge.recomputeConfidence(t);
        schema.finalize(t);
        t.scrapeStage = 'L3_done';
        db.upsert(t);
        this.run.counters.l3++;
      }
    } catch (e) {
      log.warn('L3 批次失败', { size: batch.length, error: e.message });
    }
  }

  pause() {
    if (this.state !== STATE.RUNNING) return { ok: false, state: this.state };
    this.state = STATE.PAUSED;
    this._persistRun();
    log.info('扫描已暂停', { cursor: this.cursor });
    this._emit();
    return { ok: true, state: this.state, cursor: this.cursor };
  }

  resume() {
    if (this.state !== STATE.PAUSED) return { ok: false, state: this.state, reason: '仅暂停状态可续跑' };
    this.state = STATE.RUNNING;
    log.info('扫描断点续跑', { from: this.cursor });
    this._emit();
    return { ok: true, state: this.state, from: this.cursor };
  }

  cancel() {
    if (![STATE.RUNNING, STATE.PAUSED].includes(this.state)) return { ok: false, state: this.state };
    this.state = STATE.CANCELLED;
    this._stopFlag = true;
    db.flush();
    this._persistRun();
    log.info('扫描已取消', { cursor: this.cursor });
    this._emit();
    return { ok: true, state: this.state };
  }

  _persistRun() {
    if (!this.run) return;
    const m = db.meta;
    m.lastRun = {
      taskId: this.run.taskId,
      mode: this.run.mode,
      state: this.state,
      cursor: this.cursor,
      done: this.run.done,
      total: this.run.total,
      failed: this.run.failed,
      stage: this.run.stage,
      startedAt: this.run.startedAt,
      finishedAt: Date.now(),
      counters: this.run.counters,
      distribution: this.run.distribution,
      population: this.run.population,
    };
    const i = m.runs.findIndex((x) => x.taskId === this.run.taskId);
    if (i >= 0) m.runs[i] = m.lastRun;
    else m.runs.unshift(m.lastRun);
    if (m.runs.length > 20) m.runs.length = 20;      // PRD §8.5：可回看最近 ≥20 次
    db.saveMeta();
  }

  history() { return db.meta.runs || []; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const task = new ScanTask();
module.exports = task;
module.exports.ScanTask = ScanTask;
module.exports.STATE = STATE;
