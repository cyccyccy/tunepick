'use strict';
/**
 * 标签解析统一入口 —— 按扩展名分发到 ID3 / FLAC / OGG / MP4
 * 设计要点：只读文件头部（默认 512KB），不整文件载入，控制内存
 */

const fs = require('fs');
const path = require('path');
const id3 = require('./id3');
const flac = require('./flac');
const mp4 = require('./mp4');
const { makeLogger } = require('../logger');

const log = makeLogger('tags');

const HEAD_BYTES = parseInt(process.env.TAG_HEAD_BYTES || String(512 * 1024), 10);

const EXT_FORMAT = {
  mp3: 'MP3', flac: 'FLAC', ogg: 'OGG', oga: 'OGG', opus: 'OGG',
  m4a: 'M4A', mp4: 'M4A', m4b: 'M4A', aac: 'AAC', wav: 'WAV', wma: 'WMA', ape: 'APE',
};

/**
 * 读取单个文件的标签
 * @param {string} file 绝对路径
 * @param {fs.Stats} [stat]
 * @returns {object} 统一标签对象（字段缺失为空值）
 */
function readTags(file, stat) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const format = EXT_FORMAT[ext] || 'UNKNOWN';
  const base = {
    title: '', artist: '', album: '', albumArtist: '', year: 0,
    genre: '', trackNo: 0, discNo: 0, comment: '',
    durationSec: 0, bitrate: 0, sampleRate: 0,
    format, picture: null, lyrics: '',
  };

  if (format === 'UNKNOWN') return base;

  let head;
  try {
    const s = stat || fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const want = Math.min(HEAD_BYTES, s.size);
      head = Buffer.alloc(want);
      fs.readSync(fd, head, 0, want, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    log.warn('读取文件头部失败', { file, error: e.message });
    return base;
  }

  try {
    if (format === 'MP3') {
      const t = id3.parse(head);
      const d = id3.mp3Duration(head, (stat && stat.size) || head.length);
      Object.assign(base, pick(t), {
        durationSec: d.durationSec, bitrate: d.bitrate, sampleRate: d.sampleRate,
      });
    } else if (format === 'FLAC') {
      const t = flac.parseFlac(head);
      Object.assign(base, pick(t));
    } else if (format === 'OGG') {
      const t = flac.parseOgg(head);
      Object.assign(base, pick(t));
    } else if (format === 'M4A') {
      const t = mp4.parse(head);
      Object.assign(base, pick(t));
    }
  } catch (e) {
    log.warn('标签解析异常，降级为仅文件名', { file, error: e.message });
  }

  return base;
}

/** 只挑出白名单字段，避免解析器内部字段污染 */
function pick(t) {
  if (!t) return {};
  const o = {};
  for (const k of ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'trackNo',
    'discNo', 'comment', 'durationSec', 'bitrate', 'sampleRate', 'lyrics']) {
    if (t[k] !== undefined && t[k] !== null) o[k] = t[k];
  }
  if (t.picture && t.picture.data) o.picture = t.picture;
  return o;
}

module.exports = { readTags, EXT_FORMAT };
