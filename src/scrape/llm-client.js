'use strict';
/**
 * LLM 客户端 —— OpenAI 兼容协议（零依赖，用全局 fetch）
 * 沿用 music-player/backend/llm-client.js 的设计思路：多厂商预设 + 运行时切换 + 失败返回 null 降级
 */

const config = require('../config');
const { makeLogger } = require('../logger');
const net = require('../util/net');

const log = makeLogger('llm');

/** 厂商预设（PRD §8.3 LLM_PROVIDER） */
const PROVIDERS = {
  deepseek:  { name: 'DeepSeek',  endpoint: 'https://api.deepseek.com/v1/chat/completions',  model: 'deepseek-chat' },
  openai:    { name: 'OpenAI',    endpoint: 'https://api.openai.com/v1/chat/completions',    model: 'gpt-4o-mini' },
  zhipu:     { name: '智谱',       endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
  moonshot:  { name: 'Moonshot',  endpoint: 'https://api.moonshot.cn/v1/chat/completions',   model: 'moonshot-v1-8k' },
  qwen:      { name: '通义千问',   endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  custom:    { name: '自定义',     endpoint: '', model: '' },
};

function current() {
  const p = PROVIDERS[config.LLM_PROVIDER] || PROVIDERS.custom;
  return {
    provider: config.LLM_PROVIDER,
    name: p.name,
    endpoint: config.LLM_ENDPOINT || p.endpoint,
    model: config.LLM_MODEL || p.model,
    apiKey: config.LLM_API_KEY,
  };
}

function configured() {
  const c = current();
  return !!(c.apiKey && c.endpoint && c.model);
}

/**
 * 发起一次对话
 * @returns {Promise<string|null>} 模型输出文本；失败返回 null（调用方降级）
 */
/**
 * 是否存在 HTTP 代理环境变量。
 * ⚠️ Node 的 fetch（undici）**不读** HTTP_PROXY/HTTPS_PROXY，而 curl 会读。
 * 所以在有代理的环境（如本沙箱、公司内网）里 fetch 会直连失败，必须走 curl 通道。
 */
function hasProxyEnv() {
  return !!(process.env.HTTPS_PROXY || process.env.https_proxy ||
            process.env.HTTP_PROXY || process.env.http_proxy);
}

async function chat(messages, opts = {}) {
  const c = current();
  if (!configured()) {
    log.warn('LLM 未配置，跳过调用');
    return null;
  }
  const timeoutMs = opts.timeoutMs || config.LLM_TIMEOUT_MS;
  const body = {
    model: c.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens || config.LLM_MAX_TOKENS,
  };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${c.apiKey}`,
  };
  const t0 = Date.now();

  // 原生通道：支持 HTTP 代理 CONNECT 隧道，不依赖外部 curl
  const viaRaw = async () => {
    const r = await net.rawRequest(c.endpoint, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs });
    return { ok: r.ok, status: r.status, text: r.text || '' };
  };

  const viaFetch = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(c.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } finally { clearTimeout(timer); }
  };

  // 有代理时 fetch（undici）不读代理环境变量，必然失败 → 直接用原生通道
  const order = hasProxyEnv() ? [viaRaw, viaFetch] : [viaRaw, viaFetch];
  let last = null;
  for (const fn of order) {
    try {
      const r = await fn();
      last = r;
      if (!r.ok) {
        log.warn('LLM 返回错误', { status: r.status, body: (r.text || '').slice(0, 200) });
        continue;
      }
      let j;
      try { j = JSON.parse(r.text); } catch (_) {
        log.warn('LLM 响应非 JSON', { body: (r.text || '').slice(0, 200) });
        continue;
      }
      const msg = j.choices?.[0]?.message || {};
      let content = typeof msg.content === 'string' ? msg.content : '';
      // 推理模型（如 deepseek-flash/pro）会把有效输出放进 reasoning_content，
      // 且 max_tokens 不足时 content 可能为空 —— 此时必须视为失败，不能把推理过程当答案。
      if (!content.trim() && typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
        log.warn('LLM 只返回了推理内容（content 为空），可能是 max_tokens 不足', {
          reasoningLen: msg.reasoning_content.length,
        });
        return null;
      }
      if (!content.trim()) {
        log.warn('LLM 响应缺少 content', { body: (r.text || '').slice(0, 200) });
        return null;
      }
      log.debug('LLM 调用成功', { ms: Date.now() - t0, len: content.length });
      return content;
    } catch (e) {
      log.warn('LLM 调用失败', { error: e.message, ms: Date.now() - t0, via: fn === viaFetch ? 'fetch' : 'curl' });
    }
  }
  if (last) log.warn('LLM 所有通道均失败', { lastStatus: last.status });
  return null;
}

/** 从可能含 markdown 代码块的文本中提取 JSON */
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  try { return JSON.parse(s); }
  catch (_) {
    // 尝试截取最后一个 } 或 ]
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (end > 0) { try { return JSON.parse(s.slice(0, end + 1)); } catch (_2) { return null; } }
    return null;
  }
}

/** 连通性自检 */
async function test() {
  const t0 = Date.now();
  if (!configured()) return { ok: false, latencyMs: 0, error: '未配置 API Key 或端点' };
  // ⚠️ token 预算必须给足：推理模型（deepseek-flash / v4-pro）会先把预算耗在
  // reasoning_content 上，预算不足时 content 为空 —— 那不是"没答案"，是"没说完"。
  // 实测：maxTokens=16 时推理占满 16 tokens，content 恒为空 → 误判为调用失败。
  const r = await chat([{ role: 'user', content: '请回复 OK 两个字，不要解释' }], { maxTokens: 512, timeoutMs: 30000 });
  return { ok: !!(r && r.trim()), latencyMs: Date.now() - t0, error: r ? '' : '调用失败' };
}

function listModels() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, endpoint: p.endpoint, model: p.model }));
}

module.exports = { PROVIDERS, current, configured, chat, extractJson, test, listModels };
