/**
 * 自动更新的纯逻辑：版本比较 + 渠道选择。
 *
 * 单独成文件的理由只有一个——可单测。`updater.ts` 依赖 electron 与
 * `electron-updater`，import 它就会拖起整个 Electron，测不了；而这两段逻辑
 * 恰好是「判错不会抛异常、只会悄悄做错事」的那类：
 *
 * - 版本判断反了：该提示的不提示，或者提示用户降级；
 * - 渠道选择错了：一个**落后但可达**的源被永久选中，用户停在旧版本里。
 *
 * 零外部 import（连 `./version` 都不要：Node 原生测试的 ESM 解析要求相对导入
 * 带扩展名，而带 `.ts` 扩展名又会给 electron-vite 的构建添麻烦）。
 */

// ─────────────────────────── 版本比较 ───────────────────────────

/**
 * 取前三段数字比较，忽略 `v` 前缀与预发布后缀。
 *
 * 所以 `1.3.12` 与 `1.3.12-beta.1` 被视为同一版本——对「要不要提示更新」来说，
 * 这比把 beta 当新版更安全（否则源上残留的预发布标签会让用户被反复提示）。
 */
function parse(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** a > b 返回正数，a < b 返回负数，相等返回 0 */
export function compareVersion(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l - r
  }
  return 0
}

export function isNewerVersion(remote: string, current: string): boolean {
  return compareVersion(remote, current) > 0
}

// ─────────────────────────── 渠道选择 ───────────────────────────

export interface ChannelProbe {
  /** 便于日志/报错展示的渠道名（渠道 id 为空时给「直连」） */
  id: string
  /** 探测到的远端版本；`null` = 这个渠道抛错或没给出可用版本号 */
  version: string | null
}

export type ChannelDecision =
  /** 第一个「不落后」的渠道。`newer` 表示它上面有新版，`same` 表示已同步 */
  | { index: number; reason: 'newer' | 'same' }
  /** 所有渠道都落后于当前版本（本地构建 / 刚回滚过）：取版本最高者兜底 */
  | { index: number; reason: 'stale' }
  /** 一个渠道都拿不到版本：调用方应报「全部渠道不可达」 */
  | { index: -1; reason: 'none' }

/**
 * 从探测结果里选一个可用渠道。
 *
 * ## 为什么判据是「版本」而不是「有没有抛错」
 *
 * 原来的判据是「探测没抛错就算这个渠道可用」。但「拿得到 latest.yml」不等于
 * 「这个源是最新的」：GitCode 的 `stable` 指针停在旧版本时，`checkForUpdates()`
 * 会**正常返回** `update-not-available`——不抛错，于是渠道被判为可用、写进设置、
 * 直接 `return`，后面能拿到新版的 GitHub 永远不会被尝试。
 *
 * 后果是用户被静默锁死在旧版本：界面显示「已是最新」，而下一次启动连探测都
 * 不做（渠道记忆跨启动）。v1.3.11 → v1.3.12 期间真实发生过。
 *
 * ## 三向判据
 *
 * - `remote >  current`：这个渠道有新版，可用
 * - `remote == current`：这个渠道是同步的，它的「无更新」可信，可用
 * - `remote <  current`：这个渠道落后，它的答案是**无效**（既不能证明有新版，
 *   也不能证明没有），必须顺延下一个
 *
 * 正常情况（主源已同步）行为与旧实现完全一致、请求数不变——第一个渠道就命中。
 * 只有主源落后时才多探一次，这正是我们要的。
 */
export function pickChannel(probes: ChannelProbe[], currentVersion: string): ChannelDecision {
  // 1) 按渠道优先级（顺序即优先级）取第一个不落后的
  for (let index = 0; index < probes.length; index += 1) {
    const version = probes[index].version
    if (!version) continue
    const order = compareVersion(version, currentVersion)
    if (order > 0) return { index, reason: 'newer' }
    if (order === 0) return { index, reason: 'same' }
  }

  // 2) 全落后：取版本最高的那个当 active（它的 latest.yml 至少结构与当前版本同代）。
  //    这一步不能让用户升到更低版本 —— 调用方仍然用 isNewerVersion 判定要不要提示，
  //    所以这里只是「挑一个能用的渠道」，不会降级。
  let bestIndex = -1
  let bestVersion: string | null = null
  for (let index = 0; index < probes.length; index += 1) {
    const version = probes[index].version
    if (!version) continue
    if (bestVersion === null || compareVersion(version, bestVersion) > 0) {
      bestIndex = index
      bestVersion = version
    }
  }
  if (bestIndex >= 0) return { index: bestIndex, reason: 'stale' }

  // 3) 全失败
  return { index: -1, reason: 'none' }
}
