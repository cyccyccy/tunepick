'use strict';
/**
 * Source Adapter 工厂 —— DESIGN §5 Q1
 * localfs   ：生产，直读 Docker 只读挂载的音乐目录
 * navidrome ：开发/回退，走 Subsonic API（本地读不到 NAS 文件系统时用）
 */

const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('source');

function create(kindOverride) {
  const kind = kindOverride || config.SOURCE_KIND || 'localfs';
  if (kind === 'localfs') return require('./local-fs').create();
  if (kind === 'navidrome') return require('./navidrome').create();
  throw Object.assign(new Error(`未知的 SOURCE_KIND: ${kind}`), { hint: '可选值：localfs | navidrome' });
}

module.exports = { create };
