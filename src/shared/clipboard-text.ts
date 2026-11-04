/**
 * 把剪贴板原文清成可以直接丢进搜索框的关键词。
 *
 * 规则刻意保守：只做去噪，不改写内容。搜不到是搜索的事，
 * 自作聪明地「提取歌名」会把「周杰伦 - 晴天」切成「晴天」，反而更差。
 *
 * 1. 去掉 http/https 链接（分享文案里最常见）
 * 2. 取第一行有内容的文本（多行复制通常第一行就是歌名）
 * 3. 连续空白压成一个空格
 * 4. 超过 60 字截断
 * 5. 没有字母 / 数字（纯表情、纯标点）视为不可搜
 */

export const CLIPBOARD_KEYWORD_MAX = 60

export function clipboardKeyword(raw: string): string {
  if (typeof raw !== 'string' || !raw) return ''
  const withoutLinks = raw.replace(/https?:\/\/\S+/gi, ' ')
  const lines = withoutLinks
    .split(/\r?\n/)
    .map((line) => line.replace(/[\s\u3000]+/g, ' ').trim())
    .filter((line) => line.length >= 2)
  const line = lines[0] ?? ''
  if (!line) return ''
  const clipped = line.slice(0, CLIPBOARD_KEYWORD_MAX).trim()
  // 纯标点/表情（如「😀😀😀」「……」）搜出来只会是噪音
  return /[\p{L}\p{N}]/u.test(clipped) ? clipped : ''
}
