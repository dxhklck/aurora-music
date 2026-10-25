(async () => {
  const out = {}
  try {
    const lib = await window.api.listLibrary()
    const item = lib.find((t) => (t.song.name || '').includes('睡前别想太多'))
    if (!item) return { err: 'track not found', names: lib.slice(0, 50).map((t) => t.song.name) }
    out.track = { name: item.song.name, ext: item.ext, path: item.filePath, id: item.id }
    const song = { ...item.song, id: item.id, platform: 'local', extra: { ...(item.song.extra || {}), filePath: item.filePath } }
    let resolved
    try {
      resolved = await window.api.resolveTrack({ song, autoSwitch: false })
      out.url = resolved.stream.url.slice(0, 160)
    } catch (e) {
      return { ...out, resolveFail: String((e && e.message) || e) }
    }
    const el = window.__audio && (window.__audio.mediaEl || window.__audio.el)
    out.load = await new Promise((resolve) => {
      const ok = () => resolve('LOADED')
      const bad = () => resolve('EL_ERROR code=' + (el.error && el.error.code) + ' msg=' + (el.error && el.error.message))
      el.addEventListener('loadedmetadata', ok, { once: true })
      el.addEventListener('error', bad, { once: true })
      setTimeout(() => resolve('TIMEOUT readyState=' + el.readyState + ' networkState=' + el.networkState), 9000)
      el.src = resolved.stream.url
      el.load()
    })
    if (out.load === 'LOADED') {
      out.duration = el.duration
      try {
        await el.play()
        out.play = 'PLAY OK t=' + el.currentTime.toFixed(2)
        el.pause()
      } catch (e) {
        out.play = 'PLAY FAIL ' + e.name + ': ' + e.message
      }
    }
  } catch (e) {
    out.fatal = String((e && e.stack) || e)
  }
  return out
})()
