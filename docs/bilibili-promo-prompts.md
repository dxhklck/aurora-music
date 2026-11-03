# Aurora Music · B 站介绍视频生图提示词

> 用途：为 B 站横版介绍视频生成一套风格统一的分镜图，覆盖「封面 → 桌面版 → 移动版 → 双端联动」。
> 适用模型：ChatGPT（GPT-Image / DALL·E 3）。提示词以英文给出——中文描述会被模型"意译"掉细节，英文锚点更稳。
> 对应版本：桌面版 v1.6.0（Electron 45）· 移动版按同源设计语言描述
> 最后核对：2026-11-03

---

## 一、先读这一节（三条硬规则）

**1. 不要指望 AI 生成正确的中文界面文字。**
所有提示词里都写了 `UI text rendered as soft abstract glyphs, unreadable micro-text`。这是刻意的：模型生成的中文字符一定是乱码或错字，放大后非常明显。正确做法是——**让 AI 生成"有文字的质感"，后期用真截图贴片或加设计字覆盖**。真正需要观众读到的信息（歌名、功能名）全部后期叠加。

**2. 不要出现真实平台 Logo 与歌手照片。**
提示词里用 `fictional album artwork`、`abstract geometric cover art` 代替。否则要么被模型拒答，要么生成近似商标的图形，上传 B 站有风险。

**3. 每条提示词 = 风格锚点 + 场景描述。**
下面的 `STYLE` 段（第 2 节）是**所有图共用**的。为方便你逐条粘贴，第 3 节的每条提示词已经把风格锚点内联进去了，可整段直接复制。如果你在同一个对话里连续生成，也可以只发场景部分并说"沿用上面的风格"。

---

## 二、统一视觉设定（Style Bible）

这套设定的目标是：**八张图拼起来像同一个片子里切的镜头**，而不是八个不同设计师做的海报。

### 2.1 色彩

| 角色 | 色值 | 用在哪 |
|---|---|---|
| 底色 | `#0B0B10` 近黑 | 全局背景、UI 底 |
| 次层 | `#15151C` | 侧栏、卡片底 |
| 主强调（珊瑚红） | `#E8455C` | 播放按钮、进度条、高亮导航、hero 标题 |
| 次强调（紫蓝） | `#7B6CF6` | 频谱柱、数据图形、辅助光 |
| 文字 | `#F2F3F5` / `#8A8D99` | 主文字 / 次要文字 |
| 描边 | 白 8%–12% | 玻璃面板的细分隔线 |

**比例约束**：暗部占画面 70% 以上。红只作点缀（单张图里红色面积不超过 12%），紫色作为环境光晕。两张强调色都用在"发光"上，不用在大色块上——这是这套视觉高级感的来源。

### 2.2 材质与光线

- **毛玻璃**：面板有 12–16px 圆角、细白描边、背景模糊
- **黑胶**：斜置圆盘，有细密沟槽反光，中心一张抽象封面
- **光**：单一主光源（屏幕自发光）＋ 左上轮廓光（rim light），加一层极淡的烟雾/体积光
- **质感**：电影级产品摄影 + 3D 渲染（Octane / Blender 观感），细颗粒（film grain），浅景深
- **不要**：纯白背景、扁平插画、赛博朋克霓虹堆料、霓虹紫渐变俗套、卡通吉祥物

### 2.3 英文风格锚点（STYLE）

```
Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.
```

### 2.4 负面提示词（NEGATIVE）

每条末尾追加：

```
--no legible text, no Chinese characters, no brand logos, no watermark, no real
person faces, no cartoon mascot, no bright white background, no cluttered desktop
icons, no oversaturated cyberpunk neon, no purple-pink gradient cliché, no
low-poly, no flat vector illustration
```

> DALL·E 3 不认 `--no` 语法，请把负面项写成自然语言追加：
> `Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots, white backgrounds and oversaturated neon.`

---

## 三、分镜清单

| 编号 | 用途 | 画面主题 | 建议时长 | 画幅 |
|---|---|---|---|---|
| S1 | 视频封面 / 开篇 0–5s | 桌面 + 手机同框，极光氛围，上方留标题区 | 5s | 16:9（可裁 16:10 做封面） |
| S2 | 桌面版开场 | 首页：酒红 hero + 倾斜黑胶 + 榜单卡 + 播放条 | 6s | 16:9 |
| S3 | 桌面版高潮 | 歌词舞台：黑胶 + 紫蓝频谱 + 毛玻璃歌词卡 | 8s | 16:9 |
| S4 | 桌面版专业感 | 本地音乐库：四张统计卡 + 表格 + 批量操作 | 6s | 16:9 |
| S5 | 桌面版差异化 | 迷你播放条悬浮在桌面工作区之上 | 5s | 16:9 |
| S6 | 移动版主场景 | 竖屏播放页，手持，夜间环境 | 6s | 16:9（手机竖置于横画幅） |
| S7 | 移动版功能 | 双机并置：发现页 + 播放页 | 6s | 16:9 |
| S8 | 双端对比 / 联动 | 桌面与手机由一道红色光桥连接 | 6s | 16:9 |

**总时长约 48 秒**，正好是 B 站"介绍视频"的舒适区间（40–60s）。

---

## 四、逐条提示词

### S1 · 视频封面 / 开篇

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 一台显示器显示桌面版首页（斜置黑胶唱片为视觉焦点），一部竖屏手机显示移动版播放页，两者屏幕是画面唯一光源 |
| 构图与视角 | 正面微仰 5°，桌面窗口居中偏左占 2/3，手机悬浮于右前层；**画面上方 1/3 预留深色渐变留白**给标题文字 |
| 风格与配色 | 近黑底 + 酒红光晕，红色仅出现在播放按钮与唱片反光 |
| 光线氛围 | 屏幕自发光打亮桌面与手机边框，左上轮廓光勾出设备轮廓，极淡烟雾 |
| 背景元素 | 虚化的深色房间，悬浮的细尘，远处一圈极光色带 |
| 画幅 | 16:9，1920×1080（封面可再裁 16:10） |

**英文提示词（整段复制）**

```
Wide cinematic hero shot for a music-app promo video. A large dark-mode desktop
music player window floats at a slight 5-degree angle, occupying the left two
thirds of the frame: a narrow icon sidebar on the far left, a deep wine-red hero
banner with a tilted black vinyl record as the focal point, four small chart
cards below it, a song list, and a slim playback bar at the bottom. Hovering in
front on the right, slightly lower, is a vertical smartphone showing a mobile
music playing screen with a square album cover, a thin progress line and three
transport controls. Both screens are the only light sources. The upper third of
the frame is dark negative space reserved for a title.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：这是唯一一张**必须留白**的图。B 站封面在信息流里只有约 240px 宽，主体要够大、够黑、红色够集中，缩略图才认得出。标题建议后期用「Aurora Music｜一个老师的桌面播放器」这类短句压在留白区。

---

### S2 · 桌面版 · 首页

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 桌面版首页窗口，左侧窄侧栏（图标 + 中文导航）、顶部居中搜索栏、主区酒红 hero 横幅 + 右侧倾斜黑胶、下方四个彩色圆点榜单卡、歌曲表格、底部播放条 |
| 构图与视角 | 正面 3/4 微透视（约 8°），窗口占画面 85%，四角露出深色桌面 |
| 风格与配色 | 暗色 UI，珊瑚红作高亮，四个榜单卡各带一颗小色点（红/黄/绿/蓝） |
| 光线氛围 | 屏幕为唯一主光；桌面有一层来自屏幕的酒红反光 |
| 背景元素 | 虚化的书桌环境：一副头戴耳机、一只马克杯、一株小绿植，全部失焦 |
| 画幅 | 16:9 |

**英文提示词**

```
Front-facing slightly perspective-tilted mockup (about 8 degrees) of a dark-mode
desktop music player application filling 85% of the frame. The interface has a
narrow vertical icon sidebar on the left with small Chinese-style nav labels, a
centered rounded search field along the top bar, and a main area containing: a
wide deep-wine-red hero banner with a large headline block on its left and a
tilted black vinyl record with a metallic tonearm on its right; directly below,
a row of four small chart cards each marked by a tiny colored dot; below that a
song table with small square thumbnails; and a slim playback bar pinned to the
bottom with a coral-red circular play button. Soft reflections of the UI spill
onto a dark desk surface.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：这张是"这是什么软件"的第一印象，**hero 横幅和黑胶必须在视觉中心**。桌面道具只做氛围，别抢主体——如果 AI 把耳机画得太大，加一句 `the desk props are heavily blurred in the far background`。

---

### S3 · 桌面版 · 歌词舞台（视觉高潮）

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 全屏歌词舞台：左侧斜置圆形黑胶（中心抽象封面 + 白色唱臂）＋ 一列粗壮的紫蓝渐变频谱柱；右侧一张半透明毛玻璃卡片，内含逐行歌词（当前行更亮） |
| 构图与视角 | 正面平视，左右 45:55 分割，四角轻微暗角 |
| 风格与配色 | 近黑舞台，紫蓝频谱是画面最大面积的非红色元素，红色只剩细进度条 |
| 光线氛围 | 频谱自身发光并映在唱片表面；整体低照度、单一光源、无环境杂光 |
| 背景元素 | 极浅的烟雾，底部一道细红色进度线 |
| 画幅 | 16:9 |

**英文提示词**

```
Interior view of a full-screen immersive lyrics stage inside a dark music player.
On the left half: a large circular black vinyl record tilted in perspective with
abstract geometric album art at its center and a slim white tonearm resting on
it; directly beneath the record, a row of tall chunky equalizer bars glowing in a
violet-to-blue gradient with soft reflections. On the right half: a large
frosted-glass rounded panel containing several lines of lyric text, with one line
slightly brighter as if currently playing, a small source label in its top-right
corner. At the very bottom, a thin coral-red progress line and a row of minimal
transport controls.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：这是整套图里**最该做视频转场落点**的一张。频谱柱是唯一允许"高饱和"的元素——它是这个产品的记忆点。如果生成的频谱太细碎，加 `few wide equalizer bars, roughly 18 to 24 bars, thick and blocky`。

---

### S4 · 桌面版 · 本地音乐库

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 本地音乐库页面：四张并排统计卡（曲目数 / 占用空间 / 下载中 / 存放路径）、一行筛选器（搜索框 + 分段控件 + 四个下拉）、一行批量操作按钮、下方密集歌曲表格（封面缩略图 + 标题 + 专辑 + 时长 + 容量） |
| 构图与视角 | 正面平视，窗口占 90%，极少透视——信息密度优先 |
| 风格与配色 | 表格行有细横线分隔，选中行有淡红底；品质标签是小色块（红 / 橙 / 灰） |
| 光线氛围 | 均匀的冷调环境光，几乎无彩色光晕（与其他几张形成呼吸节奏） |
| 背景元素 | 纯深色，不要道具 |
| 画幅 | 16:9 |

**英文提示词**

```
Straight-on front view of a dark-mode local music library screen filling 90% of
the frame, minimal perspective. Top row: four equal rounded statistic cards
showing a big number and a small caption, the last one a file-path block. Below
them a filter bar: a rounded search field, a small segmented toggle, four compact
dropdown pills, and a result count on the right. Under that a row of small ghost
buttons, one of them outlined in coral red as a destructive action. The rest of
the frame is a dense data table with thin horizontal separators: numbered rows,
a small square album thumbnail, a bold title line with a lighter artist line
beneath, a few tiny colored quality badges, then album, duration and file size
columns. One row is subtly highlighted with a faint red-tinted background.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：这一张的作用是"证明它不只是个好看的壳"。但它最容易画崩——AI 不擅长密集表格。如果表格糊成一片，把要求降级为 `about eight clearly separated rows, generous row height`，宁可少几行也要结构清楚。

---

### S5 · 桌面版 · 迷你播放条（差异化）

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 一根 380×56 的胶囊形迷你播放条，悬浮在桌面工作区之上（下方隐约是代码编辑器 / 浏览器的深色界面），条内含方形封面、歌名歌手、播放控制、细进度条 |
| 构图与视角 | 越肩式俯视，画面聚焦在屏幕中下部，胶囊居中偏下 |
| 风格与配色 | 胶囊是毛玻璃 + 封面模糊做底，与身后的编辑器形成层次 |
| 光线氛围 | 屏幕冷光为主，胶囊边缘有一圈极细的红色描边光 |
| 背景元素 | 失焦的深色代码编辑器、桌面壁纸斜向光带 |
| 画幅 | 16:9 |

**英文提示词**

```
Over-the-shoulder view of a dark desktop workspace, focus on a small floating
capsule-shaped mini player, roughly 380 by 56 pixels, hovering above the screen
content in the lower middle of the frame. The capsule is frosted glass tinted by
a blurred album cover, with a thin coral-red rim light along its edge; inside it,
from left to right: a small square album thumbnail, a bold song title with a
lighter artist name underneath, a thin progress line, and three tiny transport
icons. Behind and around it, a heavily blurred dark code editor with faint
colored syntax blocks and a monitor glow.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：这张是"桌面端才有"的能力证明——移动版没有"常驻桌面不打扰"这回事。配合旁白「写代码的时候它就趴在那儿，不抢焦点」，说服力很强。

---

### S6 · 移动版 · 播放页

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 一部竖屏手机，屏幕为移动版播放页：上方大方形封面，中间歌名与歌手，一根细进度条，一排圆形控制键（中间一颗红色播放键），底部一条迷你播放条 + 四项 Tab 栏 |
| 构图与视角 | 手机竖置于横版画幅中央偏右，占画面高度约 78%，微仰 8°，左侧留出呼吸空间 |
| 风格与配色 | 与桌面版同一套暗色 + 珊瑚红；但版式是**单列大卡片**，没有侧栏、没有多列表格 |
| 光线氛围 | 夜间环境：屏幕照亮周边，背景是暖色台灯与冷色屏幕的双色对比 |
| 背景元素 | 虚化的床头 / 书桌，一副有线耳机，一本合上的书 |
| 画幅 | 16:9（手机竖构图嵌在横画幅里） |

**英文提示词**

```
A vertical smartphone held upright in the center-right of a cinematic 16:9 frame,
occupying about 78% of the frame height, tilted 8 degrees. Its screen shows a
mobile music player: a large square album cover at the top, centered bold song
title and lighter artist name below it, a thin coral-red progress line, and a row
of round transport buttons with one prominent coral-red circular play button; a
compact mini playback bar and a four-item bottom tab bar sit at the very bottom.
The phone is the only screen in frame and its glow lights the fingertips and the
desk edge.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：移动版和桌面版最容易画混。**判别标准只有三条**：竖屏、单列、底部 Tab。提示词里绝不能出现 `sidebar`、`table`、`window controls` 这些词，否则模型会把桌面版糊进手机屏。若生成结果仍像"缩小的桌面版"，加一句 `the layout is a single vertical column with generous spacing, no sidebar, no multi-column table`。

---

### S7 · 移动版 · 发现页（双机）

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 两台竖屏手机错位并置：后机显示发现页（顶部搜索框 + 一张大推荐卡 + 两列榜单卡 + 歌曲列表），前机显示播放页（大封面） |
| 构图与视角 | 前机在右下、后机在左上，形成对角线；两机屏幕是画面唯一光源 |
| 风格与配色 | 同 S6；发现页用卡片网格，播放页用单列 |
| 光线氛围 | 冷调暗环境，屏幕光在手机边框形成高光 |
| 背景元素 | 深色桌面 + 极淡的极光色带 |
| 画幅 | 16:9 |

**英文提示词**

```
Two vertical smartphones arranged diagonally in a cinematic 16:9 frame: the rear
phone upper-left slightly out of focus, the front phone lower-right in sharp
focus. The rear screen shows a mobile discovery feed: a rounded search field at
top, one wide featured card with a large image, a two-column grid of small chart
cards, then a list of song rows. The front screen shows a mobile player with a
large square album cover. Both screens are the only light sources in the scene,
their glow reflecting off each other's aluminum edges.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：一前一后的景深差是这张图好看的关键（`rear phone slightly out of focus`）。两个屏幕都朝镜头，不要出现"背面手机"。

---

### S8 · 双端对比 / 联动

**中文要点**

| 项 | 内容 |
|---|---|
| 画面主体 | 左侧桌面显示器显示歌词舞台（黑胶 + 频谱），右侧手机显示移动版播放页，两个屏幕之间由**一道沿对角线流动的珊瑚红光带 + 细粒子**连接，暗示歌单 / 进度在两端同步 |
| 构图与视角 | 对称式对角线构图，左设备略后、右手机略前，中间的负空间交给光带 |
| 风格与配色 | 两端各保留自己的主元素（桌面=紫蓝频谱，移动=珊瑚红播放键），统一在同一片黑底上 |
| 光线氛围 | 两端屏幕光 + 中间光带，画面最亮的两点是两个屏幕的中心 |
| 背景元素 | 纯黑至深酒红的渐变，极淡烟尘，没有实体道具 |
| 画幅 | 16:9 |

**英文提示词**

```
Symmetrical diagonal composition in a cinematic 16:9 frame, pure dark stage.
On the left, a desktop monitor at a slight angle showing an immersive lyrics
stage: a tilted black vinyl record with abstract cover art and a row of tall
violet-blue equalizer bars beside a frosted-glass lyric panel. On the right,
slightly forward, a vertical smartphone showing a mobile player with a large
square album cover and a coral-red circular play button. Between the two screens,
a single flowing ribbon of coral-red light with fine drifting particles travels
along the diagonal, connecting them and implying the same playlist and progress
synced across both devices. No physical props, only light and darkness.

Aurora Music brand look: near-black cinematic background (#0B0B10) with deep
wine-red ambient bloom; signature coral-red accent (#E8455C) used only as small
glowing highlights, violet-blue secondary accent (#7B6CF6) used for spectrum bars
and data glows; dark-mode UI built from frosted-glass panels, 12-16px rounded
corners, hairline white borders at 8% opacity; cinematic product photography
blended with polished 3D render (Octane/Blender quality), soft volumetric light,
single screen-glow key light plus subtle left-top rim light, faint atmospheric
haze, fine film grain, shallow depth of field, crisp specular highlights on glass
edges; premium, calm, moody; UI text rendered as soft abstract glyphs and
unreadable micro-text; fictional album artwork only; no real logos, no celebrity
faces; 16:9 cinematic widescreen, 1920x1080.

Avoid any legible text, brand logos, watermark, real human faces, cartoon mascots,
white backgrounds and oversaturated neon.
```

**备注**：光带是这张图的"论点"——不要让它画成一条电线或数据线，加 `a ribbon of light, not a cable, weightless and semi-transparent`。如果光带喧宾夺主，减到 `thin, subtle, secondary to the two screens`。

---

## 五、保持一致性的四个操作要点

**1. 固定措辞，不要改写风格段。**
八条里的 `Aurora Music brand look:` 那段必须逐字一致。模型对措辞变化敏感——把 `cinematic product photography` 改成 `product photo` 就会明显跑偏。

**2. 一次生成系列，而不是八次独立对话。**
在新对话的第一条就发 S1，之后每条都加一句 `Keep exactly the same lighting, color grade and material language as the previous image.` 这样比八次冷启动一致得多。

**3. 出图顺序按"锚点优先"。**
先出 **S3（歌词舞台）**——它的元素最独特，最容易判断风格对不对；确认满意后再做 S1、S2。S3 定调，其余跟随。这一步能省掉大量返工。

**4. 用「不满意就指哪改哪」的方式迭代。**
不要说"重画"，要说具体维度：
- `darker background, the red should occupy less area`
- `the vinyl record bigger, more tilted`
- `remove the desk props, keep only the screen glow`
- `the UI rows wider, fewer of them`

---

## 六、可选的「一次生成整套」写法

如果想让模型一次吐出同一系列的多张（一致性最好，但可控性略低），用这段：

```
Generate a consistent set of eight 16:9 cinematic images for a music app promo
video, all sharing one visual system. The system: near-black background
(#0B0B10) with deep wine-red ambient bloom; a coral-red accent (#E8455C) used
only in small glowing highlights; a violet-blue accent (#7B6CF6) for spectrum
bars; dark-mode UI of frosted-glass panels with 12-16px rounded corners and 8%
white hairline borders; cinematic product photography blended with polished 3D
render, soft volumetric light, one screen-glow key light plus a subtle left-top
rim light, faint haze, fine film grain, shallow depth of field.

Shot list:
1. Hero: desktop player window plus a vertical phone, dark negative space at top.
2. Desktop home: wine-red hero banner, tilted vinyl, four chart cards, song
   table, bottom playback bar, blurred desk props.
3. Desktop lyrics stage: tilted vinyl with tonearm, tall violet-blue equalizer
   bars, frosted lyric panel.
4. Desktop library: four statistic cards, a filter bar, a dense data table.
5. Mini player: a small floating glass capsule over a blurred code editor.
6. Mobile player: vertical phone, large album cover, single-column layout,
   bottom tab bar.
7. Mobile discovery: two phones diagonal, card grid feed plus player.
8. Both devices connected by a thin ribbon of coral light.

All UI text must be abstract and unreadable. No logos, no real faces, no white
backgrounds.
```

---

## 七、后期叠加建议

AI 出的图里没有可用文字，最终成片靠这三步补足信息：

**1. 真截图贴片。** 需要观众看清具体功能的地方（榜单名、歌曲名、设置项），直接用 `docs/shots/` 里的真截图做成小窗口浮在 AI 背景上。AI 图当氛围，截图当证据——这是最稳的组合。

**2. 标题与字幕。** 每张图的留白区放一句不超过 12 字的短句：
- S1「一个中学老师写的播放器」
- S3「20 个音源，一起找同一首歌」
- S4「122 首，本地也在库里」
- S5「写代码时，它趴在角落」
- S8「桌面和手机，同一份歌单」

**3. 封面安全区。** B 站封面中心区域会被时长角标和标题遮挡，**主体不要压在中下 1/3**。S1 的桌面窗口建议整体上移一点再导出。

---

## 八、桌面版 / 移动版差异速查（防止画混）

| 维度 | 桌面版 | 移动版 |
|---|---|---|
| 画幅 | 横向窗口，16:9 铺满 | 竖屏，单列大卡片 |
| 导航 | 左侧窄侧栏（图标 + 文字，8 项） | 底部 Tab 栏（约 4 项） |
| 主内容 | hero 横幅 + 4 张榜单卡 + 多列表格 | 大封面 + 单列列表 / 两列卡片 |
| 表格 | 有（# / 标题 / 专辑 / 时长 / 大小） | 无多列表格 |
| 特有元素 | 黑胶唱片 + 唱臂、紫蓝频谱、毛玻璃歌词卡、悬浮胶囊迷你条、多窗口 | 全屏手势进度、底部常驻迷你条、单手可达的大播放键 |
| 强调色用法 | 红色作播放键与高亮，紫色作频谱 | 同色系，但红色更集中在播放键 |
| 常见误画 | 画成网页/浏览器 | 画成"缩小的桌面版" |

**写提示词时的硬约束**：移动版的提示词里**不得出现** `sidebar` / `table` / `window controls` / `multi-column`；桌面版的提示词里**不得出现** `bottom tab bar` / `portrait phone`。

> 移动版已独立立项，上面的版式按同源设计语言推导（竖屏 + 底部 Tab + 单列卡片）。如果实际界面用的是顶部 Tab、抽屉侧栏或别的结构，只需替换第 6、7 条提示词里对应的那两三个词组，风格锚点不用动。
