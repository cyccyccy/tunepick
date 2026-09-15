# NAS 音乐元数据刮削服务 · 原型验证（Spike）

**目的：用最小成本回答一个问题——中文车载曲库在公开在线源上的真实命中率是多少？**

本目录**不是产品代码**，是原型验证。不做 Web 界面、不做数据库、不做 Docker、不接 LLM（L3）、不做音频解码。
只做 **L1（内嵌标签 + 目录推断）** 与 **L2（在线刮削）** 的**实测**。

结论见 [`报告-命中率实测.md`](./报告-命中率实测.md)。

---

## 环境要求

- **Node.js ≥ 20**（本环境使用 `C:\Users\Admin\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`，v22.22.2）
- **零依赖**：只用 Node 内置模块（`http` / `fs` / `path` / `child_process`）+ 全局 `fetch`。**不要 `npm install`。**
- 需要能访问 Navidrome：`http://100.82.120.125:4533`

### Windows / Git Bash 注意事项

```bash
# PATH 偶发损坏，每条命令前先修
export PATH="/usr/bin:/bin:/usr/local/bin:$PATH"
```

### 代理（关键，最容易卡住的地方）

| 目标 | 走法 | 原因 |
|---|---|---|
| Navidrome（Tailscale IP） | **必须不走代理** —— 脚本用内置 `http` 模块（不读代理环境变量） | 走代理必然失败 |
| 网易云 / MusicBrainz（公网） | 先用 `fetch` 直连；失败时回落到 `curl`（curl 自动读取 `HTTP_PROXY`/`HTTPS_PROXY`） | 直连通常可用，代理作为兜底 |

`src/util/net.js` 已把这两条路径分开实现，业务代码无需关心。

---

## 运行顺序

```bash
cd nas-music-scraper/prototype

node src/00-probe.js            # 1. 环境自检：gb18030 还原、各源可达性
node src/01-fetch-catalog.js    # 2. 拉全库快照 -> data/catalog.json（已缓存则跳过，--refresh 强制重拉）
node src/02-analyze-l1.js       # 3. L1 全库统计 -> data/l1-report.json
node src/03-sample.js           # 4. 分层抽样 100 首 -> data/sample-100.json
node src/04-run-l2.js           # 5. L2 抓取 -> data/result.json（可中断续跑；--replay 清空重跑）
node src/06-audit.js            # 6. 定性审计 -> data/qualitative-audit.json（命中的歌手可信度 / 未命中归因 / 伪歌手）
node src/05-gen-report.js       # 7. 生成报告 -> 报告-命中率实测.md
```

辅助脚本与常用开关：

```bash
node src/01b-verify-total.js               # 核查 2903 / 3392 / 3488 三个数字哪个对
node src/04-run-l2.js --only=5 --replay    # 冒烟测试：只跑前 5 首
node src/04-run-l2.js --netease-only       # 只重跑网易云（复用已缓存的 MusicBrainz 结果）
node src/04-run-l2.js --mb-only            # 只重跑 MusicBrainz
node src/04-run-l2.js --rescore            # 离线重算评分（无网络，用于改完匹配规则后复算）
```

> `--rescore` 只能在前 5 个候选内重排（持久化时只保留 top-5），改了规则又想完整复算请直接 `--replay` 重跑。

---

## 限速（硬性，宁慢不封）

| 源 | 限制 | 脚本实现 |
|---|---|---|
| MusicBrainz | **≤ 1 请求/秒**（官方规定，超限封 IP），**必须**带真实 User-Agent | `RateLimiter(1200ms)` |
| 网易云音乐 | ≤ 2 QPS | `RateLimiter(600ms)` |

单请求超时 15 s。全量 100 首实测约 6–8 分钟（含限速等待）。

---

## 文件结构

```
prototype/
├── package.json
├── README.md
├── 报告-命中率实测.md          # ★ 最终交付物
├── src/
│   ├── 00-probe.js             # 环境自检
│   ├── 01-fetch-catalog.js     # 拉取 Navidrome 全库
│   ├── 01b-verify-total.js     # 曲库总数交叉核对
│   ├── 02-analyze-l1.js        # L1 全库分析
│   ├── 03-sample.js            # 分层抽样
│   ├── 04-run-l2.js            # L2 抓取（核心）+ --rescore 离线复算
│   ├── 05-gen-report.js        # 报告生成
│   ├── 06-audit.js             # 定性审计（命中可信度 / 未命中归因 / 伪歌手）
│   ├── match.js                # 候选匹配与 strict/relaxed 双档评分
│   └── util/
│       ├── encoding.js         # GBK-as-Latin-1 乱码检测与无损还原
│       ├── text.js             # 归一化、广告串识别、标题拆分、相似度
│       └── net.js              # 网络：http（无代理）/ fetch+curl（公网）
└── data/                       # 全部实测产出（可重建）
```

---

## 核心实现要点

### 乱码无损还原（`util/encoding.js`）

本库的"乱码"不是数据损坏，是 **GBK 字节被当成 Latin-1 解码**：

```js
const fixed = new TextDecoder('gb18030').decode(Buffer.from(broken, 'latin1'));
```

判定规则（保守，避免误伤正常标签）：

1. U+00A0–U+00FF 区间的字符 ≥ 2 个（一个 GBK 汉字 = 2 个这样的字节）；
2. 整串所有码点 ≤ 0xFF（否则混合内容会被破坏而非还原）；
3. 还原后 CJK 字符数必须**严格增加**，且不产生 U+FFFD 替换符。

### strict / relaxed 双档评分（`match.js`）

- **strict**：`0.6×曲名相似 + 0.4×歌手相似`，要求歌手佐证标题 —— 高精度，代表"可安全写库"的命中率。
- **relaxed**：`曲名相似 × 时长系数` —— 代表"标题 + 时长"口径的理论上限。

两档同时输出，是为了量化**精度/召回权衡**，而不是用宽松口径把命中率做好看。

### 时长交叉校验

本地 `duration`（秒）vs 网易云 `duration`（毫秒 ÷ 1000）：
`|Δ| ≤ 15s` 不罚、`≤ 30s` 罚 0.85、`> 30s` 判版本冲突（分数封顶 0.5）。

---

## 数据重建

`data/` 下所有文件都可由脚本重建。`data/catalog.json` 是 Navidrome 快照缓存，
重复运行不会重新拉取（除非加 `--refresh`），因此全流程在断网时也能复算 L1 与报告。
`data/result.json` 支持断点续跑：已完成的曲目会被跳过。
