'use strict';
/**
 * L3：LLM 推断层
 *
 * 核心原则（PRD / AI-INTEGRATION-PLAN）：AI 负责「理解」，程序负责「检索与排序」
 * 只把**文本元数据**发给模型，绝不发音频、默认不发文件路径（LLM_SEND_PATH=false）
 *
 * 本层是流派 / 情绪 / 场景 / 语种的唯一来源——在线源不返回这些字段（实测 ≈0%）
 */

const llm = require('./llm-client');
const vocab = require('./vocab');
const merge = require('./merge');
const config = require('../config');
const { makeLogger } = require('../logger');

const log = makeLogger('scrape:l3');

const SYSTEM_PROMPT = `你是一个中文音乐元数据标注助手。根据给定的曲目信息，为每首曲目输出结构化标签。

严格要求：
1. 只输出 JSON 数组，不要任何解释文字、不要 markdown 代码块。
2. 每个元素形如：{"id":"<给定id>","cleanTitle":"清洗后曲名","cleanArtist":"清洗后歌手","genre":"<流派>","mood":["<情绪>"],"scene":["<场景>"],"lang":"<语种>","era":"<年代>","energy":<1-5>,"valence":<1-5>,"isCover":false,"isLive":false,"isRemix":false,"isInstrumental":false,"confidence":<0-1>}
3. 取值必须严格来自下列封闭词表，越界值会被丢弃：
   - genre(选1)：${vocab.VOCAB.genre.join(' / ')}
   - mood(选1-3)：${vocab.VOCAB.mood.join(' / ')}
   - scene(选0-3)：${vocab.VOCAB.scene.join(' / ')}
   - lang(选1)：${vocab.VOCAB.lang.join(' / ')}
   - era(选1)：${vocab.VOCAB.era.join(' / ')}
4. 曲名若含装饰噪声（如【3D环绕】、DJ版、公众号引流），请在 cleanTitle 中剔除。
5. 若歌手字段是把「歌手-曲名」塞在一起的（如 "Mojito-周杰伦"），请拆开填入 cleanArtist 与 cleanTitle。
6. 判断不了时用"其他"/"未知"，不要编造。confidence 反映你的把握程度。`;

/**
 * 批量推断
 * @param {Array<object>} tracks 曲目数组
 * @returns {Promise<Map<string, object>>} id → 标签结果
 */
async function inferBatch(tracks) {
  const results = new Map();
  if (!config.LLM_ENABLED || !llm.configured()) {
    log.info('L3 跳过：未启用或未配置 LLM', { enabled: config.LLM_ENABLED, configured: llm.configured() });
    return results;
  }

  const size = Math.max(1, config.LLM_BATCH_SIZE);
  for (let i = 0; i < tracks.length; i += size) {
    const batch = tracks.slice(i, i + size);
    const payload = batch.map((t) => ({
      id: t.id,
      title: t.title || '',
      artist: t.cleanArtist || t.artist || '',
      album: t.album || '',
      year: t.year || 0,
      durationSec: t.durationSec || 0,
      ...(config.LLM_SEND_PATH ? { path: t.filePath } : {}),
    }));

    const content = await llm.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ]);

    if (!content) {
      log.warn('L3 批次失败，跳过', { offset: i, size: batch.length });
      continue;
    }

    const parsed = llm.extractJson(content);
    if (!Array.isArray(parsed)) {
      log.warn('L3 返回不可解析', { offset: i, preview: content.slice(0, 120) });
      continue;
    }

    for (const item of parsed) {
      if (!item || !item.id) continue;
      results.set(String(item.id), item);
    }
  }
  return results;
}

/**
 * 把 L3 结果应用到曲目（字段级，受 lockedFields 保护）
 * @returns {string[]} 实际写入的字段名
 */
function apply(track, raw) {
  const written = [];
  if (!raw) return written;

  const { ok, tags } = vocab.validate(raw);
  if (!ok) {
    log.debug('L3 结果未通过词表校验', { id: track.id, reason: 'V-03' });
    track.needReview = true;
    return written;
  }

  const conf = clamp(Number(raw.confidence) ?? 0.7);
  const put = (field, value, c = conf) => {
    if (merge.applyField(track, field, value, 'llm', c) === 'accepted') written.push(field);
  };

  if (raw.cleanTitle) put('cleanTitle', String(raw.cleanTitle).trim(), conf);
  if (raw.cleanArtist) put('cleanArtist', String(raw.cleanArtist).trim(), conf);
  if (tags.genre) put('genre', tags.genre);
  if (tags.mood && tags.mood.length) put('mood', tags.mood);
  if (tags.scene && tags.scene.length) put('scene', tags.scene);
  if (tags.lang) put('lang', tags.lang);
  if (tags.era) put('era', tags.era);
  if (tags.energy) put('energy', tags.energy);
  if (tags.valence) put('valence', tags.valence);

  // FLAGS：只置 true，不覆盖已有的 true
  for (const f of ['isCover', 'isLive', 'isRemix', 'isInstrumental']) {
    if (raw[f] === true && !track[f]) track[f] = true;
  }

  if (!track.year && tags.era && tags.era !== '未知') {
    merge.applyField(track, 'era', tags.era, 'llm', conf);
  }

  track.modelVersion = `${llm.current().model}/${vocab.VOCAB_VERSION}`;
  return written;
}

function clamp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, +v.toFixed(3)));
}

module.exports = { inferBatch, apply, SYSTEM_PROMPT };
