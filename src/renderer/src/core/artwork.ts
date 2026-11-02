/**
 * 任务栏媒体面板（SMTC / macOS Now Playing）的封面地址。
 *
 * Chromium 156（Electron 45）起，`MediaMetadata.artwork` 的 `src` 只接受
 * `http:` / `https:` / `data:` / `blob:`，其它协议会被丢弃并打一条警告：
 *
 *   MediaImage src can only be of http/https/data/blob scheme: muse://media/?u=...
 *
 * 而本项目大部分封面走 `muse://media/?u=<encoded>&r=<referer>` 代理——那是给
 * `<img>` 用的，用来补 Referer、绕开图床的防盗链。直接塞进 MediaMetadata 的结果是
 * 「界面有封面、任务栏没有」，且只有渲染层一条警告，很难联想到是协议问题。
 *
 * 所以这里把代理地址还原成原始 http(s) 地址：媒体面板由系统自己去拉图，
 * 不需要 Referer（需要的图床本来也拿不到，那就退化成无封面，不报错）。
 * 本地封面（`muse://local/?p=`）无法给系统直接读，返回 undefined。
 *
 * 还原出来的地址如果是 `http:`，顺手升到 `https:`：渲染层的 CSP 是
 * `img-src 'self' data: blob: muse: https: http://127.0.0.1:*`，http 图会被直接拦掉
 * （控制台一条 CSP 违规，封面照样没有）。主图床都是 https 可达的。
 */
export function artworkSrc(coverUrl: string | null | undefined): string | undefined {
  const raw = (coverUrl ?? '').trim()
  if (!raw) return undefined
  if (/^data:/i.test(raw) || /^blob:/i.test(raw)) return raw
  if (/^https:/i.test(raw)) return raw
  if (/^http:/i.test(raw)) return raw.replace(/^http:/i, 'https:')

  // 只有代理地址需要还原；其余自定义协议（muse://local 等）系统读不到
  if (!/^muse:\/\//i.test(raw)) return undefined
  try {
    const url = new URL(raw)
    if (url.hostname !== 'media') return undefined
    const target = url.searchParams.get('u') ?? ''
    if (/^https?:\/\//i.test(target)) return target.replace(/^http:/i, 'https:')
    return undefined
  } catch {
    return undefined
  }
}
