<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { gradientFromSeed } from '../core/cover'

/**
 * 首页右上角的黑胶唱片。
 *
 * 视觉：唱片 + 中心专辑封面 + 唱臂（未播放时停在盘外，播放落针到盘内）。
 *       深色主题是黑胶；浅色主题是奶白唱片，避免浅底上一块「黑疙瘩」。
 * 动画：只在播放时旋转（animation-play-state 开关，暂停冻结在当前角度不跳回 0°）；
 *       没有频谱/炫彩光效，只用一层中性的软阴影保持层次。
 * 尺寸：size<=0 时铺满父容器，圆盘按容器短边比例自适应。
 */
const props = withDefaults(defineProps<{ size?: number; label?: string }>(), {
  size: 0,
  label: 'AURORA'
})

const player = usePlayerStore()
const boxRef = ref<HTMLElement | null>(null)

/** size <= 0 = 自适应容器 */
const auto = computed(() => props.size <= 0)
const discPx = ref(props.size > 0 ? props.size : 200)
const isLight = ref(document.documentElement.dataset.theme === 'light')

const song = computed(() => player.displaySong)
const cover = computed(() => song.value?.coverUrl ?? '')
const coverFallback = computed(() =>
  song.value ? gradientFromSeed(`${song.value.name}${song.value.artists.join('')}`) : 'none'
)

let ro: ResizeObserver | null = null
let mo: MutationObserver | null = null

function measure(): void {
  if (!auto.value) {
    discPx.value = props.size
    return
  }
  const el = boxRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  // 0.96：几乎占满容器短边（外侧唱臂由溢出绘制，不占布局空间）
  discPx.value = Math.max(96, Math.round(Math.min(rect.width, rect.height) * 0.96))
}

onMounted(() => {
  measure()
  if (boxRef.value) {
    ro = new ResizeObserver(() => measure())
    ro.observe(boxRef.value)
  }
  mo = new MutationObserver(() => {
    isLight.value = document.documentElement.dataset.theme === 'light'
  })
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onBeforeUnmount(() => {
  ro?.disconnect()
  mo?.disconnect()
})
</script>

<template>
  <div ref="boxRef" class="vd" :class="{ auto, light: isLight }">
    <div class="vd-deck">
      <div
        class="vd-disc"
        :class="{ spinning: player.playing }"
        :style="{ width: discPx + 'px', height: discPx + 'px' }"
      >
        <div class="vd-grooves" />
        <div class="vd-art" :style="cover ? undefined : { background: coverFallback }">
          <img v-if="cover" :src="cover" alt="" draggable="false" />
          <em v-else>{{ label }}</em>
        </div>
        <div class="vd-sheen" />
        <!-- 有封面时不画轴孔：封面是完整圆，一个白点反而像瑕疵 -->
        <span v-if="!cover" class="vd-spindle" />
      </div>

      <!-- 唱臂：默认停在盘外，播放时落针到盘内 -->
      <svg class="vd-arm" :class="{ on: player.playing }" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="arm-base" cx="88" cy="12" r="8.5" />
        <path class="arm-rod" d="M88 20 C 92 46, 86 72, 68 86" />
        <rect class="arm-head" x="54" y="81" width="19" height="10" rx="5" transform="rotate(-38 64 86)" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.vd {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
}
.vd.auto {
  /* 绝对定位铺满父容器：避免 height:100% 与内容互相撑高，导致尺寸自激放大 */
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
}

/* 定位容器：唱片与唱臂共用，不参与旋转 */
.vd-deck {
  position: relative;
  display: grid;
  place-items: center;
}

/* ---------------- 唱片本体 ---------------- */
.vd-disc {
  position: relative;
  border-radius: 50%;
  background: radial-gradient(circle at 46% 38%, #2b2b37 0%, #17171f 40%, #0a0a10 74%, #050508 100%);
  box-shadow:
    0 24px 50px rgba(0, 0, 0, 0.52),
    0 6px 16px rgba(0, 0, 0, 0.4),
    inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  will-change: transform;
  /* 旋转常驻，靠 play-state 开关：暂停冻结在当前角度，不跳回 0° */
  animation: vd-turn 16s linear infinite;
  animation-play-state: paused;
}
.vd-disc.spinning {
  animation-play-state: running;
}

.vd-grooves {
  position: absolute;
  top: 4%;
  right: 4%;
  bottom: 4%;
  left: 4%;
  border-radius: 50%;
  background: repeating-radial-gradient(
    circle at 50% 50%,
    rgba(255, 255, 255, 0.055) 0 1px,
    transparent 1px 4px
  );
  mask: radial-gradient(circle, transparent 26%, #000 30%, #000 98%, transparent 100%);
  -webkit-mask: radial-gradient(circle, transparent 26%, #000 30%, #000 98%, transparent 100%);
}

/* 中心专辑封面 */
.vd-art {
  position: absolute;
  top: 28%;
  right: 28%;
  bottom: 28%;
  left: 28%;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: #12121a;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.14),
    0 6px 18px rgba(0, 0, 0, 0.55);
}
.vd-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.vd-art em {
  font-style: normal;
  font-size: 8px;
  letter-spacing: 2.4px;
  color: rgba(255, 255, 255, 0.6);
  padding-left: 2.4px;
}

/* 中心轴孔：必须显式居中，否则绝对定位会落在盘面左上角 */
.vd-spindle {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4%;
  height: 4%;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: #0a0a10;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}

/* 斜向高光，让盘面有漆面质感 */
.vd-sheen {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border-radius: 50%;
  background: linear-gradient(
    128deg,
    rgba(255, 255, 255, 0.14) 0%,
    rgba(255, 255, 255, 0.03) 26%,
    transparent 46%,
    transparent 62%,
    rgba(255, 255, 255, 0.05) 82%,
    transparent 100%
  );
  pointer-events: none;
}

/* ---------------- 浅色主题：奶白唱片 ---------------- */
.vd.light .vd-disc {
  background: radial-gradient(circle at 46% 36%, #ffffff 0%, #fbf7f1 38%, #f0e7da 72%, #e4d8c7 100%);
  box-shadow:
    0 20px 42px rgba(120, 96, 68, 0.18),
    0 4px 12px rgba(120, 96, 68, 0.12),
    inset 0 0 0 1px rgba(255, 255, 255, 0.95);
}
.vd.light .vd-grooves {
  background: repeating-radial-gradient(
    circle at 50% 50%,
    rgba(146, 118, 88, 0.13) 0 1px,
    transparent 1px 5px
  );
}
.vd.light .vd-art {
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.95),
    0 0 0 3px rgba(226, 212, 193, 0.55),
    0 6px 16px rgba(120, 96, 68, 0.25);
}
.vd.light .vd-spindle {
  background: #f7f2ea;
  box-shadow: inset 0 0 0 1px rgba(150, 122, 92, 0.45);
}
.vd.light .vd-sheen {
  background: linear-gradient(
    128deg,
    rgba(255, 255, 255, 0.75) 0%,
    rgba(255, 255, 255, 0.2) 24%,
    transparent 44%,
    transparent 64%,
    rgba(255, 255, 255, 0.4) 84%,
    transparent 100%
  );
}

/* ---------------- 唱臂 ---------------- */
.vd-arm {
  position: absolute;
  width: 56%;
  height: 56%;
  top: -4%;
  right: -4%;
  overflow: visible;
  transform-origin: 71.7% 10%;
  /* 默认停在盘外（唱头抬离盘面） */
  transform: rotate(-40deg);
  transition: transform 0.55s var(--ease, ease);
  pointer-events: none;
  filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.45));
}
.vd-arm.on {
  /* 播放落针：转到盘内 */
  transform: rotate(0deg);
}
.arm-base {
  fill: #f7f7fa;
  stroke: rgba(0, 0, 0, 0.25);
  stroke-width: 0.8;
}
.arm-rod {
  fill: none;
  stroke: #f7f7fa;
  stroke-width: 6;
  stroke-linecap: round;
}
.arm-head {
  fill: #f7f7fa;
  stroke: rgba(0, 0, 0, 0.22);
  stroke-width: 0.8;
}
.vd.light .vd-arm {
  filter: drop-shadow(0 3px 5px rgba(120, 96, 68, 0.35));
}
.vd.light .arm-base,
.vd.light .arm-head {
  fill: #ffffff;
  stroke: rgba(150, 122, 92, 0.28);
}
.vd.light .arm-rod {
  stroke: #ffffff;
}

@keyframes vd-turn {
  to {
    transform: rotate(360deg);
  }
}

/* 减弱动态效果时只关唱臂的过渡；旋转是播放状态指示，不跟随系统设置停摆 */
@media (prefers-reduced-motion: reduce) {
  .vd-arm {
    transition: none;
  }
}
</style>
