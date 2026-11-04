import { audio } from './audio'

/**
 * 音频输出设备的选择与恢复。
 *
 * deviceId 由浏览器按 profile 加盐生成，换机器、清数据、有时甚至重启后就会变，
 * 所以设置里同时存 label：id 匹配不上时按名字找回来。两者都找不到（设备拔了）
 * 就退回系统默认，绝不让「记住的设备」把播放卡死在一条不存在的通道上。
 */

export interface OutputDevice {
  deviceId: string
  label: string
}

/** 当前可用的输出设备；浏览器不支持枚举时返回空数组（UI 据此隐藏这一项） */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => ({
        deviceId: device.deviceId,
        // 未授权时 label 是空串，用占位名而不是空白选项
        label: device.label || '未命名设备'
      }))
  } catch {
    return []
  }
}

export interface AppliedOutput {
  /** 是否成功切到目标设备（false = 已回退系统默认） */
  ok: boolean
  /** 实际生效的 deviceId（'' = 系统默认） */
  deviceId: string
}

/**
 * 应用保存的输出设备。空 id + 空 label = 系统默认。
 * 启动时静默调用：设备不在了就回退默认，不打断播放也不弹提示。
 */
export async function applySavedOutput(
  savedId: string,
  savedLabel: string
): Promise<AppliedOutput> {
  if (!savedId && !savedLabel) {
    await audio.setOutputDevice('')
    return { ok: true, deviceId: '' }
  }
  const devices = await listOutputDevices()
  const target =
    devices.find((device) => device.deviceId === savedId) ??
    (savedLabel ? devices.find((device) => device.label === savedLabel) : undefined)
  if (!target) {
    await audio.setOutputDevice('')
    return { ok: false, deviceId: '' }
  }
  const ok = await audio.setOutputDevice(target.deviceId)
  return { ok, deviceId: ok ? target.deviceId : '' }
}
