/* TunePick Web 管理界面 —— 零依赖原生 JS */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const view = () => document.getElementById('view');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- token ---------------- */
  function getToken() { return localStorage.getItem('tp_token') || ''; }
  function setToken(v) { localStorage.setItem('tp_token', v); }

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) { promptToken(); throw new Error('需要有效的访问令牌'); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return res.text();
    return res.json();
  }

  function promptToken() {
    const t = prompt('请输入 API 访问令牌（对应服务端的 AUTH_TOKEN）', getToken());
    if (t !== null) { setToken(t); location.reload(); }
  }

  $('#btn-token').addEventListener('click', promptToken);

  /* ---------------- 路由 ---------------- */
  const ROUTES = { overview, scan, report, review, library, detail, sources, llm, logs };
  let pollTimer = null;

  function currentRoute() {
    const h = location.hash.replace(/^#\/?/, '') || 'overview';
    const [name, arg] = h.split('/');
    return { name: ROUTES[name] ? name : 'overview', arg };
  }

  function render() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const { name, arg } = currentRoute();
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
    view().innerHTML = '<div class="empty">加载中…</div>';
    Promise.resolve(ROUTES[name](arg)).catch((e) => {
      view().innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    });
  }

  window.addEventListener('hashchange', render);

  async function boot() {
    try {
      const h = await api('/api/health');
      if (h.authWarning) {
        const bar = $('#alert-bar');
        bar.textContent = '⚠ ' + h.authWarning;
        bar.classList.remove('hidden');
      }
    } catch (e) { /* ignore */ }
    if (!getToken()) {
      // 首次访问：尝试无 token（本机/localhost-only 场景可用）
    }
    render();
  }

  /* ---------------- 概览 ---------------- */
  async function overview() {
    const [stat, health] = await Promise.all([api('/api/stats/coverage'), api('/api/health')]);
    const c = stat.coverage, p = stat.coveragePct;
    const cards = [
      ['曲目总数', c.total, ''],
      ['歌手', p.artist + '%', '可用 ' + p.artistUsable + '%'],
      ['年代', p.era + '%', ''],
      ['流派', p.genre + '%', ''],
      ['歌词', p.lyrics + '%', ''],
      ['封面', p.cover + '%', ''],
      ['待审阅', stat.needReview, ''],
      ['高质量', stat.quality.high || 0, ''],
    ];
    view().innerHTML = `
      <h1>概览</h1>
      <div class="sub">曲库 ${c.total} 首 · 词表 ${health.vocabVersion} · 数据源 ${health.sourceKind} · 封面缓存 ${health.coverUsageMB}MB</div>
      <div class="cards">${cards.map(([k, v, s]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)} <small>${esc(s)}</small></div></div>`).join('')}</div>

      <h2>质量分布</h2>
      <div class="cards">
        <div class="card"><div class="k">高</div><div class="v">${stat.quality.high || 0}</div></div>
        <div class="card"><div class="k">中</div><div class="v">${stat.quality.medium || 0}</div></div>
        <div class="card"><div class="k">低</div><div class="v">${stat.quality.low || 0}</div></div>
      </div>

      <h2>快速操作</h2>
      <div class="row">
        <button onclick="location.hash='#/scan'">前往扫描</button>
        <button class="btn-ghost" onclick="location.hash='#/report'">查看质量报告</button>
        <button class="btn-ghost" onclick="location.hash='#/review'">审阅队列（${stat.needReview}）</button>
      </div>`;
  }

  /* ---------------- 扫描任务 ---------------- */
  async function scan() {
    const st = await api('/api/scan/status');
    const running = st.running || st.state === 'paused';
    view().innerHTML = `
      <h1>扫描任务</h1>
      <div class="sub">手动触发 · 支持暂停与断点续跑</div>

      <div class="panel">
        <div class="row">
          <button id="btn-full" ${running ? 'disabled' : ''}>全量扫描</button>
          <button id="btn-inc" class="btn-ghost" ${running ? 'disabled' : ''}>增量扫描（仅变更文件）</button>
          <button id="btn-sample" class="btn-ghost" ${running ? 'disabled' : ''}>抽样试跑</button>
          <span class="spacer"></span>
          <button id="btn-pause" class="btn-ghost" ${st.state !== 'running' ? 'disabled' : ''}>暂停</button>
          <button id="btn-resume" class="btn-ghost" ${st.state !== 'paused' ? 'disabled' : ''}>继续</button>
          <button id="btn-cancel" class="btn-danger" ${!running ? 'disabled' : ''}>取消</button>
        </div>
        <div class="row">
          <label style="display:inline">样本量 <input id="sample-size" type="number" value="100" style="width:90px"></label>
          <label style="display:inline"><input type="checkbox" id="use-l3" checked> 启用 LLM（L3）</label>
        </div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">进度</h2>
        <div id="status-box">${renderStatus(st)}</div>
      </div>

      <div class="panel">
        <h2 style="margin-top:0">运行日志（尾部）</h2>
        <div class="logs" id="log-box"></div>
      </div>`;

    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body || {}) });

    bind('btn-full', async () => { await post('/api/scan/start', { mode: 'full', useL3: document.getElementById('use-l3').checked }); render(); });
    bind('btn-inc', async () => { await post('/api/scan/start', { mode: 'incremental', useL3: document.getElementById('use-l3').checked }); render(); });
    bind('btn-sample', async () => {
      const size = parseInt(document.getElementById('sample-size').value, 10) || 100;
      await post('/api/scan/sample', { size, useL3: document.getElementById('use-l3').checked });
      render();
    });
    bind('btn-pause', async () => { await post('/api/scan/pause'); render(); });
    bind('btn-resume', async () => { await post('/api/scan/resume'); render(); });
    bind('btn-cancel', async () => { await post('/api/scan/cancel'); render(); });

    pollTimer = setInterval(async () => {
      try {
        const s = await api('/api/scan/status');
        const box = document.getElementById('status-box');
        if (box) box.innerHTML = renderStatus(s);
        const lb = document.getElementById('log-box');
        if (lb) {
          const r = await api('/api/scan/logs?tail=30');
          lb.innerHTML = (r.lines || []).map((l) => `<div class="${esc(l.level)}">[${esc(l.level)}] ${esc(l.msg)}</div>`).join('') || '<div>暂无日志</div>';
        }
        if (!s.running && s.state !== 'paused') { clearInterval(pollTimer); pollTimer = null; render(); }
      } catch (_) { /* ignore */ }
    }, 2000);
  }

  function renderStatus(s) {
    if (!s || !s.total) return `<div class="empty">当前无运行中的任务</div>`;
    return `
      <div class="row" style="margin:0">
        <span class="tag ${s.state === 'running' ? 'ok' : s.state === 'failed' ? 'err' : ''}">${esc(s.state)}</span>
        <span>${s.done} / ${s.total}</span>
        <span class="spacer"></span>
        <span style="color:var(--fg2)">失败 ${s.failed} · ${s.speedPerSec} 首/秒 · 预计剩余 ${s.etaSec == null ? '—' : Math.round(s.etaSec / 60) + ' 分钟'}</span>
      </div>
      <div class="progress"><i style="width:${s.percent}%"></i></div>
      <div class="mono" style="color:var(--fg2)">${esc(s.currentFile || '')}</div>`;
  }

  /* ---------------- 质量报告 ---------------- */
  async function report() {
    const [r, pr] = await Promise.all([api('/api/scan/sample-report'), api('/api/scan/probe-report')]);
    const rep = r.report || {};
    const probe = pr.report || {};
    const srcRows = Object.entries(rep.sourceStats || {}).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${v.requests || 0}</td><td>${v.ok || 0}</td><td>${v.empty || 0}</td><td>${v.failed || 0}</td><td>${v.blocked || 0}</td></tr>`).join('');
    const dist = Object.entries(rep.distribution || {}).map(([k, v]) =>
      `<tr><td>${esc(k)} · ${esc(v.name)}</td><td>${v.pool}</td><td>${v.picked}</td></tr>`).join('');

    view().innerHTML = `
      <h1>质量报告</h1>
      <div class="sub">${rep.available ? '基于最近一次抽样试跑' : '尚未运行抽样试跑，以下为当前曲库状态'}</div>

      <div class="cards">
        <div class="card"><div class="k">样本量</div><div class="v">${rep.sampled || 0} <small>/ 全库 ${rep.population || 0}</small></div></div>
        <div class="card"><div class="k">单曲耗时</div><div class="v">${rep.perTrackMs || 0} <small>ms</small></div></div>
        <div class="card"><div class="k">全量预估</div><div class="v">${Math.round((rep.estimateFullMs || 0) / 60000)} <small>分钟</small></div></div>
        <div class="card"><div class="k">LLM</div><div class="v">${rep.llm && rep.llm.configured ? '已配置' : '未配置'}</div></div>
      </div>

      <h2>各源表现</h2>
      <table><thead><tr><th>源</th><th>请求</th><th>成功</th><th>空结果</th><th>失败</th><th>疑似软封</th></tr></thead><tbody>${srcRows || '<tr><td colspan="6" class="empty">暂无数据</td></tr>'}</tbody></table>

      <h2>抽样分层</h2>
      <table><thead><tr><th>层</th><th>总体</th><th>抽样</th></tr></thead><tbody>${dist || '<tr><td colspan="3" class="empty">暂无数据</td></tr>'}</tbody></table>

      <h2>目录结构探测</h2>
      <div class="cards">
        <div class="card"><div class="k">扁平文件占比</div><div class="v">${probe.flatRatio || 0}%</div></div>
        <div class="card"><div class="k">疑似歌手目录</div><div class="v">${probe.suspectedArtistDirs || 0}</div></div>
        <div class="card"><div class="k">目录推断生效</div><div class="v">${probe.pathInferApplied || 0}</div></div>
      </div>

      <div class="row"><button onclick="location.hash='#/scan'">返回扫描任务</button></div>`;
  }

  /* ---------------- 标签审阅 ---------------- */
  async function review() {
    const r = await api('/api/review/queue?limit=100');
    view().innerHTML = `
      <h1>标签审阅</h1>
      <div class="sub">共 ${r.total} 首待审阅 · 修改后字段将自动锁定，后续扫描不再覆盖</div>
      <table>
        <thead><tr><th>曲目</th><th>歌手</th><th>专辑</th><th>年代</th><th>流派</th><th>置信度</th><th>原因</th><th>操作</th></tr></thead>
        <tbody>${(r.items || []).map((t) => `
          <tr data-id="${esc(t.id)}">
            <td>${esc(t.title)}</td>
            <td><input value="${esc(t.artist)}" data-f="cleanArtist" style="width:110px"></td>
            <td><input value="${esc(t.albumTitle || '')}" data-f="album" style="width:130px"></td>
            <td><input value="${t.year || ''}" data-f="year" type="number" style="width:70px"></td>
            <td><input value="${esc(t.genre)}" data-f="genre" style="width:80px"></td>
            <td>${esc(t.confidence)}</td>
            <td style="color:var(--fg2);font-size:12px">${esc(t.reviewReason)}</td>
            <td><button class="btn-ghost" data-save="${esc(t.id)}">保存锁定</button></td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无待审阅曲目</td></tr>'}
        </tbody>
      </table>`;

    view().querySelectorAll('[data-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const patch = {};
        tr.querySelectorAll('input[data-f]').forEach((inp) => {
          const v = inp.value.trim();
          if (v === '') return;
          patch[inp.dataset.f] = inp.dataset.f === 'year' ? parseInt(v, 10) : v;
        });
        await api('/api/tracks/' + encodeURIComponent(btn.dataset.save), { method: 'PATCH', body: JSON.stringify(patch) });
        btn.textContent = '已锁定';
        btn.disabled = true;
      });
    });
  }

  /* ---------------- 曲库浏览 ---------------- */
  async function library() {
    const f = await api('/api/facets');
    const r = await api('/api/tracks/filter?limit=100');
    view().innerHTML = `
      <h1>曲库浏览</h1>
      <div class="sub">共 ${r.total} 首</div>
      <div class="panel">
        <div class="row">
          <input id="f-q" placeholder="搜索曲名/歌手/专辑" style="width:220px">
          <select id="f-genre"><option value="">全部流派</option>${f.genre.map((x) => `<option value="${esc(x.value)}">${esc(x.value)} (${x.count})</option>`).join('')}</select>
          <select id="f-era"><option value="">全部年代</option>${f.era.map((x) => `<option value="${esc(x.value)}">${esc(x.value)} (${x.count})</option>`).join('')}</select>
          <select id="f-scene"><option value="">全部场景</option>${f.scene.map((x) => `<option value="${esc(x.value)}">${esc(x.value)} (${x.count})</option>`).join('')}</select>
          <select id="f-album"><option value="">全部专辑</option><option value="unknown">未知专辑</option><option value="real">真实专辑</option></select>
          <button id="f-go">筛选</button>
          <button class="btn-ghost" onclick="window.open('/api/export?format=csv')">导出 CSV</button>
        </div>
      </div>
      <table>
        <thead><tr><th>曲目</th><th>歌手</th><th>专辑</th><th>年代</th><th>流派</th><th>时长</th><th>质量</th><th></th></tr></thead>
        <tbody id="tb">${rowsHtml(r.items || [])}</tbody>
      </table>`;

    document.getElementById('f-go').addEventListener('click', async () => {
      const p = new URLSearchParams({
        q: document.getElementById('f-q').value,
        genre: document.getElementById('f-genre').value,
        era: document.getElementById('f-era').value,
        scene: document.getElementById('f-scene').value,
        albumGroup: document.getElementById('f-album').value,
        limit: '200',
      });
      const rr = await api('/api/tracks/filter?' + p.toString());
      document.getElementById('tb').innerHTML = rowsHtml(rr.items || []);
    });
  }

  function rowsHtml(items) {
    return items.map((t) => `
      <tr>
        <td><a href="#/detail/${encodeURIComponent(t.id)}" style="color:var(--accent);text-decoration:none">${esc(t.title)}</a></td>
        <td>${esc(t.artist)}</td>
        <td>${esc(t.albumTitle || '')}</td>
        <td>${t.year || '—'}</td>
        <td>${esc(t.genre || '')}</td>
        <td>${fmtDur(t.durationSec)}</td>
        <td><span class="tag ${t.qualityLevel === 'high' ? 'ok' : ''}">${esc(t.qualityLevel || '')}</span></td>
        <td>${t.needReview ? '<span class="tag warn">待审阅</span>' : ''}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">无匹配结果</td></tr>';
  }

  async function detail(arg) {
    if (!arg) { location.hash = '#/library'; return; }
    const r = await api('/api/tracks/' + arg);
    const t = r.track;
    if (!t) { view().innerHTML = '<div class="empty">曲目不存在</div>'; return; }
    const sm = t.sourceMap || {}, fc = t.fieldConfidence || {};
    const fields = ['title', 'cleanTitle', 'artist', 'cleanArtist', 'album', 'year', 'era', 'genre', 'mood', 'scene', 'lang', 'energy', 'valence'];
    view().innerHTML = `
      <h1>${esc(t.cleanTitle || t.title)}</h1>
      <div class="sub">${esc(t.cleanArtist || t.artist || '未知歌手')} · ${esc(t.album || '')} · ${t.year || '年代未知'}</div>
      <div class="grid2">
        <div class="panel">
          ${t.coverId ? `<img src="${esc(t.coverUrl || ('/api/cover/' + t.coverId + '?size=300'))}" style="width:100%;border-radius:8px">` : ''}
          ${t.lyrics ? `<h2>歌词</h2><pre style="white-space:pre-wrap;font-size:12px;color:var(--fg2);max-height:260px;overflow:auto">${esc(t.lyrics)}</pre>` : '<div class="empty">暂无歌词</div>'}
        </div>
        <div class="panel">
          <h2 style="margin-top:0">字段与来源</h2>
          <table>
            <thead><tr><th>字段</th><th>值</th><th>来源</th><th>置信度</th></tr></thead>
            <tbody>${fields.map((f) => `<tr><td>${esc(f)}</td><td>${esc(Array.isArray(t[f]) ? t[f].join(' / ') : t[f])}</td><td class="mono">${esc(sm[f] || '—')}</td><td>${fc[f] ?? '—'}</td></tr>`).join('')}</tbody>
          </table>
          <h2>质量标记</h2>
          <div class="row">
            ${['isAd', 'isGarbled', 'isLive', 'isRemix', 'isCover', 'isInstrumental', 'isShort', 'needReview']
        .map((f) => t[f] ? `<span class="tag warn">${esc(f)}</span>` : '').join('')}
            <span class="tag">${esc(t.qualityLevel)}</span>
            <span class="tag">${esc(t.scrapeStage)}</span>
          </div>
          <div class="sub" style="margin-top:12px">文件路径：${esc(t.filePath)}</div>
          <div class="row"><button class="btn-ghost" onclick="location.hash='#/library'">返回列表</button></div>
        </div>
      </div>`;
  }

  /* ---------------- 数据源 ---------------- */
  async function sources() {
    const r = await api('/api/sources');
    view().innerHTML = `
      <h1>数据源</h1>
      <div class="sub">逐源可开关；限速 ${r.qps} QPS（MusicBrainz 硬性 ≤1）</div>
      <div class="panel">
        <label><input type="checkbox" id="g-on" ${r.globalEnabled ? 'checked' : ''}> 启用在线刮削（L2 总开关）</label>
        <label style="margin-top:10px">QPS 上限 <input id="g-qps" type="number" step="0.5" value="${r.qps}" style="width:90px"></label>
        <div class="row"><button id="g-save">保存</button></div>
      </div>
      <table>
        <thead><tr><th>源</th><th>启用</th><th>请求</th><th>成功</th><th>空结果</th><th>失败</th><th>疑似软封</th><th></th></tr></thead>
        <tbody>${r.sources.map((s) => `
          <tr>
            <td>${esc(s.name)}</td>
            <td><input type="checkbox" data-name="${esc(s.name)}" ${s.enabled ? 'checked' : ''}></td>
            <td>${s.requests || 0}</td><td>${s.ok || 0}</td><td>${s.empty || 0}</td><td>${s.failed || 0}</td>
            <td>${s.blocked || 0}</td>
            <td><button class="btn-ghost" data-test="${esc(s.name)}">连通性测试</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    document.getElementById('g-save').addEventListener('click', async () => {
      const list = [...view().querySelectorAll('input[data-name]')].map((i) => ({ name: i.dataset.name, enabled: i.checked }));
      await api('/api/sources', {
        method: 'PATCH',
        body: JSON.stringify({ sources: list, globalEnabled: document.getElementById('g-on').checked, qps: parseFloat(document.getElementById('g-qps').value) || 1 }),
      });
      render();
    });
    view().querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
      const r2 = await api('/api/sources/' + b.dataset.test + '/test', { method: 'POST' });
      alert(`${b.dataset.test}: ${r2.ok ? '可用' : '不可用'}（${r2.latencyMs}ms）${r2.error ? '\n' + r2.error : ''}`);
    }));
  }

  /* ---------------- LLM ---------------- */
  async function llm() {
    const [c, m] = await Promise.all([api('/api/llm/config'), api('/api/llm/models')]);
    view().innerHTML = `
      <h1>LLM 配置</h1>
      <div class="sub">L3 是流派 / 情绪 / 场景 / 语种的唯一来源——在线源不返回这些字段</div>
      <div class="grid2">
        <div class="panel">
          <div class="field"><label>厂商</label>
            <select id="l-prov">${m.models.map((x) => `<option value="${esc(x.id)}" ${x.id === c.provider ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>端点</label><input id="l-end" value="${esc(c.endpoint)}"></div>
          <div class="field"><label>模型</label><input id="l-model" value="${esc(c.model)}"></div>
          <div class="field"><label>API Key</label><input id="l-key" placeholder="${esc(c.apiKeyMasked || '未配置')}" type="password"></div>
          <div class="field"><label>批次大小</label><input id="l-batch" type="number" value="${c.batchSize}"></div>
          <label><input type="checkbox" id="l-on" ${c.enabled ? 'checked' : ''}> 启用 L3</label>
          <label style="margin-top:8px"><input type="checkbox" id="l-path" ${c.sendPath ? 'checked' : ''}> 发送文件路径给模型（默认关闭，保护隐私）</label>
          <div class="row">
            <button id="l-save">保存</button>
            <button class="btn-ghost" id="l-test">连通性测试</button>
          </div>
        </div>
        <div class="panel">
          <h2 style="margin-top:0">当前状态</h2>
          <table>
            <tr><td>已配置</td><td>${c.configured ? '<span class="tag ok">是</span>' : '<span class="tag warn">否</span>'}</td></tr>
            <tr><td>词表版本</td><td>${esc(c.vocabVersion)}</td></tr>
            <tr><td>Key</td><td class="mono">${esc(c.apiKeyMasked || '—')}</td></tr>
          </table>
          <p style="color:var(--fg2);font-size:12px">
            未配置 Key 时 L3 会自动跳过，扫描任务不会失败（PRD §8.4）。<br>
            词表变更后需点下方按钮重刷旧标签。
          </p>
          <div class="row"><button class="btn-ghost" id="l-rerun">重刷旧标签</button></div>
        </div>
      </div>`;

    document.getElementById('l-save').addEventListener('click', async () => {
      const body = {
        provider: document.getElementById('l-prov').value,
        endpoint: document.getElementById('l-end').value,
        model: document.getElementById('l-model').value,
        batchSize: parseInt(document.getElementById('l-batch').value, 10) || 8,
        enabled: document.getElementById('l-on').checked,
        sendPath: document.getElementById('l-path').checked,
      };
      const key = document.getElementById('l-key').value;
      if (key) body.apiKey = key;
      await api('/api/llm/config', { method: 'PATCH', body: JSON.stringify(body) });
      alert('已保存');
      render();
    });
    document.getElementById('l-test').addEventListener('click', async () => {
      const r = await api('/api/llm/test', { method: 'POST' });
      alert(r.ok ? `可用（${r.latencyMs}ms）` : `不可用：${r.error}`);
    });
    document.getElementById('l-rerun').addEventListener('click', async () => {
      const r = await api('/api/tags/rerun-stale', { method: 'POST', body: JSON.stringify({ limit: 500 }) });
      alert(`已重刷 ${r.queued} 首，跳过锁定 ${r.skippedLocked} 首`);
    });
  }

  /* ---------------- 日志 ---------------- */
  async function logs() {
    const r = await api('/api/scan/logs?tail=500');
    view().innerHTML = `
      <h1>运行日志</h1>
      <div class="sub">最近 ${r.lines.length} 条（内存环形缓冲，最多 2000 条）</div>
      <div class="row">
        <input id="q" placeholder="关键字过滤" style="width:200px">
        <select id="lv"><option value="">全部级别</option><option value="warn">warn 及以上</option><option value="error">仅 error</option></select>
        <button id="go">刷新</button>
      </div>
      <div class="logs" id="box">${(r.lines || []).map((l) => `<div class="${esc(l.level)}">[${esc(l.t)}] [${esc(l.level)}] [${esc(l.mod)}] ${esc(l.msg)}</div>`).join('') || '<div>暂无日志</div>'}</div>`;

    document.getElementById('go').addEventListener('click', async () => {
      const p = new URLSearchParams({ tail: '500', q: document.getElementById('q').value, level: document.getElementById('lv').value });
      const rr = await api('/api/scan/logs?' + p.toString());
      document.getElementById('box').innerHTML = (rr.lines || []).map((l) => `<div class="${esc(l.level)}">[${esc(l.t)}] [${esc(l.level)}] [${esc(l.mod)}] ${esc(l.msg)}</div>`).join('') || '<div>无匹配</div>';
    });
  }

  function fmtDur(s) {
    if (!s) return '—';
    const m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  }

  boot();
})();
