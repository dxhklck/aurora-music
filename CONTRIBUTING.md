# 贡献指南

> 对应版本：1.5.0 · 最后核对：2026-11-02

这个项目是单人维护的教学项目（Electron + Vue 3 + TypeScript 的桌面音乐播放器）。
欢迎 issue 与 PR，但有几条边界先说清楚，避免白做功。

---

## 一、跑起来

需要 **Node ≥ 22.6**（`.nvmrc` 里写的是 22；22.6 是 `--experimental-strip-types` 的下限，
测试脚本靠它直接跑 `.ts`）与 Windows / macOS / Linux 桌面环境。

```bash
npm ci                # 严格按 lock 装，别用 npm install 改依赖树
npm run dev           # 开发模式（热更新）
```

> ⚠️ 如果你的终端继承了 `ELECTRON_RUN_AS_NODE=1`（某些 IDE / 代理工具会注入），
> Electron 会以纯 Node 模式启动，表现为「一启动就退出、什么都不显示」。
> `npm run selftest` 与 `npm run shots` 内部会剔除这个变量；手动跑 `electron` 时请自己 `unset`。

## 二、四道检查（PR 前必须全绿）

```bash
npm run typecheck     # vue-tsc + tsc，零 error
npm test              # 单元测试（Node 原生 runner，139 例）
npm run engine:test   # 引擎层单元测试（92 例）
npm run build         # 三端产物必须能出
```

改动涉及主进程链路（搜索 / 取址 / 下载 / 落库 / 协议）时，再跑一次集成自检：

```bash
npm run selftest      # 无界面启动 Electron，真跑一遍全链路（用临时目录，不动你的数据）
```

CI 在推 `main` 与打 tag 时会跑前两项；三平台打包只在 tag / 手动触发时跑
（macOS runner 是 10× 计费，双跑会烧掉月度额度）。

## 三、代码约定

这些不是偏好，是这个项目已经踩过的坑：

1. **不用 `any`**。全仓 `as any` / `@ts-ignore` 都是 0 处，`noUnusedLocals` 已打开。请保持。
2. **渲染层不要用 Chrome 92+ 的 API**。`electron.vite.config.ts` 为兼容旧 WebView 把
   renderer 压到 `target: 'es2017'`，`crypto.randomUUID` / `structuredClone` / `toSorted`
   一律不可用（用了在老内核里白屏，本地开发看不出来）。
3. **JSON 落盘走 `services/atomic-write.ts`**。不要自己写 `writeFile(tmp) + rename`——
   并发写会抢同一个 `.tmp`，这个 bug 修过三次。多文件要一起提交时用 `commitGroup`。
4. **新增 IPC 通道要同步四处**：`shared/ipc.ts` → `main/ipc.ts` → `preload/index.ts` →
   `shared/api.ts`。漏一处编译器不报错，运行期才发现。`tests/ipc-contract.test.ts` 会兜住
   大部分情况，但别依赖它。
5. **渲染层传数组给主进程前先展开**。`ref([]).value` 是响应式代理，结构化克隆会抛
   `An object could not be cloned`，而这个错误会被 errorHandler 吞掉，表现为「点了没反应」。
6. **改 UI 文案时顺手看 `src/renderer/src/data/guide.ts`**。应用内指南（F1）里的说法
   必须和实际行为一致——这个项目出过两次「提示说能做、代码做不到」。

## 四、提交与 PR

- 提交信息用 Conventional Commits：`fix(...)` / `feat(...)` / `chore(...)` / `docs(...)` / `ci(...)`。
  正文写**为什么**，不要复述 diff。
- 一个 PR 只做一件事。把「修 bug + 顺手重构 + 调格式」混在一起会让 review 无法进行。
- 不要提交 `out/`、`dist/`、`artifacts/`、`node_modules/`（已在 `.gitignore`）。
- 不要为了通过检查去改测试的期望值。测试挂了先确认是实现错了还是期望错了。

## 五、什么 PR 受欢迎

- **新的引擎音源**（不需要登录、无 DRM）：见 [`docs/adding-a-source.md`](adding-a-source.md)
- **修上游失效**：某个平台改了接口导致搜不到 / 播不了
- **修 bug**：带上复现步骤与现象，最好能指出是哪一层出的问题
- **文档纠错**：尤其是「文档说的和实际行为不一致」

## 六、什么 PR 会被拒绝（不是不礼貌，是定位问题）

- **加 AI 推荐 / 云同步 / 账号体系**：这个项目的定位是本地优先、无后端、MIT 自托管。
  上云等于给一个教学项目增加一份隐私承诺和一份服务器账单。
- **移动端适配**：Electron 只支持桌面三平台。移动端是另一个独立项目，不在本仓库。
- **UI 国际化（i18n）**：界面布局是像素级算过的（迷你条 380×56 的宽度分配写死在代码里），
  英文一上先崩布局。要传播力，英文 README 比半吊子 i18n 有效。
- **引入重型依赖**：运行时依赖目前只有 5 个，这是资产不是吝啬。加依赖请在 PR 里说明
  为什么现有代码做不到。
- **纯格式化的 PR**：这类改动会砸掉 git blame。要统一格式请先开 issue 讨论。

## 七、报告问题

提 issue 时请附上**诊断包**：设置 → 关于 → 导出诊断。它包含版本、平台、设置快照
（已脱敏：白名单字段，Cookie 与路径不会带上）、音源巡检结果与最近日志。

一个能直接定位的 issue 长这样：

```
版本：1.4.0（Windows 11 x64）
现象：切换到「酷狗」搜「晴天」返回 0 条，其它音源正常
时间：2026-11-02 15:20 左右
诊断包：已附
```

「打不开」「没声音」这类描述无法处理——请补上「点了什么、期望什么、实际什么」。

## 八、许可

提交 PR 即表示同意以项目的 MIT 许可发布你的贡献。

注意 `NOTICE` 的约定：**项目的名称与图标不随 MIT 授权**。基于本项目的二次分发必须改名换图标，
避免用户把修改版当成官方版本（官方发行渠道只有 GitHub 与 GitCode 两个）。
