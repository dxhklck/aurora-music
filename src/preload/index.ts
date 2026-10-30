import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { AuroraApi } from '../shared/api'

const api: AuroraApi = {
  platform: process.platform,
  providers: () => ipcRenderer.invoke(IPC.providerList),
  search: (args) => ipcRenderer.invoke(IPC.search, args),
  onSearchPartial: (cb) => {
    const listener = (_event: unknown, payload: any): void => cb(payload)
    ipcRenderer.on(IPC.searchPartial, listener)
    return () => ipcRenderer.removeListener(IPC.searchPartial, listener)
  },
  charts: (platform) => ipcRenderer.invoke(IPC.charts, platform),
  chartDetail: (args) => ipcRenderer.invoke(IPC.chartDetail, args),
  lyric: (song) => ipcRenderer.invoke(IPC.lyric, song),
  resolveTrack: (args) => ipcRenderer.invoke(IPC.resolveTrack, args),
  coverResolve: (song) => ipcRenderer.invoke(IPC.coverResolve, song),

  enqueueDownload: (song) => ipcRenderer.invoke(IPC.downloadEnqueue, song),
  enqueueDownloads: (songs) => ipcRenderer.invoke(IPC.downloadEnqueueMany, songs),
  listDownloads: () => ipcRenderer.invoke(IPC.downloadList),
  cancelDownload: (id) => ipcRenderer.invoke(IPC.downloadCancel, id),
  retryDownload: (id) => ipcRenderer.invoke(IPC.downloadRetry, id),
  retryFailedDownloads: () => ipcRenderer.invoke(IPC.downloadRetryFailed),
  removeDownload: (id) => ipcRenderer.invoke(IPC.downloadRemove, id),
  clearDownloads: () => ipcRenderer.invoke(IPC.downloadClear),
  openDownload: (id) => ipcRenderer.invoke(IPC.downloadOpen, id),
  revealDownload: (id) => ipcRenderer.invoke(IPC.downloadReveal, id),
  downloadDir: () => ipcRenderer.invoke(IPC.downloadDir),
  chooseDownloadDir: () => ipcRenderer.invoke(IPC.downloadChooseDir),

  engineStatus: () => ipcRenderer.invoke(IPC.engineStatus),
  engineRestart: () => ipcRenderer.invoke(IPC.engineRestart),
  sourceHealth: () => ipcRenderer.invoke(IPC.sourceHealth),
  sourceHealthRefresh: () => ipcRenderer.invoke(IPC.sourceHealthRefresh),

  listLibrary: () => ipcRenderer.invoke(IPC.libraryList),
  removeLibrary: (id) => ipcRenderer.invoke(IPC.libraryRemove, id),
  updateLibraryMeta: (id, patch) => ipcRenderer.invoke(IPC.libraryUpdateMeta, id, patch),
  updateLibraryMetaMany: (ids, patch) => ipcRenderer.invoke(IPC.libraryUpdateMetaMany, ids, patch),
  copyLibraryFiles: (ids) => ipcRenderer.invoke(IPC.libraryCopyFiles, ids),
  refreshLibrary: () => ipcRenderer.invoke(IPC.libraryRefresh),
  revealLibrary: (id) => ipcRenderer.invoke(IPC.libraryReveal, id),
  importMusicDir: () => ipcRenderer.invoke(IPC.libraryImportDir),
  removeMusicDir: (dir) => ipcRenderer.invoke(IPC.libraryRemoveDir, dir),
  listMusicDirs: () => ipcRenderer.invoke(IPC.libraryDirs),
  deleteLibraryFiles: (ids) => ipcRenderer.invoke(IPC.libraryDeleteFiles, ids),
  removeLibraryMany: (ids) => ipcRenderer.invoke(IPC.libraryRemoveMany, ids),
  findDuplicateTracks: () => ipcRenderer.invoke(IPC.libraryDuplicates),
  copyLibraryTracks: (ids) => ipcRenderer.invoke(IPC.libraryCopyTo, ids),
  exportLibraryTracks: (ids, template) => ipcRenderer.invoke(IPC.libraryExportTo, ids, template),
  relocateLibraryTracks: () => ipcRenderer.invoke(IPC.libraryRelocate),
  purgeMissingTracks: () => ipcRenderer.invoke(IPC.libraryPurgeMissing),
  openTrash: () => ipcRenderer.invoke(IPC.libraryOpenTrash),
  openFolder: (dir) => ipcRenderer.invoke(IPC.libraryOpenDir, dir),
  onLibraryOpProgress: (cb) => {
    const listener = (_event: unknown, payload: any): void => cb(payload)
    ipcRenderer.on(IPC.libraryOpProgress, listener)
    return () => ipcRenderer.removeListener(IPC.libraryOpProgress, listener)
  },

  listPlaylists: () => ipcRenderer.invoke(IPC.playlistList),
  createPlaylist: (name, songs) => ipcRenderer.invoke(IPC.playlistCreate, { name, songs }),
  renamePlaylist: (id, name) => ipcRenderer.invoke(IPC.playlistRename, { id, name }),
  removePlaylist: (id) => ipcRenderer.invoke(IPC.playlistRemove, id),
  addPlaylistSongs: (id, songs) => ipcRenderer.invoke(IPC.playlistAddSongs, { id, songs }),
  removePlaylistSong: (id, platform, songId) =>
    ipcRenderer.invoke(IPC.playlistRemoveSong, { id, platform, songId }),
  movePlaylistSong: (id, platform, songId, direction) =>
    ipcRenderer.invoke(IPC.playlistMoveSong, { id, platform, songId, direction }),
  toggleFavorite: (song) => ipcRenderer.invoke(IPC.playlistToggleFavorite, song),

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),

  logWrite: (level, scope, message) => ipcRenderer.invoke(IPC.logWrite, { level, scope, message }),
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, text),
  exportDiagnostics: () => ipcRenderer.invoke(IPC.diagExport),

  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.send(IPC.updateInstall),
  onUpdateStatus: (cb) => {
    const listener = (_event: unknown, status: any): void => cb(status)
    ipcRenderer.on(IPC.updateStatus, listener)
    return () => ipcRenderer.removeListener(IPC.updateStatus, listener)
  },

  winMinimize: () => ipcRenderer.send(IPC.winMinimize),
  winMaximize: () => ipcRenderer.send(IPC.winMaximize),
  winClose: () => ipcRenderer.send(IPC.winClose),
  isMaximized: () => ipcRenderer.invoke(IPC.winIsMaximized),
  setMiniExtra: (extra, direction) => ipcRenderer.send(IPC.miniSetExtra, extra, direction),
  toggleMiniVolume: (state) => ipcRenderer.invoke(IPC.miniVolumeToggle, state),
  getMiniVolume: () => ipcRenderer.invoke(IPC.miniVolumeInit),
  setMiniVolume: (volume) => ipcRenderer.send(IPC.miniVolumeSet, volume),
  pushMiniVolume: (state) => ipcRenderer.send(IPC.miniVolumePush, state),
  onMiniVolumeChanged: (cb) => {
    const listener = (_event: unknown, state: any): void => cb(state)
    ipcRenderer.on(IPC.miniVolumeChanged, listener)
    return () => ipcRenderer.removeListener(IPC.miniVolumeChanged, listener)
  },
  onMiniVolumeState: (cb) => {
    const listener = (_event: unknown, state: any): void => cb(state)
    ipcRenderer.on(IPC.miniVolumeState, listener)
    return () => ipcRenderer.removeListener(IPC.miniVolumeState, listener)
  },
  closeMiniVolume: () => ipcRenderer.send(IPC.miniVolumeClose),

  toggleLyricWindow: () => ipcRenderer.invoke(IPC.lyricWindowToggle),
  closeLyricWindow: () => ipcRenderer.send(IPC.lyricWindowClose),
  setLyricWindowLock: (locked) => ipcRenderer.send(IPC.lyricWindowLock, locked),
  setLyricWindowHover: (hover) => ipcRenderer.send(IPC.lyricWindowHover, hover),
  dragLyricWindow: () => ipcRenderer.send(IPC.lyricWindowDragStart),
  moveLyricWindow: (dx, dy) => ipcRenderer.send(IPC.lyricWindowDragMove, dx, dy),
  endLyricWindowDrag: () => ipcRenderer.send(IPC.lyricWindowDragEnd),
  startLyricResize: () => ipcRenderer.send(IPC.lyricWindowResizeStart),
  resizeLyricWindow: (dw, dh) => ipcRenderer.send(IPC.lyricWindowResizeMove, dw, dh),
  endLyricResize: () => ipcRenderer.send(IPC.lyricWindowResizeEnd),
  pushLyricState: (state) => ipcRenderer.send(IPC.lyricWindowPush, state),
  getLyricMode: () => ipcRenderer.invoke(IPC.lyricWindowMode),
  setLyricMode: (mode) => ipcRenderer.invoke(IPC.lyricWindowMode, mode),
  sendLyricCommand: (command) => ipcRenderer.send(IPC.lyricWindowCommand, command),

  pushTrayState: (state) => ipcRenderer.send(IPC.trayState, state),
  onTrayCommand: (cb) => {
    const listener = (_event: unknown, command: any): void => cb(command)
    ipcRenderer.on(IPC.trayCommand, listener)
    return () => ipcRenderer.removeListener(IPC.trayCommand, listener)
  },

  startQrLogin: (platform) => ipcRenderer.invoke(IPC.qrLoginStart, platform),
  pollQrLogin: () => ipcRenderer.invoke(IPC.qrLoginPoll),
  cancelQrLogin: () => ipcRenderer.send(IPC.qrLoginCancel),

  sendSmsCaptcha: (phone, countrycode) => ipcRenderer.invoke(IPC.smsCaptchaSend, { phone, countrycode }),
  cellphoneLogin: (args) => ipcRenderer.invoke(IPC.cellphoneLogin, args),

  openLoginWindow: (platform) => ipcRenderer.invoke(IPC.loginWindowOpen, platform),
  closeLoginWindow: () => ipcRenderer.send(IPC.loginWindowClose),
  onLoginWindowResult: (cb) => {
    const listener = (_event: unknown, result: any): void => cb(result)
    ipcRenderer.on(IPC.loginWindowResult, listener)
    return () => ipcRenderer.removeListener(IPC.loginWindowResult, listener)
  },

  onDownloadProgress: (cb) => {
    const listener = (_event: unknown, tasks: any): void => cb(tasks)
    ipcRenderer.on(IPC.downloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC.downloadProgress, listener)
  },
  onSettingsChanged: (cb) => {
    const listener = (_event: unknown, settings: any): void => cb(settings)
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
  },
  onLyricWindowState: (cb) => {
    const listener = (_event: unknown, state: any): void => cb(state)
    ipcRenderer.on(IPC.lyricWindowState, listener)
    return () => ipcRenderer.removeListener(IPC.lyricWindowState, listener)
  },
  onLyricContextMenu: (cb) => {
    const listener = (_event: unknown, pos: { x: number; y: number }): void => cb(pos)
    ipcRenderer.on(IPC.lyricWindowContextMenu, listener)
    return () => ipcRenderer.removeListener(IPC.lyricWindowContextMenu, listener)
  },
  onToast: (cb) => {
    const listener = (_event: unknown, payload: any): void => cb(payload)
    ipcRenderer.on(IPC.toast, listener)
    return () => ipcRenderer.removeListener(IPC.toast, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
