# TunePick · NAS 音乐元数据刮削服务

> 读取挂载目录下的音乐文件 → 自动刮削出完整元数据（歌手、年代、专辑、歌词、流派、场景、封面、简介）
> → 提供 REST API + Web 管理界面。**原始音频文件严格只读，绝不改写。**

零第三方依赖（仅 Node 内置模块 + 全局 fetch），单容器，内存限 512MB~1GB。

---

## 一、快速开始（Docker Compose，推荐）

```bash
# 1. 配置（复制后按需修改）
cp .env.example .env
# 至少设置：AUTH_TOKEN、ADMIN_PASSWORD、LLM_API_KEY

# 2. 把音乐目录改成你 NAS 上的真实路径（编辑 docker-compose.yml 的 volumes）
#    - /volume1/music:/music:ro   ← 改成你的路径，务必保留 :ro

# 3. 构建并启动
docker compose up -d

# 4. 打开管理界面
#    http://<NAS-IP>:8090
```

首次使用流程：概览页 → **抽样试跑（100 首）** → 看质量报告 → 确认后跑全量。

## 一·B、GitHub Actions 自动构建 → GHCR（NAS 零构建，推荐）

代码推到 GitHub 后，Actions 会自动构建 `linux/amd64` + `linux/arm64` 双架构镜像并推到 GHCR。
**NAS 上不用装 git、不用构建，只需拉镜像。**

```bash
# —— 一次性配置 ——
# 1) GitHub 网页新建私有仓库，把本项目推上去（需先 git init，见下方"上传代码"）
# 2) Actions 跑完后，在 NAS 上登录一次 GHCR（私有镜像需要）
echo <GHCR_TOKEN> | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
#    token 获取：GitHub → Settings → Developer settings → Personal access tokens
#              → Tokens(classic) → 勾选 read:packages

# 3) 编辑 docker-compose.ghcr.yml：把 <OWNER> 换成你的 GitHub 用户名（小写），
#    把 /volume1/music 换成真实音乐目录

# 4) 启动
docker compose -f docker-compose.ghcr.yml up -d

# —— 以后更新（一条命令）——
docker compose -f docker-compose.ghcr.yml pull && docker compose -f docker-compose.ghcr.yml up -d
```

### 上传代码到 GitHub

本机若已装 git：

```bash
git init
git add .
git commit -m "feat: TunePick 首版（L1+L2+L3 刮削 / REST API / Web 管理界面）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/tunepick.git
git push -u origin main
```

> ⚠️ `.gitignore` 已排除 `.env`（含 NAS 密码与 LLM Key）、`data/`、`tests/fixtures/music/`
> （真实音频，有版权）、`prototype/data/`。**推送前请确认这些目录未被加入。**
> 若误提交，用 `git rm --cached <路径>` 移除并重新提交。

未装 git 时：在 GitHub 仓库页用 "Add file → Upload files" 上传即可（先按上面清单自查）。

## 二、docker run（不用 compose）

```bash
docker build -t tunepick:latest .

docker run -d --name tunepick \
  -p 8090:8090 \
  -v /volume1/music:/music:ro \
  -v $(pwd)/data:/data \
  -e AUTH_TOKEN=你的令牌 \
  -e ADMIN_USER=admin \
  -e ADMIN_PASSWORD=你的密码 \
  -e SOURCE_KIND=localfs \
  -e ONLINE_SOURCES=netease,caa \
  -e LLM_API_KEY=你的Key \
  -e LLM_MODEL=deepseek-flash \
  --memory=1g --cpus=1 \
  --restart unless-stopped \
  tunepick:latest
```

## 三、关键环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `SOURCE_KIND` | `localfs` | ⚠️ 只能是 `localfs` 或 `navidrome`。**写成 `local-fs` 会启动失败**（故意的，避免只读自检被静默跳过） |
| `MUSIC_DIR` | `/music` | 音乐目录，**必须只读挂载** |
| `DATA_DIR` | `/data` | 自己的数据库与封面缓存，必须可写 |
| `AUTH_TOKEN` | 空 | 为空时**仅允许 127.0.0.1 访问**并在界面告警（不拒启） |
| `ONLINE_SOURCES` | `netease,caa` | 在线源唯一开关，逗号分隔。⚠️ 不存在 `NETEASE_ENABLED` 等单独变量 |
| `ONLINE_ENABLED` | `true` | 总开关，`false` = 完全不访问外网 |
| `LLM_API_KEY` | 空 | 为空时自动降级为只跑 L1+L2 |
| `LLM_MAX_TOKENS` | `16384` | ⚠️ 推理模型会先把 token 消耗在推理上，给不足则 `content` 为空导致打标失败 |

完整清单见 `.env.example`。

## 四、不用 Docker，怎么真机验证？

Docker 只是交付方式，**验证不依赖它**。按"从轻到重"三种方式：

### 方式 A：先用 Navidrome 源跑通全链路（零部署，最快）

不需要访问 NAS 文件系统，只要能连上 Navidrome API：

```bash
export SOURCE_KIND=navidrome
export NAVIDROME_URL=http://<NAS内网或Tailscale IP>:4533
export NAVIDROME_USER=<用户名> NAVIDROME_PASS=<密码>
node src/server.js
```

这样 L1 / L2 / L3 / API / Web 界面全部可验证，只是文件来源换成 Subsonic API。

### 方式 B：把 `probe-dir.js` 拷到 NAS 上跑（只读，最安全）

只需 NAS 上有 Node，**不改任何文件、不写任何数据**：

```bash
node scripts/probe-dir.js /volume1/music 20
```

输出：目录结构探测报告（层级深度分布 / 疑似歌手目录数 / 扁平占比）+ 标签解析实测
（各字段可用率、乱码率、广告率）。用来确认「扫描 + 标签解析」在你的真实文件上是否正常。

> 注：该脚本打印的是**原始标签**。若 title 为空属正常——L1 会用文件名兜底（曲库里
> 大量 `Mojito-周杰伦` 就来自文件名）。

### 方式 C：直接在 NAS 上裸跑（不打包镜像）

若飞牛自带 Node（≥18）：

```bash
node src/server.js   # 环境变量同第三节
```

行为与容器内完全一致。

### 方式 D：本地用真实文件验证（已做过）

从 NAS 下载几首真实音频到本地目录，用 `SOURCE_KIND=localfs` 指向它即可完整验证
扫描 → 标签解析 → L1 → 目录推断 链路。本项目的 `tests/fixtures/music/` 就是用这种方式建的。

## 五、排错

| 现象 | 原因与处理 |
|---|---|
| 启动即退，报 `未知的 SOURCE_KIND` | 拼写错，正确值是 `localfs`（无连字符） |
| 启动即退，报音乐目录可写 | 只读挂载没生效，检查 volumes 是否带 `:ro` |
| 封面全是同一张水印图 | Navidrome 源 99.5% 的 `coverArt` 是占位图；本服务已按内容 hash 去重 + 假图名单处理，用 `localfs` 源不受影响 |
| L3 打标返回空 | 推理模型 token 被推理吃光，调大 `LLM_MAX_TOKENS` |
| 命中率明显偏低 | 确认乱码还原生效（L2 的前置必要条件）；否则查询词本身是乱码，命中趋近 0 |
| 全库扫描很慢 | 去掉 `ONLINE_SOURCES` 里的 `musicbrainz`（对中文曲库命中仅 28~33%，却占约 4/5 耗时） |

## 六、实测基线（2903 首真实脏数据）

| 指标 | 仅 L1+L2 | 加 L3 |
|---|---|---|
| L2 命中率 | 63%~75% | — |
| 歌词 | 62%~83% | — |
| 封面 | 100% | — |
| 年代 | 41.7% | **75%** |
| 流派 | ≈0% | **62.5%** |
| 情绪 | 0% | **100%** |
| 场景 | 0% | **75%** |

> 流派 / 情绪 / 场景在线源根本不返回，**只能靠 L3**。

## 七、不做的事

不转码、不解码（无 BPM / 声学指纹）、不改写原文件、不做用户账号体系、不提供音乐下载。
`/api/stream/:id` 仅做**只读文件直通**（支持 Range），不做播放编排。
