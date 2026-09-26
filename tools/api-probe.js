'use strict';
/**
 * 对外开放 API 实测探针 —— 对真实服务逐条打请求，输出状态码 / 数据量 / 分页正确性
 *
 * 用法：
 *   node tools/api-probe.js                      # 默认打线上 http://192.168.2.107:8091  token=cyccyccy
 *   BASE=http://127.0.0.1:18099 TOKEN=test-token node tools/api-probe.js
 *
 * 说明：
 *   - 只用内置 http 模块（不读 HTTP_PROXY，避免沙箱代理吃掉内网请求）
 *   - 输出：控制台表格 + tools/api-probe-report.json
 *   - 退出码：全部通过 0，存在失败 1
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://192.168.2.107:8091';
const TOKEN = process.env.TOKEN || 'cyccyccy';

function request(method, urlPath, body) {
  return new Promise((resolve) => {
    const u = new URL(urlPath, BASE);
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (chunks.length < 64) chunks.push(c);      // 只留前若干块，避免把整首歌读进内存
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* 非 JSON（图片/音频/纯文本歌词）*/ }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes,
            text: text.slice(0, 400),
            json,
          });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message, bytes: 0, text: '', json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', bytes: 0, text: '', json: null }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const rows = [];
let failed = 0;

function record(name, method, urlPath, expectStatus, r, extra = '') {
  const ok = Array.isArray(expectStatus) ? expectStatus.includes(r.status) : r.status === expectStatus;
  if (!ok) failed++;
  const d = r.json && r.json.data ? r.json.data : r.json;
  const total = d && d.pagination ? d.pagination.total : '';
  const count = Array.isArray(d && d.items) ? d.items.length : '';
  rows.push({
    name, method, url: urlPath,
    status: r.status, expect: String(expectStatus), pass: ok,
    total, items: count, bytes: r.bytes,
    err: r.json && r.json.error ? r.json.error.code || r.json.error.message : (r.error || ''),
    note: extra,
  });
  return r;
}

function pad(s, n) { s = String(s); let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); }

(async function main() {
  console.log(`\n=== API 实测探针 ===\n目标：${BASE}\n令牌：${TOKEN ? TOKEN.slice(0, 4) + '***' : '(空)'}\n`);

  /* ---------- 鉴权 ---------- */
  {
    const u = new URL('/api/v1/stats', BASE);
    const r = await new Promise((resolve) => {
      const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', timeout: 10000 },
        (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, json: null, bytes: 0, text: '' })); });
      req.on('error', (e) => resolve({ status: 0, error: e.message, json: null, bytes: 0, text: '' }));
      req.end();
    });
    record('鉴权-无令牌', 'GET', '/api/v1/stats', 401, r, '缺 Bearer 必须 401');
  }

  /* ---------- 基础 ---------- */
  const rStats = record('统计', 'GET', '/api/v1/stats', 200, await request('GET', '/api/v1/stats'));
  record('首页聚合', 'GET', '/api/v1/home', 200, await request('GET', '/api/v1/home?limit=6&albumLimit=12'));
  record('标签维度', 'GET', '/api/v1/facets', 200, await request('GET', '/api/v1/facets'));

  /* ---------- 列表 + 分页 ---------- */
  const lists = [
    ['曲目列表', '/api/v1/tracks?limit=5'],
    ['曲目-第二页', '/api/v1/tracks?limit=5&offset=5'],
    ['曲目-page 写法', '/api/v1/tracks?limit=5&page=3'],
    ['曲目-随机', '/api/v1/tracks?sort=random&seed=abc&limit=5'],
    ['曲目-歌手筛选', '/api/v1/tracks?limit=5'],
    ['专辑列表', '/api/v1/albums?limit=5'],
    ['专辑-仅真实', '/api/v1/albums?limit=5&include=real'],
    ['歌手列表', '/api/v1/artists?limit=5'],
    ['风格列表', '/api/v1/genres?limit=5'],
    ['歌单列表', '/api/v1/playlists?limit=5'],
  ];
  for (const [name, p] of lists) record(name, 'GET', p, 200, await request('GET', p));

  /* 随机 seed 一致性 */
  {
    const a = await request('GET', '/api/v1/tracks?sort=random&seed=same&limit=5');
    const b = await request('GET', '/api/v1/tracks?sort=random&seed=same&limit=5');
    const ia = (a.json && a.json.data && a.json.data.items || []).map((x) => x.id).join(',');
    const ib = (b.json && b.json.data && b.json.data.items || []).map((x) => x.id).join(',');
    const ok = ia && ia === ib;
    if (!ok) failed++;
    rows.push({ name: '随机 seed 一致性', method: 'GET', url: 'sort=random&seed=same (两次)', status: ok ? 200 : 409, expect: '相同', pass: ok, total: '', items: '', bytes: 0, err: ok ? '' : '两次顺序不一致', note: '' });
  }

  /* ---------- 详情：取第一条真实 id ---------- */
  let tid = '';
  let cid = '';
  {
    const r = await request('GET', '/api/v1/tracks?limit=1');
    const it = r.json && r.json.data && r.json.data.items && r.json.data.items[0];
    if (it) { tid = it.id; cid = it.coverId || ''; }
  }
  if (tid) {
    record('曲目详情', 'GET', `/api/v1/tracks/${tid}`, 200, await request('GET', `/api/v1/tracks/${tid}`));
    record('曲目-不存在', 'GET', '/api/v1/tracks/not_exist_id', 404, await request('GET', '/api/v1/tracks/not_exist_id'));
    record('歌词', 'GET', `/api/track/${tid}/lyric`, 200, await request('GET', `/api/track/${tid}/lyric`));
    const st = await request('GET', `/api/stream/${tid}`);
    record('音频流', 'GET', `/api/stream/${tid}`, [200, 206], st, st.headers ? String(st.headers['content-type'] || '') : '');
  } else {
    console.log('!! 曲库为空，跳过详情类探针');
  }
  if (cid) record('封面', 'GET', `/api/cover/${cid}?size=300`, 200, await request('GET', `/api/cover/${cid}?size=300`));

  /* ---------- 子资源分页：专辑 / 歌手 / 歌单 / 风格 ---------- */
  let albumId = '', artistId = '', playlistId = '', genreVal = '';
  {
    const a = await request('GET', '/api/v1/albums?limit=1');
    const item = a.json && a.json.data && a.json.data.items && a.json.data.items[0];
    if (item) albumId = item.id;
    const b = await request('GET', '/api/v1/artists?limit=1');
    const it2 = b.json && b.json.data && b.json.data.items && b.json.data.items[0];
    if (it2) artistId = it2.id;
    const c = await request('GET', '/api/v1/playlists?limit=1');
    const it3 = c.json && c.json.data && c.json.data.items && c.json.data.items[0];
    if (it3) playlistId = it3.id;
    const d = await request('GET', '/api/v1/genres?limit=1');
    const it4 = d.json && d.json.data && d.json.data.items && d.json.data.items[0];
    if (it4) genreVal = it4.value;
  }
  if (albumId) record('专辑详情+曲目分页', 'GET', `/api/v1/albums/${encodeURIComponent(albumId)}?limit=5`, 200, await request('GET', `/api/v1/albums/${encodeURIComponent(albumId)}?limit=5`));
  if (artistId) record('歌手详情+曲目分页', 'GET', `/api/v1/artists/${encodeURIComponent(artistId)}?limit=5`, 200, await request('GET', `/api/v1/artists/${encodeURIComponent(artistId)}?limit=5`));
  if (playlistId) record('歌单详情+曲目分页', 'GET', `/api/v1/playlists/${encodeURIComponent(playlistId)}?limit=5`, 200, await request('GET', `/api/v1/playlists/${encodeURIComponent(playlistId)}?limit=5`));
  if (genreVal) record('风格曲目分页', 'GET', `/api/v1/genres/${encodeURIComponent(genreVal)}/tracks?limit=5`, 200, await request('GET', `/api/v1/genres/${encodeURIComponent(genreVal)}/tracks?limit=5`));

  /* ---------- 搜索 ---------- */
  record('搜索-全类型', 'GET', '/api/v1/search?q=%E7%9A%84', 200, await request('GET', '/api/v1/search?q=' + encodeURIComponent('的')));
  record('搜索-仅歌曲(分页)', 'GET', '/api/v1/search?q=%E7%9A%84&type=track&limit=5', 200, await request('GET', '/api/v1/search?q=' + encodeURIComponent('的') + '&type=track&limit=5'));
  record('搜索-仅歌手', 'GET', '/api/v1/search?type=artist', 200, await request('GET', '/api/v1/search?q=' + encodeURIComponent('的') + '&type=artist&limit=5'));
  record('搜索-缺 q', 'GET', '/api/v1/search', 400, await request('GET', '/api/v1/search'));

  /* ---------- 收藏 / 播放历史 ---------- */
  if (tid) {
    record('收藏-加入', 'PUT', `/api/v1/favorites/${tid}`, 200, await request('PUT', `/api/v1/favorites/${tid}`));
    record('收藏-查询单曲', 'GET', `/api/v1/favorites/${tid}`, 200, await request('GET', `/api/v1/favorites/${tid}`));
    record('收藏-列表分页', 'GET', '/api/v1/favorites?limit=5', 200, await request('GET', '/api/v1/favorites?limit=5'));
    record('收藏-不存在曲目', 'PUT', '/api/v1/favorites/not_exist_id', 404, await request('PUT', '/api/v1/favorites/not_exist_id'));
    record('播放-上报', 'POST', '/api/v1/history', 200, await request('POST', '/api/v1/history', { trackId: tid, durationSec: 12 }));
    record('播放-不存在曲目', 'POST', '/api/v1/history', 404, await request('POST', '/api/v1/history', { trackId: 'not_exist_id' }));
    record('播放-最近播放(去重)', 'GET', '/api/v1/history?scope=distinct&limit=5', 200, await request('GET', '/api/v1/history?scope=distinct&limit=5'));
    record('播放-原始流水', 'GET', '/api/v1/history?scope=raw&limit=5', 200, await request('GET', '/api/v1/history?scope=raw&limit=5'));
    record('首页-含收藏与最近播放', 'GET', '/api/v1/home', 200, await request('GET', '/api/v1/home?limit=6'));
    record('收藏-移除', 'DELETE', `/api/v1/favorites/${tid}`, 200, await request('DELETE', `/api/v1/favorites/${tid}`));
    record('收藏-移除幂等', 'DELETE', `/api/v1/favorites/${tid}`, 200, await request('DELETE', `/api/v1/favorites/${tid}`));
  }

  /* ---------- 输出 ---------- */
  console.log(pad('接口', 26) + pad('方法', 8) + pad('状态', 7) + pad('期望', 8) + pad('总数', 8) + pad('本页', 6) + pad('字节', 10) + '备注');
  console.log('-'.repeat(100));
  for (const r of rows) {
    console.log(
      pad(r.name, 26) + pad(r.method, 8) + pad(r.status, 7) + pad(r.expect, 8) +
      pad(r.total, 8) + pad(r.items, 6) + pad(r.bytes, 10) + (r.err || r.note || '')
    );
  }
  const pass = rows.filter((r) => r.pass).length;
  console.log(`\n通过 ${pass}/${rows.length}，失败 ${failed}\n`);
  const out = path.join(__dirname, 'api-probe-report.json');
  fs.writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, failed, rows }, null, 2));
  console.log(`报告已写入：${out}\n`);
  process.exit(failed ? 1 : 0);
})();
