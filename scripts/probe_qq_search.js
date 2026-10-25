/** 探针：复现迷你→展开全流程，观察最终界面状态 */
;(async () => {
  await window.api.setSettings({ miniMode: true })
  await new Promise((r) => setTimeout(r, 800))
  await window.api.setSettings({ miniMode: false })
  await new Promise((r) => setTimeout(r, 800))
  return { miniNow: (await window.api.getSettings()).miniMode }
})()
