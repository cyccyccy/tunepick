/* TunePick · 搜歌下载（SqMusic） —— 零依赖原生 JS
 * 由 app.js 的 #/discover 路由调用：window.TPDiscover.render(root, ctx)
 * 只做三件事：搜索展示 → 下发下载任务 → 轮询进度。
 * 写文件由 SqMusic 完成，本页面不碰音乐文件。
 */
(function () {
  'use strict';

  /** 当前页状态（切走即丢，不做持久化） */
  const state = {
    keyword: '',
    plugName: '',
    items: [],
    tasks: [],
    scanning: false,
    lastScanAt: 0,
  };

  let pollTimer = null;
  let ctxRef = null;

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  // 离开页面时务必停掉轮询，否则会一直打 /api/sqmusic/tasks
  window.addEventListener('hashchange', stopPoll);

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

  function statusTag(st) {
    const map = {
      waiting: ['等待中', ''],
      downloading: ['下载中', 'ok'],
      success: ['已完成', 'ok'],
      error: ['失败', 'err'],
    };
    const [label, cls] = map[st] || [st || '未知', ''];
    return '<span class="tag ' + cls + '">' + ctxRef.esc(label) + '</span>';
  }

  /* ---------------- 渲染 ---------------- */

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
      </div>

      <div id="sq-result"></div>

      <div class="panel" id="sq-task-panel" style="display:none">
        <h2 style="margin-top:0">下载任务</h2>
        <div id="sq-tasks"></div>
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
        <td><button data-dl="${i}">下载</button></td>
      </tr>`).join('');

    return `
      <div class="panel">
        <h2 style="margin-top:0">搜索结果 <small style="color:var(--fg2);font-weight:400">共 ${state.items.length} 首 · 音源 ${esc(state.plugName)}</small></h2>
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
    const rows = state.tasks.map((t) => `
      <tr>
        <td>${esc(t.name || t.id)}</td>
        <td>${esc(t.artist || '')}</td>
        <td>${esc(t.brType ? brLabel(t.brType) : '—')}</td>
        <td>${statusTag(t.status)}</td>
        <td style="color:var(--fg2);font-size:12px">${esc(t.message || t.filePath || '')}</td>
      </tr>`).join('');
    const c = state.tasks.reduce((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});
    const summary = ['等待 ' + (c.waiting || 0), '下载中 ' + (c.downloading || 0),
      '完成 ' + (c.success || 0), '失败 ' + (c.error || 0)].join(' · ');
    return `
      <div class="sub">${esc(summary)}${state.lastScanAt ? ' · 已触发入库扫描' : ''}</div>
      <table>
        <thead><tr><th>曲目</th><th>歌手</th><th>码率</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /* ---------------- 行为 ---------------- */

  async function loadStatus(ctx) {
    const st = await ctx.api('/api/sqmusic/status');
    return (st && st.status) || { enabled: false, plugins: [] };
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
      } catch (e) {
        box.innerHTML = `<div class="panel"><div class="empty">搜索失败：${ctx.esc(e.message || '未知错误')}</div></div>`;
      }
    };
    root.querySelector('#sq-go').addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
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
          await ctx.api('/api/sqmusic/download', {
            method: 'POST',
            body: JSON.stringify({ key: it.key, brType }),
          });
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

    let st;
    try {
      st = await loadStatus(ctx);
    } catch (e) {
      root.innerHTML = `<h1>搜歌下载</h1><div class="empty">加载失败：${ctx.esc(e.message)}</div>`;
      return;
    }

    root.innerHTML = renderShell(ctx.esc);
    const sub = root.querySelector('#sq-sub');

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
      if (state.tasks.length) {
        const panel = document.getElementById('sq-task-panel');
        if (panel) panel.style.display = '';
        const box = document.getElementById('sq-tasks');
        if (box) box.innerHTML = tasksHtml(ctx.esc);
        if (state.tasks.some((t) => t.status === 'waiting' || t.status === 'downloading')) startPoll(ctx);
      }
    } catch (_) { /* ignore */ }
  }

  window.TPDiscover = { render, stopPoll };
})();
