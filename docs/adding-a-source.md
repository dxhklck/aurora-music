# 新增一个音源（10 分钟）

> 对应版本：1.5.0 · 最后核对：2026-11-02 · 文档索引见 [README.md](./README.md)

这份文档的目标是：**只读它，不读别的音源代码，就能加进一个能搜、能播的音源。**

如果你发现必须去翻 [`src/main/engine/ts/sources/kugou.ts`](../src/main/engine/ts/sources/kugou.ts) 才知道下一步做什么，
那是这份文档的 bug，请提 issue。

---

## 0. 先判断这个音源值不值得加

符合以下全部条件再加：

- 搜索接口**不需要登录**（要登录的走 `src/main/providers/` 那套原生适配器，不是这里）
- 返回的播放地址是**直链或 HLS**，不是 DRM / 加密分片
- 没有强制验证码

只要有 DRM 或必须登录，别加——加进来也是搜得到、播不了，最后被当成坏源。

---

## 1. 复制模板

```bash
cp src/main/engine/ts/sources/_template.ts src/main/engine/ts/sources/example.ts
```

文件名用音源的英文小写，和后面注册的 `key` 一致。

---

## 2. 改三个地方

打开新文件，只需要改这三处：

| 位置 | 改成什么 |
| --- | --- |
| `const API_URL` | 该平台的搜索接口 |
| `const HEADERS` | 至少 `referer` 填该平台首页 |
| `class ExampleSource` 的 `key` / `label` | `key: 'example'`（英文小写）、`label: '示例音乐'`（侧栏显示） |

剩下的 `buildUrls` 与 `parsePage` 就是你要适配的部分。

---

## 3. 改 `buildUrls`：把「要 N 条」拆成若干页 URL

打开浏览器的开发者工具，在平台上搜一次，看网络面板里那个搜索请求长什么样。

**协议 A：offset / limit**

```
https://api.example.com/search?q=晴天&limit=3&offset=0
https://api.example.com/search?q=晴天&limit=3&offset=3
```

模板里写的就是这种。

**协议 B：page / pageSize**

```ts
protected buildUrls(keyword: string, perPage: number, size: number): string[] {
  const urls: string[] = []
  const pages = Math.ceil(size / perPage)
  for (let page = 1; page <= pages; page += 1) {
    urls.push(
      `${API_URL}?${new URLSearchParams({ q: keyword, page: String(page), size: String(perPage) })}`
    )
  }
  return urls
}
```

**协议 C：POST 才能搜**

`buildUrls` 只能返回 URL，所以这种情况要自己在 `parsePage` 里判断：

```ts
protected buildUrls(keyword: string, perPage: number, size: number): string[] {
  // 用一个假 URL 当「第几页」的载体，真正的请求在 parsePage 里发
  return Array.from({ length: Math.ceil(size / perPage) }, (_, index) =>
    `${API_URL}#${keyword}#${index * perPage}`
  )
}

protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
  const [, keyword, offset] = url.split('#')
  const response = await this.http.post(API_URL, { keyword, offset: Number(offset), limit: ctx.limit })
  // …下面同模板
}
```

⚠️ **offset 有上限**：有些接口超过 100 就返回空数组，表现为「搜到一半突然没结果」。
`size` 超过上限时，多的页直接不生成。

---

## 4. 改 `parsePage`：把响应变成 `SongInfo`

```ts
for (const row of parseRows(response.text)) {
  if (ctx.full) break                       // ① 收满就停
  const probed = await probeFirst([row.playUrl], { headers: HEADERS })
  if (!probed) continue                     // ② 探测不到就跳过
  ctx.push(makeSong(this.key, { … }))       // ③ 填字段
}
```

三行的理由：

**① `ctx.full`**：`ctx.limit` 是**本页**上限。不看这个标志会一页塞几十条，
整个搜索退化成串行（咪咕实测从 6 秒变 50 秒+）。

**② `probeFirst`**：搜索接口给的地址经常是占位符、需要跟随 302、或者干脆是空的。
`probeFirst` 会发一次 Range 请求确认真的能播，并推断扩展名、体积、是否 HLS。
不探测 = 列表看着漂亮，点播放全失败。

**③ `makeSong`**：它负责清洗脏数据（`'NULL'` 字符串、HTML 实体、首尾空白）并把
字段归一化成秒 / 字节。**别自己拼对象**，否则 `'NULL'` 会变成一位叫 NULL 的歌手。

### 字段对照表

| `makeSong` 字段 | 从哪来 | 单位 / 注意 |
| --- | --- | --- |
| `identifier` | 平台曲目 id | 同一首歌要稳定；跨页去重靠它 |
| `songName` | 歌名 | 原样传，清洗由 `makeSong` 做 |
| `singers` | 歌手 | 多个用 `/` 分隔（和界面一致） |
| `album` | 专辑 | 没有就空串 |
| `durationS` | 时长 | **秒**。接口给毫秒要除 1000；给 `"3:45"` 要自己换算 |
| `ext` | 扩展名 | 用 `probed.ext`，不要猜 |
| `fileSizeBytes` | 体积 | 用 `probed.size`，HLS 为 0 |
| `coverUrl` | 封面 | 没有就空串；渲染层会退化成渐变占位 |
| `downloadUrl` | 播放地址 | 用 `probed.url`（跟随重定向后的最终地址） |
| `headers` | 播放请求头 | 和搜索用的一致，主要是 referer |
| `protocol` | `'HTTP'` / `'HLS'` | 用 `probed.protocol` |
| `raw` | 原始响应片段 | 排查用，不参与对外协议 |

---

## 5. 注册到音源表

编辑 `src/main/engine/ts/sources/index.ts`，**三处都要改**：

```ts
import { ExampleSource } from './example' // ① 导入

const BUILDERS = new Map<string, () => SourceClient>([
  // …
  ['example', () => new ExampleSource()] // ② 注册
])

export const SOURCE_META: SourceMeta[] = [
  // …
  { key: 'example', label: '示例音乐', pageSize: 3 } // ③ 元信息（侧栏与自检用）
]

export { ExampleSource } // ④ 文件末尾的再导出，保持风格一致
```

漏掉 ② 的表现：侧栏没有这个源。
漏掉 ③ 的表现：源存在但侧栏名字是空的，自检也看不到它。

---

## 6. 验证（必须做完这三步）

```bash
npm run typecheck      # 编译
npm run engine:test    # 引擎层单测（92 例，确认没弄坏公共逻辑）
npm run dev            # 真机跑
```

在 `dev` 里：

1. 左侧切到新音源 → 搜一个**该平台一定有**的关键词 → 看列表出不出结果
2. 看时长列——是 `0:00`、`70 万小时`，还是正常值
3. **点播放**，确认真的出声（最容易翻车的一步）
4. 下载一首，确认文件能播、标签写进去了

四步都过才算接好。

---

## 7. 常见问题

**搜不到任何结果**

- 先看 `HEADERS.referer` 有没有填。没有 referer 时不少平台返回 403 或一段 HTML
- 把 `API_URL` 直接粘进浏览器地址栏，看返回的是什么。如果返回 HTML，说明接口变了
- 关键词要用 `encodeURIComponent`（`URLSearchParams` 已经帮你做了）

**能搜到，点播放没声音**

- 说明没走 `probeFirst`，或者传了 `playUrl` 而不是 `probed.url`
- 有的平台地址要跟随 302 才是真文件，`probed.url` 已经是最终地址

**时长全是 0 / 全是 70 万小时**

- 单位错了。毫秒忘了除 1000（→ 70 万小时），或者把毫秒当秒

**搜索很慢（>10 秒）**

- 把 `pageSize` 调小，让它拆成更多页并发。咪咕每页 2 条会退化到 50 秒+，
  所以默认是 3，按平台实测调
- 不要在 `parsePage` 里串行 `await` 每一个探测请求——`probeFirst` 已经足够轻，
  但一页 3 条串行探测是 3 次往返

**搜索结果第二条开始重复**

- 平台自己返回了重复项。跨页去重由 `BaseSource` 按 `identifier` 做，
  所以问题在 `identifier` 不稳定（比如用了列表下标）

**被平台限流 / 返回验证码页**

- `pageSize` 调小、`concurrency` 调小（构造 `super({ … })` 里传）
- 别为了快把并发开到 10 以上，那是最容易被封的做法

---

## 8. 提交前

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) 里的四道检查要全绿
- 在 PR 描述里写清：平台名、搜索接口、是否需登录、实测关键词与结果数
- 如果这个源只支持部分内容（比如只有 CC 授权曲目），在 `label` 或注释里写明

---

## 附：为什么音源只返回首屏约 10 条

这是**有意取舍**，不是缺陷。引擎型音源在搜索阶段就解析真实地址，翻倍召回等于翻倍耗时；
而用户看到 10 条基本够用，向下滚动再加载的代价远高于收益。

同样的道理适用于 `catalog` 的换源预算：跨源换源最多试 2 个引擎源、总 deadline 12 秒。
新音源不需要为此做任何特殊处理。
