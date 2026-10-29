# 文档索引

所有非代码文档的入口。分两类：**现行**（描述当前实现，代码变了就改）与**归档**（某个时间点的记录，不再更新）。

## 现行

| 文档 | 讲什么 | 什么时候看 |
| --- | --- | --- |
| [../README.md](../README.md) | 项目定位、功能、命令、发版、已知限制 | 第一次接触这个项目 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层与依赖、音源接口与错误模型、缓存与换源调度、下载状态机、`muse://` 协议、Web Audio 图、关键流程、扩展点 | 要改主进程逻辑、加音源、排查播放问题 |
| [PLATFORM.md](PLATFORM.md) | Windows / macOS / Linux 的窗口、路径、托盘差异；为什么移动端不行 | 打包新平台、处理平台特有的窗口问题 |
| [mini-player.md](mini-player.md) | 迷你播放窗的三态、悬停面板、尺寸与位置记忆 | 改 `MiniPlayer.vue` 或 `windows.ts` 的窗口形态 |
| [desktop-lyric.md](desktop-lyric.md) | 桌面歌词的「裸字 / 悬停」两态、伪元素画面板、逐字高亮 | 改歌词窗口样式或穿透行为 |

## 归档（`archive/`）

时间点记录，**不再随代码更新**。有疑问时以现行文档和代码为准。

| 文档 | 记录了什么 | 日期 |
| --- | --- | --- |
| [archive/python-removal.md](archive/python-removal.md) | 彻底移除 Python 的保留/改写/移除清单，以及为什么做得到 | 2026-10-29 |
| [archive/engine-ts-migration.md](archive/engine-ts-migration.md) | 引擎从 Python/musicdl 子进程迁到进程内 TypeScript 的过程与性能对照 | 2026-10-29 |
| [archive/engine-ts-parity-report.md](archive/engine-ts-parity-report.md) | 迁移后的功能对等与性能评估（15 个逐源对拍） | 2026-10-29 |
| [archive/audit-2026-10-29.md](archive/audit-2026-10-29.md) | 全量检测：模块划分、修掉的 bug 清单、风险与优先级 | 2026-10-29 |
| [archive/android_migration_plan.md](archive/android_migration_plan.md) | Android 迁移六问（基于 Capacitor 的假设，依赖已移除，方案暂缓） | 2026-10-27 |

## 截图

`shots/` 下所有界面图由 [`scripts/shots.mjs`](../scripts/shots.mjs) 生成，不是手工截的：

```bash
npm run build        # 截图跑的是 out/ 里的产物
npm run shots        # 全部重拍；也可只拍指定几张：npm run shots -- discover search
npm run shots -- --list
```

脚本用固定的临时 profile（`<tmp>/aurora-shots-profile`）驱动真实界面：切换音源、填搜索词、播第一首、
打开播放舞台与均衡器面板，再调 `AURORA_CAPTURE` 截图。改版后重跑一次即可，不必再手工对图。

> 截图里的歌曲、下载记录、本地库条目都来自这个 profile；首次运行会联网搜索与真实下载一首，
> 之后重复跑结果基本一致。
