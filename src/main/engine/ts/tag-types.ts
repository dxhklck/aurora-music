/** 标签写入的公共类型（供 tag-mp4 / tag-ogg / tag 共用，避免循环依赖） */

export interface TagPayload {
  path: string
  title: string
  artists: string
  album: string
  lyric?: string
  track?: number
}

export interface TagResult {
  ok: boolean
  skipped?: string
  error?: string
}

/** 写入器实际需要的字段（track 仅 ID3 写入，m4a/ogg 忽略） */
export interface TagFields {
  title: string
  artists: string
  album: string
  lyric?: string
  track?: number
}
