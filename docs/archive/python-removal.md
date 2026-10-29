# 彻底移除 Python：迁移结果与清理清单

> 日期：2026-10-29 · 对应版本：1.2.0
> 结论：运行期与构建期均不再依赖 Python。`engine/` 目录（973 MB）只剩死文件，可整目录删除。

## 一、为什么能做这件事

音源引擎早前已从 Python/musicdl 子进程迁到进程内 TypeScript（`src/main/engine/ts`，15 个源），
但迁移只做到「默认走 TS」，Python 那条路一直留着：`engineMode` 开关、解释器探测、设置页的
「指定解释器 / 修复源码」两个按钮、以及每次启动无条件执行的 `engine.ensure()` 预热。

结果是三份冗余同时存在：代码里的双实现、安装包里的 304 MB CPython、以及一个每次启动都会
拉起但从不被调用的子进程。本次把这三份一起清掉。

## 二、移除清单

### 2.1 运行时代码

| 文件 | 原功能 | 判断 |
| --- | --- | --- |
| `src/main/engine/python.ts`（404 行） | stdio NDJSON 桥：解释器探测、握手 ready 帧、请求 id 关联、超时与崩溃重启 | 唯一职责是驱动 Python 子进程，进程内实现不需要 |
| `src/main/paths.ts`（52 行） | `engineDir` / `bridgeScript` / `repairScript` / `vendoredMusicdlDir` / `musicdlDirs` | 只被 `python.ts` 引用，随之失效 |

### 2.2 引擎侧 Python 源码

| 文件 | 行数 | 原功能 |
| --- | --- | --- |
| `engine/musicdl/bridge.py` | 145 | stdio 协议、线程池 4、ready/fatal 帧、`install_page_hook` 轮询补丁 |
| `engine/musicdl/engine_core.py` | 791 | 8 条命令、token 缓存、模糊重定位、180s 搜索缓存、45s 超时 |
| `engine/musicdl/repair_vendor.py` | — | 从 PyPI 回填损坏的上游源码 |
| `engine/requirements-bundle.txt` | — | musicdl 的 PyPI 依赖钉版清单 |

### 2.3 开发期脚本

| 文件 | 行数 | 原功能 | 去向 |
| --- | --- | --- | --- |
| `scripts/setup_engine.py` | 119 | 建 `engine/.venv` 并装依赖 | 移除，无 Python 可装 |
| `scripts/vendor_engine.py` | 149 | 下载 musicdl 源码进 `engine/vendor` | 移除，不再分发上游源码 |
| `scripts/repair_musicdl.py` | 109 | 回填空字节损坏的上游文件 | 移除，无 vendor 可修 |
| `scripts/probe_engine_vip.py` | 47 | 一次性调研：探测 VIP 音源 | 移除，调研已完成 |
| `scripts/make_demo_audio.py` | 202 | 合成 3 首演示音频 | **改写**为 `scripts/make-demo-audio.mjs` |
| `scripts/make_app_icon.py` | 188 | PIL 生成应用图标 | 移除，产物已入库（`build/`、`build-icons/`） |
| `scripts/make_tray_icon.py` | 73 | PIL 生成托盘图标 | 同上 |
| `scripts/make_android_icons.py` | 160 | PIL 生成 Android 图标 | 同上（本就不入库） |
| `scripts/engine-ts/compare.mjs` | 149 | 双引擎逐字段对拍 | 移除，无 Python 侧可比 |
| `scripts/engine-ts/python-run.mjs` | 68 | 对拍时拉起 Python 引擎 | 移除 |
| `scripts/engine-ts/bench/*` | 326 | 双引擎冷启 / 耗时 / RSS 基准 | 移除，结论已固化在迁移文档 |
| `scripts/engine-ts/fixtures/{generate-audio,generate-parity,verify-tags}.py` | 601 | 生成音频夹具、对拍夹具、校验标签 | 移除，`fixtures/` 产物已入库 |

### 2.4 配置与依赖声明

| 项 | 处理 |
| --- | --- |
| `package.json` | 删 `engine:setup` / `engine:repair` / `engine:vendor` / `engine:bench` / `engine:compare`；`dist` 去掉 `engine:vendor` 前缀；`demo:audio` 改为 `node scripts/make-demo-audio.mjs` |
| `electron-builder.yml` | `extraResources` 删 `engine/python`、`engine/vendor`、`engine/musicdl` |
| `settings.engineMode` / `settings.pythonPath` | 删除字段；旧 `settings.json` 里的同名键会被忽略（读取是浅合并，无校验） |
| `IPC.engineChoosePython` / `IPC.engineRepairVendor` | 主进程 handler、preload、`AuroraApi` 类型一并删除 |
| `.gitignore` | 去掉 `__pycache__/`、`*.pyc`；`engine/` 整目录忽略 |
| `engine/requirements-bundle.txt` | 删除 |

## 三、改写清单

| 原实现 | 新实现 | 说明 |
| --- | --- | --- |
| `python.ts` 桥 + `engine_core.py` | `src/main/engine/musicdl.ts`（84 行门面）+ `engine/ts` | 上层 `MusicdlProvider` 的调用签名一字未改；`EngineCallError` → `EngineError`，错误码与 `toProviderError` 的映射保持一致 |
| `musicdl.repairVendor()` | 删除 | 没有私有 vendor 需要修；平台改版直接改 `engine/ts/sources` |
| `musicdl.status()` 的 `bridgeFound` / `musicdlFound` / `log` | 删除 | 进程内引擎恒为就绪，这三个字段失去含义 |
| 设置页「解释器 / 源码 / 日志 / 安装引导」 | 换成「运行时 / 版本 / 音源数」 | 不再引导用户装任何东西 |
| `make_demo_audio.py` | `scripts/make-demo-audio.mjs` | 逐函数照搬，产物仍是 3 × 1,764,044 字节的 WAV |
| 启动时 `engine.ensure()` 预热 | 删除 | TS 引擎无进程可预热，这行是迁移遗漏 |

## 四、保留项（以及为什么）

- **`engine/ts` 全部代码**：15 个音源、分页并行、缓存与锁、ID3/FLAC/MP4 标签写入、HLS 分片。
- **`musicdl` 这个命名**：函数语义已完全一致，改名会牵动 provider 与服务层；作为历史沿革保留。
- **`settings.engineEnabled`**：仍有意义——用不上的用户可以关掉这批音源，减少搜索等待。
- **`resources/demo/*.wav`**：演示音源是产品资源，不是构建中间物。
- **`scripts/engine-ts/{build.mjs,e2e.ts,run.ts,test/}`**：纯 Node 的构建与测试链路，继续使用。
- **`ffmpeg`**：HLS 转封装的外部依赖，与 Python 无关，保留并在 README 中说明。

## 五、已删除的目录

确认不回滚后已执行（2026-10-29）：

| 路径 | 体积 | 说明 |
| --- | --- | --- |
| `engine/python` | 304 MB | 内嵌 CPython 3.12 |
| `engine/.venv` | 357 MB | 开发期虚拟环境 |
| `engine/vendor` | 4.6 MB | musicdl 上游源码 |
| **合计** | **973 MB** | `rm -rf engine/` 一条命令清完 |

> 回滚成本：桥接代码可从 `git log -- engine/musicdl` 找回；
> CPython 运行时与 musicdl 依赖需要联网重下，不会再随仓库出现。

## 六、验证方法

```bash
npm run typecheck     # 全量类型检查
npm test              # 单元测试
npm run engine:test   # 引擎测试（含音源结构与缓存）
npm run build         # 主进程 / 渲染进程构建
npm run demo:audio    # 演示音频重新生成（产物大小应与仓库内一致）
```

判定标准：仓库内 `git grep -l "import.*python"` 无结果；`npm run dist` 产出的安装包
`resources/` 下不再有 `python/`，安装后磁盘占用降约 300 MB。

## 七、注释与命名

`src` 与 `scripts` 下已无 Python 提及（`grep -ri python` 为空）。迁移期 62 处
「与 Python 版一致 / 对齐」的注释已改写为规则本身的说明——例如「缺 identifier 时
id 用元信息 md5 前 16 位」「错误码被 `toProviderError` 按 code 映射」，
不再引用已删除的实现。

保留的命名：`musicdl`（provider 与服务层仍在用）、`engine/ts`（目录名，指向 TS 引擎）。
