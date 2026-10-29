# 桌面歌词：闲置裸字 / 悬停浮出面板

桌面歌词窗口的两种状态，以及为了「没有背景也能读」所做的取舍。

| 状态 | 触发 | 表现 |
|---|---|---|
| **闲置（bare）** | 鼠标不在窗口内 | 全透明：没有面板、边框、投影，也没有工具栏 / 关闭按钮 / 署名。只剩歌词文字 + 描边 |
| **悬停（hover）** | 鼠标进入窗口 | 面板 180ms 淡入（半透明深色 + 1px 边框 + 外投影），同时工具栏、关闭按钮、底部署名淡入 |

过渡只动 `opacity` 与 `box-shadow`，不触发重排；文字本身始终在场，不会跟着面板一起闪。

## 1. 面板为什么画在伪元素上

`background` 是 `linear-gradient`，CSS 无法在两个渐变之间插值，直接过渡 `background` 会硬切。
所以面板画在 `.lyric-window::before`，只过渡 `opacity`：

```css
.lyric-window::before { opacity: 0; transition: opacity .18s ease; z-index: 0 }
.lyric-window:hover::before { opacity: 1 }
```

两个踩过的坑：

- **`z-index: -1` 在透明窗口里完全不可见。** 负层级会被合成器裁掉（实测面板整个消失）。
  改回 `0` 后靠「伪元素是第一个子盒」保证它在文字下面——文字的 `filter` 会生成层叠上下文，
  天然盖在面板之上。
- **投影不能放在伪元素上。** 父级 `overflow: hidden` 会把子盒的投影裁掉，
  所以 `box-shadow` 留在 `.lyric-window` 自身，随 `:hover` 一起过渡。

## 2. 没有面板时怎么保证可读

主歌词是白色渐变字，落在亮壁纸上对比只有约 **1.1:1**（实测面板 `#a1a3a9` / 文字 `#dde2df` 时为 1.92:1）。
裸字状态必须自带轮廓，但**描边只有一种写法能用**：

```css
.line { -webkit-text-stroke: .8px var(--ly-outline); paint-order: stroke fill }
```

不能用 `text-shadow`，也不能用连环 `drop-shadow`：

| 方案 | 结果 |
|---|---|
| `text-shadow` 四向 1px | 这行是 `background-clip: text` 的渐变字，填充色其实是**背景**，而 `text-shadow` 画在背景**之上**——四个偏移副本把整个字形盖成实心黑板，字直接看不见 |
| `drop-shadow()` × 5 | 每次都会把上一轮累积的半透明光晕当作输入再投影，alpha 反复叠加，同样糊成一团黑板 |
| `-webkit-text-stroke` | 只画 1px 边缘，可被逐字的 `.w-base/.w-fill` 继承，字心仍是渐变 |

小字（上一行 / 下一行 / 署名）是实色字，`text-shadow` 反而合适，用 `--ly-outline-soft` 做 0.8px 四向细描边。

配套的对比度微调（都只在深色调色板，歌词窗口恒定深色）：

| 变量 | 原值 | 现值 | 原因 |
|---|---|---|---|
| `--ly-wbase`（未唱部分） | 0.28 | 0.42 | 没有面板时 28% 白几乎归零，看不出唱到哪 |
| `--ly-fg-3`（署名 / 上下行） | 0.32 | 0.45 | 同上 |

## 3. 已知边界

- **闲置时窗口仍然拦截点击**（未锁定时）。透明区域会挡住桌面，这是「无边框、可拖动」的代价；
  要完全不挡桌面，用工具栏的锁定按钮（穿透），鼠标移上去会临时恢复交互。
- **歌词窗口不跟随主题**：始终使用深色调色板，`html[data-theme='light']` 那套 `--ly-*` 目前不会生效。
- 面板淡入不改变窗口尺寸，所以窗口四周没有额外留白，投影只在窗口内可见。

## 4. 截图

| 闲置（亮壁纸） | 悬停（亮壁纸） |
|---|---|
| ![裸字](./shots/lyric-bare-light.png) | ![面板](./shots/lyric-hover-light.png) |

| 闲置（暗壁纸） | 悬停（暗壁纸） |
|---|---|
| ![裸字暗](./shots/lyric-bare-dark.png) | ![面板暗](./shots/lyric-hover-dark.png) |

3 倍放大：描边只占 0.8px，字心仍然是渐变——

![描边细节](./shots/lyric-zoom-light.png)
