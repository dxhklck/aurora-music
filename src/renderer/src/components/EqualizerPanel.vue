<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { EQ_BANDS, EQ_MAX_GAIN, wave } from '../core/wave'

/**
 * 五段图形均衡器。
 *
 * 数据流很直白：拖动 → 立刻改音频图（要听见）→ 松手才落盘（别每像素写一次 settings.json）。
 * 参数在音频图未挂接时也能设置：wave 内部会缓存，等第一次打开播放舞台时一起生效。
 */

const app = useAppStore()

function initialGains(): number[] {
  const saved = app.settings?.equalizer?.gains
  return EQ_BANDS.map((_, index) => {
    const value = Number(saved?.[index])
    return Number.isFinite(value) ? Math.max(-EQ_MAX_GAIN, Math.min(EQ_MAX_GAIN, value)) : 0
  })
}

const gains = ref<number[]>(initialGains())
const enabled = ref(app.settings?.equalizer?.enabled === true)
const flat = computed(() => gains.value.every((value) => value === 0))

function label(freq: number): string {
  if (freq < 1000) return String(freq)
  return `${(freq / 1000).toFixed(freq >= 10_000 ? 0 : 1)}k`
}

function onInput(index: number, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  gains.value[index] = Number.isFinite(value) ? value : 0
  // 拖动过程中就要听到变化，不能等松手
  wave.setEqualizer(gains.value, enabled.value)
}

function commit(): void {
  void app.patchSettings({ equalizer: { enabled: enabled.value, gains: [...gains.value] } })
}

function toggle(): void {
  enabled.value = !enabled.value
  wave.setEqualizer(gains.value, enabled.value)
  commit()
}

function reset(): void {
  gains.value = EQ_BANDS.map(() => 0)
  wave.setEqualizer(gains.value, enabled.value)
  commit()
}
</script>

<template>
  <div class="eq-panel" :class="{ off: !enabled }" @click.stop>
    <div class="eq-head">
      <strong>均衡器</strong>
      <button class="switch" :class="{ on: enabled }" title="开关均衡器" @click="toggle">
        <i />
      </button>
    </div>

    <div class="eq-bands">
      <div v-for="(freq, index) in EQ_BANDS" :key="freq" class="eq-band">
        <span class="val">{{ gains[index] > 0 ? '+' : '' }}{{ gains[index].toFixed(1) }}</span>
        <input
          class="slider"
          type="range"
          :min="-EQ_MAX_GAIN"
          :max="EQ_MAX_GAIN"
          step="0.5"
          :value="gains[index]"
          :aria-label="`${label(freq)} Hz 增益`"
          @input="onInput(index, $event)"
          @change="commit"
        />
        <span class="freq">{{ label(freq) }}</span>
      </div>
    </div>

    <div class="eq-foot">
      <span class="hint">{{ flat ? '当前为平坦响应' : '松手后保存' }}</span>
      <button class="reset" :disabled="flat" @click="reset">重置</button>
    </div>
  </div>
</template>

<style scoped>
.eq-panel {
  position: absolute;
  top: 54px;
  right: 26px;
  z-index: 6;
  width: 268px;
  padding: 12px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-radius: 16px;
  background: var(--panel-strong);
  border: 1px solid var(--border);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.eq-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.eq-head strong {
  font-size: 12.5px;
  color: var(--text-1);
  font-weight: 600;
}
.switch {
  width: 34px;
  height: 19px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  display: flex;
  cursor: pointer;
  transition: background 0.16s ease;
}
.switch i {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--text-3);
  transition: transform 0.16s ease, background 0.16s ease;
}
.switch.on {
  background: rgba(110, 231, 255, 0.28);
  border-color: rgba(110, 231, 255, 0.5);
}
.switch.on i {
  transform: translateX(14px);
  background: #6ee7ff;
}
.eq-bands {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 2px 0;
}
.eq-band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 1;
}
.val {
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}
.slider {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 4px;
  height: 96px;
  accent-color: #6ee7ff;
  cursor: pointer;
}
.freq {
  font-size: 9.5px;
  color: var(--text-3);
}
.eq-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.eq-foot .hint {
  font-size: 10px;
  color: var(--text-3);
}
.reset {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
}
.reset:disabled {
  opacity: 0.4;
  cursor: default;
}
.off .eq-bands {
  opacity: 0.45;
}
</style>
