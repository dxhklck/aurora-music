# 国内更新源配置指南

> 目标：国内用户自动更新不超时、速度快，且差量更新（只下 5~15MB 而不是全量 105MB）真正生效。
> 代码侧已全部就绪（`src/main/updater.ts` 的 `STORAGE_FEED` + `.github/workflows/build.yml` 的
> 「Sync update files to COS」步骤），缺的只是一个对象存储桶和四个 secrets。

## 一、为什么需要自建源

| 渠道 | 直连 | 镜像（ghfast.top 等） | 对象存储 |
| --- | --- | --- | --- |
| 可用性 | 国内基本被墙 | 第三方公益反代，随时下线（`mirror.ghproxy.com` 已死） | 你自己的桶，SLA 由云厂商保证 |
| 速度 | — | 不稳定 | CDN 级 |
| 信任 | — | 可篡改 `latest.yml` 与安装包（sha512 校验拦不住一起改） | 自己的桶，无第三方 |
| 差量更新 | ✓（能按版本取旧 blockmap） | **✗ 必然失败**，每次全量 105MB | **✓ 只下变化的字节** |

差量失效的原因：electron-updater 要拿「上一个版本」的 blockmap 和安装包按 Range 请求旧字节。
镜像渠道的基础 URL 是 `releases/latest/download/`，只指向最新版，旧文件 404 → 退化为全量。

## 一点五、有没有免费的桶

| 方案 | 免费额度 | 代价 | 国内可用性 |
| --- | --- | --- | --- |
| **Cloudflare R2** | 10GB 存储 + **出口流量免费** | 必须绑自定义域名才有稳定的公开读（域名一年约 ¥10~60）；`r2.dev` 测试域名有速率限制且国内常不可达 | 一般——CF 无国内节点、未备案，速度波动大；差量后只下 5~15MB，可接受 |
| Cloudflare Workers 反代 | 10 万请求/天，零存储（流式转发 GitHub） | 同样要自定义域名；旧版本路径需要 Worker 做版本重写才能让差量生效 | 同上 |
| 七牛 / 又拍云 | 七牛 10GB 存储 + 10GB 流量/月 | **自定义域名必须 ICP 备案**；测试域名会过期 | 快 |
| 腾讯 COS / 阿里 OSS | 无长期免费，仅新用户试用 3~6 个月 | 差量生效后每次发布约 ¥5~15 流量费 | 最快、免域名（直接用桶默认域名） |

**建议**：已经差量化之后，每次更新的流量只有 5~15MB，COS 一年成本大概率不到一顿饭钱；
为省这点钱上 R2 反而要买域名、忍受 CF 的国内速度。**除非你本来就有域名**——那 R2 全免费，
直接用。没有域名就选 COS，把「域名」这笔隐性成本省下来。

## 二、你需要做的（一次性）

1. **开通对象存储**（三选一）：
   - 腾讯云 COS：`cos.<region>.myqcloud.com`，流量约 ¥0.5/GB，1000 用户一次更新约 ¥5~15；
   - 阿里云 OSS：`<bucket>.oss-<region>.aliyuncs.com`，价格相近；
   - Cloudflare R2：出口流量免费（10GB/月免费额度），需绑自定义域名。
2. **创建桶**：
   - 名称随意（如 `aurora-updates`），**地域选国内用户多的**（如上海/广州）；
   - 读写权限设为「公有读、私有写」（electron-updater 不带凭据下载）；
   - **只增不删**：CI 只上传，永不覆盖删除旧版本——旧版本的 exe 与 blockmap 是差量下载的数据源。
3. **在 GitHub 仓库 Settings → Secrets and variables → Actions 配四个 secrets**：

   | Secret 名 | 值 |
   | --- | --- |
   | `COS_SECRET_ID` | 云 API 密钥 SecretId（只授予该桶的读写权限） |
   | `COS_SECRET_KEY` | 对应 SecretKey |
   | `COS_BUCKET` | 桶全名（如 `aurora-updates-1250000000`） |
   | `COS_REGION` | 地域（如 `ap-guangzhou`） |

   **不要把密钥贴到对话或代码里。** 用子账号（CAM/ram）最小权限：只给这个桶的 `PutObject`/`GetObject`。
4. **把桶的公开读地址告诉我**（如 `https://aurora-updates-1250000000.cos.ap-guangzhou.myqcloud.com`），
   我把它填进 `src/main/updater.ts` 的 `STORAGE_FEED` 并发版——这一步之后国内用户自动优先走桶。

## 三、生效后的行为

```
启动 30s 后静默检查：
  1. settings.updateChannel 记着上次可用的渠道 → 直接用它，不探测（国内直连被墙时省 12s）
  2. 没有记忆 → 按顺序探测：对象存储 → GitHub 直连 → 镜像 ×2
  3. 第一个能拉到 latest.yml 的胜出，写回 settings
  4. 渠道中途失效（error 事件）→ 清掉内存与 settings 里的记忆，下次重新探测
```

- 探测和下载走同一渠道：桶在但某个文件缺失时，错误会触发渠道重选。
- CI 在 secrets 未配置时自动跳过同步步骤，GitHub Release 照常发布——可以先上代码后配桶。
- 成本估算（差量生效后）：每次更新每用户约 5~15MB；1000 用户 ≈ 5~15GB ≈ COS ¥5~15 / R2 ¥0。

## 四、验证清单

配好桶并发版后，按顺序确认：

```bash
# 1. CI 的「Sync update files to COS」步骤成功（或输出 notice 表示跳过）
# 2. 桶里能看到 latest.yml / Aurora-Music-<v>-x64.exe / .blockmap
curl -sL "https://<桶地址>/latest.yml" | head -3
# 3. 应用端：设置页检查更新，首次会探测并记住渠道；settings.json 里出现
#    "updateChannel": "https://<桶地址>"
# 4. 差量验证：连发两个相邻版本后看第二次更新的下载量（应远小于安装包体积）
```
