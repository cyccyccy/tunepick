/* TunePick · 搜歌下载（SqMusic） —— 零依赖原生 JS
 * 由 app.js 的 #/discover 路由调用：window.TPDiscover.render(root, ctx)
 * 只做几件事：搜索展示 → 试听 → 下发下载任务 → 轮询进度 → 已下载列表。
 * 写文件由 SqMusic 完成，本页面不碰音乐文件。
 *
 * ⚠️ 关于「进度 / 网速」的诚实说明：
 *    SqMusic 的任务状态只有 waiting / success / error 三态（实测 /api/task/list
 *    的 downloadStatus），不存在真实进度百分比，因此本页**不画进度条**。
 *    页面上的「大小 / 网速」是：有真实值用真实值，没有则用「码率 × 时长」估算
 *    （真值优先 + 估算兜底），估算值一律带 ≈ 前缀，不冒充实测。
 */
(function () {
  'use strict';

  /** 本地提交记录：用于把 SqMusic 的 waiting 推断成「下载中」 */
  const SUBMIT_KEY = 'tp_sq_submitted';
  const SUBMIT_TTL_MS = 30 * 60 * 1000;

  /** 当前页状态（切走即丢；只有 localStorage 里的提交记录跨刷新保留 30 分钟） */
  const state = {
    keyword: '',
    plugName: '',
    items: [],
    tasks: [],
    scanning: false,
    lastScanAt: 0,
    // ---- 下载目录 ----
    downloadPath: '',
    downloadPathError: '',
    // ---- 已下载列表 ----
    downloaded: [],
    dlPage: 1,
    dlTotal: 0,
    dlLoading: false,
    // ---- 本地提交记录（签名 → 时间戳） ----
    submitted: {},
    doneIds: new Set(),
  };

  const DL_PAGE_SIZE = 50;

  let pollTimer = null;
  let ctxRef = null;

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  // 离开页面时务必停掉轮询，否则会一直打 /api/sqmusic/tasks
  window.addEventListener('hashchange', stopPoll);

  /* ==========================================================================
   * 格式化小工具
   * ========================================================================== */

  function fmtDur(s) {
    if (!s) return '—';
    const m = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    return m + ':' + ss;
  }

  /** 码率标签：KW_FLAC_2000 → FLAC 2000k */
  function brLabel(b) {
    if (!b) return '自动（最高）';
    const s = String(b);
    const m = /^(?:[A-Z]+_)?([A-Z0-9]+)_?(\d{3,4})?$/.exec(s);
    if (!m) return s;
    const fmt = (m[1] || '').toUpperCase();
    return m[2] ? fmt + ' ' + m[2] + 'k' : fmt;
  }

  function fmtBytes(b) {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function fmtSpeed(bps) {
    const n = Number(bps);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB/s';
    return Math.max(1, Math.round(n / 1024)) + ' KB/s';
  }

  /** 毫秒 → 「12秒 / 3分05秒 / 1时05分」 */
  function fmtElapsed(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    const s = Math.round(n / 1000);
    if (s < 60) return s + '秒';
    const m = Math.floor(s / 60);
    const ss = s % 60;
    if (m < 60) return m + '分' + (ss ? String(ss).padStart(2, '0') + '秒' : '');
    return Math.floor(m / 60) + '时' + (m % 60) + '分';
  }

  /**
   * 解析时间字段。SqMusic 给的是 "2026-08-28 10:00:00" 这类字符串，
   * 也可能是秒 / 毫秒时间戳，这里都兼容；解析不出返回 0。
   */
  function parseTs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
    const s = String(v).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n > 1e12 ? n : n * 1000;
    }
    // '2026-08-28 10:00:00' → '2026/08/28 10:00:00'（兼容各浏览器 Date 解析）
    const t = new Date(s.replace(/-/g, '/').replace('T', ' ')).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  /** 时间戳 → MM-DD HH:mm */
  function fmtClock(v) {
    const t = parseTs(v);
    if (!t) return '—';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * 任务文件大小：真值优先 + 估算兜底
   *   1) 后端给了 fileSizeBytes（已入库曲目有真实体积）→ 真值
   *   2) 否则用 码率(kbps) × 时长(秒) / 8 估算 → estimated=true（前端带 ≈ 显示）
   */
  function taskSize(t) {
    const real = Number(t && t.fileSizeBytes);
    if (Number.isFinite(real) && real > 0) return { bytes: real, estimated: false };
    const kbps = Number(t && t.bitrateKbps) || 0;
    const sec = Number(t && t.durationSec) || 0;
    if (kbps > 0 && sec > 0) {
      return { bytes: Math.round((kbps * 1000 / 8) * sec), estimated: true };
    }
    return { bytes: 0, estimated: false };
  }

  /** 耗时：updatedAt - startedAt；还在进行中的用当前时间 - startedAt */
  function taskElapsedMs(t) {
    const s = parseTs(t && t.startedAt);
    if (!s) return 0;
    const e = parseTs(t && t.updatedAt) || Date.now();
    const d = e - s;
    return d > 0 ? d : 0;
  }

  /* ==========================================================================
   * 本地提交记录（把 waiting 推断成 downloading）
   * ========================================================================== */

  function sig(name, artist) {
    return String(name || '').trim().toLowerCase() + '|' + String(artist || '').trim().toLowerCase();
  }

  /** 读 localStorage 并丢掉超过 30 分钟的记录 */
  function loadSubmitted() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(SUBMIT_KEY) || '{}') || {}; } catch (_) { raw = {}; }
    const now = Date.now();
    const out = {};
    for (const k of Object.keys(raw || {})) {
      const ts = Number(raw[k]);
      if (Number.isFinite(ts) && now - ts < SUBMIT_TTL_MS && now - ts >= 0) out[k] = ts;
    }
    return out;
  }

  function saveSubmitted() {
    try { localStorage.setItem(SUBMIT_KEY, JSON.stringify(state.submitted)); } catch (_) { /* 隐私模式下忽略 */ }
  }

  function markSubmitted(name, artist) {
    state.submitted = loadSubmitted();
    state.submitted[sig(name, artist)] = Date.now();
    saveSubmitted();
  }

  function wasSubmitted(t) {
    const ts = state.submitted[sig(t && t.name, t && t.artist)];
    return !!ts && (Date.now() - ts < SUBMIT_TTL_MS);
  }

  /**
   * 有效状态：SqMusic 没有 downloading 态，
   * 本地刚提交过、服务端还报 waiting 的，按「下载中」显示（带 title 说明是推断）。
   */
  function effStatus(t) {
    if (t.status === 'waiting' && wasSubmitted(t)) return 'downloading';
    return t.status;
  }

  // 首屏先读一次本地提交记录
  state.submitted = loadSubmitted();

  function statusTag(t) {
    const st = effStatus(t);
    const map = {
      waiting: ['等待中', ''],
      downloading: ['下载中', 'ok'],
      success: ['已完成', 'ok'],
      error: ['失败', 'err'],
    };
    const [label, cls] = map[st] || [st || '未知', ''];
    const inferred = st === 'downloading' && t.status === 'waiting';
    const tip = inferred ? ' title="SqMusic 仍报等待中，按本地提交记录推断为下载中"' : '';
    return `<span class="tag ${cls}"${tip}>${ctxRef.esc(label)}${inferred ? ' *' : ''}</span>`;
  }

  /* ==========================================================================
   * 试听播放条（页面底部固定，全页唯一一个 <audio>）
   * ========================================================================== */

  /**
   * 播放一个直链并展示播放条
   * @param {string} url 直链（试听为 SqMusic 外链，已下载为本站 /api/stream/<id>）
   * @param {string} title 展示标题
   */
  function play(url, title) {
    const bar = document.getElementById('sq-player');
    const audio = document.getElementById('sq-player-audio');
    const t = document.getElementById('sq-player-title');
    if (!bar || !audio || !t) return;
    t.textContent = title || '试听';
    bar.style.display = '';
    // 播放条是 fixed 定位，撑开底部 padding 免得盖住页面最后几行
    document.body.classList.add('has-player');
    audio.src = url;
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 浏览器拦截自动播放时用户手动点播放即可 */ });
  }

  function closePlayer() {
    const bar = document.getElementById('sq-player');
    const audio = document.getElementById('sq-player-audio');
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (bar) bar.style.display = 'none';
    document.body.classList.remove('has-player');
  }

  function bindPlayer() {
    const closeBtn = document.getElementById('sq-player-close');
    if (closeBtn) closeBtn.addEventListener('click', closePlayer);
    const audio = document.getElementById('sq-player-audio');
    if (audio) {
      // 直链带时间签名会过期，报错时给一句人话，别让浏览器自己弹英文
      audio.addEventListener('error', () => {
        const t = document.getElementById('sq-player-title');
        if (t && audio.src) {
          t.textContent = (t.textContent || '') + '　（播放失败，直链可能已过期，重新点一次「试听」即可）';
        }
      });
    }
  }

  /* ==========================================================================
   * 渲染
   * ========================================================================== */

  function renderShell(esc) {
    return `
      <h1>搜歌下载</h1>
      <div class="sub" id="sq-sub">通过 SqMusic 在线搜索并下载；文件与标签由 SqMusic 写入曲库目录，TunePick 只负责入库补充</div>

      <div class="panel" id="sq-search">
        <div class="row">
          <input id="sq-kw" placeholder="歌名 / 歌手" style="width:240px" value="${esc(state.keyword)}">
          <select id="sq-src" style="width:120px"></select>
          <button id="sq-go">搜索</button>
          <span class="spacer"></span>
          <button class="btn-ghost" id="sq-test">连通性测试</button>
        </div>
        <div class="row" id="sq-dir" style="margin-bottom:0"></div>
      </div>

      <div id="sq-result"></div>

      <div class="panel" id="sq-task-panel" style="display:none">
        <h2 style="margin-top:0">下载任务</h2>
        <div id="sq-tasks"></div>
      </div>

      <div class="panel" id="sq-downloaded-panel" style="display:none">
        <h2 style="margin-top:0">已下载</h2>
        <div id="sq-downloaded"></div>
      </div>

      <div id="sq-player" style="display:none">
        <div class="row" style="margin:0 0 6px">
          <span id="sq-player-title" style="font-size:13px"></span>
          <span class="spacer"></span>
          <button class="btn-ghost" id="sq-player-close">关闭</button>
        </div>
        <audio id="sq-player-audio" controls preload="none" style="width:100%"></audio>
      </div>`;
  }

  function disabledGuide() {
    return `
      <div class="panel">
        <h2 style="margin-top:0">未启用 SqMusic 集成</h2>
        <p style="color:var(--fg2);font-size:13px;line-height:1.8">
          在线搜歌下载依赖你 NAS 上已部署的 SqMusic 服务。启用步骤：
        </p>
        <ol style="color:var(--fg2);font-size:13px;line-height:1.9;padding-left:20px">
          <li>确认 SqMusic 已部署并可访问（默认 <span class="mono">http://sqmusic_main:8099</span>）</li>
          <li>在部署模板的 <span class="mono">environment</span> 里设置
              <span class="mono">SQ_ENABLED=true</span> 与 <span class="mono">SQ_BASE_URL</span>、<span class="mono">SQ_USERNAME</span>、<span class="mono">SQ_PASSWORD</span></li>
          <li>重启 TunePick 容器后回到本页</li>
        </ol>
        <p style="color:var(--fg2);font-size:12px">
          未启用时本页不会报错，其余功能（扫描 / 曲库 / 打标）不受影响。
        </p>
        <div class="row"><button class="btn-ghost" id="sq-retry">重新检测</button></div>
      </div>`;
  }

  /** 下载目录一行：读不到就明说，绝不编造路径 */
  function dirHtml(esc) {
    if (state.downloadPath) {
      return `
        <span style="color:var(--fg2);font-size:12px">下载目录</span>
        <span class="mono" id="sq-dir-val">${esc(state.downloadPath)}</span>
        <button class="btn-ghost" id="sq-dir-copy">复制</button>
        <span style="color:var(--fg2);font-size:12px">（由 SqMusic 写入，TunePick 扫描同一目录入库）</span>`;
    }
    const why = state.downloadPathError ? '：' + state.downloadPathError : '';
    return `<span style="color:var(--fg2);font-size:12px">未能读取下载目录${esc(why)}</span>`;
  }

  function bindDir() {
    const btn = document.getElementById('sq-dir-copy');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const text = state.downloadPath || '';
      if (!text) return;
      const done = () => { const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1200); };
      // 优先用 Clipboard API，不可用时退回 execCommand（老浏览器 / 非 HTTPS 场景）
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => { legacyCopy(text) && done(); });
        return;
      }
      if (legacyCopy(text)) done();
    });
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function resultsHtml(esc) {
    if (!state.items.length) {
      return '<div class="panel"><div class="empty">没有找到相关歌曲，换个关键词或音源试试</div></div>';
    }
    const rows = state.items.map((it, i) => `
      <tr data-i="${i}">
        <td style="width:56px">
          ${it.picUrl
            ? `<img src="${esc(it.picUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:6px" referrerpolicy="no-referrer">`
            : '<div class="empty" style="padding:12px 0">无封面</div>'}
        </td>
        <td>${esc(it.name)}</td>
        <td>${esc(it.artist || '')}</td>
        <td>${esc(it.albumName || '')}</td>
        <td>${fmtDur(it.durationSec)}</td>
        <td>
          <select data-br="${i}" style="width:130px">
            <option value="">自动（最高）</option>
            ${(it.brTypes || []).map((b) => `<option value="${esc(b)}"${b === it.defaultBrType ? ' selected' : ''}>${esc(brLabel(b))}</option>`).join('')}
          </select>
        </td>
        <td>
          <button class="btn-ghost" data-pv="${i}">试听</button>
          <button data-dl="${i}">下载</button>
        </td>
      </tr>`).join('');

    return `
      <div class="panel">
        <h2 style="margin-top:0">搜索结果 <small style="color:var(--fg2);font-weight:400">共 ${state.items.length} 首 · 音源 ${esc(state.plugName)}</small></h2>
        <div class="sub" style="font-size:12px">试听直链带时间签名，取到后请尽快播放；过期重新点一次「试听」即可。</div>
        <table>
          <thead><tr><th>封面</th><th>歌名</th><th>歌手</th><th>专辑</th><th>时长</th><th>码率</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function tasksHtml(esc) {
    if (!state.tasks.length) {
      return '<div class="empty">暂无下载任务</div>';
    }
    const rows = state.tasks.map((t) => {
      const sz = taskSize(t);
      const el = taskElapsedMs(t);
      const spd = (sz.bytes > 0 && el > 0) ? sz.bytes / (el / 1000) : 0;
      return `
      <tr>
        <td>${esc(t.name || t.id)}</td>
        <td>${esc(t.artist || '')}</td>
        <td>${esc(t.brType ? brLabel(t.brType) : '—')}</td>
        <td>${statusTag(t)}</td>
        <td>${sz.bytes ? (sz.estimated ? '≈' : '') + fmtBytes(sz.bytes) : '—'}</td>
        <td>${spd > 0 ? (sz.estimated ? '≈' : '') + fmtSpeed(spd) : '—'}</td>
        <td>${fmtElapsed(el)}</td>
        <td style="color:var(--fg2);font-size:12px">${esc(t.message || t.filePath || '')}</td>
      </tr>`;
    }).join('');

    const c = state.tasks.reduce((acc, t) => {
      const st = effStatus(t);
      acc[st] = (acc[st] || 0) + 1;
      return acc;
    }, {});
    const summary = ['等待 ' + (c.waiting || 0), '下载中 ' + (c.downloading || 0),
      '完成 ' + (c.success || 0), '失败 ' + (c.error || 0)].join(' · ');
    return `
      <div class="sub">${esc(summary)}${state.lastScanAt ? ' · 已触发入库扫描' : ''}
        <span style="color:var(--fg2);font-size:12px"> · SqMusic 无真实进度，带 ≈ 的是按「码率 × 时长」估算</span>
      </div>
      <table>
        <thead><tr><th>曲目</th><th>歌手</th><th>码率</th><th>状态</th><th>大小</th><th>速度</th><th>耗时</th><th>说明</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /** 已下载列表 */
  function downloadedHtml(esc) {
    if (!state.downloaded.length) {
      return '<div class="empty">还没有已下载歌曲</div>';
    }
    const rows = state.downloaded.map((it, i) => `
      <tr>
        <td>${esc(it.name || '')}</td>
        <td>${esc(it.artist || '')}</td>
        <td>${esc(it.album || '')}</td>
        <td>${esc(it.brType ? brLabel(it.brType) : '—')}</td>
        <td style="color:var(--fg2);font-size:12px">${esc(fmtClock(it.updatedAt || it.startedAt))}</td>
        <td>${it.inLibrary
          ? '<span class="tag ok">已在曲库</span>'
          : '<span class="tag warn">未入库</span>'}
          ${it.inLibrary && it.filePath
            ? `<div class="mono" style="color:var(--fg2);font-size:11px">${esc(it.filePath)}</div>`
            : ''}
        </td>
        <td>
          <button class="btn-ghost" data-play-dl="${i}"${it.trackId ? '' : ' disabled'}
            title="${it.trackId ? '播放曲库文件' : '尚未入库，先扫描后再播放'}">播放</button>
        </td>
      </tr>`).join('');

    const miss = state.downloaded.filter((x) => !x.inLibrary).length;
    const more = state.downloaded.length < state.dlTotal
      ? '<button class="btn-ghost" id="sq-dl-more">加载更多</button>'
      : '';
    return `
      <div class="sub">
        共 ${state.dlTotal} 首 · 已入库 ${state.downloaded.length - miss} 首 · 未入库 ${miss} 首
        ${miss ? '<button class="btn-ghost" id="sq-dl-scan" style="margin-left:10px">去扫描</button>' : ''}
      </div>
      <table>
        <thead><tr><th>曲目</th><th>歌手</th><th>专辑</th><th>码率</th><th>下载时间</th><th>位置</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="row">${more}</div>`;
  }

  function bindDownloaded(ctx) {
    const box = document.getElementById('sq-downloaded');
    if (!box) return;
    box.querySelectorAll('[data-play-dl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.playDl, 10);
        const it = state.downloaded[i];
        if (!it || !it.trackId) return;
        // 走本站 /api/stream：<audio> 只能带同域 Cookie，服务端对该前缀已放行 Cookie 鉴权
        play('/api/stream/' + encodeURIComponent(it.trackId), (it.name || '') + (it.artist ? ' · ' + it.artist : ''));
      });
    });
    const more = document.getElementById('sq-dl-more');
    if (more) more.addEventListener('click', () => loadDownloaded(ctx, true));
    const scan = document.getElementById('sq-dl-scan');
    if (scan) scan.addEventListener('click', () => { location.hash = '#/scan'; });
  }

  /* ==========================================================================
   * 行为
   * ========================================================================== */

  async function loadStatus(ctx) {
    const st = await ctx.api('/api/sqmusic/status');
    return (st && st.status) || { enabled: false, plugins: [] };
  }

  /** 拉一次下载目录（失败只记 error，不打断页面） */
  async function loadDir(ctx) {
    try {
      const r = await ctx.api('/api/sqmusic/dir');
      if (r && r.ok !== false) {
        state.downloadPath = r.downloadPath || '';
        state.downloadPathError = r.error || '';
      } else {
        state.downloadPath = '';
        state.downloadPathError = (r && r.error) || '读取失败';
      }
    } catch (e) {
      state.downloadPath = '';
      state.downloadPathError = (e && e.message) || '读取失败';
    }
    const box = document.getElementById('sq-dir');
    if (box) {
      box.innerHTML = dirHtml(ctx.esc);
      bindDir();
    }
  }

  /** 拉已下载列表；append=true 时追加下一页 */
  async function loadDownloaded(ctx, append) {
    if (state.dlLoading) return;
    state.dlLoading = true;
    try {
      state.dlPage = append ? state.dlPage + 1 : 1;
      const r = await ctx.api(
        '/api/sqmusic/downloaded?pageIndex=' + state.dlPage + '&pageSize=' + DL_PAGE_SIZE,
      );
      if (!r || r.ok === false) {
        state.dlPage = append ? Math.max(1, state.dlPage - 1) : 1;
        const box = document.getElementById('sq-downloaded');
        if (box) box.innerHTML = `<div class="empty">${ctx.esc((r && r.error) || '读取已下载列表失败')}</div>`;
        return;
      }
      const items = r.items || [];
      state.downloaded = append ? state.downloaded.concat(items) : items;
      state.dlTotal = Number(r.total) || state.downloaded.length;
      // 顺带补一次下载目录（已下载接口也会带回），没有也无所谓
      if (!state.downloadPath && r.downloadPath) state.downloadPath = r.downloadPath;

      const panel = document.getElementById('sq-downloaded-panel');
      const box = document.getElementById('sq-downloaded');
      if (!panel || !box) return;
      panel.style.display = '';
      box.innerHTML = downloadedHtml(ctx.esc);
      bindDownloaded(ctx);
    } catch (e) {
      state.dlPage = append ? Math.max(1, state.dlPage - 1) : 1;
      const box = document.getElementById('sq-downloaded');
      if (box) box.innerHTML = `<div class="empty">读取已下载列表失败：${ctx.esc(e.message || '未知错误')}</div>`;
    } finally {
      state.dlLoading = false;
    }
  }

  function bindSearch(ctx, root, st) {
    const sel = root.querySelector('#sq-src');
    const plugins = (st.plugins && st.plugins.length) ? st.plugins : ['kw', 'kg', 'qq', 'netease'];
    const labels = (st.pluginLabels) || { kw: '酷我', kg: '酷狗', qq: 'QQ音乐', netease: '网易云' };
    sel.innerHTML = plugins
      .map((p) => `<option value="${ctx.esc(p)}"${p === state.plugName ? ' selected' : ''}>${ctx.esc(labels[p] || p)}</option>`)
      .join('');
    if (!state.plugName) state.plugName = plugins[0];

    const input = root.querySelector('#sq-kw');
    const go = async () => {
      const kw = input.value.trim();
      if (!kw) { input.focus(); return; }
      state.keyword = kw;
      state.plugName = sel.value;
      const box = root.querySelector('#sq-result');
      box.innerHTML = '<div class="panel"><div class="empty">搜索中…</div></div>';
      try {
        const r = await ctx.api('/api/sqmusic/search', {
          method: 'POST',
          body: JSON.stringify({ keyword: kw, plugName: state.plugName, pageSize: 20, pageIndex: 1 }),
        });
        // 4xx/5xx 返回的是 { ok:false, error }，不要把展示成「没搜到」
        if (!r || r.ok === false) {
          state.items = [];
          box.innerHTML = `<div class="panel"><div class="empty">${ctx.esc((r && r.error) || '搜索失败')}</div></div>`;
          return;
        }
        state.items = (r && r.items) || [];
        box.innerHTML = resultsHtml(ctx.esc);
        bindDownload(ctx, box);
        bindPreview(ctx, box);
      } catch (e) {
        box.innerHTML = `<div class="panel"><div class="empty">搜索失败：${ctx.esc(e.message || '未知错误')}</div></div>`;
      }
    };
    root.querySelector('#sq-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  function bindPreview(ctx, box) {
    box.querySelectorAll('[data-pv]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.pv, 10);
        const it = state.items[i];
        if (!it) return;
        const brSel = box.querySelector('[data-br="' + i + '"]');
        const brType = brSel ? brSel.value : '';
        btn.disabled = true;
        btn.textContent = '取链中';
        try {
          const r = await ctx.api('/api/sqmusic/preview', {
            method: 'POST',
            body: JSON.stringify({ key: it.key, brType }),
          });
          if (!r || r.ok === false) throw new Error((r && r.error) || '取播放地址失败');
          const note = r.brType ? brLabel(r.brType) : '';
          play(r.url, (it.name || '') + (it.artist ? ' · ' + it.artist : '') + (note ? '　[' + note + ']' : ''));
          btn.textContent = '试听中';
        } catch (e) {
          alert('试听失败：' + (e.message || '未知错误'));
          btn.textContent = '试听';
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function bindDownload(ctx, box) {
    box.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.dataset.dl, 10);
        const it = state.items[i];
        if (!it) return;
        const brSel = box.querySelector('[data-br="' + i + '"]');
        const brType = brSel ? brSel.value : '';
        btn.disabled = true;
        btn.textContent = '提交中';
        try {
          const r = await ctx.api('/api/sqmusic/download', {
            method: 'POST',
            body: JSON.stringify({ key: it.key, brType }),
          });
          if (!r || r.ok === false) throw new Error((r && r.error) || '提交失败');
          // 记一笔本地提交：SqMusic 仍报 waiting 时前端据此显示「下载中」
          markSubmitted(it.name, it.artist);
          btn.textContent = '已入队';
          startPoll(ctx);
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '下载';
          alert('下载失败：' + (e.message || '未知错误'));
        }
      });
    });
  }

  async function tick(ctx) {
    try {
      const r = await ctx.api('/api/sqmusic/tasks');
      state.tasks = (r && r.items) || [];
      if (r && r.autoScan && r.autoScan.lastAt) state.lastScanAt = r.autoScan.lastAt;
      const box = document.getElementById('sq-tasks');
      const panel = document.getElementById('sq-task-panel');
      if (!box || !panel) { stopPoll(); return; }
      panel.style.display = '';
      box.innerHTML = tasksHtml(ctx.esc);

      // 出现「新完成」的任务 → 已下载列表要跟着变，重新拉一次（只拉第一页）
      const doneIds = state.tasks.filter((t) => t.status === 'success').map((t) => String(t.id));
      const fresh = doneIds.filter((id) => !state.doneIds.has(id));
      state.doneIds = new Set(doneIds);
      if (fresh.length && !state.dlLoading) await loadDownloaded(ctx, false);

      const active = state.tasks.some((t) => t.status === 'waiting' || t.status === 'downloading');
      if (!active) stopPoll();
    } catch (_) {
      stopPoll();
    }
  }

  function startPoll(ctx) {
    tick(ctx);
    stopPoll();
    pollTimer = setInterval(() => tick(ctx), 2000);
  }

  /**
   * 页面入口
   * @param {HTMLElement} root #view
   * @param {{api:Function, esc:Function}} ctx 由 app.js 注入
   */
  async function render(root, ctx) {
    ctxRef = ctx;
    stopPoll();
    state.tasks = [];
    state.lastScanAt = 0;
    state.doneIds = new Set();
    state.downloaded = [];
    state.dlPage = 1;
    state.dlTotal = 0;
    state.submitted = loadSubmitted();

    let st;
    try {
      st = await loadStatus(ctx);
    } catch (e) {
      root.innerHTML = `<h1>搜歌下载</h1><div class="empty">加载失败：${ctx.esc(e.message)}</div>`;
      return;
    }

    root.innerHTML = renderShell(ctx.esc);
    const sub = root.querySelector('#sq-sub');
    bindPlayer();

    if (!st.enabled) {
      root.querySelector('#sq-search').style.display = 'none';
      root.querySelector('#sq-result').innerHTML = disabledGuide();
      const retry = document.getElementById('sq-retry');
      if (retry) retry.addEventListener('click', () => render(root, ctx));
      if (sub) sub.textContent = '当前未启用 SqMusic 集成（SQ_ENABLED=false）';
      return;
    }

    if (sub) {
      sub.textContent = '已启用 · 服务 ' + (st.baseUrl || '') +
        (st.autoScan ? ' · 下载完成后自动增量入库' : ' · 需手动扫描入库');
    }

    bindSearch(ctx, root, st);
    await loadDir(ctx);

    const testBtn = root.querySelector('#sq-test');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        try {
          const r = await ctx.api('/api/sqmusic/test', { method: 'POST' });
          alert(r.ok ? `SqMusic 可用（${r.latencyMs}ms）` : 'SqMusic 不可用：' + (r.error || '未知错误'));
        } catch (e) {
          alert('SqMusic 不可用：' + (e.message || '未知错误'));
        } finally {
          testBtn.disabled = false;
        }
      });
    }

    // 进入页面先看一眼有没有进行中的任务（只展示，不自动触发扫描）
    try {
      const r = await ctx.api('/api/sqmusic/tasks');
      state.tasks = (r && r.items) || [];
      state.doneIds = new Set(state.tasks.filter((t) => t.status === 'success').map((t) => String(t.id)));
      if (state.tasks.length) {
        const panel = document.getElementById('sq-task-panel');
        if (panel) panel.style.display = '';
        const box = document.getElementById('sq-tasks');
        if (box) box.innerHTML = tasksHtml(ctx.esc);
        if (state.tasks.some((t) => t.status === 'waiting' || t.status === 'downloading')) startPoll(ctx);
      }
    } catch (_) { /* ignore */ }

    // 已下载列表：进页面加载一次（失败只在本区块里提示，不影响上面）
    await loadDownloaded(ctx, false);
  }

  window.TPDiscover = { render, stopPoll };
})();
