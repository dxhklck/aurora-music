import type {
  ChartSummary,
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { parseLrc, buildLyric } from '@shared/lyric'
import { BaseProvider } from './base'
import { ProviderError, type SearchArgs } from './types'
import { localUrl } from '../media'
import { fileSize } from '../utils'
import { join } from 'node:path'

interface DemoTrack {
  file: string
  song: Song
  lrc: string
  /** 逐字 yrc；为空时降级为整行高亮 */
  yrc?: string
}

/**
 * 内置演示音源：完全离线，用于首次启动即可体验播放 / 歌词 / 下载全链路，
 * 也是「新增平台只需实现接口」的最小样例（不含任何网络请求）。
 */
export class DemoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'demo',
    name: '极光精选',
    short: 'Aurora',
    color: '#7c6cff',
    gradient: ['#7c6cff', '#2a1d6e'],
    capabilities: { search: true, charts: true, stream: true, lyric: true },
    description: '内置离线曲目，无需网络即可体验完整功能'
  }

  private readonly tracks: DemoTrack[]

  constructor(private readonly demoDir: string) {
    super()
    this.tracks = buildTracks(demoDir)
  }

  protected baseHeaders(): Record<string, string> {
    return {}
  }

  async search({ keyword, page, limit }: SearchArgs): Promise<SearchPage> {
    const key = keyword.trim().toLowerCase()
    const matched = key
      ? this.tracks.filter(
          (t) =>
            t.song.name.toLowerCase().includes(key) ||
            t.song.album.toLowerCase().includes(key) ||
            t.song.artists.join(' ').toLowerCase().includes(key)
        )
      : this.tracks
    const start = (page - 1) * limit
    const items = matched.slice(start, start + limit).map((t) => t.song)
    return { items, total: matched.length, page, hasMore: start + limit < matched.length }
  }

  async charts(): Promise<ChartSummary[]> {
    return [
      {
        id: 'aurora-picks',
        platform: this.info.id,
        name: '极光精选',
        subtitle: '为深夜与通勤准备的合成器小品',
        coverUrl: null,
        trackCount: this.tracks.length,
        updateFrequency: '离线内置'
      }
    ]
  }

  async chartDetail({
    page,
    limit
  }: {
    id: string
    page: number
    limit: number
  }): Promise<SearchPage> {
    const start = (page - 1) * limit
    return {
      items: this.tracks.slice(start, start + limit).map((t) => t.song),
      total: this.tracks.length,
      page,
      hasMore: start + limit < this.tracks.length
    }
  }

  async resolveStream(song: Song, _quality: Quality): Promise<StreamInfo> {
    const track = this.tracks.find((t) => t.song.id === song.id)
    if (!track) throw new ProviderError('empty', '演示曲目不存在', this.info.id)
    const path = join(this.demoDir, track.file)
    const size = await fileSize(path)
    if (!size) throw new ProviderError('empty', '演示音频缺失，请运行 npm run demo:audio', this.info.id)
    return {
      url: localUrl(path),
      quality: 'high',
      label: 'WAV 44.1k',
      format: 'wav',
      expiresAt: Number.MAX_SAFE_INTEGER
    }
  }

  async lyric(song: Song): Promise<Lyric | null> {
    const track = this.tracks.find((t) => t.song.id === song.id)
    if (!track) return null
    // 有 yrc 时走 buildLyric，得到带 words 的逐字歌词；否则用 LRC。
    if (track.yrc) {
      return buildLyric(track.lrc, '', '内置歌词', track.yrc)
    }
    const parsed = parseLrc(track.lrc)
    return {
      lines: parsed.lines,
      offset: parsed.offset,
      translated: false,
      source: '内置歌词'
    }
  }
}

const LRC_NIGHT = `[00:00.00]夜航 · Night Flight
[00:02.50]城市把灯举过头顶
[00:07.00]我在低空慢慢滑行
[00:11.50]云层背面没有回声
[00:16.00]只有心跳在数星星
[00:20.50]如果夜色是一张唱片
[00:25.00]我愿意循环这一遍
[00:29.50]让风把坐标都吹散
[00:34.00]落地之前不必说晚安`

/** 夜航的逐字 yrc：[行起始ms,行时长](字起始ms,字时长,0)字…
 *  与 LRC_NIGHT 逐行对齐，用于演示逐字渐变（离线、稳定可复现）。 */
const YRC_NIGHT = `[2500,4000](2500,330,0)城(2830,300,0)市(3130,270,0)把(3400,300,0)灯(3700,400,0)举(4100,400,0)过(4500,300,0)头(4800,330,0)顶(5130,870,0)
[6500,4500](6500,330,0)我(6830,300,0)在(7130,280,0)低(7410,320,0)空(7730,350,0)慢(8080,300,0)慢(8380,320,0)滑(8700,400,0)行(9100,1900,0)
[11000,5000](11000,320,0)云(11320,300,0)层(11620,280,0)背(11900,300,0)面(12200,320,0)没(12520,300,0)有(12820,350,0)回(13170,400,0)声(13570,1430,0)
[16000,4500](16000,330,0)只(16330,300,0)有(16630,280,0)心(16910,300,0)跳(17210,350,0)在(17560,320,0)数(17880,350,0)星(18230,400,0)星(18630,870,0)
[20500,4500](20500,320,0)如(20820,300,0)果(21120,280,0)夜(21400,300,0)色(21700,350,0)是(22050,300,0)一(22350,320,0)张(22670,350,0)唱(23020,380,0)片(23400,1600,0)
[25000,4500](25000,320,0)我(25320,300,0)愿(25620,280,0)意(25900,320,0)循(26220,350,0)环(26570,320,0)这(26890,350,0)一(27240,400,0)遍(27640,1860,0)
[29500,4500](29500,330,0)让(29830,300,0)风(30130,280,0)把(30410,300,0)坐(30710,350,0)标(31060,320,0)都(31380,350,0)吹(31730,400,0)散(32130,1870,0)
[34000,4000](34000,330,0)落(34330,300,0)地(34630,280,0)之(34910,300,0)前(35210,350,0)不(35560,320,0)必(35880,350,0)说(36230,400,0)晚(36630,370,0)安`

const LRC_MIST = `[00:00.00]晨雾 · Morning Mist
[00:03.00]六点半的街道很轻
[00:08.00]玻璃上写着谁的姓名
[00:13.00]咖啡把时间泡得很慢
[00:18.00]阳光在杯沿停一停
[00:23.00]雾散之后我们去哪
[00:28.00]沿着河岸一直走好吗
[00:33.00]把昨天折叠成纸船
[00:37.00]放进今天的水洼`

const LRC_NEON = `[00:00.00]霓虹 · Neon
[00:02.00]霓虹在雨里打了个结
[00:06.50]出租车载着午夜
[00:11.00]我们谈论无关的细节
[00:15.50]把沉默留给音乐
[00:20.00]再快一点 再亮一点
[00:24.50]把心跳调到同一拍
[00:29.00]天亮之前不必告别
[00:33.50]让这座城市继续通电`

function buildTracks(demoDir: string): DemoTrack[] {
  void demoDir
  return [
    {
      file: 'night-flight.wav',
      lrc: LRC_NIGHT,
      yrc: YRC_NIGHT,
      song: {
        id: 'demo-night-flight',
        platform: 'demo',
        name: '夜航',
        artists: ['Aurora Studio'],
        album: 'Offline Sessions',
        coverUrl: null,
        duration: 40_000,
        qualityLabel: '44.1k WAV'
      }
    },
    {
      file: 'morning-mist.wav',
      lrc: LRC_MIST,
      song: {
        id: 'demo-morning-mist',
        platform: 'demo',
        name: '晨雾',
        artists: ['Aurora Studio'],
        album: 'Offline Sessions',
        coverUrl: null,
        duration: 40_000,
        qualityLabel: '44.1k WAV'
      }
    },
    {
      file: 'neon.wav',
      lrc: LRC_NEON,
      song: {
        id: 'demo-neon',
        platform: 'demo',
        name: '霓虹',
        artists: ['Aurora Studio'],
        album: 'Offline Sessions',
        coverUrl: null,
        duration: 40_000,
        qualityLabel: '44.1k WAV'
      }
    }
  ]
}
