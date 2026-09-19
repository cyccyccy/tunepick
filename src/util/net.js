'use strict';

/**
 * Network helpers.
 *
 * Two very different paths on purpose:
 *  - `httpGetJson` uses the built-in `http` module and IGNORES proxy env vars.
 *    Required for the Navidrome box on the Tailscale IP: routing it through the
 *    local proxy always fails.
 *  - `webGet` targets the public internet (NetEase / MusicBrainz / Cover Art
 *    Archive). It first tries the global `fetch` without a proxy, and falls
 *    back to `curl` (which honours HTTP_PROXY/HTTPS_PROXY) when direct access
 *    is blocked.
 *
 * ---------------------------------------------------------------------------
 * RESPONSE CLASSIFICATION (why this file is stricter than it looks)
 * A response is only `ok` when ALL of these hold:
 *   1. the HTTP status is a real 2xx  — for the `curl` path the status comes
 *      from `-w '%{http_code}'`, NOT from a hard-coded guess. An earlier
 *      version reported `status: 200` for every parsable curl response, which
 *      made the whole "source health" telemetry meaningless.
 *   2. the body parsed as JSON
 *   3. the body carries no BUSINESS error, which is how these APIs actually
 *      report failure (NetEase: `{"code":405,"msg":"操作频繁…"}` with HTTP 200;
 *      MusicBrainz: `{"error":"The MusicBrainz web server is currently busy…"}`
 *      with HTTP 200). Both look perfectly healthy at the HTTP layer.
 * Failures are returned as distinct flags (`httpError`, `businessError`,
 * `parseError`) so callers can tell "the source said no" from "we could not
 * reach the source" — the distinction the source-liveness metric depends on.
 * ---------------------------------------------------------------------------
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const nodeNet = require('net');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;

/** Appended by curl's `-w` so the real HTTP status survives the process boundary. */
const STATUS_MARKER = '\n__HTTP_STATUS__:';

/**
 * Plain HTTP GET returning a parsed JSON body. No proxy, ever.
 *
 * @param {string} urlString
 * @param {{timeoutMs?:number, headers?:Record<string,string>}} [opts]
 * @returns {Promise<{status:number, headers:Record<string,string>, body:any, rawLength:number, elapsedMs:number}>}
 */
function httpGetJson(urlString, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.get(
      urlString,
      { headers: opts.headers || {}, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let body = null;
          let parseError = null;
          try {
            body = JSON.parse(buf.toString('utf8'));
          } catch (err) {
            parseError = err.message;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body,
            parseError,
            rawLength: buf.length,
            elapsedMs: Date.now() - started,
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => reject(err));
  });
}

/**
 * Detects a business-level error inside an otherwise valid JSON body.
 *
 * Both sources in this spike signal failure in the body while returning HTTP
 * 200, so the transport layer alone can never tell success from failure.
 *
 * @param {any} body
 * @returns {string|null} a human-readable reason, or null when the body is clean
 */
function detectBusinessError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  // NetEase convention: top-level numeric `code`, 200 means OK.
  if (typeof body.code === 'number' && body.code !== 200) {
    const msg = body.msg ? ` ${String(body.msg).trim()}` : '';
    return `business code ${body.code}${msg}`;
  }
  // MusicBrainz convention: top-level `error` string.
  if (body.error) {
    const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    return `business error: ${detail.slice(0, 160)}`;
  }
  return null;
}

/**
 * Combines transport + parse + business signals into one verdict.
 *
 * @param {number} status real HTTP status (0 = never observed)
 * @param {any} body parsed JSON body
 * @param {string|null} parseError
 * @returns {{ok:boolean, httpError:boolean, businessError:string|null, parseError:string|null, error?:string}}
 */
function classify(status, body, parseError) {
  const httpError = !(status >= 200 && status < 300);
  const businessError = detectBusinessError(body);
  const ok = !httpError && !parseError && !businessError;
  let error;
  if (parseError) error = `unparsable body: ${parseError}`;
  else if (businessError) error = businessError;
  else if (httpError) error = status === 0 ? 'no HTTP status observed' : `HTTP ${status}`;
  return { ok, httpError, businessError, parseError: parseError || null, error };
}

/** Minimal cookie jar: enough for the NetEase anonymous session. */
const cookieJar = new Map();

function cookieHeader() {
  if (cookieJar.size === 0) return '';
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(res) {
  const raw = res.headers && res.headers['set-cookie'];
  if (!raw) return;
  for (const line of raw) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/**
 * Splits curl's stdout into the body and the real HTTP status.
 *
 * @param {string} stdout
 * @returns {{text:string, status:number}} status 0 when curl printed no marker
 */
function splitCurlOutput(stdout) {
  const raw = String(stdout == null ? '' : stdout);
  const idx = raw.lastIndexOf(STATUS_MARKER);
  if (idx === -1) return { text: raw, status: 0 };
  const text = raw.slice(0, idx);
  const parsed = Number.parseInt(raw.slice(idx + STATUS_MARKER.length).trim(), 10);
  return { text, status: Number.isFinite(parsed) ? parsed : 0 };
}

/**
 * Runs curl and returns the body plus the REAL HTTP status code.
 *
 * `-w` is used rather than `-o <file>` so no temp file is needed. `-f` is
 * deliberately NOT used: we want to read 4xx/5xx status codes and bodies
 * instead of turning them into an opaque non-zero exit.
 *
 * @param {string} urlString
 * @param {{timeoutMs?:number, headers?:Record<string,string>, userAgent?:string, noProxy?:boolean, proxy?:string, method?:string, form?:Record<string,string>}} [opts]
 * @returns {Promise<{text:string, status:number}>}
 */
function curl(urlString, opts = {}) {
  const args = [
    '-sS',
    '-L',
    '-m',
    String(Math.ceil((opts.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)),
    '--compressed',
    '-A',
    opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    '-w',
    `${STATUS_MARKER}%{http_code}`,
  ];
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  if (opts.noProxy) args.push('--noproxy', '*');
  if (opts.proxy) args.push('-x', opts.proxy);
  if (opts.method === 'POST') {
    if (opts.body !== undefined) {
      // 原始 body（如 JSON）：经 stdin 传入，避免命令行长度限制与编码问题
      args.push('--data-binary', '@-');
    } else {
      for (const [k, v] of Object.entries(opts.form || {})) {
        args.push('--data-urlencode', `${k}=${v}`);
      }
    }
  }
  args.push(urlString);

  return new Promise((resolve, reject) => {
    const execOpts = { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' };
    if (opts.body !== undefined) execOpts.input = opts.body;
    execFile('curl', args, execOpts, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`curl failed: ${err.message} ${String(stderr || '').slice(0, 200)}`));
        return;
      }
      resolve(splitCurlOutput(stdout));
    });
  });
}

/* ==========================================================================
 * Node 原生 HTTPS 请求（支持 HTTP 代理 CONNECT 隧道）
 * --------------------------------------------------------------------------
 * 为什么不用 fetch / curl：
 *  - fetch（undici）**不读** HTTP_PROXY/HTTPS_PROXY，在有代理的环境里直连必然失败；
 *  - curl 子进程依赖外部二进制（Docker alpine 未必有），且 Windows 版 curl 的
 *    代理行为与 Git Bash 版不一致，实测会卡死。
 * 这里是纯 Node 实现，零依赖、跨平台，且是生产环境（企业/NAS 在代理后）同样需要的能力。
 * ========================================================================== */

/** 按 URL 决定是否走代理（尊重 NO_PROXY） */
function proxyForUrl(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch (_) { return null; }
  const isHttps = u.protocol === 'https:';
  const env = isHttps
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy);
  if (!env) return null;

  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (noProxy.trim()) {
    if (noProxy.trim() === '*') return null;
    const host = u.hostname;
    for (const raw of noProxy.split(',')) {
      const p = raw.trim().toLowerCase();
      if (!p) continue;
      if (p === '*') return null;
      if (host === p || host.endsWith(p.startsWith('.') ? p : '.' + p)) return null;
    }
  }
  try { return new URL(env); } catch (_) { return null; }
}

/** 通过代理建立 CONNECT 隧道，返回裸 socket */
function openProxyTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = nodeNet.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80 });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('代理连接超时')); }, timeoutMs);
    const done = (fn, arg) => { clearTimeout(timer); sock.removeAllListeners(); fn(arg); };

    sock.once('error', (e) => done(reject, e));
    sock.once('connect', () => {
      const auth = proxyUrl.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || '')}`
          ).toString('base64')}\r\n`
        : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);

      let buf = '';
      const onData = (d) => {
        buf += d.toString('binary');
        if (!buf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);
        const line = buf.split('\r\n')[0];
        const code = parseInt((line.split(' ')[1] || ''), 10);
        if (code !== 200) {
          sock.destroy();
          done(reject, new Error(`代理 CONNECT 失败：${line}`));
          return;
        }
        done(resolve, sock);
      };
      sock.on('data', onData);
    });
  });
}

/**
 * 发一个（可能是 HTTPS 的）HTTP 请求，自动处理代理。
 * @returns {Promise<{ok:boolean,status:number,text:string,elapsedMs:number}>}
 */
function rawRequest(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 60000 } = opts;
  const u = new URL(urlStr);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  // noProxy：LAN / docker 容器名 / 127.0.0.1 的内网地址一律直连。
  // 这些目标若被 HTTP_PROXY 接管必然失败（代理不认识 sqmusic_main 这类内网主机名）。
  const proxy = opts.noProxy ? null : proxyForUrl(urlStr);
  const started = Date.now();

  const mod = isHttps ? https : http;

  const options = {
    method,
    host: u.hostname,
    port,
    path: u.pathname + u.search,
    headers: { ...headers },
    timeout: timeoutMs,
  };
  if (body !== null && body !== undefined) {
    const buf = Buffer.from(String(body), 'utf8');
    options.headers['Content-Length'] = buf.length;
  }

  // 有代理且目标是 HTTPS：需要 CONNECT 隧道 + TLS 包装
  let agent;
  if (proxy && isHttps) {
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (connOpts, cb) => {
      openProxyTunnel(proxy, u.hostname, port, timeoutMs)
        .then((sock) => {
          const tlsSock = tls.connect({ socket: sock, servername: u.hostname }, () => cb(null, tlsSock));
          tlsSock.once('error', (e) => cb(e));
        })
        .catch(cb);
    };
    options.agent = agent;
  } else if (proxy && !isHttps) {
    // http 目标：直接把请求发给代理，用绝对 URL
    options.host = proxy.hostname;
    options.port = Number(proxy.port) || 80;
    options.path = urlStr;
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        elapsedMs: Date.now() - started,
      }));
    });
    req.once('error', reject);
    req.once('timeout', () => { req.destroy(new Error('请求超时')); });
    if (body !== null && body !== undefined) req.write(String(body));
    req.end();
  });
}

/** Shared body-parsing step for both transports. */
function parseBody(text) {
  let body = null;
  let parseError = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    parseError = err.message;
  }
  return { body, parseError, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Builds the single response object shape every caller sees. */
function buildResponse({ via, status, text, elapsedMs }) {
  const { body, parseError, bytes } = parseBody(text);
  const verdict = classify(status, body, parseError);
  return {
    ...verdict,
    via,
    status,
    body,
    elapsedMs,
    bytes,
    textSample: typeof text === 'string' ? text.slice(0, 300) : '',
  };
}

/**
 * Fetches a public URL and parses JSON, with proxy fallback.
 *
 * Strategy: try `fetch` directly (fast, no process spawn). If it throws or
 * returns a non-2xx / unparsable / business-error body, retry once through
 * curl — curl reads HTTP_PROXY / HTTPS_PROXY from the environment, which is
 * exactly what the sandbox needs for international hosts.
 *
 * A 404 is treated as a definitive negative answer: it is returned with
 * `ok:false` and is NOT retried through curl (retrying a "not found" cannot
 * help, and treating it as success hid real failures).
 *
 * @param {string} urlString
 * @param {{timeoutMs?:number, headers?:Record<string,string>, userAgent?:string, preferCurl?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, via:'fetch'|'curl'|'curl(noproxy)'|'none', status:number, body:any, httpError:boolean, businessError:string|null, parseError:string|null, error?:string, elapsedMs:number, bytes:number}>}
 */
async function webGet(urlString, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const headers = { ...(opts.headers || {}) };
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  }
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;

  const direct = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(urlString, { headers, signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      absorbCookies(res);
      return buildResponse({ via: 'fetch', status: res.status, text, elapsedMs: Date.now() - started });
    } finally {
      clearTimeout(timer);
    }
  };

  const viaCurl = async (noProxy) => {
    const { text, status } = await curl(urlString, { ...opts, headers, noProxy });
    return buildResponse({
      via: noProxy ? 'curl(noproxy)' : 'curl',
      status,
      text,
      elapsedMs: Date.now() - started,
    });
  };

  const dead = (message) => ({
    ok: false,
    via: 'none',
    status: 0,
    body: null,
    httpError: true,
    businessError: null,
    parseError: null,
    error: message,
    elapsedMs: Date.now() - started,
    bytes: 0,
    textSample: '',
  });

  if (opts.preferCurl) {
    try {
      return await viaCurl(false);
    } catch (err) {
      try {
        return await direct();
      } catch (err2) {
        return dead(`${err.message} | ${err2.message}`);
      }
    }
  }

  try {
    const r = await direct();
    if (r.ok) return r;
    // A definitive 404 is an answer, not a transport failure: report and stop.
    if (r.status === 404) return r;
    try {
      const c = await viaCurl(false);
      if (c.ok) return c;
      // Neither transport succeeded; prefer the one that at least reached HTTP.
      return c.status > 0 ? c : r;
    } catch (err) {
      return r;
    }
  } catch (err) {
    try {
      return await viaCurl(false);
    } catch (err2) {
      try {
        return await viaCurl(true);
      } catch (err3) {
        return dead(`${err.message} | ${err2.message}`);
      }
    }
  }
}

/** `sleep` as a promise. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs `application/x-www-form-urlencoded` and parses JSON, with the same
 * fetch-then-curl fallback and the same classification as webGet. Needed for
 * NetEase's current search endpoint (`/api/cloudsearch/pc`), which is POST-only.
 *
 * @param {string} urlString
 * @param {Record<string,string>} form
 * @param {{timeoutMs?:number, headers?:Record<string,string>, userAgent?:string}} [opts]
 * @returns {Promise<{ok:boolean, via:string, status:number, body:any, httpError:boolean, businessError:string|null, error?:string, elapsedMs:number, bytes:number}>}
 */
async function webPost(urlString, form, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const headers = { ...(opts.headers || {}) };
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  }
  headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const encoded = new URLSearchParams(form).toString();

  const direct = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(urlString, {
        method: 'POST',
        headers,
        body: encoded,
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      absorbCookies(res);
      return buildResponse({ via: 'fetch', status: res.status, text, elapsedMs: Date.now() - started });
    } finally {
      clearTimeout(timer);
    }
  };

  const viaCurl = async () => {
    const { text, status } = await curl(urlString, { ...opts, headers, method: 'POST', form });
    return buildResponse({ via: 'curl', status, text, elapsedMs: Date.now() - started });
  };

  try {
    const r = await direct();
    if (r.ok) return r;
    if (r.status === 404) return r;
    try {
      const c = await viaCurl();
      if (c.ok) return c;
      return c.status > 0 ? c : r;
    } catch (err) {
      return r;
    }
  } catch (err) {
    try {
      return await viaCurl();
    } catch (err2) {
      return {
        ok: false,
        via: 'none',
        status: 0,
        body: null,
        httpError: true,
        businessError: null,
        parseError: null,
        error: `${err.message} | ${err2.message}`,
        elapsedMs: Date.now() - started,
        bytes: 0,
        textSample: '',
      };
    }
  }
}

/**
 * Serial rate limiter — enforces a minimum interval between calls and retries
 * with exponential backoff. Sources in this spike are strictly rate-limited
 * (MusicBrainz 1 req/s, NetEase 2 QPS), so a token-bucket style gate is enough.
 */
class RateLimiter {
  /**
   * @param {number} minIntervalMs minimum spacing between two requests
   */
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.lastStart = 0;
    this.totalWaitMs = 0;
    this.requests = 0;
  }

  /** Blocks until the next slot is free, then stamps the slot. */
  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.lastStart + this.minIntervalMs - now);
    if (wait > 0) {
      this.totalWaitMs += wait;
      await sleep(wait);
    }
    this.lastStart = Date.now();
    this.requests += 1;
  }
}

module.exports = { httpGetJson, webGet, webPost, curl, rawRequest, proxyForUrl, sleep, RateLimiter, detectBusinessError, classify, splitCurlOutput };
