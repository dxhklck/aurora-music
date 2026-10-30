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

- `electron-builder.yml` 的 `win` 段启用了 `signingHashAlgorithms: [sha256]` 与
  `rfc3161TimeStampServer`（DigiCert 公共时间戳服务）；
- `.github/workflows/build.yml` 的 `Detect signing certificate` 步骤会检查
  `CSC_LINK`：有值才开启签名，没有就打一条 notice 并跳过，**CI 不会因此变红**。

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
# 下载产物后在本机检查（PowerShell）
Get-AuthenticodeSignature .\Aurora-Music-1.3.8-x64.exe | Format-List Status, SignerCertificate

# Status 应为 Valid；再看时间戳
(Get-AuthenticodeSignature .\Aurora-Music-1.3.8-x64.exe).TimeStamperCertificate
```

`Status: NotSigned` = 证书没进去（检查 Secret 名字拼写与 base64 是否被换行截断）。

## 四、踩坑清单

1. **pfx 用密码保护才能被 electron-builder 读取**，导出时别选「无密码」；
2. **base64 里不能有换行**——`certutil -encode` 会输出多行，需要自己拼成一行，
   否则 electron-builder 解析失败且报错信息很含糊（只在 `--publish never` 的日志末尾一行）；
3. **时间戳服务器要能通**：CI 走海外网络，DigiCert 的 `http://timestamp.digicert.com` 稳定；
   若换国内服务器务必确认支持 RFC3161，否则 sha256 签名会失败；
4. **证书主体名称必须与 `productName` 对应的公司/个人一致**，否则 SmartScreen 仍会降级提示；
5. 签名会让打包时间增加 1–3 分钟（每个可执行文件都要签），属正常现象。

## 五、与自动更新的关系

`electron-updater` 校验的是 `latest.yml` 里的 **sha512**，与代码签名无关——签名不影响更新链路。
但 Windows 安装器（NSIS）在覆盖安装已签名的旧版本时，会对新版本做发布者一致性检查：
**从「已签名」退回「未签名」的版本，部分环境下会安装失败**。一旦开始签名就不要中途取消，
或至少在发版说明里提示用户手动卸载重装。
