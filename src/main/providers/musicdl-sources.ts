/**
 * musicdl 引擎音源清单（纯数据，无任何 Node 依赖）。
 *
 * 拆出独立文件的动机：Android 桥（renderer/bridge/mobile.ts）要复用这份
 * 清单注册引擎音源，而 musicdl.ts 引着 subprocess 引擎运行时
 * （node:child_process / electron）——那些进不了 WebView。
 * 桌面版与移动端共用同一份事实来源，改这里即可。
 */

export interface SourceSpec {
  key: string
  name: string
  short: string
  color: string
  gradient: [string, string]
  description: string
  note?: string
  /** 播放地址必须带的 Referer；为空时只用引擎回传的请求头 */
  referer?: string
}

export const MUSICDL_SOURCES: SourceSpec[] = [
  {
    key: 'kugou',
    name: '酷狗音乐',
    short: '酷狗',
    color: '#2aa3ff',
    gradient: ['#4fc3ff', '#0b4a7a'],
    description: '概念版曲库，320k 直链',
    note: '部分歌曲需要客户端签名，失败时自动换源'
  },
  {
    key: 'migu',
    name: '咪咕音乐',
    short: '咪咕',
    color: '#ff6a00',
    gradient: ['#ff9a3d', '#7a2f00'],
    description: '正版曲库，无损资源较多'
  },
  {
    key: 'qianqian',
    name: '千千音乐',
    short: '千千',
    color: '#3f7cff',
    gradient: ['#6f9bff', '#16265c'],
    description: '原百度音乐曲库'
  },
  {
    key: 'fivesing',
    name: '5sing 原创',
    short: '5sing',
    color: '#ff5c8a',
    gradient: ['#ff87ab', '#6d1f38'],
    description: '原创与翻唱作品聚集地'
  },
  {
    key: 'bodian',
    name: '波点音乐',
    short: '波点',
    color: '#7c5cff',
    gradient: ['#a58cff', '#2c1f66'],
    description: '短视频热门 BGM 曲库'
  },
  {
    key: 'streetvoice',
    name: '街声',
    short: '街声',
    color: '#22c55e',
    gradient: ['#5ce08d', '#0d3b22'],
    description: '独立音乐人作品'
  },
  {
    key: 'bilibili',
    name: '哔哩哔哩',
    short: 'B站',
    color: '#fb7299',
    gradient: ['#ff9db5', '#5c1d2c'],
    description: '视频音轨与音乐区投稿'
  },
  {
    key: 'jiosaavn',
    name: 'JioSaavn',
    short: 'Jio',
    color: '#2bc48a',
    gradient: ['#5ce0b0', '#0c3f2c'],
    description: '印度与南亚曲库'
  },
  {
    key: 'jamendo',
    name: 'Jamendo',
    short: 'Jam',
    color: '#f59e0b',
    gradient: ['#ffc45c', '#5c3a05'],
    description: 'CC 授权独立音乐'
  },
  {
    key: 'ccmixter',
    name: 'ccMixter',
    short: 'ccM',
    color: '#f472b6',
    gradient: ['#ffa3d1', '#5c1f3d'],
    description: '可商用的混音素材'
  },
  {
    key: 'opengameart',
    name: 'OpenGameArt',
    short: 'OGA',
    color: '#84cc16',
    gradient: ['#b6e85c', '#2f4705'],
    description: '游戏音乐与音效'
  },
  {
    key: 'wikimedia',
    name: '维基共享',
    short: 'Wiki',
    color: '#64748b',
    gradient: ['#9aa8bb', '#1f2937'],
    description: '公共领域音频'
  },
  {
    key: 'audius',
    name: 'Audius',
    short: 'Aud',
    color: '#cc0fe0',
    gradient: ['#e86bff', '#4a0a52'],
    description: '去中心化音乐平台'
  },
  {
    key: 'fma',
    name: 'Free Music Archive',
    short: 'FMA',
    color: '#0ea5e9',
    gradient: ['#5cc9f5', '#0a3a52'],
    description: '免费授权音乐库'
  },
  {
    key: 'soundcloud',
    name: 'SoundCloud',
    short: 'SC',
    color: '#ff5500',
    gradient: ['#ff8a4d', '#5c2100'],
    description: '全球独立音乐社区',
    note: '部分曲目需要登录 Cookie'
  }
]
