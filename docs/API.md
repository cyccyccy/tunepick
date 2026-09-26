# TunePick 对外开放 API v1.0

面向外部应用 / 服务器调用的稳定接口。覆盖一首 App 需要的全部能力：首页聚合、曲目、专辑、歌手、风格、歌单、搜索、收藏、播放历史、封面、音频流、歌词。

- **Base URL**：`http://<服务地址>:<端口>`，例：`http://192.168.2.107:8091`
- **鉴权**：所有 `/api/v1/*` 需 `Authorization: Bearer <TOKEN>`（`<TOKEN>` = 部署时配置的 `AUTH_TOKEN`）。缺省或错误 → `401`
- **编码**：请求与响应统一 UTF-8；路径中的中文请 URL 编码
- **稳定性**：`/api/v1/*` 一旦发布不再更改字段语义；内部 Schema 演进不对外暴露。旧版 `/api/*` 端点（见第 9 节）继续保留

> 文档中的 `<TOKEN>` 请替换为你自己的令牌，**不要提交或分享**。

---

## 1. 通用约定

### 1.1 响应包

成功：

```json
{ "ok": true, "data": { } }
```

列表统一（凡可能返回多条的接口，`data` 都是这个形状）：

```json
{
  "ok": true,
  "data": {
    "items": [ ],
    "pagination": { "total": 2906, "limit": 30, "offset": 0, "page": 1, "hasMore": true }
  }
}
```

失败：

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "曲目不存在：tp_xxx" } }
```

判断逻辑：**先看 HTTP 状态码，再看 `ok` 字段，永不以某个字段是否存在来判断成败。**

### 1.2 分页（所有列表接口一致）

| 参数 | 默认 | 说明 |
|---|---|---|
| `limit` | `30` | 每页条数，范围 `1..200`，超范围自动钳位（`<1` → 1，`>200` → 200） |
| `offset` | `0` | 偏移量，从 0 起 |
| `page` | — | 1 起的页码。**给了 `page` 就覆盖 `offset`**：`offset = (page-1) × limit` |

响应里的 `pagination`：

| 字段 | 说明 |
|---|---|
| `total` | 符合条件的**总条数**（不是本页条数） |
| `limit` | 本次实际生效的每页条数 |
| `offset` | 本次实际生效的偏移量 |
| `page` | 当前页码（1 起） |
| `hasMore` | 是否还有下一页。`offset + 本页条数 < total` 时为 `true` |

越界行为：翻过末尾返回 `200` + `items: []`，**不会报错**，因此循环翻页到 `hasMore === false` 或 `items` 为空即可停止。

### 1.3 曲目对象 `trackLite`

列表类接口统一返回这个精简视图（不含歌词正文、歌手简介等大字段）：

```json
{
  "id": "tp_0f1c2e3a4b5c",
  "title": "晴天",
  "artist": "周杰伦",
  "album": "叶惠美",
  "albumTitle": "叶惠美",
  "year": 2003,
  "durationSec": 269,
  "trackNo": 3,
  "format": "FLAC",
  "bitrate": 921,
  "genre": "流行",
  "mood": ["温暖", "怀旧"],
  "scene": ["深夜驾驶", "独处"],
  "lang": "国语",
  "era": "2000s",
  "coverUrl": "/api/cover/cv_8a7b6c5d4e3f?size=300",
  "streamUrl": "/api/stream/tp_0f1c2e3a4b5c",
  "lyricUrl": "/api/track/tp_0f1c2e3a4b5c/lyric",
  "addedAt": "2026-09-14T10:22:31.000Z",
  "updatedAt": "2026-09-14T10:22:31.000Z"
}
```

`coverUrl` / `streamUrl` / `lyricUrl` 是相对路径，拼接 Base URL 即可访问（`coverUrl` / `streamUrl` 同样需要带令牌）。
`曲目详情`接口在上表基础上追加：`fileName`、`fileSizeBytes`、`sampleRate`、`confidence`、`qualityLevel`、`lyricsSource`、`coverSource`。

### 1.4 错误码

| HTTP | code | 含义 | 处理建议 |
|---|---|---|---|
| `401` | —（包体可能为空） | 缺令牌 / 令牌错 | 检查 `Authorization` 头 |
| `400` | `MISSING_QUERY` | 搜索接口缺 `q` | 补关键词 |
| `400` | `INVALID_PARAM` | 参数非法（如 POST body 非 JSON） | 检查参数 |
| `400` | `CACHE_EXPIRED` | 搜索结果缓存过期（试听/下载的 key 失效） | 重新搜索拿新 key |
| `404` | `NOT_FOUND` | 曲目 / 专辑 / 歌手 / 歌单不存在，或路径不存在 | 数据可能被重新扫描换 id，重新拉取列表 |
| `500` | `SERVER_ERROR` | 服务异常 | 重试 + 告警 |
| `502` | `UPSTREAM_ERROR` | 上游（SqMusic/音乐源）异常或未返回数据 | 稍后重试 |
| `503` | `SQMUSIC_DISABLED` | 搜歌下载集成未启用 | 需在服务端配置后使用 |

---

## 2. 快速上手

**curl**

```bash
curl -s "http://192.168.2.107:8091/api/v1/tracks?limit=5" \
  -H "Authorization: Bearer <TOKEN>"
```

**JavaScript（浏览器 / Node ≥18）**

```js
const BASE = 'http://192.168.2.107:8091';
const TOKEN = '<TOKEN>';

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error.code + ': ' + body.error.message);
  return body.data;
}

const tracks = await api('/api/v1/tracks?limit=20&sort=recentAdded');
console.log(tracks.total, tracks.items.map(t => t.title));
```

**Python**

```python
import requests

BASE = "http://192.168.2.107:8091"
TOKEN = "<TOKEN>"
H = {"Authorization": f"Bearer {TOKEN}"}

def api(path, **kwargs):
    r = requests.get(BASE + path, headers=H, timeout=10, **kwargs)
    r.raise_for_status()
    body = r.json()
    if not body.get("ok"):
        raise RuntimeError(body.get("error"))
    return body["data"]

d = api("/api/v1/tracks", params={"limit": 20})
print(d["pagination"]["total"], [t["title"] for t in d["items"]])
```

---

## 3. 接口清单

| # | 方法 | 路径 | 说明 | 分页 |
|---|---|---|---|---|
| 1 | GET | `/api/v1/home` | 首页聚合（随机/最近添加/最近播放/收藏/最近专辑/统计） | 否（内部截断） |
| 2 | GET | `/api/v1/tracks` | 曲目列表（多维过滤 + 排序 + 随机） | ✅ |
| 3 | GET | `/api/v1/tracks/:id` | 曲目详情 | — |
| 4 | GET | `/api/v1/albums` | 专辑列表 | ✅ |
| 5 | GET | `/api/v1/albums/:id` | 专辑详情 + 曲目 | ✅ |
| 6 | GET | `/api/v1/artists` | 歌手列表 | ✅ |
| 7 | GET | `/api/v1/artists/:id` | 歌手详情 + 曲目 | ✅ |
| 8 | GET | `/api/v1/genres` | 风格列表（含曲目数） | ✅ |
| 9 | GET | `/api/v1/genres/:value/tracks` | 某风格的曲目 | ✅ |
| 10 | GET | `/api/v1/playlists` | 系统歌单列表（按情绪/场景/流派自动生成） | ✅ |
| 11 | GET | `/api/v1/playlists/:id` | 歌单详情 + 曲目 | ✅ |
| 12 | GET | `/api/v1/search` | 统一搜索（歌曲/歌手/专辑/歌单） | 分类型可选 |
| 13 | GET | `/api/v1/favorites` | 收藏列表 | ✅ |
| 14 | GET | `/api/v1/favorites/:trackId` | 查询某首是否收藏 | — |
| 15 | PUT | `/api/v1/favorites/:trackId` | 加入收藏 | — |
| 16 | DELETE | `/api/v1/favorites/:trackId` | 取消收藏（幂等） | — |
| 17 | POST | `/api/v1/history` | 上报一条播放记录 | — |
| 18 | GET | `/api/v1/history` | 最近播放（去重）/ 原始流水 | ✅ |
| 19 | DELETE | `/api/v1/history` | 清空播放历史 | — |
| 20 | GET | `/api/v1/facets` | 标签维度聚合（情绪/场景/流派/语言/年代） | 否 |
| 21 | GET | `/api/v1/stats` | 曲库统计 | — |
| 22 | GET | `/api/v1/sqmusic/status` | 搜歌下载集成状态 + 下载目录 | — |
| 23 | POST | `/api/v1/sqmusic/search` | 在线搜歌（多音源，返回试听/下载凭据） | ✅ |
| 24 | POST | `/api/v1/sqmusic/preview` | 获取试听直链（带时间签名） | — |
| 25 | POST | `/api/v1/sqmusic/download` | 下发下载任务（完成后自动/手动入库） | — |
| 26 | GET | `/api/v1/sqmusic/tasks` | 下载任务列表（状态/估算大小/速度/耗时） | ✅ |
| 27 | GET | `/api/v1/sqmusic/downloaded` | 已下载列表（含是否已入库） | ✅ |
| 28 | POST | `/api/v1/sqmusic/rescan` | 触发增量扫描（把已下载文件补进曲库） | — |
| 29 | POST | `/api/v1/sqmusic/test` | SqMusic 连通性自检 | — |
| 30 | GET | `/api/cover/:coverId` | 封面图（`?size=`） | — |
| 31 | GET | `/api/stream/:trackId` | 音频流（支持 Range） | — |
| 32 | GET | `/api/track/:trackId/lyric` | 歌词（纯文本） | — |

> 未启用搜歌下载（`SQ_ENABLED=false`）时，除 `status` 外的 `/api/v1/sqmusic/*` 一律返回 `503 SQMUSIC_DISABLED`。

---

## 4. 接口详解

### 4.1 首页聚合 `GET /api/v1/home`

一次请求拿到首页全部区块。

| 参数 | 默认 | 说明 |
|---|---|---|
| `limit` | `6` | 随机 / 最近添加 / 最近播放 / 收藏区块各取几条（1..200） |
| `albumLimit` | `12` | 最近添加专辑取几条（1..200） |
| `seed` | 随机 | 随机漫游的种子，见 4.2 |

```json
{
  "ok": true,
  "data": {
    "random": [ { "id": "tp_…", "title": "…" } ],
    "recentAdded": [ { "id": "tp_…", "title": "…" } ],
    "recentPlayed": { "items": [ { "id": "tp_…", "title": "…" } ], "total": 12 },
    "favorites": { "count": 37, "items": [ { "id": "tp_…", "favoritedAt": "2026-09-14T…" } ] },
    "recentAlbums": [ { "id": "al_1a2b3c", "title": "叶惠美", "trackCount": 11, "coverUrl": "…", "addedAt": "…" } ],
    "stats": { "tracks": 2906, "albums": 128, "artists": 94, "favorites": 37, "plays": 214 }
  }
}
```

### 4.2 曲目列表 `GET /api/v1/tracks`

| 参数 | 说明 |
|---|---|
| `q` | 关键词，匹配歌名 / 歌手 / 专辑（子串，不区分大小写） |
| `artist` | 歌手精确匹配 |
| `album` | 专辑精确匹配 |
| `genre` / `mood` / `scene` / `lang` / `era` | 按标签维度过滤，取值见 `/api/v1/facets` |
| `albumGroup` | `real`（真实专辑）/ `unknown` |
| `sort` | `title`(默认) / `artist` / `album` / `year` / `duration` / `added`（入库时间）/ `updated` / `random` |
| `order` | `asc`(默认) / `desc` |
| `seed` | `sort=random` 时的随机种子 |
| `limit` / `offset` / `page` | 分页 |

**随机漫游**：`sort=random&seed=<任意字符串>` —— **同一 seed 必得同一顺序**，App 翻页 / 刷新才不会跳；不给 seed 则每次都不一样。

```bash
curl -s "http://192.168.2.107:8091/api/v1/tracks?sort=random&seed=morning&limit=20" -H "Authorization: Bearer <TOKEN>"
curl -s "http://192.168.2.107:8091/api/v1/tracks?genre=%E6%B5%81%E8%A1%8C&sort=year&order=desc&limit=20" -H "Authorization: Bearer <TOKEN>"
```

### 4.3 曲目详情 `GET /api/v1/tracks/:id`

`:id` 支持三种写法，按此顺序解析：**新 id → 旧系统 id 别名 → `时长|文件名` 兜底**。不存在返回 `404 NOT_FOUND`。

### 4.4 专辑列表 `GET /api/v1/albums`

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | 专辑名 / 歌手子串匹配 |
| `artist` | — | 歌手精确匹配 |
| `include` | `all` | `real` 只返回刮削确认过的真实专辑；`all` 含「未知专辑」聚合组 |
| `sort` | `tracks` | `tracks`(曲数) / `added`(最近添加) / `year` / `title` |
| `order` | `desc` | `asc` / `desc` |

返回 `albumLite`：`{ id, title, artist, year, trackCount, coverUrl, albumGroup, addedAt }`。专辑 id（`al_...`）与旧接口 `/api/albums` 同源同值，两套 id 可混用。

### 4.5 专辑详情 `GET /api/v1/albums/:id`

返回 `{ album: albumLite, items: trackLite[], pagination }`。默认按 `trackNo` 升序，可用 `sort` / `order` 覆盖。

### 4.6 歌手列表 `GET /api/v1/artists`

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | — | 歌手名子串 |
| `sort` | `tracks` | `tracks`(曲目数) / `name` |
| `order` | `desc` | — |

返回 `artistLite`：`{ id: "ar_<hash>", name, trackCount, albumCount, coverUrl }`。歌名为空 / 伪值（如 `Unknown Artist`）的曲目不参与聚合。

### 4.7 歌手详情 `GET /api/v1/artists/:id`

返回 `{ artist: artistLite, items: trackLite[], pagination }`，默认曲名升序。

### 4.8 风格 `GET /api/v1/genres`

返回 `[{ value: "流行", count: 812, coverUrl: "…" }]`，按曲目数降序，总数见 `pagination.total`。

### 4.9 风格曲目 `GET /api/v1/genres/:value/tracks`

返回 `{ genre: "流行", items: trackLite[], pagination }`。`:value` 需 URL 编码。

### 4.10 系统歌单 `GET /api/v1/playlists`

按情绪 / 场景 / 流派自动生成的只读歌单。**阈值规则**：某标签下曲目数 ≥ 3 才会成单（低于阈值的标签不出现在列表里，属预期行为）。

返回 `[{ id: "sys_genre_流行", title: "流行 · 812 首", trackCount: 812, coverUrl: "", system: true, dimension: "genre", value: "流行" }]`。

### 4.11 歌单详情 `GET /api/v1/playlists/:id`

返回 `{ playlist: {…}, items: trackLite[], pagination }`。歌单 id 含中文（如 `sys_scene_深夜驾驶`），调用时务必 `encodeURIComponent`。

### 4.12 统一搜索 `GET /api/v1/search`

| 参数 | 默认 | 说明 |
|---|---|---|
| `q` | **必填** | 关键词，缺失返回 `400 MISSING_QUERY` |
| `type` | `all` | `all` / `track` / `artist` / `album` / `playlist` |
| `limit` / `offset` / `page` | — | **仅 `type` 为单值时生效** |

`type=all`（用作搜索建议页）：返回四组概览，自带 `total`，各段仅截断前若干条，**不做分页**：

```json
{
  "ok": true,
  "data": {
    "query": "晴天",
    "tracks":   { "total": 14, "items": [ …最多 10 条… ] },
    "artists":  { "total": 1,  "items": [ …最多 8 条… ] },
    "albums":   { "total": 2,  "items": [ …最多 8 条… ] },
    "playlists":{ "total": 0,  "items": [ …最多 8 条… ] }
  }
}
```

`type=track|artist|album|playlist`：返回 `{ query, type, items, pagination }`，**完整支持分页**（用于「查看全部 N 条结果」）。

### 4.13 收藏

```bash
# 加入收藏（曲目不存在 → 404）
curl -X PUT "http://192.168.2.107:8091/api/v1/favorites/tp_0f1c2e3a4b5c" -H "Authorization: Bearer <TOKEN>"
# → { "ok": true, "data": { "favorited": true, "count": 38 } }

# 查询单首
curl "http://192.168.2.107:8091/api/v1/favorites/tp_0f1c2e3a4b5c" -H "Authorization: Bearer <TOKEN>"
# → { "ok": true, "data": { "favorited": true, "count": 38 } }

# 收藏列表（按收藏时间倒序）
curl "http://192.168.2.107:8091/api/v1/favorites?limit=20&page=2" -H "Authorization: Bearer <TOKEN>"

# 取消收藏（幂等：已不在收藏中也返回 200）
curl -X DELETE "http://192.168.2.107:8091/api/v1/favorites/tp_0f1c2e3a4b5c" -H "Authorization: Bearer <TOKEN>"
# → { "ok": true, "data": { "favorited": false, "count": 37 } }
```

语义要点：

- 重复 `PUT` 同一首：`count` 不增，保留**首次**收藏时间 `favoritedAt`
- 列表返回的曲目都带 `favoritedAt`
- 曲库里已不存在的收藏记录会被**自动跳过**，不计入 `total`（重新扫描换 id 后不会出现脏数据）

### 4.14 播放历史

```bash
# 上报一次播放（曲目不存在 → 404；body 非 JSON → 400）
curl -X POST "http://192.168.2.107:8091/api/v1/history" \
  -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  -d '{"trackId":"tp_0f1c2e3a4b5c","durationSec":269}'
# → { "ok": true, "data": { "plays": 215, "latest": "2026-09-19T01:02:03.000Z" } }

# 最近播放（按曲目去重，带播放次数）
curl "http://192.168.2.107:8091/api/v1/history?scope=distinct&limit=20" -H "Authorization: Bearer <TOKEN>"

# 原始流水（每次播放一条）
curl "http://192.168.2.107:8091/api/v1/history?scope=raw&limit=50" -H "Authorization: Bearer <TOKEN>"

# 清空
curl -X DELETE "http://192.168.2.107:8091/api/v1/history" -H "Authorization: Bearer <TOKEN>"
```

- 建议播放**开始**时上报一次即可，`durationSec` 可省略
- 历史上限 5000 条，超出自动丢弃最旧记录
- App 的「最近播放」页用 `scope=distinct`（默认）

### 4.15 标签维度 `GET /api/v1/facets`

```json
{
  "ok": true,
  "data": {
    "mood":  [{ "value": "温暖", "count": 421 }],
    "scene": [{ "value": "深夜驾驶", "count": 188 }],
    "genre": [{ "value": "流行", "count": 812 }],
    "lang":  [{ "value": "国语", "count": 1402 }],
    "era":   [{ "value": "2000s", "count": 906 }]
  }
}
```

用作筛选器 / 标签云的数据源；取值可直接喂给 `/api/v1/tracks?genre=…&mood=…`。

### 4.16 统计 `GET /api/v1/stats`

```json
{ "ok": true, "data": { "tracks": 2906, "albums": 128, "artists": 94, "genres": 15, "favorites": 37, "plays": 214, "needReview": 1447 } }
```

---

### 4.17 搜歌下载（在线搜索 → 试听 → 下载 → 自动入库）

> 依赖服务端配置 SqMusic 集成（`SQ_ENABLED=true`）。整条链路：**搜索拿 `key` → 试听/下载都用 `key` → 下载完成后轮询任务状态 → 已完成的文件自动增量入库（或手动 `rescan`）→ 从 `/api/v1/sqmusic/downloaded` 拿到 `trackId` 后用 `/api/stream/:trackId` 播放。**

**① 状态与下载目录 `GET /api/v1/sqmusic/status`**

```json
{ "ok": true, "data": {
  "enabled": true, "baseUrl": "http://sqmusic:8099", "loggedIn": true,
  "plugins": ["kw"], "pluginLabels": { "kw": "酷狗" }, "brType": "kw_mp3_320",
  "autoScan": true, "downloadPath": "/vol1/@appshare/navidrome/music", "downloadPathError": "" } }
```

**② 在线搜索 `POST /api/v1/sqmusic/search`**

```json
// 请求体
{ "q": "十一年", "plugName": "kw", "limit": 20, "offset": 0 }
```

```json
// 响应 data（分页与其它列表一致）
{ "query": "十一年", "plugName": "kw", "pluginLabel": "酷狗",
  "items": [ {
    "key": "kw:1042xxx",            // ★ 试听/下载的凭据，原样回传
    "songId": "1042xxx",
    "title": "十一年", "name": "十一年",
    "artist": "邱永传", "artists": ["邱永传"],
    "album": "十一年", "albumId": "123",
    "coverUrl": "http://…/cover.jpg",
    "durationSec": 254,
    "brTypes": ["kw_mp3_128", "kw_mp3_320", "kw_flac_2000"],
    "defaultBrType": "kw_mp3_320",
    "plugName": "kw", "hasLyric": true
  } ],
  "pagination": { "total": 3584, "limit": 20, "offset": 0, "page": 1, "hasMore": true } }
```

**③ 试听 `POST /api/v1/sqmusic/preview`**

```json
// 请求体：{ "key": "kw:1042xxx", "brType": "kw_mp3_320" }
{ "ok": true, "data": { "url": "http://…(带时间签名的直链)", "brType": "kw_mp3_320",
  "bit": "320", "name": "十一年", "artist": "邱永传", "key": "kw:1042xxx",
  "ttlHint": "直链带时间签名会过期，失效后重新获取" } }
```

`url` 直接喂给播放器即可。直链有时效，过期（`400 CACHE_EXPIRED`）就重新拿。

**④ 下载 `POST /api/v1/sqmusic/download`**

```json
// 请求体：{ "key": "kw:1042xxx", "brType": "kw_flac_2000" }
{ "ok": true, "data": { "accepted": true, "key": "kw:1042xxx", "brType": "kw_flac_2000",
  "hint": "下载完成后的入库：轮询 tasks 或调用 rescan" } }
```

`brType` 省略时用该曲目的 `defaultBrType`。**SqMusic 不提供真实进度**，任务状态只有 等待/下载中/完成/失败，大小与速度是按「码率×时长」的估算值。

**⑤ 任务列表 `GET /api/v1/sqmusic/tasks?limit=20&status=running`**

```json
{ "ok": true, "data": {
  "counts": { "waiting": 0, "running": 1, "success": 3, "error": 0 },
  "autoScan": { "enabled": true },
  "items": [ { "id": "…", "title": "断桥残雪", "name": "断桥残雪", "artist": "许嵩",
    "album": "许嵩早期单曲集", "brType": "kw_flac_2000", "status": "success", "progress": 100,
    "sizeBytesEst": 56937554, "elapsedSec": 5, "speedBpsEst": 11320000,
    "downloadedAt": "09-22 00:50", "message": "" } ],
  "pagination": { "total": 4, "limit": 20, "offset": 0, "page": 1, "hasMore": false } } }
```

`status` 可选 `waiting | running | success | error`。**建议下载后每 2~3 秒轮询一次本接口**：服务端发现「新完成的任务」会自动触发一次增量扫描（`autoScan.enabled=true` 时），把新文件补进曲库。

**⑥ 已下载列表 `GET /api/v1/sqmusic/downloaded?limit=20`**

```json
{ "ok": true, "data": {
  "counts": { "total": 3, "inLibrary": 3, "notInLibrary": 0 },
  "downloadPath": "/vol1/@appshare/navidrome/music", "downloadPathError": "",
  "items": [ { "id": "…", "title": "断桥残雪", "artist": "许嵩", "album": "许嵩早期单曲集",
    "brType": "kw_flac_2000", "downloadedAt": "09-22 00:50",
    "inLibrary": true, "trackId": "tp_3f2a…", "filePath": "music/许嵩/…/许嵩.flac",
    "fileSizeBytes": 56712345, "streamUrl": "/api/stream/tp_3f2a…", "coverUrl": "/api/cover/cv_…?size=300" } ],
  "pagination": { "total": 3, "limit": 20, "offset": 0, "page": 1, "hasMore": false } } }
```

- `inLibrary=true` 时可直接用 `streamUrl` 播放、`coverUrl` 显示封面
- 参数 `all=0` 可切到「只查当前页」模式（此时 `inLibrary/notInLibrary` 仅统计本页）；`q` 支持歌名/歌手/专辑子串过滤
- 全量统计默认开启（`all=1`），上限 500 条

**⑦ 手动入库 `POST /api/v1/sqmusic/rescan`**

```json
{ "ok": true, "data": { "started": true, "taskId": "scan_…" } }
```

已在扫描中时返回 `started:false` + 原因（仍是 200）。扫描只**补充**标签（保护已内嵌字段），不会覆盖。

**⑧ 连通性自检 `POST /api/v1/sqmusic/test`**

```json
{ "ok": true, "data": { "ok": true, "latencyMs": 31, "baseUrl": "http://sqmusic:8099" } }
```

**完整调用示例（搜到并下载、等到入库、拿到播放地址）**

```js
const BASE = 'http://192.168.2.107:8091', TOKEN = '<TOKEN>';
const api = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await r.json()).data;
};

// 1) 搜歌
const hits = await api('/api/v1/sqmusic/search', { q: '十一年', plugName: 'kw' });
const song = hits.items[0];

// 2) 试听（可选）
const pv = await api('/api/v1/sqmusic/preview', { key: song.key });
console.log('试听直链：', pv.url);

// 3) 下载
await api('/api/v1/sqmusic/download', { key: song.key, brType: song.defaultBrType });

// 4) 轮询任务直到完成（每 2s 一次）
let done;
for (;;) {
  const t = await api('/api/v1/sqmusic/tasks?status=success&limit=10');
  done = t.items.find(x => x.title === song.title && x.artist === song.artist);
  if (done) break;
  await new Promise(r => setTimeout(r, 2000));
}

// 5) 拿入库结果并播放（autoScan 开启时通常已完成入库；未入库则调 rescan 等一会）
let dl = (await api('/api/v1/sqmusic/downloaded?limit=50')).items.find(x => x.inLibrary && x.title === song.title);
if (!dl) { await api('/api/v1/sqmusic/rescan'); /* 稍后重查 */ }
console.log('播放：', BASE + dl.streamUrl);
```

---

## 5. 媒体接口


| 用途 | 路径 | 说明 |
|---|---|---|
| 封面 | `GET /api/cover/:coverId?size=300` | 返回 JPEG/PNG 二进制；无封面自动返回占位 SVG。建议实参 `size=300`（移动端）/ `600`（详情页） |
| 音频流 | `GET /api/stream/:trackId` | 支持 HTTP Range，`206 Partial Content`，可直接喂给 `<audio src>` / ExoPlayer。`<audio>` 场景可用 Cookie 令牌（见下） |
| 歌词 | `GET /api/track/:trackId/lyric` | `text/plain`；无歌词返回 `200` + JSON `{"available":false,…}`（统一成功口径，非 404） |

> **浏览器直连提示**：`<audio src>` 不会附加 `Authorization` 头，只会带同域 Cookie。因此 `/api/stream/*` 额外接受 Cookie 令牌 `tp_token`，其余 `/api/*` 仍只认 Bearer。
> 浏览器场景请先访问 `/login` 写入 Cookie，或使用带令牌的服务端代理。

---

## 6. 分页最佳实践

**两种写法等价**，任选其一：

```
/api/v1/tracks?limit=30&offset=60     # 第 3 页
/api/v1/tracks?limit=30&page=3        # 同上
```

**遍历全部（JS）**

```js
async function allTracks() {
  const out = [];
  let offset = 0;
  for (;;) {
    const d = await api(`/api/v1/tracks?limit=200&offset=${offset}`);
    out.push(...d.items);
    if (!d.pagination.hasMore) break;
    offset += d.pagination.limit;
  }
  return out;
}
```

**大列表建议**：SEO/首屏用 `limit=30`；全量同步用 `limit=200` 配 `hasMore` 翻页；不要用一次拉上万条的单请求（响应体大、易超时）。

---

## 7. 典型调用场景

| 场景 | 调用序列 |
|---|---|
| 渲染首页 | `GET /api/v1/home` |
| 「随机漫游」刷新一批 | `GET /api/v1/tracks?sort=random&seed=<当天日期>&limit=20` |
| 歌手详情页 | `GET /api/v1/artists?q=周杰伦` → `GET /api/v1/artists/ar_xxx?limit=50` |
| 专辑详情页 | `GET /api/v1/albums?sort=added` → `GET /api/v1/albums/al_xxx` |
| 播放器 | 用 `trackLite.streamUrl` + `trackLite.lyricUrl`，结束时 `POST /api/v1/history` |
| 收藏按钮 | `GET /api/v1/favorites/:id` 查状态 → `PUT` / `DELETE` 切换 |
| 搜索联想页 | `GET /api/v1/search?q=关键词` |
| 「查看全部搜索结果」 | `GET /api/v1/search?q=关键词&type=track&limit=30&page=2` |

---

## 8. 数据刷新说明

- 曲库由服务端扫描本地音乐目录生成，**歌曲文件的增删由 TunePick 扫描后同步**（`POST /api/scan/start`）
- 重新扫描可能改变曲目 id；旧 id 通过别名表仍能解析，收藏 / 历史中的失效记录会被安全跳过
- 元数据（歌手、流派、情绪、场景、封面、歌词）为服务端刮削结果，质量分级见 `qualityLevel` 字段

---

## 9. 旧端点（`/api/*`，继续保留）

已在使用的旧接口不受影响，建议新接入方直接用 `/api/v1/*`：

| 旧 | 对应 v1 |
|---|---|
| `GET /api/library` | `GET /api/v1/home` |
| `GET /api/tracks` | `GET /api/v1/tracks`（v1 增加过滤、随机、更多排序） |
| `GET /api/albums` | `GET /api/v1/albums`（v1 增加分页、包含未知专辑组） |
| `GET /api/album/:id` | `GET /api/v1/albums/:id`（id 同源同值） |
| `GET /api/playlists` / `/api/playlist/:id` | v1 同名（增加分页） |
| `GET /api/search` | `GET /api/v1/search?q=&type=track` |
| `GET /api/track/:id` | `GET /api/v1/tracks/:id` |
| `GET /api/facets` | `GET /api/v1/facets` |
| `GET /api/tracks/filter` | `GET /api/v1/tracks`（参数更全） |

管理类端点（扫描、数据源、LLM、审阅队列）不在对外开放范围内，见服务端管理界面。

---

## 10. 实测通过清单

> 每个接口都在真实服务上打过请求，下表为实测记录。

| # | 接口 | HTTP | 结果 |
|---|---|---|---|
| — | （待测，见交付时的实测报告） | — | — |
