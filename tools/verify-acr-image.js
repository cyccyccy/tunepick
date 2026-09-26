'use strict';
/**
 * 校验远端 latest 镜像里的内容是否与本地源文件一致（不用 docker pull）
 *
 * 为什么需要它：一次推多个文件会触发多个并发 CI run，**最后完成的那个不一定是最后一个提交**，
 * 只看 latest 的构建时间会误判。可靠做法是：拉清单 → 找层 → 抽文件 → 与本地逐文件比对 md5 与字节数。
 *
 * 用法：
 *   node tools/verify-acr-image.js
 *   FILES=src/api/v1.js,src/store/userdata.js node tools/verify-acr-image.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const REGISTRY = 'crpi-18u9lmp0sqaxuesr.cn-shenzhen.personal.cr.aliyuncs.com';
const REPO = 'cyccyc-music/tunepick';
const DEFAULT_FILES = ['src/api/v1.js', 'src/store/userdata.js', 'src/api/index.js', 'tests/qa-v1-api.test.js', 'tools/api-probe.js'];

/** 走沙箱代理的 GET（内网 IP 请另行绕代理，这里只访问公网 registry） */
function get(url, headers = {}, binary = false, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'tunepick-verify', ...headers },
      timeout: 60000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(res.headers.location, headers, binary, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: binary ? buf : buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.end();
  });
}

/** 匿名拉 token：realm 与 service 两个参数都必须原样带回 */
async function anonToken(scope) {
  const probe = await get(`https://${REGISTRY}/v2/`, {}, false);
  const auth = probe.headers['www-authenticate'] || '';
  const realm = /realm="([^"]+)"/.exec(auth)[1];
  const service = /service="([^"]+)"/.exec(auth)[1];
  const r = await get(`${realm}?scope=${encodeURIComponent(scope)}&service=${encodeURIComponent(service)}`);
  return JSON.parse(r.body).token;
}

/**
 * 从 tar.gz 里抽出目标文件：返回 { 'src/api/v1.js': Buffer }
 * ⚠️ tar 里的路径常带构建上下文前缀（如 app/ 或 ./），所以按「后缀」匹配，不能全等。
 */
function untarSelect(buf, wanted) {
  const raw = zlib.gunzipSync(buf);
  const out = {};
  let off = 0;
  let entries = 0;
  while (off + 512 <= raw.length) {
    const header = raw.slice(off, off + 512);
    let name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const type = header.slice(156, 157).toString('utf8');
    const sizeField = header.slice(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const bodyStart = off + 512;
    const clean = name.replace(/^\.\//, '');
    entries++;
    if (type === '0' || type === '\0') {
      for (const w of wanted) {
        if (clean === w || clean.endsWith('/' + w)) {
          out[w] = raw.slice(bodyStart, bodyStart + size);
        }
      }
    }
    off = bodyStart + Math.ceil(size / 512) * 512;
  }
  out.__entries = entries;      // 诊断用：该层共有多少个 tar 条目
  return out;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);

(async function main() {
  const files = (process.env.FILES || '').split(',').filter(Boolean).length
    ? process.env.FILES.split(',')
    : DEFAULT_FILES;

  console.log(`\n=== 校验 latest 镜像内容 ===\nRegistry: ${REGISTRY}\nImage:    ${REPO}:latest\n`);

  const token = await anonToken(`repository:${REPO}:pull`);
  const man = await get(`https://${REGISTRY}/v2/${REPO}/manifests/latest`, {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.docker.distribution.manifest.v2+json,' +
            'application/vnd.oci.image.manifest.v1+json,' +
            'application/vnd.docker.distribution.manifest.list.v2+json,' +
            'application/vnd.oci.image.index.v1+json',
  });
  if (man.status !== 200) { console.log('取清单失败 HTTP ' + man.status); process.exit(1); }
  const m = JSON.parse(man.body);
  const digest = man.headers['docker-content-digest'] || '(未知)';
  const isIndex = !!m.manifests;
  console.log(`清单类型：${isIndex ? '多架构索引' : '单架构'}    digest=${digest}\n`);

  // 若是索引，挑 amd64 子清单再拉一次
  let layers = m.layers;
  if (isIndex) {
    const plat = (m.manifests || []).find((x) => x.platform && x.platform.architecture === 'amd64') || m.manifests[0];
    const subRes = await get(`https://${REGISTRY}/v2/${REPO}/manifests/${plat.digest}`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json',
    });
    layers = JSON.parse(subRes.body).layers;
    console.log(`已选子清单 ${plat.digest.slice(0, 20)}（${plat.platform.architecture}/${plat.platform.os}）\n`);
  }

  console.log(`层数量：${layers.length}\n`);
  const root = path.resolve(__dirname, '..');
  let checked = 0, missing = 0, mismatch = 0;

  const seen = new Set();
  // 从最上层往下找：同一路径在多个层出现时，以最上层（最终生效版本）为准
  for (const layer of [...layers].reverse()) {
    // ⚠️ ACR 会 307 跳 OSS，必须跟随重定向，否则拿回 0 字节
    const blob = await get(`https://${REGISTRY}/v2/${REPO}/blobs/${layer.digest}`, { Authorization: `Bearer ${token}` }, true);
    if (blob.status !== 200 || blob.body.length < 64) {
      console.log(`  · 层 ${layer.digest.slice(7, 19)} HTTP ${blob.status} ${blob.body.length}B（跳过）`);
      continue;
    }
    let picked;
    try { picked = untarSelect(blob.body, files); } catch (e) { continue; }
    for (const [name, buf] of Object.entries(picked)) {
      if (name === '__entries' || seen.has(name)) continue;
      const localPath = path.join(root, name);
      if (!fs.existsSync(localPath)) { console.log(`  ⚠️ ${name} 本地不存在（跳过比对）`); continue; }
      seen.add(name);
      const localBuf = fs.readFileSync(localPath);
      const same = localBuf.equals(buf);
      checked++;
      if (same) {
        console.log(`  ✅ ${name}  镜像 ${buf.length}B md5=${md5(buf)}  本地一致`);
      } else {
        mismatch++;
        console.log(`  ❌ ${name}  镜像 ${buf.length}B md5=${md5(buf)}  本地 ${localBuf.length}B md5=${md5(localBuf)}  ← 不一致`);
      }
    }
  }

  for (const name of files) {
    if (fs.existsSync(path.join(root, name)) && !checked) missing++;
  }

  console.log(`\n已比对 ${checked} 个文件，不一致 ${mismatch} 个。\n`);
  console.log(mismatch === 0 && checked > 0
    ? '结论：latest 镜像内容与本地源码一致，可以拉取部署。\n'
    : '结论：latest 未包含最新代码 —— 重新触发一次构建（workflow_dispatch）后再校验。\n');
  process.exit(mismatch === 0 && checked > 0 ? 0 : 1);
})().catch((e) => { console.error('校验过程异常：', e.message); process.exit(2); });
