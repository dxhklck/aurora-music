# 国内更新源配置指南

> 目标：国内用户自动更新不超时、速度快。**主源 = GitCode（免费，已实测接线）**，
> GitHub 直连与镜像作后备；对象存储是可选的差量更新增强（未配置）。

## 一、当前架构（2026-10-30 落地）

```
探测顺序（src/main/updater.ts 的 CHANNELS）：
  1. GitCode 主源  → gitcode.com/dxhklck/aurora_music/releases/download/stable/
  2. 对象存储（可选，STORAGE_FEED 为空串时不启用）
  3. GitHub 直连
  4. ghfast.top / gh-proxy.com 镜像兜底

首个能拉到 latest.yml 的胜出，跨启动记在 settings.updateChannel；
渠道失效（error 事件）时清掉记忆重新探测。
```

CI（`build.yml` 的 publish-release job）每次发版做两件事：

- **Sync update files to GitCode**：`scripts/publish-gitcode.mjs` 把
  `latest.yml + exe + blockmap` 传到版本 release（tag=vX.Y.Z）与指针 release（tag=stable）；
- **Mirror code to GitCode**：把 `origin/main` 与全部 tags 推到 GitCode 仓库作镜像。

## 二、GitCode 上的实测结论（排坑实录，2026-10-30）

| 事项 | 结论 |
| --- | --- |
| 附件下载 | `releases/download/<tag>/<file>` **可用**，匿名、无需登录 |
| Range 请求 | **支持**（HTTP 206 + Content-Range），断点续传没问题 |
| `releases/latest/download/<file>` 别名 | **不可用**：返回的是网页 HTML 而不是文件（只看状态码会误判，必须查内容） |
| tag 名叫 `latest` | **不要用**：下载路由会把它解析成「当前 API latest」而不是固定 tag |
| 同名附件重复上传 | **不生效**：PUT 返回成功但下载内容钉死在第一次（v1.3.6 实测：先传 0.0.0 再传 1.3.6，下载仍是 0.0.0）。必须先 `DELETE /releases/{tag}/attach_files/{id}` 删旧记录再传——publish-gitcode.mjs 已内置「先删后传 + sha256 内容校验」 |
| 删除 release | v5 API 无按 tag 删除端点（DELETE 返回 405），只能在网页上手动删 |
| 创建 release | tag 不存在时会**自动创建 git tag**；`release_status: "pre"/"latest"` 可控制是否被 latest 选中 |
| 附件上传 | `GET /releases/<tag>/upload_url?file_name=…` 拿预签名 OBS 地址，按返回 headers 原样 PUT |
| 令牌 | git 推送用 `https://oauth2:<token>@gitcode.com/...`；API 用 `PRIVATE-TOKEN` 头 |

**指针设计**：更新器固定拉 `stable` tag；CI 每次发版把三件套覆盖上传到 `stable` 与版本 release
两处。`stable` release 标记为 `pre`，永远不抢占「最新版本」的显示位。

## 三、一次性配置（已完成项打勾）

- [x] GitCode 注册账号 `dxhklck`，建公开仓库 `aurora_music`
- [x] 生成私人令牌（作用域 repo + api），本地存 `F:\aurora\.env.local`（已被 .gitignore 覆盖）
- [ ] **把同一个令牌配到 GitHub 仓库 Secrets**：Settings → Secrets and variables → Actions →
      New repository secret，名字 `GITCODE_TOKEN`。CI 的两个 GitCode 步骤都依赖它；
      缺失时步骤会 `::error::` 失败（不影响 GitHub Release 本身）
- [ ] 清理 GitCode 上的测试残留：网页上删除 `sync-test` 与 `latest` 两个 release（API 删不了）

## 四、验证清单

下次发版（`v*` tag）后按序确认：

```bash
# 1. CI「Sync update files to GitCode」步骤成功，输出「GitCode 同步完成」
# 2. 指针内容已更新为新版本：
curl -sL "https://gitcode.com/dxhklck/aurora_music/releases/download/stable/latest.yml" | head -3
# 3. 应用端：settings.json 里出现 "updateChannel" 指向 stable 路径；
#    设置页检查更新能发现新版本并完成下载
# 4. 代码镜像：GitCode 仓库的 main 与 tags 与 GitHub 一致
```

## 五、对象存储（可选的差量增强，未启用）

差量更新（每次只下 5~15MB）只有「旧版本文件可达」的渠道才能生效。GitCode 指针与镜像
的 URL 都只指向最新版，差量失败时 electron-updater 自动退化为全量（GitCode 全量也快，可接受）。
若以后想启用差量：开一个公有读的 COS/OSS/R2 桶（只增不删），把桶地址填进
`src/main/updater.ts` 的 `STORAGE_FEED`，再配四个 `COS_*` secrets——CI 的
「Sync update files to COS」步骤会自动开始同步。详见 git 历史（`1e32d48`）中的完整说明。
