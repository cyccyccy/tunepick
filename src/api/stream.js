'use strict';
/**
 * 只读文件直通音频流 —— PRD §6.1（Q-02 裁决）
 * 支持 Range，不转码、不封装。「不做播放服务」= 不做解码/转码/播放编排。
 */

const db = require('../store/db');
const source = require('../source');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('api:stream');

let _src = null;
function src() { if (!_src) _src = source.create(); return _src; }

const MIME = {
  mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  wma: 'audio/x-ms-wma', aac: 'audio/aac', m4b: 'audio/mp4',
};

async function handle(req, res, id) {
  const track = db.resolve(id);
  if (!track) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: '曲目不存在', hint: '确认 id 是否正确' }));
  }

  try {
    const rangeHeader = config.STREAM_RANGE_ENABLED ? req.headers.range : null;
    const r = await src().readRange(track, rangeHeader);
    const mime = MIME[track.fileExt] || 'application/octet-stream';
    res.writeHead(r.status, {
      'Content-Type': mime,
      'Accept-Ranges': r.headers['Accept-Ranges'] || 'bytes',
      ...(r.headers['Content-Length'] ? { 'Content-Length': r.headers['Content-Length'] } : {}),
      ...(r.headers['Content-Range'] ? { 'Content-Range': r.headers['Content-Range'] } : {}),
      'Cache-Control': 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    r.stream.pipe(res);
    r.stream.on('error', (e) => { log.warn('音频流中断', { id, error: e.message }); try { res.end(); } catch (_) {} });
  } catch (e) {
    log.error('音频流失败', { id, error: e.message });
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '读取音频失败：' + e.message, hint: '检查音乐目录挂载与文件权限' }));
  }
}

module.exports = { handle };
