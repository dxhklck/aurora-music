/**
 * 备份文件校验单测。
 *
 * 这段逻辑守着两件事：
 * 1. **不把垃圾写进用户目录**——外来 JSON 必须过格式与版本两道关；
 * 2. **不做路径穿越**——备份里的文件名是不可信输入，只有白名单里的名字能被采纳。
 *
 * 还原是覆盖式、不可撤销的操作（虽然有安全副本），所以这些分支必须锁死，
 * 不能靠「手动点一次对话框看看」来确认。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AppSettings, BackupFilePayload } from '../src/shared/types.ts'
import {
  BACKUP_FILES,
  BACKUP_LOCAL_KEYS,
  mergeRestoredSettings,
  normalizeBackupLocal,
  stripCredentialsForBackup,
  validateBackup,
  type LocalOnlySettings
} from '../src/shared/backup-format.ts'

function payload(patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    format: 'aurora-backup',
    version: 1,
    appVersion: '1.4.0',
    createdAt: 1_700_000_000_000,
    files: { 'settings.json': '{"volume":0.3}' },
    local: { 'aurora.stats': '{"days":1}' },
    ...patch
  }
}

test('合法备份通过校验', () => {
  const result = validateBackup(payload())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.payload.files['settings.json'], '{"volume":0.3}')
  assert.equal(result.payload.local['aurora.stats'], '{"days":1}')
})

test('不是对象一律拒绝', () => {
  for (const bad of [null, undefined, 'a string', 42, [payload()]]) {
    const result = validateBackup(bad)
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`)
  }
})

test('format 不对时给出「不是备份文件」而不是继续解析', () => {
  const result = validateBackup(payload({ format: 'something-else' }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /不是 Aurora Music 的备份文件/)
})

test('缺少合法版本号时拒绝（损坏的备份不能靠猜版本救回来）', () => {
  for (const version of [undefined, 0, -1, 'v1', null]) {
    const result = validateBackup(payload({ version }))
    assert.equal(result.ok, false, `应拒绝 version=${String(version)}`)
  }
})

test('版本比当前新时拒绝，并提示升级应用', () => {
  const result = validateBackup(payload({ version: 2 }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /请先升级应用/)
})

test('files 缺失或不是对象时拒绝', () => {
  assert.equal(validateBackup(payload({ files: undefined })).ok, false)
  assert.equal(validateBackup(payload({ files: 'x' })).ok, false)
  assert.equal(validateBackup(payload({ files: [] })).ok, false)
})

test('只采纳白名单里的文件名，路径穿越的 key 被丢弃', () => {
  const result = validateBackup(
    payload({
      files: {
        'settings.json': '{}',
        '../../../.ssh/authorized_keys': 'ssh-rsa AAAA',
        'evil.exe': 'MZ'
      }
    })
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.payload.files), ['settings.json'])
})

test('一个白名单文件都没有时拒绝（还原成空壳不如不还原）', () => {
  const result = validateBackup(payload({ files: { 'evil.exe': 'MZ' } }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /没有任何可还原的配置文件/)
})

test('文件内容必须是字符串，空串视为没有', () => {
  const result = validateBackup(payload({ files: { 'settings.json': '', 'playlists.json': { a: 1 } } }))
  assert.equal(result.ok, false)
})

test('local 只保留白名单键，非字符串值丢弃', () => {
  const result = validateBackup(
    payload({
      local: {
        'aurora.stats': '{"days":1}',
        'aurora.queue': '{"songs":[]}',
        'aurora.recent': 123
      }
    })
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.payload.local), ['aurora.stats'])
})

test('normalizeBackupLocal 面对任意输入都返回对象，不抛错', () => {
  for (const bad of [null, undefined, 'x', 1, []]) {
    assert.deepEqual(normalizeBackupLocal(bad), {})
  }
})

test('白名单常量与实际使用的字段对齐（防止有人只改一边）', () => {
  assert.ok(BACKUP_FILES.includes('settings.json'))
  assert.ok(BACKUP_FILES.includes('playlists.json'))
  assert.ok(BACKUP_LOCAL_KEYS.includes('aurora.stats'))
  // 凭据文件不在备份范围内：备份是明文，会被传网盘
  assert.equal(BACKUP_FILES.some((name) => name.includes('cookie')), false)
})

test('合法备份的 payload 字段类型与 BackupFilePayload 一致', () => {
  const result = validateBackup(payload())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const typed: BackupFilePayload = result.payload
  assert.equal(typeof typed.appVersion, 'string')
  assert.equal(typeof typed.createdAt, 'number')
})

/* ---------------- 还原 settings.json 时的本机字段保留 ---------------- */

const LOCAL: LocalOnlySettings = {
  qqCookie: 'qq-本机',
  neteaseCookie: 'ne-本机',
  neteaseAccount: { userId: 1, nickname: '本机账号', avatarUrl: '', vipType: 0 },
  windowBounds: { normal: { x: 100, y: 200, width: 1200, height: 800 } },
  desktopLyricBounds: { mini: { x: 5, y: 5, width: 380, height: 56 } },
  miniMode: true
}

test('凭据与窗口几何一律保留本机值，其余字段以备份为准', () => {
  const backup = JSON.stringify({
    qqCookie: '来自别人的 Cookie',
    neteaseCookie: '来自别人的 NE Cookie',
    neteaseAccount: { nickname: '别人' },
    windowBounds: { normal: { x: -3000, y: 4000, width: 1200, height: 800 } },
    desktopLyricBounds: {},
    miniMode: true,
    volume: 0.3,
    platform: 'kuwo'
  })
  const merged = mergeRestoredSettings(backup, LOCAL)
  assert.ok(merged)
  const parsed = JSON.parse(merged) as AppSettings
  assert.equal(parsed.volume, 0.3, '备份里的普通设置要生效')
  assert.equal(parsed.platform, 'kuwo')
  assert.equal(parsed.qqCookie, 'qq-本机', 'Cookie 不能从备份带过来')
  assert.equal(parsed.neteaseCookie, 'ne-本机')
  assert.equal(parsed.neteaseAccount?.nickname, '本机账号')
  assert.equal(parsed.windowBounds.normal?.x, 100, '窗口坐标必须用本机的')
  assert.equal(parsed.desktopLyricBounds.mini?.width, 380)
  assert.equal(parsed.miniMode, false, '迷你态不应还原')
})

test('备份里的 settings.json 不是合法对象时返回 null，由调用方判失败', () => {
  assert.equal(mergeRestoredSettings('{"volume":', LOCAL), null)
  assert.equal(mergeRestoredSettings('null', LOCAL), null)
  assert.equal(mergeRestoredSettings('[]', LOCAL), null)
})

/* ---------------- 导出前的脱敏 ---------------- */

/** 完整设置夹具：凭据相关字段故意填成有值，用来验证导出时被清掉 */
function settingsFixture(): AppSettings {
  return {
    platform: 'netease',
    quality: 'high',
    volume: 0.42,
    audioOutputId: 'device-1',
    audioOutputLabel: '扬声器',
    playMode: 'loop',
    downloadDir: 'D:/music',
    musicDirs: ['E:/more'],
    searchLimit: 30,
    autoSwitchSource: true,
    preferredSources: ['kuwo'],
    desktopLyricLocked: false,
    desktopLyricMode: 'mini',
    nowPlayingStyle: 'vinyl',
    playerTheme: 'aurora',
    themeMode: 'dark',
    downloadConcurrency: 2,
    downloadRetries: 3,
    writeTags: true,
    engineEnabled: true,
    updateChannel: '',
    equalizer: { enabled: true, gains: [1, 2, 3, 4, 5] },
    closeToTray: true,
    qqCookie: 'qq_secret_cookie',
    neteaseCookie: 'MUSIC_U=secret',
    neteaseAccount: { userId: 9, nickname: '练老师', avatarUrl: 'x', vipType: 1 },
    miniMode: true,
    windowBounds: { normal: { x: 10, y: 20, width: 800, height: 600 } },
    desktopLyricBounds: { mini: { x: 1, y: 2, width: 380, height: 56 } }
  }
}

test('导出时凭据被清空，普通设置原样保留', () => {
  const stripped = stripCredentialsForBackup(settingsFixture())
  assert.equal(stripped.qqCookie, '')
  assert.equal(stripped.neteaseCookie, '')
  assert.equal(stripped.neteaseAccount, null)
  assert.deepEqual(stripped.windowBounds, {})
  assert.deepEqual(stripped.desktopLyricBounds, {})
  assert.equal(stripped.miniMode, false)
  // 用户真正想带走的东西必须还在
  assert.equal(stripped.volume, 0.42)
  assert.equal(stripped.downloadDir, 'D:/music')
  assert.deepEqual(stripped.musicDirs, ['E:/more'])
  assert.deepEqual(stripped.preferredSources, ['kuwo'])
  assert.deepEqual(stripped.equalizer.gains, [1, 2, 3, 4, 5])
  assert.equal(stripped.audioOutputId, 'device-1')
})

test('脱敏不改入参（settings.get() 返回的是共享缓存）', () => {
  const original = settingsFixture()
  stripCredentialsForBackup(original)
  assert.equal(original.qqCookie, 'qq_secret_cookie')
  assert.equal(original.neteaseCookie, 'MUSIC_U=secret')
  assert.notDeepEqual(original.windowBounds, {})
  assert.equal(original.miniMode, true)
})
