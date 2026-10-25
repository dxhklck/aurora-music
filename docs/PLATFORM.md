# 跨平台支持说明

## 一、结论

| 平台 | 是否支持 | 原因 |
| --- | :---: | --- |
| Windows 10 / 11（x64 / arm64） | 支持 | 主目标平台，已实机验证 |
| macOS 12+（Intel / Apple Silicon） | 支持 | 已做红绿灯、应用菜单、置顶层级适配，需在 mac 上打包 |
| Linux（X11） | 支持 | 自绘标题栏、AppImage / deb 打包，X11 下窗口行为完整 |
| Linux（Wayland） | 基本可用 | 桌面歌词的「鼠标穿透 / 置顶 / 透明」依赖合成器能力，见下方限制 |
| Android | 不支持 | Electron 官方只支持桌面三平台，见第三节 |
| iOS / iPadOS | 不支持 | 同上 |

> 一句话：**Windows / macOS / Linux 可以，Android 不行**。这不是改个打包参数能解决的——移动端没有 Node 主进程，
> 而本项目的音源层、下载器、媒体代理、桌面歌词窗口全都活在主进程里。

---

## 二、桌面三平台已做的适配

| 关注点 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 窗口框架 | `frame:false` + 自绘标题栏 | `frame:true` + `hiddenInset`，保留原生红绿灯 | `frame:false` + 自绘标题栏 |
| 标题栏留白 | 默认 | `html[data-platform=darwin] .titlebar { padding-left:86px }` | 默认 |
| 双击标题栏 | 自绘逻辑切换最大化 | 交给系统（避免双重触发） | 自绘逻辑 |
| 应用菜单 | 置空（不遮挡界面） | 保留 `appMenu/editMenu/viewMenu/windowMenu`，否则 Cmd+C/V/Q 失效 | 置空 |
| 任务栏 / Dock | `setAppUserModelId` 保证分组与通知 | 默认 Dock 行为 | 默认 |
| 桌面歌词置顶 | `setAlwaysOnTop(true)` | `screen-saver` 层级 + 全工作区可见 | `setAlwaysOnTop(true)`，穿透取决于合成器 |
| 路径 | `app.getPath('music')` → `%USERPROFILE%\Music` | `~/Music` | XDG 音乐目录，无则 `~/Music` |
| 文件名 | 过滤 `\ / : * ? " < > \|` | 同（更保守，兼容外接 exFAT） | 同（多过滤不会出错） |
| 字体 | 微软雅黑 / Segoe UI | 苹方 | Noto Sans CJK / Source Han Sans / Ubuntu |
| 打包 | NSIS 安装包 | dmg + zip（未签名需右键打开） | AppImage + deb |
| CI | `windows-latest` | `macos-latest` | `ubuntu-latest`（`.github/workflows/build.yml`） |

代码层面所有路径拼接都用 `node:path`，没有硬编码 `\` 或盘符；`finalPath.split(/[\\/]/)` 同时兼容两种分隔符。

---

## 三、Android 为什么不行

Electron 的运行时只有 Windows / macOS / Linux。Android 上没有 `BrowserWindow`、没有主进程 Node 环境，
下面这些能力全部要重新实现：

| 现有实现 | Android 上的替代 |
| --- | --- |
| 主进程 `fetch` 抓平台接口（无 CORS、可自定义 Referer） | 原生 HTTP（CapacitorHttp / OkHttp），WebView 内直接 fetch 会被 CORS 与 Referer 拦截 |
| `muse://` 协议代理音频（补 Referer、透传 Range） | 原生 ExoPlayer + 本地代理服务（或 OkHttp 拦截器） |
| `DownloadManager`（流式写盘 + 断点续传） | Android DownloadManager 或前台服务 + SAF 目录授权 |
| 桌面歌词透明置顶窗口 | 悬浮窗权限（SYSTEM_ALERT_WINDOW）+ 前台服务，各家 ROM 限制不同 |
| `library.json` 本地库 | 应用私有目录 / MediaStore |
| 系统媒体键（MediaSession） | MediaSession + 通知栏样式，必须由原生侧接管 |

### 如果确实要做 Android，三条现实路径

1. **Capacitor + 原生插件（推荐，复用度最高）**
   - 直接复用 `renderer/`（Vue 组件、Pinia store、歌词时钟、渐变封面）；
   - 写 3 个插件：`http`（原生请求，绕过 CORS/Referer）、`player`（ExoPlayer + 媒体通知）、`files`（SAF 下载目录）；
   - 把 `providers/*.ts` 从主进程搬到 Web 层，用插件发请求；`DownloadManager` 改成调用原生下载；
   - 预计改动：数据层重写约 60%，UI 层复用约 85%，桌面歌词改为悬浮窗（或先砍掉）。
2. **Tauri 2（移动端已可用）**
   - Rust 侧重写 provider 与代理，WebView 复用 UI；包体更小，但要重学一套 IPC 与插件。
3. **Flutter / 原生重写**
   - UI 成本最高，除非同时要做 iOS 且追求极致性能，否则不建议。

### 不建议的做法

- 直接把 `file://` 页面塞进 WebView：平台接口有 Referer 校验且返回跨域，播放会大面积失败；
- 用「服务器中转」方案：等于自建音源代理，带宽与合规成本都会成倍上升。

---

## 四、Linux 已知限制

1. **Wayland**：`transparent` + `always-on-top` + 鼠标穿透由合成器决定。GNOME/KDE 新版本基本可用，
   部分环境（如某些 Sway/Hyprland 配置）会出现歌词窗无法置顶。可用 `--ozone-platform=x11` 启动回退到 X11。
2. **无 GPU 的环境**（容器 / 远程桌面）：需要 `--disable-gpu` 或 `--use-angle=swiftshader`。
3. **系统托盘**：本项目未实现托盘，Linux 上关闭窗口即退出（与 Windows 行为一致）。
4. **打包**：AppImage 需要 `libfuse2`；deb 在 Debian/Ubuntu 系可直接安装。

---

## 五、各平台运行与打包

```bash
# 开发（三平台一致）
npm install
npm run dev

# 本机打包
npx electron-builder            # 按当前系统产出对应安装包
npx electron-builder --win      # 仅在 Windows 上可用
npx electron-builder --mac      # 仅在 macOS 上可用（dmg 需要 hdiutil）
npx electron-builder --linux    # Linux 本机，或 Windows + WSL/Docker
```

> 跨平台打包不要指望「一台机器出三端」：macOS 的 dmg 必须在 macOS 上打，
> 最省事的做法是推送到 GitHub 后由 `.github/workflows/build.yml` 的三平台矩阵各出一份产物。

**签名**：未配置证书时，Windows 会触发 SmartScreen 提示，macOS 需右键「打开」或执行
`xattr -dr com.apple.quarantine /Applications/Aurora\ Music.app`。正式分发请补齐签名与公证。

**图标**：把 `icon.ico`（Windows）、`icon.icns`（macOS）、`icon.png`（Linux，512×512）放进 `build/` 目录即可自动使用。
