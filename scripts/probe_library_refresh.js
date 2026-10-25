(async () => {
  const before = await window.api.listLibrary()
  const after = await window.api.refreshLibrary()
  return { beforeCount: before.length, afterCount: after.length }
})()
