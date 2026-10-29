import type { SourceClient, SourceMeta } from '../types'
import { AudiusSource } from './audius'
import { BilibiliSource } from './bilibili'
import { BodianSource } from './bodian'
import { CcmixterSource } from './ccmixter'
import { FiveSingSource } from './fivesing'
import { FmaSource } from './fma'
import { JamendoSource } from './jamendo'
import { JiosaavnSource } from './jiosaavn'
import { KugouSource } from './kugou'
import { MiguSource } from './migu'
import { OpenGameArtSource } from './opengameart'
import { QianqianSource } from './qianqian'
import { SoundCloudSource } from './soundcloud'
import { StreetVoiceSource } from './streetvoice'
import { WikimediaSource } from './wikimedia'

/**
 * 音源注册表。
 *
 * 只登记「无需登录 / 无 DRM」的 15 个源。netease / qq / kuwo 由 Aurora 原生适配器
 * 负责（支持榜单与逐字歌词），
 * 这里刻意不重复注册，避免同一个平台出现两套行为。
 *
 * pageSize 决定分页并行的粒度，按音源实测标定：
 * 酷狗 2（每页 2 条拆成 5 页并发）、咪咕 3（每页 2 条会从 6s 退化到 50s+），
 * 其余沿用默认 3。
 */
const BUILDERS = new Map<string, () => SourceClient>([
  ['kugou', () => new KugouSource()],
  ['migu', () => new MiguSource()],
  ['qianqian', () => new QianqianSource()],
  ['fivesing', () => new FiveSingSource()],
  ['bodian', () => new BodianSource()],
  ['streetvoice', () => new StreetVoiceSource()],
  ['bilibili', () => new BilibiliSource()],
  ['jiosaavn', () => new JiosaavnSource()],
  ['jamendo', () => new JamendoSource()],
  ['ccmixter', () => new CcmixterSource()],
  ['opengameart', () => new OpenGameArtSource()],
  ['wikimedia', () => new WikimediaSource()],
  ['audius', () => new AudiusSource()],
  ['fma', () => new FmaSource()],
  ['soundcloud', () => new SoundCloudSource()]
])

export const SOURCE_META: SourceMeta[] = [
  { key: 'kugou', label: '酷狗音乐', pageSize: 2 },
  { key: 'migu', label: '咪咕音乐', pageSize: 3 },
  { key: 'qianqian', label: '千千音乐', pageSize: 3 },
  { key: 'fivesing', label: '5sing 原创', pageSize: 3 },
  { key: 'bodian', label: '波点音乐', pageSize: 3 },
  { key: 'streetvoice', label: '街声', pageSize: 3 },
  { key: 'bilibili', label: '哔哩哔哩', pageSize: 3 },
  { key: 'jiosaavn', label: 'JioSaavn', pageSize: 3 },
  { key: 'jamendo', label: 'Jamendo', pageSize: 3 },
  { key: 'ccmixter', label: 'ccMixter', pageSize: 3 },
  { key: 'opengameart', label: 'OpenGameArt', pageSize: 3 },
  { key: 'wikimedia', label: '维基共享', pageSize: 3 },
  { key: 'audius', label: 'Audius', pageSize: 3 },
  { key: 'fma', label: 'Free Music Archive', pageSize: 3 },
  { key: 'soundcloud', label: 'SoundCloud', pageSize: 3 }
]

export function hasSource(key: string): boolean {
  return BUILDERS.has(key)
}

/** 每次新建实例：音源本身无跨请求状态，避免并发搜索互相污染 */
export function createSource(key: string): SourceClient | null {
  const builder = BUILDERS.get(key)
  return builder ? builder() : null
}

export function availableSources(): SourceMeta[] {
  return SOURCE_META.filter((meta) => BUILDERS.has(meta.key))
}

export {
  AudiusSource,
  BilibiliSource,
  BodianSource,
  CcmixterSource,
  FiveSingSource,
  FmaSource,
  JamendoSource,
  JiosaavnSource,
  KugouSource,
  MiguSource,
  OpenGameArtSource,
  QianqianSource,
  SoundCloudSource,
  StreetVoiceSource,
  WikimediaSource
}
