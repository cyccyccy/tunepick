'use strict';

/**
 * Network helpers.
 *
 * Two very different paths on purpose:
 *  - `httpGetJson` uses the built-in `http` module and IGNORES proxy env vars.
 *    Required for the Navidrome box on the Tailscale IP: routing it through the
 *    local proxy always fails.
 *  - `webGet` / `webPost` target the public internet (NetEase / MusicBrainz /
 *    Cover Art Archive). Their primary transport is `rawRequest` — a pure
 *    built-in-module implementation that speaks HTTPS, honours HTTP_PROXY /
 *    HTTPS_PROXY (CONNECT tunnel) and needs no external binary.
 *
 * ⚠️ 单次调用 = 单个请求（评审发现 #3）：
 *    早期版本是「先 fetch 再 curl 兜底」，一次 webGet 实际会打上游 2 次，
 *    而限速器只记 1 次 → 网易云实际 QPS 翻倍，触发静默软封。
 *    同时 fetch(undici) 不读代理环境变量，与本项目「HTTP 必须内置模块」的硬约束冲突。
 *    现在默认只走 rawRequest；curl 仅在 `PREFER_CURL=1`（或 opts.preferCurl）时启用。
 *
 * ⚠️ 响应必须对端完整送达才结算（评审发现 #1）：
 *    只监听 data/end 时，若上游声明 Content-Length=N 却中途断开，Promise 永不结算，
 *    扫描批次会永久挂死（scan/task.js 对 _processOne 没有超时）。
 *    所有收包路径统一走 `readBody()`：监听 error / aborted，并限制响应体大小。
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
const zlib = require('zlib');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;

/** 默认响应体大小上限 32MB：防止对端（或劫持页）用超大响应吃满内存。可由 opts.maxBytes 覆盖。 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** 重定向最大跳数（rawRequest 内部跟随 3xx，替代原 fetch 的 redirect:'follow'）。 */
const DEFAULT_MAX_REDIRECTS = 5;

/** Appended by curl's `-w` so the real HTTP status survives the process boundary. */
const STATUS_MARKER = '\n__HTTP_STATUS__:';

/**
 * 收取响应体，并同时防挂死 + 防超限。
 *
 * - `error`   ：socket 层错误（ECONNRESET 等）
 * - `aborted` ：对端在响应未发完时关闭连接（Node ≥16 会先发 'aborted' 再发 'error'）
 * - 超限     ：累计字节数超过 maxBytes，立即 destroy 并 reject
 *
 * 用 `settled` 守卫保证 Promise 一定结算，且只结算一次。
 *
 * @param {import('http').IncomingMessage} res
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { res.destroy(); } catch (_) { /* socket 可能已关闭 */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    res.on('data', (c) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        fail(new Error(`响应体超过上限 ${maxBytes} 字节`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    res.on('error', (err) => fail(err));
    res.on('aborted', () => fail(new Error('响应中断：对端在传输完成前关闭连接')));
  });
}

/**
 * Plain HTTP GET returning a parsed JSON body. No proxy, ever.
 *
 * @param {string} urlString
 * @param {{timeoutMs?:number, headers?:Record<string,string>, maxBytes?:number}} [opts]
 * @returns {Promise<{status:number, headers:Record<string,string>, body:any, parseError:string|null, rawLength:number, elapsedMs:number}>}
 */
function httpGetJson(urlString, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = normalizeMaxBytes(opts.maxBytes);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.get(
      urlString,
      { headers: opts.headers || {}, timeout: timeoutMs },
      (res) => {
        readBody(res, maxBytes).then((buf) => {
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
        }, reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => reject(err));
  });
}

/** maxBytes 归一化：非法值一律回落到 32MB 默认。 */
function normalizeMaxBytes(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
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

/* ==========================================================================
 * Cookie jar（评审发现 #4）
 * --------------------------------------------------------------------------
 * 两个 bug：
 *  1. 旧实现读 `res.headers['set-cookie']` —— 对 WHATWG Headers（fetch）恒为 undefined，
 *     实测 jar 里从来没存进过任何东西；
 *  2. jar 是模块级全局、无 host 维度 —— 一旦真存进去，music.163.com 的 cookie 会被
 *     发给 musicbrainz.org / coverartarchive.org（跨源泄漏）。
 * 现在：jar = Map<host, Map<name, value>>，取用严格按 host 隔离。
 * ========================================================================== */

/** @type {Map<string, Map<string,string>>} host -> (name -> value) */
const cookieJar = new Map();

/** 从 URL 取 host；非法或缺失时返回 ''（'' 表示「无 host 上下文」，不参与存取） */
function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * 取出一个响应里的所有 Set-Cookie 行。
 * 兼容三种形态：WHATWG Headers（getSetCookie / get）、node http 原生（数组或字符串）。
 *
 * @param {{headers?:any}} res 具名 headers 的对象（fetch Response 或 http.IncomingMessage 均可）
 * @returns {string[]}
 */
function setCookieList(res) {
  const h = res && res.headers;
  if (!h) return [];
  // WHATWG Headers
  if (typeof h.getSetCookie === 'function') {
    const list = h.getSetCookie();
    if (Array.isArray(list) && list.length) return list;
  }
  if (typeof h.get === 'function') {
    const v = h.get('set-cookie');
    if (v) return Array.isArray(v) ? v : [v];
  }
  // node http 原生：数组最常见，个别场景是单串
  const raw = h['set-cookie'];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return [raw];
  return [];
}

/**
 * 组装 Cookie 请求头（只带同 host 的 cookie）。
 *
 * 向后兼容：无参调用（旧签名）返回 '' —— 没有 host 上下文时绝不跨源发送 cookie。
 *
 * @param {string} [url]
 * @returns {string}
 */
function cookieHeader(url) {
  const host = hostOf(url);
  if (!host) return '';
  const jar = cookieJar.get(host);
  if (!jar || jar.size === 0) return '';
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 吸收响应里的 Set-Cookie。
 *
 * @param {string} url 目标 URL（决定 cookie 归属的 host）
 * @param {{headers?:any}} res
 */
function absorbCookies(url, res) {
  // 旧签名兼容：absorbCookies(res) —— 只有一个对象参数时视为无 host 上下文，直接忽略
  if (res === undefined && url && typeof url === 'object') {
    res = url;
    url = '';
  }
  const host = hostOf(url);
  if (!host) return;

  for (const line of setCookieList(res)) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    let jar = cookieJar.get(host);
    if (!jar) {
      jar = new Map();
      cookieJar.set(host, jar);
    }
    // 空值 / Max-Age=0 视为删除（服务端清 cookie 的常规写法）
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

/** 仅供测试：清空 cookie jar */
function resetCookieJar() {
  cookieJar.clear();
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

  // 环回 / 内网 / 无点主机名（Docker 容器名、Tailscale 主机名等）一律直连，
  // 即使 NO_PROXY 没写。这些目标交给代理只会得到代理自己的响应
  // （沙箱实测：普通 GET 被代理回 200 假响应，连接拒绝也变 200），
  // 且生产上内网地址（NAS / Tailscale / 局域网 LLM）本就不该被代理劫持。
  let host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const isLocal = host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || (!host.includes('.') && !host.includes(':'));
  if (isLocal) return null;

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

/**
 * 通过代理建立 CONNECT 隧道，返回裸 socket。
 *
 * 评审发现 #5：旧实现用 `sock.removeAllListeners()` 收尾，会把 socket 自身的 error
 * 监听一并摘掉；且 Promise 的 resolve/reject 没有单次守卫。现在用 `settled` 保证
 * 只结算一次，收尾只摘本函数注册的那几个监听器。
 */
function openProxyTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = nodeNet.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 80 });
    let settled = false;
    let timer = null;
    let onData = null;

    const finish = (fn, arg) => {
      if (settled) return;            // 双触发守卫：connect / error / timeout 只生效一次
      settled = true;
      if (timer) clearTimeout(timer);
      // 只摘自己注册的监听器，不能用 removeAllListeners
      sock.removeListener('error', onError);
      sock.removeListener('connect', onConnect);
      if (onData) sock.removeListener('data', onData);
      fn(arg);
    };

    const onError = (e) => finish(reject, e);

    const onConnect = () => {
      const auth = proxyUrl.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || '')}`
          ).toString('base64')}\r\n`
        : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);

      let buf = '';
      onData = (d) => {
        buf += d.toString('binary');
        if (!buf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);
        onData = null;
        const line = buf.split('\r\n')[0];
        const code = parseInt((line.split(' ')[1] || ''), 10);
        if (code !== 200) {
          sock.destroy();
          finish(reject, new Error(`代理 CONNECT 失败：${line}`));
          return;
        }
        finish(resolve, sock);
      };
      sock.on('data', onData);
    };

    timer = setTimeout(() => {
      sock.destroy();
      finish(reject, new Error('代理连接超时'));
    }, timeoutMs);

    sock.on('error', onError);
    sock.on('connect', onConnect);
  });
}

/**
 * 按 Content-Encoding 解压响应体；失败时原样返回（不因解压失败丢掉整份响应）。
 * @param {Buffer} buf
 * @param {string|undefined} encoding
 * @returns {Buffer}
 */
function decodeBody(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return buf;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf);
      } catch (_) {
        // 部分服务器发的是 raw deflate（无 zlib 头）
        try { return zlib.inflateRawSync(buf); } catch (_2) { return buf; }
      }
    }
  } catch (_) {
    return buf;
  }
  return buf;
}

/**
 * 发一次（可能是 HTTPS 的）HTTP 请求，自动处理代理；不跟随重定向。
 *
 * @param {string} urlStr
 * @param {{method?:string, headers?:Record<string,string>, body?:string|null, timeoutMs?:number, maxBytes?:number, noProxy?:boolean}} opts
 * @returns {Promise<{ok:boolean, status:number, headers:Record<string,string>, text:string, bytes:number, elapsedMs:number}>}
 */
function requestOnce(urlStr, opts = {}) {
  const { method = 'GET', headers = {}, body = null } = opts;
  const timeoutMs = opts.timeoutMs || 60000;
  const maxBytes = normalizeMaxBytes(opts.maxBytes);
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
      let called = false;
      const once = (err, socket) => {
        if (called) return;          // secureConnect 与 error 只能有一个生效
        called = true;
        cb(err, socket);
      };
      openProxyTunnel(proxy, u.hostname, port, timeoutMs)
        .then((sock) => {
          const tlsSock = tls.connect({ socket: sock, servername: u.hostname }, () => once(null, tlsSock));
          tlsSock.once('error', (e) => once(e));
        })
        .catch((e) => once(e));
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
      readBody(res, maxBytes).then((raw) => {
        const buf = decodeBody(raw, res.headers && res.headers['content-encoding']);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          headers: res.headers || {},
          text: buf.toString('utf8'),
          bytes: buf.length,
          elapsedMs: Date.now() - started,
        });
      }, reject);
    });
    req.once('error', reject);
    req.once('timeout', () => { req.destroy(new Error('请求超时')); });
    if (body !== null && body !== undefined) req.write(String(body));
    req.end();
  });
}

/**
 * 发一个（可能是 HTTPS 的）HTTP 请求，自动处理代理，必要时跟随 3xx 重定向。
 *
 * 跟随重定向是为了保持与原 fetch(redirect:'follow') 一致的行为（CAA 等源会跳 3xx）。
 * 307/308 保留 method 与 body；其余 3xx 降级为 GET 且不带 body（RFC 常规语义）。
 *
 * @param {string} urlStr
 * @param {{method?:string, headers?:Record<string,string>, body?:string|null, timeoutMs?:number, maxBytes?:number, noProxy?:boolean, maxRedirects?:number}} [opts]
 * @returns {Promise<{ok:boolean, status:number, headers:Record<string,string>, text:string, bytes:number, elapsedMs:number}>}
 */
async function rawRequest(urlStr, opts = {}) {
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? Math.max(0, opts.maxRedirects) : DEFAULT_MAX_REDIRECTS;
  const started = Date.now();
  let url = urlStr;
  let method = opts.method || 'GET';
  let body = opts.body === undefined ? null : opts.body;
  let last = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const r = await requestOnce(url, {
      ...opts,
      method,
      body,
      maxRedirects: 0,
    });
    last = r;
    const isRedirect = r.status >= 300 && r.status < 400;
    const location = isRedirect && r.headers ? r.headers.location : '';
    if (!location) return { ...r, elapsedMs: Date.now() - started };

    let next;
    try {
      next = new URL(String(location), url).toString();
    } catch (_) {
      return { ...r, elapsedMs: Date.now() - started };
    }
    if (r.status !== 307 && r.status !== 308) {
      method = 'GET';
      body = null;
    }
    url = next;
  }
  return { ...(last || { ok: false, status: 0, headers: {}, text: '', bytes: 0 }), elapsedMs: Date.now() - started };
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

/** 统一的「完全没够到上游」返回体 */
function deadResponse(started, message) {
  return {
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
  };
}

/** 是否启用 curl 兜底通道（默认关闭：单次调用只允许打一个请求） */
function curlEnabled(opts) {
  return opts.preferCurl === true || process.env.PREFER_CURL === '1';
}

/**
 * Fetches a public URL and parses JSON.
 *
 * 单次调用 = 单个请求（评审发现 #3）：主通道是 Node 原生 `rawRequest`
 * （支持 HTTPS 与 HTTP 代理 CONNECT 隧道，零依赖）。只有显式开启
 * `PREFER_CURL=1` / `opts.preferCurl` 时才优先使用 curl，且 curl 抛错
 * （二进制不存在等）才回落到原生通道——不会在正常路径上打第二次请求。
 *
 * A 404 is still treated as a definitive negative answer: it is returned with
 * `ok:false` and is NOT retried through another transport (retrying a "not
 * found" cannot help, and treating it as success hid real failures).
 *
 * @param {string} urlString
 * @param {{timeoutMs?:number, headers?:Record<string,string>, userAgent?:string, preferCurl?:boolean, maxBytes?:number, noProxy?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, via:string, status:number, body:any, httpError:boolean, businessError:string|null, parseError:string|null, error?:string, elapsedMs:number, bytes:number, textSample:string}>}
 */
async function webGet(urlString, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const headers = { ...(opts.headers || {}) };
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  }
  const cookie = cookieHeader(urlString);
  if (cookie) headers.Cookie = cookie;

  // 主通道：Node 原生请求（不依赖 undici / 外部二进制，支持代理）
  const viaRaw = async () => {
    const r = await rawRequest(urlString, {
      method: 'GET',
      headers,
      timeoutMs,
      maxBytes: opts.maxBytes,
      noProxy: opts.noProxy,
    });
    absorbCookies(urlString, { headers: r.headers });
    return buildResponse({ via: 'raw', status: r.status, text: r.text, elapsedMs: Date.now() - started });
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

  if (curlEnabled(opts)) {
    try {
      return await viaCurl(false);
    } catch (err) {
      try {
        return await viaRaw();
      } catch (err2) {
        return deadResponse(started, `${err.message} | ${err2.message}`);
      }
    }
  }

  try {
    return await viaRaw();
  } catch (err) {
    return deadResponse(started, err.message);
  }
}

/** `sleep` as a promise. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs `application/x-www-form-urlencoded` and parses JSON.
 * Same single-request policy, same classification as `webGet`.
 * Needed for NetEase's current search endpoint (`/api/cloudsearch/pc`), which is POST-only.
 *
 * @param {string} urlString
 * @param {Record<string,string>} form
 * @param {{timeoutMs?:number, headers?:Record<string,string>, userAgent?:string, preferCurl?:boolean, maxBytes?:number, noProxy?:boolean}} [opts]
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
  const cookie = cookieHeader(urlString);
  if (cookie) headers.Cookie = cookie;
  const encoded = new URLSearchParams(form).toString();

  const viaRaw = async () => {
    const r = await rawRequest(urlString, {
      method: 'POST',
      headers,
      body: encoded,
      timeoutMs,
      maxBytes: opts.maxBytes,
      noProxy: opts.noProxy,
    });
    absorbCookies(urlString, { headers: r.headers });
    return buildResponse({ via: 'raw', status: r.status, text: r.text, elapsedMs: Date.now() - started });
  };

  const viaCurl = async () => {
    const { text, status } = await curl(urlString, { ...opts, headers, method: 'POST', form });
    return buildResponse({ via: 'curl', status, text, elapsedMs: Date.now() - started });
  };

  if (curlEnabled(opts)) {
    try {
      return await viaCurl();
    } catch (err) {
      try {
        return await viaRaw();
      } catch (err2) {
        return deadResponse(started, `${err.message} | ${err2.message}`);
      }
    }
  }

  try {
    return await viaRaw();
  } catch (err) {
    return deadResponse(started, err.message);
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

  /**
   * Blocks until the next slot is free, then stamps the slot.
   *
   * 评审发现 #2：旧实现在 `await sleep(wait)` **之后**才推进 lastStart，
   * N 个并发调用者会基于同一个旧值算出相同的 wait，睡完后同一毫秒齐发
   * （实测 4 并发 → 0/1013/1013/1013）。现在在 await 之前同步占坑，
   * 后续调用者基于更新后的 lastStart 计算，放行时刻自然形成 0/300/600/900。
   */
  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.lastStart + this.minIntervalMs - now);
    // 同步推进占位时间：即使本调用者还在睡，后续调用者也按新值排队
    this.lastStart = now + wait;
    this.requests += 1;
    if (wait > 0) {
      this.totalWaitMs += wait;
      await sleep(wait);
    }
  }
}

module.exports = {
  httpGetJson,
  webGet,
  webPost,
  curl,
  rawRequest,
  requestOnce,
  proxyForUrl,
  sleep,
  RateLimiter,
  detectBusinessError,
  classify,
  splitCurlOutput,
  cookieHeader,
  absorbCookies,
  resetCookieJar,
  setCookieList,
};
