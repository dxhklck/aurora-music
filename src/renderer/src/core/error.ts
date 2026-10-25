/**
 * Electron 的 ipcRenderer.invoke 会把主进程异常包成
 * "Error invoking remote method 'xxx': ProviderError: 真正的信息"，
 * UI 只应该展示最后那段人话。
 */
export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const prefix = /Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/
  const message = raw.replace(prefix, '').trim()
  return message || '操作失败，请稍后重试'
}
