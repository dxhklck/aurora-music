<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })

interface IconDef {
  /** 字符串 = 按图标级 fill/stroke 渲染；对象可单路径覆盖 fill（用于半填充图形） */
  paths: Array<string | { d: string; fill?: boolean }>
  fill?: boolean
  circles?: Array<{ cx: number; cy: number; r: number }>
}

const ICONS: Record<string, IconDef> = {
  play: { paths: ['M8 5.2 19 12 8 18.8Z'], fill: true },
  pause: { paths: ['M8 5h3v14H8zM13 5h3v14h-3z'], fill: true },
  next: { paths: ['M7 5.2 17 12 7 18.8Z', 'M19 5v14'], fill: false },
  prev: { paths: ['M17 5.2 7 12l10 6.8Z', 'M5 5v14'], fill: false },
  'volume-high': { paths: ['M4 10v4h3l4 3V7L7 10H4z', 'M15.2 9.2a4 4 0 0 1 0 5.6', 'M17.6 6.8a7.4 7.4 0 0 1 0 10.4'], fill: false },
  'volume-mute': { paths: ['M4 10v4h3l4 3V7L7 10H4z', 'M15.5 10l4 4M19.5 10l-4 4'], fill: false },
  heart: { paths: ['M12 20s-7.2-4.6-7.2-9.6A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.2 2.8C19.2 15.4 12 20 12 20z'], fill: false },
  'heart-filled': { paths: ['M12 20s-7.2-4.6-7.2-9.6A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.2 2.8C19.2 15.4 12 20 12 20z'], fill: true },
  'playlist-add': { paths: ['M4 7h10M4 12h10M4 17h6', 'M17 12.5v7M13.5 16h7'], fill: false },
  pencil: { paths: ['M4 20h4L19.5 8.5 15.5 4.5 4 16z', 'M13.5 6.5l4 4'], fill: false },
  download: { paths: ['M12 4v10', 'M8 11l4 4 4-4', 'M5 19h14'], fill: false },
  list: { paths: ['M4 7h11M4 12h11M4 17h7', 'M18 9v7', 'M16 14l2 2 2-2'], fill: false },
  lyrics: { paths: ['M5 6h14', 'M5 11h9', 'M5 16h12', 'M5 21h7'], fill: false },
  shuffle: { paths: ['M4 7h3l7 10h4', 'M4 17h3l7-10h4', 'M16 4.5 19.5 7 16 9.5', 'M16 14.5 19.5 17 16 19.5'], fill: false },
  repeat: { paths: ['M5 9a3 3 0 0 1 3-3h8', 'M13 3.5 16 6l-3 2.5', 'M19 15a3 3 0 0 1-3 3H8', 'M11 20.5 8 18l3-2.5'], fill: false },
  'repeat-one': { paths: ['M5 9a3 3 0 0 1 3-3h8', 'M13 3.5 16 6l-3 2.5', 'M19 15a3 3 0 0 1-3 3H8', 'M11 20.5 8 18l3-2.5', 'M12 10.5v4'], fill: false },
  search: { paths: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M16.2 16.2 21 21'], fill: false },
  home: { paths: ['M4 11.2 12 4.5l8 6.7V20h-5v-5H9v5H4z'], fill: false },
  chart: { paths: ['M4 20h16', 'M7 20V11', 'M12 20V5', 'M17 20v-6'], fill: false },
  folder: { paths: ['M4 7h5l2 2.4h9V19H4z'], fill: false },
  'folder-plus': { paths: ['M4 7h5l2 2.4h9V19H4z', 'M13 12v6M10 15h6'], fill: false },
  qrcode: {
    paths: [
      'M4 4h6v6H4z',
      'M14 4h6v6h-6z',
      'M4 14h6v6H4z',
      'M14 14h2v2h-2z',
      'M18 14h2v2h-2z',
      'M14 18h2v2h-2z',
      'M18 18h2v2h-2z'
    ],
    fill: false
  },
  clock: { paths: ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z', 'M12 8v4.4l3 1.8'], fill: false },
  check: { paths: ['M5 12.5 9.5 17 19 7'], fill: false },
  close: { paths: ['M6 6l12 12M18 6 6 18'], fill: false },
  minimize: { paths: ['M5 12h14'], fill: false },
  expand: { paths: ['M9 4H4v5', 'M15 20h5v-5', 'M4 4l6 6', 'M20 20l-6-6'], fill: false },
  maximize: { paths: ['M5 5h14v14H5z'], fill: false },
  restore: { paths: ['M8 8h11v11H8z', 'M5 16V5h11'], fill: false },
  more: { paths: ['M6 12h.01M12 12h.01M18 12h.01'], fill: false },
  trash: { paths: ['M5 7h14', 'M9 7V5h6v2', 'M7 7l1 12h8l1-12'], fill: false },
  refresh: { paths: ['M19 12a7 7 0 1 1-2.1-5', 'M19 4v5h-5'], fill: false },
  monitor: { paths: ['M4 5h16v11H4z', 'M9 20h6M12 16v4'], fill: false },
  sun: {
    paths: [
      'M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z',
      'M12 3v2M12 19v2M3 12h2M19 12h2M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5'
    ],
    fill: false
  },
  moon: { paths: ['M20.2 13.6A8.2 8.2 0 1 1 10.4 3.8a6.6 6.6 0 0 0 9.8 9.8Z'], fill: false },
  plus: { paths: ['M12 5v14M5 12h14'], fill: false },
  mic: { paths: ['M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3Z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v3'], fill: false },
  play_circle: { paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M10 8.5 16 12l-6 3.5z'], fill: false },
  equalizer: { paths: ['M6 4v16M12 4v16M18 4v16', 'M4 9h4M10 15h4M16 7h4'], fill: false },
  lock: { paths: ['M6 10.5h12V20H6z', 'M9 10.5V7.5a3 3 0 0 1 6 0v3'], fill: false },
  unlock: { paths: ['M6 10.5h12V20H6z', 'M9 10.5V7.5a3 3 0 0 1 5.6-1.6'], fill: false },
  settings: { paths: ['M4 7.5h7M15.5 7.5H20', 'M4 16.5h4.5M13 16.5h7', 'M13.2 5.2v4.6', 'M10.8 14.2v4.6'], fill: false }
}

const def = computed<IconDef>(() => ICONS[props.name] ?? { paths: [] })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="def.fill ? 'currentColor' : 'none'"
    :stroke="def.fill ? 'none' : 'currentColor'"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      v-for="(path, i) in def.paths"
      :key="i"
      :d="typeof path === 'string' ? path : path.d"
      :fill="typeof path === 'string' ? undefined : path.fill ? 'currentColor' : 'none'"
    />
  </svg>
</template>
