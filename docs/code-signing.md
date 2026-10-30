# Windows 代码签名

> 最后核对：2026-10-30 · 文档索引见 [README.md](./README.md)

## 一、为什么必须做

安装包没有签名时，Windows 的行为是：

1. 浏览器下载 `.exe` 后提示「此文件不常用，可能不安全」；
2. 双击安装时弹 **SmartScreen「Windows 已保护你的电脑」**，默认按钮是「删除」，用户必须点「更多信息 → 仍要运行」；
3. 部分企业网络策略与第三方杀软会直接拦截未签名可执行文件。

对一个要长期更新的播放器来说，这三步会吃掉相当一部分下载量，而它和代码质量无关。

签名后的差别：安装界面直接显示发布者名称，SmartScreen 信任度随下载量累积逐步建立；
**带 RFC3161 时间戳的签名在证书过期后依然有效**——老版本的安装包不会突然变成「未签名」。

## 二、三条路线怎么选

| 路线 | 成本 | 适合场景 | 备注 |
| --- | --- | --- | --- |
| **SignPath Foundation** | 免费 | 开源项目 | 需要仓库公开、许可证为 OSI 认可（本项目是 MIT）、提交申请并等待审核；通过后用他们的 CI 集成签名 |
| **Azure Trusted Signing** | 约 $10/月 | 个人 / 小团队 | 微软自家服务，需要完成身份验证（个人可用，需证件）；CI 里走 `azureSignOptions` |
| 传统 OV / EV 证书 | ¥1500–4000/年 | 商业分发 | EV 证书要硬件令牌，无法直接在 CI 用；OV 可导出 pfx |

优先级建议：**先按 SignPath 申请（免费），审核期间用下面的「临时方案」止血**。

### 临时方案（不签名也能少踩坑）

- 下载页给出 `Aurora-Music-<版本>-x64.exe` 的 SHA256，教用户用
  `certutil -hashfile 文件名 SHA256` 自行比对；
- README 里写明「首次安装被 SmartScreen 拦截时选『更多信息 → 仍要运行』」。

## 三、证书就位后的接线（已配好，只差密钥）

仓库里已经做完的部分：

- `electron-builder.yml` 的 `win` 段**只留注释、不写签名选项**：`signingHashAlgorithms` /
  `rfc3161TimeStampServer` / `timeStampServer` 放在 `win` 根级会让 26.x 的 schema 把整个 `win`
  段判为非法（`Invalid configuration object`），三平台打包一起失败。这三项的默认值本来就是
  RFC3161 + DigiCert + SHA-256，要换服务器时写到 **`win.signtoolOptions`** 下；
- `.github/workflows/build.yml` 的 `Detect signing certificate` 步骤会检查 `CSC_LINK`：有值才开启签名，
  没有就打一条 notice 并跳过，**CI 不会因此变红**；同时 `Package` 步骤在未启用签名时
  `unset CSC_LINK / CSC_KEY_PASSWORD`——macOS 侧用 `cscLink == null` 判断，空串会被当成证书路径
  去 base64 解码并抛错，导致 mac 打包失败。

你需要做的只有两件事：

### 1. 把证书转成 base64 存进 GitHub Secrets

```bash
# Windows PowerShell / Git Bash 均可（如果证书是 pfx）
base64 -w0 aurora-signing.pfx > csc-link.txt      # Linux / Git Bash
# certutil -encode aurora-signing.pfx csc-link.txt   # 纯 Windows 环境
```

在仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | 上面那串 base64（单行，不要换行） |
| `CSC_KEY_PASSWORD` | 导出 pfx 时设置的密码 |

> 也可以让 `CSC_LINK` 填证书文件的 HTTPS 链接，electron-builder 会去下载；
> 但放 Secrets 里更可控。

### 2. 触发一次发版，验证签名

```bash
# 下载产物后在本机检查（PowerShell，版本号按实际替换）
Get-AuthenticodeSignature .\Aurora-Music-1.3.9-x64.exe | Format-List Status, SignerCertificate

# Status 应为 Valid；再看时间戳
(Get-AuthenticodeSignature .\Aurora-Music-1.3.9-x64.exe).TimeStamperCertificate
```

`Status: NotSigned` = 证书没进去（检查 Secret 名字拼写与 base64 是否被换行截断）。

## 四、踩坑清单

1. **pfx 用密码保护才能被 electron-builder 读取**，导出时别选「无密码」；
2. **base64 里不能有换行**——`certutil -encode` 会输出多行，需要自己拼成一行，
   否则 electron-builder 解析失败且报错信息很含糊（只在 `--publish never` 的日志末尾一行）；
3. **时间戳服务器要能通**：CI 走海外网络，DigiCert 的 `http://timestamp.digicert.com` 稳定；
   若换国内服务器务必确认支持 RFC3161，否则 sha256 签名会失败；
4. **证书主体名称必须与 `productName` 对应的公司/个人一致**，否则 SmartScreen 仍会降级提示；
5. 签名会让打包时间增加 1–3 分钟（每个可执行文件都要签），属正常现象；
6. **签名选项别放 `win` 根级**：`signingHashAlgorithms` / `rfc3161TimeStampServer` 在
   electron-builder 26.x 的 schema 里不在这一层，写上去会让整个 `win` 段校验失败，
   报 `Invalid configuration object` 并中止打包（本地 `electron-builder --dir` 即可复现）。
   默认值已经是 RFC3161 + DigiCert + SHA-256，通常什么都不用写。

## 五、与自动更新的关系

`electron-updater` 校验的是 `latest.yml` 里的 **sha512**，与代码签名无关——签名不影响更新链路。
但 Windows 安装器（NSIS）在覆盖安装已签名的旧版本时，会对新版本做发布者一致性检查：
**从「已签名」退回「未签名」的版本，部分环境下会安装失败**。一旦开始签名就不要中途取消，
或至少在发版说明里提示用户手动卸载重装。
