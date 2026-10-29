# 归档文档

这里放的是**某个时间点的记录**，不再随代码更新。它们回答的是「当时为什么这么决定」，
而不是「现在是怎么实现的」——后者看 [../ARCHITECTURE.md](../ARCHITECTURE.md)。

| 文档 | 记录了什么 | 结论 | 日期 |
| --- | --- | --- | --- |
| [python-removal.md](python-removal.md) | 移除 Python 运行时与 stdio 桥的完整清单（保留 / 改写 / 移除） | 运行期与构建期均不再依赖 Python，`engine/` 973 MB 已删除 | 2026-10-29 |
| [engine-ts-migration.md](engine-ts-migration.md) | 引擎从 Python 子进程迁到进程内 TypeScript 的过程与性能对照 | 收益主要来自「少一个运行时 + 最坏路径变短」，不是语言差异 | 2026-10-29 |
| [engine-ts-parity-report.md](engine-ts-parity-report.md) | 迁移后 15 个源的功能对等与性能评估 | 可作为正式版本；对拍的 Python 侧已不存在 | 2026-10-29 |
| [audit-2026-10-29.md](audit-2026-10-29.md) | 全量代码检测：模块划分、修掉的 bug、风险与优先级建议 | 8 项修复已落地；遗留项见文末第六、七章 | 2026-10-29 |
| [android_migration_plan.md](android_migration_plan.md) | Android 迁移的六个问题与方案 | 基于 Capacitor 的假设；该依赖已从项目移除，方案暂缓 | 2026-10-27 |

## 阅读提示

- 归档文档里的**路径、文件名、数据可能已经过时**：`engine/python`、`src/main/engine/python.ts`、
  `settings.engineMode` 等已全部删除，`docs/audit-2026-10-29.md` 里提到的 `scripts/bench` 也不存在了。
- Android 方案里假设的 Capacitor 桥接层已经移除（依赖 `@capacitor/core`、`@capacitor/filesystem` 已删），
  如果真要重启这条路，需要重新评估。见 [../../PLATFORM.md](../PLATFORM.md) 第三节。
