'use strict';
/**
 * L1：内嵌标签层（+ 目录推断兜底）
 *
 * 处理链：
 *   乱码检测 → GBK 无损还原 → 装饰噪声剥离 → 分隔切分
 *   → 目录推断(L1-b) → 伪歌手/广告识别 → FLAGS 标记 → 年代映射
 *
 * 关键实测结论（原型）：
 *   - 乱码还原是 L2 的前置必要条件，不做则在线查询词本身是乱码，命中率趋近 0
 *   - 目录推断与内嵌标签同源，覆盖率净增益为 0，只能当校验用
 */

const path = require('path');
const enc = require('../util/encoding');
const T = require('../util/text');
const vocab = require('./vocab');
const schema = require('../store/schema');
const { applyField } = require('./merge');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('scrape:l1');

/** 已知伪歌手 / 打包站上传者（原型实测 Cydian 325 首，[Unknown Artist] 704 首） */
const PSEUDO_ARTISTS = new Set([
  'cydian', 'unknown artist', 'unknown', 'various artists', '群星',
  '未知艺术家', '未知歌手', '无', 'none', 'null',
]);

/** 疑似占位专辑名（本库 2956 首同名） */
const PLACEHOLDER_ALBUMS = new Set([
  '律动车载音乐', '车载音乐', 'music', 'unknown album', '未知专辑', '我的音乐', '无损音乐',
]);

function isPseudoArtist(a) {
  if (!a) return true;
  const s = String(a).trim().toLowerCase();
  if (!s) return true;
  if (PSEUDO_ARTISTS.has(s)) return true;
  if (schema.PSEUDO_VALUES.has(String(a).trim())) return true;
  return false;
}

/** FLAGS 关键词规则 */
const FLAG_RULES = [
  ['isLive', /(live|现场|演唱会|音乐会|live版)/i],
  ['isRemix', /(remix|dj|混音|电音版|改编版|remix版)/i],
  ['isInstrumental', /(纯音乐|伴奏|无人声|instrumental|karaoke|off ?vocal)/i],
  ['isCover', /(翻唱|cover by|cover版)/i],
];

/**
 * 执行 L1
 * @param {object} entry  文件条目（来自 source.enumerate）
 * @param {object} tags   统一标签对象（来自 source.readTags）
 * @returns {object} 曲目对象
 */
function process(entry, tags = {}) {
  const rel = entry.filePath;
  const t = schema.newTrack({
    id: schema.makeTrackId(rel),
    filePath: rel,
    fileName: entry.fileName || path.basename(rel),
    fileExt: entry.fileExt || path.extname(rel).slice(1).toLowerCase(),
    fileSizeBytes: entry.fileSizeBytes || 0,
    fileMtime: entry.fileMtime || '',
    dirDepth: entry.dirDepth ?? 0,
    format: tags.format || 'UNKNOWN',
    bitrate: tags.bitrate || 0,
    sampleRate: tags.sampleRate || 0,
    durationSec: tags.durationSec || 0,
  });

  // ---------- 1. 乱码检测与还原（前置必要条件）----------
  const rawTitle = tags.title || '';
  const rawArtist = tags.artist || '';
  const rawAlbum = tags.album || '';

  const garbledTitle = enc.looksGarbled(rawTitle);
  const garbledArtist = enc.looksGarbled(rawArtist);
  const garbledAlbum = enc.looksGarbled(rawAlbum);
  const wasGarbled = garbledTitle || garbledArtist || garbledAlbum;

  const title = garbledTitle ? enc.fixGarbled(rawTitle) : rawTitle;
  const artist = garbledArtist ? enc.fixGarbled(rawArtist) : rawArtist;
  const album = garbledAlbum ? enc.fixGarbled(rawAlbum) : rawAlbum;

  t.isGarbled = wasGarbled;
  t.title = title || stripExt(t.fileName);

  // ---------- 2. 广告 / 引流识别 ----------
  const adHit = T.isAdText(title) || T.isAdText(artist) || T.isAdText(album);
  t.isAd = adHit;
  if (adHit) log.debug('识别为广告内容', { id: t.id, artist });

  // ---------- 3. 清洗与分隔切分 ----------
  const usableArtist = artist && !isPseudoArtist(artist) && !T.isAdText(artist) ? artist.trim() : '';
  const { titleCandidates, artistCandidates } = T.splitTitle(t.title, usableArtist);

  const cleanTitle = (titleCandidates.find((c) => c && c.length > 0) || t.title).trim();
  t.cleanTitle = T.stripTrailingDecorations(T.stripLeadingDecorations(T.stripTrackPrefix(cleanTitle))).trim() || cleanTitle;

  if (usableArtist) {
    t.artist = artist.trim();
    t.cleanArtist = usableArtist;
    applyField(t, 'artist', artist.trim(), 'embed', 0.9);
    applyField(t, 'cleanArtist', usableArtist, 'embed', 0.9);
  } else if (artistCandidates.length) {
    // 标题里拆出的歌手（`Mojito-周杰伦`）→ 低置信度推断
    const inferred = artistCandidates[0];
    t.cleanArtist = inferred;
    applyField(t, 'cleanArtist', inferred, 'filename', 0.4);
    log.debug('从标题推断歌手', { id: t.id, inferred });
  }
  applyField(t, 'cleanTitle', t.cleanTitle, 'embed', 0.7);

  // ---------- 4. 专辑 ----------
  const albumVal = album && !schema.PSEUDO_VALUES.has(album.trim()) ? album.trim() : '';
  t.albumIsPlaceholder = PLACEHOLDER_ALBUMS.has(albumVal.toLowerCase());
  if (albumVal) {
    // 占位专辑（如「律动车载音乐」2956 首同名）给低置信度，允许被在线源的真实专辑覆盖
    applyField(t, 'album', albumVal, 'embed', t.albumIsPlaceholder ? 0.3 : 0.85);
  }
  if (t.albumIsPlaceholder) t.albumGroup = 'unknown';
  if (tags.albumArtist && !isPseudoArtist(tags.albumArtist)) t.albumArtist = tags.albumArtist;

  // ---------- 5. 目录推断（L1-b，优先级低于内嵌）----------
  if (config.PATH_INFER_ENABLED) {
    const inferred = inferFromPath(rel, entry.dirDepth ?? 0);
    if (inferred.artist && !t.cleanArtist) {
      applyField(t, 'cleanArtist', inferred.artist, 'path', 0.6);
      t.cleanArtist = inferred.artist;
    }
    if (inferred.album && !t.album) {
      applyField(t, 'album', inferred.album, 'path', 0.6);
      t.album = inferred.album;
    }
  }

  // ---------- 6. 数值字段 ----------
  if (tags.year > 0) applyField(t, 'year', tags.year, 'embed', 0.9);
  if (tags.trackNo > 0) t.trackNo = tags.trackNo;
  if (tags.discNo > 0) t.discNo = tags.discNo;
  t.era = vocab.yearToEra(t.year);
  if (t.year > 0) applyField(t, 'era', t.era, 'embed', 0.85);

  // ---------- 7. 内嵌歌词 ----------
  if (tags.lyrics && tags.lyrics.trim().length > 10) {
    t.lyrics = sanitizeLyrics(tags.lyrics);
    t.lyricsHasTimeline = /\[\d{1,2}:\d{2}/.test(t.lyrics);
    t.lyricsSource = 'embedded';
    applyField(t, 'lyrics', t.lyrics, 'embed', 0.9);
  }

  // ---------- 8. FLAGS ----------
  const hay = `${t.title} ${t.album} ${t.artist} ${t.cleanTitle}`;
  for (const [flag, re] of FLAG_RULES) t[flag] = re.test(hay);
  t.isShort = t.durationSec > 0 && t.durationSec < 60;

  // ---------- 9. 收尾 ----------
  t.scrapeStage = 'L1_only';
  schema.finalize(t);
  return t;
}

/**
 * 目录推断：path = "歌手/专辑/文件.mp3"
 * 实测结论：与内嵌标签同源，覆盖率净增益 0，仅作兜底与校验
 */
function inferFromPath(rel, depth) {
  const parts = rel.split('/').filter(Boolean);
  const out = { artist: '', album: '' };
  if (parts.length < 3) return out;         // 需要至少 歌手/专辑/文件
  if (depth < config.PATH_INFER_MIN_DEPTH) return out;   // 扁平目录优雅降级，不猜测不报错

  const a = parts[0].trim();
  const b = parts[1].trim();
  if (a && !isPseudoArtist(a) && !T.isAdText(a) && a.length <= 40) out.artist = a;
  if (b && !PLACEHOLDER_ALBUMS.has(b.toLowerCase()) && b.length <= 60) out.album = b;
  return out;
}

function stripExt(name) {
  return String(name).replace(/\.[^.]+$/, '').trim();
}

/** 歌词清洗：去 HTML/脚本，超 50KB 截断（PRD §4.3） */
function sanitizeLyrics(raw) {
  let s = String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n');
  const MAX = 50 * 1024;
  if (s.length > MAX) {
    log.warn('歌词超长，已截断', { len: s.length });
    s = s.slice(0, MAX);
  }
  return s.trim();
}

module.exports = {
  process,
  isPseudoArtist,
  inferFromPath,
  sanitizeLyrics,
  PSEUDO_ARTISTS,
  PLACEHOLDER_ALBUMS,
};
