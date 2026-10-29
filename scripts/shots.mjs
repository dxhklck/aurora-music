#!/usr/bin/env node
/**
 * 文档截图流水线。
 *
 * 为什么要有它：README 与 docs 里的界面截图必须与当前代码一致，而手工截图
 * 既不可复现、也容易漏掉新加的面板（均衡器、引擎巡检、音量气泡）。
 * 这里把「打开哪个页面、填什么搜索词、等什么元素出现」写成脚本，
 * 交给主进程的 AURORA_CAPTURE 通道执行，一次跑完所有图。
 *
 * 用法：
 *   node scripts/shots.mjs                # 全部
 *   node scripts/shots.mjs discover search  # 指定几张
 *   node scripts/shots.mjs --list          # 看有哪些
 *
 * 前置：npm run build（截图跑的是 out/ 里的产物，不是源码）。
 * 数据：使用固定的临时 profile，首次会真实联网搜索/下载，后续复用，
 *       所以同一台机器上重复跑出来的图基本一致。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shotsDir = join(root, 'docs', 'shots')
const profile = join(tmpdir(), 'aurora-shots-profile')

/** 注入到每个截图脚本前面的小工具，避免每段脚本重复写样板 */
const PRELUDE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (sel) => document.querySelector(sel)
const all = (sel) => Array.from(document.querySelectorAll(sel))
const text = (sel) => (q(sel)?.textContent ?? '').trim()
const waitFor = async (fn, timeout = 20000, step = 200) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = typeof fn === 'function' ? fn() : null
    if (value) return value
    await sleep(step)
  }
  return null
}
const go = async (hash) => {
  location.hash = hash
  await sleep(900)
}
const typeInto = (el, value) => {
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}
const clickText = (sel, keyword) => {
  const hit = all(sel).find((el) => el.textContent.includes(keyword))
  if (hit) hit.click()
  return Boolean(hit)
}
// 歌曲列表是 div.row 铺的，不是 <table>；之前按 tbody tr 数会永远是 0
const rowCount = () => all('.table .row').length
const pickPlatform = async (name) => {
  q('.platform-card')?.click()
  await sleep(450)
  const hit = clickText('.platform-option', name)
  await sleep(1400)
  return hit && text('.platform-card strong').includes(name)
}
/** 搜索并等结果落表；平台偶发返回空，换词再试一次 */
const searchFor = async (word, retryWord) => {
  for (const kw of [word, retryWord].filter(Boolean)) {
    typeInto(q('.search-box input'), kw)
    await sleep(150)
    q('.search-box .btn')?.click()
    await waitFor(() => rowCount() >= 8, 16000)
    if (rowCount() >= 8) return kw + ':' + rowCount()
    await sleep(800)
  }
  return 'empty:' + rowCount()
}
/** 播第一首并打开正在播放舞台 */
const openStage = async () => {
  q('.table .row .play-mini')?.click()
  await waitFor(() => document.querySelector('.player-bar .now strong'), 15000)
  await sleep(2400)
  q('.cover-btn')?.click()
  await waitFor(() => q('.stage'), 10000)
  await sleep(2600)
  return Boolean(q('.stage'))
}
`

/**
 * 每张图：目标文件名 → 在渲染进程里做的事。
 * 约定：脚本最后返回一句说明，会打在主进程 stdout 里，便于排查「图拍歪了」。
 */
const SHOTS = {
  discover: {
    script: `
      await pickPlatform('网易云音乐')
      await go('#/')
      await waitFor(() => all('.chart-card, .dot-item').length > 4, 20000)
      await sleep(1800)
      return 'cards=' + all('.chart-card').length + ' dots=' + all('.dot-item').length
    `
  },
  search: {
    script: `
      await pickPlatform('网易云音乐')
      await go('#/search')
      const hit = await searchFor('晴天', '稻香')
      await sleep(1000)
      return hit
    `
  },
  'search-engine': {
    script: `
      const switched = await pickPlatform('酷狗')
      await go('#/search')
      const hit = await searchFor('周杰伦', '林俊杰')
      await sleep(1200)
      return hit + ' switched=' + switched
    `
  },
  nowplaying: {
    script: `
      await pickPlatform('网易云音乐')
      await go('#/search')
      await searchFor('晴天', '稻香')
      await sleep(600)
      const open = await openStage()
      return 'stage=' + open
    `
  },
  equalizer: {
    script: `
      await pickPlatform('网易云音乐')
      await go('#/search')
      await searchFor('晴天', '稻香')
      await sleep(600)
      await openStage()
      q('[title="均衡器"]')?.click()
      await sleep(900)
      // 先打开开关：关闭状态下滑块虽能动，但 D 档只是摆设，截图要体现「已启用」
      q('.eq-panel .switch')?.click()
      await sleep(400)
      // 调两组增益，让面板不是一条直线
      const sliders = all('.eq-band input[type="range"]')
      if (sliders.length >= 5) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        const preset = ['6', '3', '0', '-2', '4']
        sliders.forEach((el, i) => {
          setter.call(el, preset[i])
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await sleep(600)
      }
      return 'panel=' + Boolean(q('.eq-panel')) + ' sliders=' + sliders.length
    `
  },
  downloads: {
    script: `
      await pickPlatform('网易云音乐')
      await go('#/search')
      await searchFor('晴天', '稻香')
      await sleep(500)
      const dl = all('.table .row [title="下载"]').slice(0, 3)
      dl.forEach((el, i) => setTimeout(() => el.click(), i * 1000))
      await sleep(1500)
      await go('#/downloads')
      // 等到至少一首下完，进度条不半截
      await waitFor(() => all('.task.done, .task.completed').length > 0, 60000, 500)
      // 等提示气泡淡出，否则截图右下角挂着「开始下载」
      await sleep(4200)
      return 'tasks=' + all('.task').length + ' done=' + all('.task.done, .task.completed').length
    `
  },
  library: {
    script: `
      await go('#/library')
      await waitFor(() => rowCount() > 0, 15000)
      await sleep(1200)
      return 'rows=' + rowCount()
    `
  },
  charts: {
    script: `
      await pickPlatform('网易云音乐')
      await go('#/charts')
      await sleep(2200)
      return 'cards=' + all('.chart-card').length
    `
  },
  settings: {
    script: `
      await go('#/settings')
      await sleep(1800)
      return 'sections=' + all('section.card').length
    `
  },
  'settings-engine': {
    script: `
      await go('#/settings')
      await sleep(2000)
      const head = all('.block-head').find((el) => el.textContent.includes('引擎'))
      if (head) head.scrollIntoView({ block: 'center' })
      await sleep(1000)
      return 'scrolled=' + Boolean(head)
    `
  }
}

function electronBinary() {
  const base = join(root, 'node_modules', 'electron', 'dist')
  const candidates =
    process.platform === 'win32'
      ? [join(base, 'electron.exe')]
      : process.platform === 'darwin'
        ? [join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
        : [join(base, 'electron')]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    console.error('[shots] 找不到 Electron，先执行 npm install')
    process.exit(2)
  }
  return found
}

async function capture(name, shot, binary, scripDir) {
  const target = join(shotsDir, `${name}.png`)
  const scriptPath = join(scripDir, `${name}.js`)
  await writeFile(scriptPath, `(async () => {\n${PRELUDE}\n${shot.script}\n})()`, 'utf8')

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.AURORA_CAPTURE = target
  env.AURORA_CAPTURE_SCRIPT_FILE = scriptPath
  env.AURORA_USER_DATA = profile

  const child = spawn(binary, [join(root, 'out', 'main', 'index.js')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk.toString()))
  child.stderr.on('data', (chunk) => (out += chunk.toString()))

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, 90_000)
    child.on('exit', (value) => {
      clearTimeout(timer)
      resolve(value ?? 0)
    })
  })

  const detail = (out.match(/script result: (.*)/) ?? [])[1] ?? ''
  const errors = out
    .split('\n')
    .filter((line) => line.startsWith('[renderer:'))
    .slice(0, 3)
  const ok = out.includes('captured:')
  console.log(
    `${ok ? '✓' : '✗'} ${name.padEnd(16)} ${detail.padEnd(46)} ${code === 'timeout' ? '超时' : ''}`
  )
  for (const line of errors) console.log(`     ${line}`)
  return ok
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log(Object.keys(SHOTS).join('\n'))
  process.exit(0)
}

const entry = join(root, 'out', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error('[shots] 找不到 out/main/index.js，先执行 npm run build')
  process.exit(2)
}

const names = args.filter((item) => !item.startsWith('--'))
const selected = names.length ? names : Object.keys(SHOTS)
const unknown = selected.filter((name) => !SHOTS[name])
if (unknown.length) {
  console.error(`[shots] 未知的图：${unknown.join(', ')}（用 --list 查看）`)
  process.exit(2)
}

const binary = electronBinary()
const scripDir = await mkdtemp(join(tmpdir(), 'aurora-shots-'))
let failed = 0
for (const name of selected) {
  const ok = await capture(name, SHOTS[name], binary, scripDir)
  if (!ok) failed += 1
}
console.log(`\n完成 ${selected.length - failed}/${selected.length}，输出目录 ${shotsDir}`)
process.exit(failed ? 1 : 0)
