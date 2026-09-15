'use strict';
/**
 * 元数据 Schema —— PRD §4.1 的 63 个字段
 * A 标识与文件 12 + B 核心元数据 12 + C 标签 7 + D 歌词图片 10 + E 简介 3 + F 质量治理 19 = 63
 */

const crypto = require('crypto');
const vocab = require('../scrape/vocab');

/** 伪值：这些值视为「不可用」，不得参与合并与统计 */
const PSEUDO_VALUES = new Set([
  '[Unknown Artist]', '[Unknown Album]', 'Unknown Artist', 'Unknown Album',
  'unknown', 'N/A', 'n/a', '-', '',
]);

function isPseudo(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'number') return v === 0;
  if (typeof v === 'string') return PSEUDO_VALUES.has(v.trim());
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 生成稳定曲目 id */
function makeTrackId(filePath) {
  return 'tp_' + crypto.createHash('sha1').update(String(filePath)).digest('hex').slice(0, 12);
}

/** 生成封面 id（内容 hash 去重） */
function makeCoverId(buffer) {
  return 'cv_' + crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
}

/** 新建一条曲目记录（全部 63 字段，带默认值） */
function newTrack(init = {}) {
  const now = new Date().toISOString();
  const t = {
    // ---- A. 标识与文件属性 ----
    id: init.id || '',
    filePath: init.filePath || '',
    fileName: init.fileName || '',
    fileExt: init.fileExt || '',
    fileSizeBytes: init.fileSizeBytes || 0,
    fileMtime: init.fileMtime || '',
    legacyIds: init.legacyIds || [],
    dirDepth: init.dirDepth ?? 0,
    format: init.format || 'UNKNOWN',
    bitrate: init.bitrate ?? 0,
    sampleRate: init.sampleRate ?? 0,
    durationSec: init.durationSec ?? 0,

    // ---- B. 核心元数据 ----
    title: init.title || '',
    cleanTitle: init.cleanTitle || '',
    artist: init.artist || '',
    cleanArtist: init.cleanArtist || '',
    albumArtist: init.albumArtist || '',
    album: init.album || '',
    albumGroup: init.albumGroup || 'unknown',
    albumIsPlaceholder: init.albumIsPlaceholder ?? false,
    trackNo: init.trackNo ?? 0,
    discNo: init.discNo ?? 0,
    year: init.year ?? 0,
    era: init.era || '未知',

    // ---- C. 标签类（封闭词表）----
    genre: init.genre || '',
    mood: init.mood || [],
    scene: init.scene || [],
    lang: init.lang || '',
    energy: init.energy ?? 0,
    valence: init.valence ?? 0,
    customTags: init.customTags || [],

    // ---- D. 歌词与图片 ----
    lyrics: init.lyrics || '',
    lyricsHasTimeline: init.lyricsHasTimeline ?? false,
    lyricsSource: init.lyricsSource || '',
    coverId: init.coverId || '',
    coverMime: init.coverMime || '',
    coverWidth: init.coverWidth ?? 0,
    coverHeight: init.coverHeight ?? 0,
    coverHash: init.coverHash || '',
    coverSource: init.coverSource || '',
    coverSizes: init.coverSizes || [],

    // ---- E. 文本简介 ----
    artistBio: init.artistBio || '',
    albumIntro: init.albumIntro || '',
    bioSource: init.bioSource || '',

    // ---- F. 质量与治理 ----
    confidence: init.confidence ?? 0,
    fieldConfidence: init.fieldConfidence || {},
    sourceMap: init.sourceMap || {},
    qualityLevel: init.qualityLevel || 'low',
    needReview: init.needReview ?? true,
    isAd: init.isAd ?? false,
    isGarbled: init.isGarbled ?? false,
    isLive: init.isLive ?? false,
    isRemix: init.isRemix ?? false,
    isInstrumental: init.isInstrumental ?? false,
    isShort: init.isShort ?? false,
    isCover: init.isCover ?? false,
    isDuplicate: init.isDuplicate ?? false,
    lockedFields: init.lockedFields || [],
    manualNote: init.manualNote || '',
    modelVersion: init.modelVersion || '',
    scrapeStage: init.scrapeStage || 'L1_only',
    createdAt: init.createdAt || now,
    updatedAt: init.updatedAt || now,
  };
  if (!t.id && t.filePath) t.id = makeTrackId(t.filePath);
  return t;
}

/** 全部字段名（63） */
const FIELD_NAMES = Object.keys(newTrack({ id: 'x', filePath: 'y' }));

/**
 * 计算质量分级（PRD §4.5）
 * high：核心 6 字段 ≥5 有值 且 confidence ≥0.8
 * medium：≥3 有值
 * low：其余
 */
function computeQualityLevel(t) {
  const core = [t.cleanArtist || t.artist, t.era, t.genre, t.mood, t.coverId, t.lyrics];
  const filled = core.filter((v) => !isPseudo(v)).length;
  if (filled >= 5 && (t.confidence || 0) >= 0.8) return 'high';
  if (filled >= 3) return 'medium';
  return 'low';
}

/**
 * 计算 needReview（PRD §4.5）
 * confidence<0.6 / yearConflict / isAd / isGarbled / 核心字段(artist|era|genre)为空
 */
function computeNeedReview(t) {
  if ((t.confidence || 0) < 0.6) return true;
  if (t.isAd || t.isGarbled) return true;
  if (t.fieldConfidence && t.fieldConfidence.yearConflict) return true;
  if (isPseudo(t.cleanArtist) && isPseudo(t.artist)) return true;
  if (isPseudo(t.era) || t.era === '未知') return true;
  if (isPseudo(t.genre)) return true;
  return false;
}

/** 统一收尾：算 qualityLevel / needReview / updatedAt */
function finalize(t) {
  t.qualityLevel = computeQualityLevel(t);
  t.needReview = computeNeedReview(t);
  t.updatedAt = new Date().toISOString();
  return t;
}

/** 兼容层字段映射：内部 Schema → 对外 App 契约（PRD §6.2 唯一未缓解项） */
function toCompat(t, coverUrlFn) {
  return {
    id: t.id,
    title: t.cleanTitle || t.title,
    artist: t.cleanArtist || t.artist,
    albumTitle: t.album,        // 原契约字段名
    album: t.album,             // 新字段名并存
    year: t.year || 0,
    durationSec: t.durationSec || 0,
    coverUrl: coverUrlFn ? coverUrlFn(t) : (t.coverId ? `/api/cover/${t.coverId}?size=300` : ''),
    coverId: t.coverId || '',
    genre: t.genre || '',
    mood: t.mood || [],
    scene: t.scene || [],
    lang: t.lang || '',
    era: t.era || '未知',
    format: t.format || '',
    bitrate: t.bitrate || 0,
    trackNo: t.trackNo || 0,
  };
}

module.exports = {
  FIELD_NAMES,
  PSEUDO_VALUES,
  isPseudo,
  makeTrackId,
  makeCoverId,
  newTrack,
  computeQualityLevel,
  computeNeedReview,
  finalize,
  toCompat,
  vocab,
};
