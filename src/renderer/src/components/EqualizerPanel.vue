<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from '../stores/app'
import { EQ_BANDS, EQ_MAX_GAIN, PREAMP_MAX, wave } from '../core/wave'

/**
 * 五段图形均衡器 + 内置预设。
 *
 * 数据流很直白：拖动 → 立刻改音频图（要听见）→ 松手才落盘（别每像素写一次 settings.json）。
 * 参数在音频图未挂接时也能设置：wave 内部会缓存，等第一次打开播放舞台时一起生效。
 */

const app = useAppStore()

/**
 * 内置预设（dB，按 EQ_BANDS 顺序 60/230/910/3600/14000，范围 ±12）。
 * 夜间档附带动态压缩；其余是常规五段曲线的经验值，起点参考了 Winamp 系预设
 * 再按本机 5 段中心频率重新折算。
 */
const PRESETS: Array<{ name: string; gains: number[] }> = [
  { name: '流行', gains: [2, 0, -1.5, 1.5, 2.5] },
  { name: '摇滚', gains: [4.5, 2, -2, 3, 3.5] },
  { name: '人声', gains: [-2.5, -1, 4, 2.5, -1.5] },
  { name: '低音', gains: [6.5, 4.5, 0.5, -1, -2] },
  { name: '夜间', gains: [2, 1.5, -0.5, -2, -4.5] },
  { name: '古典', gains: [3.5, 1.5, -1.5, 2, 3] },
  { name: '爵士', gains: [3, 2, -1, 1.5, 2] },
  { name: '电子', gains: [4.5, 2, -2.5, 2.5, 4] },
  { name: '嘻哈', gains: [5, 3.5, -1, 1, 2.5] },
  { name: '原声', gains: [2.5, 1, 1, 2, 1.5] }
]

function initialGains(): number[] {
  const saved = app.settings?.equalizer?.gains
  return EQ_BANDS.map((_, index) => {
    const value = Number(saved?.[index])
    return Number.isFinite(value) ? Math.max(-EQ_MAX_GAIN, Math.min(EQ_MAX_GAIN, value)) : 0
  })
}

const gains = ref<number[]>(initialGains())
const enabled = ref(app.settings?.equalizer?.enabled === true)
/** 夜间限幅（动态压缩）。跟「夜间」预设绑定，也随设置持久化 */
const night = ref(app.settings?.equalizer?.night === true)
/** 总增益补偿（dB）：独立于五段曲线，给安静的音源补音量 */
const preamp = ref(Number(app.settings?.equalizer?.preamp) || 0)
const flat = computed(() => gains.value.every((value) => value === 0) && preamp.value === 0)

/* ---------------- 自定义预设（localStorage 持久化） ---------------- */

interface Preset {
  name: string
  gains: number[]
}
const CUSTOM_KEY = 'aurora.eq-presets'

function loadCustom(): Preset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is Preset =>
        !!item &&
        typeof (item as Preset).name === 'string' &&
        Array.isArray((item as Preset).gains) &&
        (item as Preset).gains.length === EQ_BANDS.length
    )
  } catch {
    return []
  }
}

const customPresets = ref<Preset[]>(loadCustom())
const saving = ref(false)
const newName = ref('')

/** 展示顺序：内置在前，自定义在后 */
const allPresets = computed<Preset[]>(() => [...PRESETS, ...customPresets.value])
const isCustom = (preset: Preset): boolean => !PRESETS.includes(preset)

function persistCustom(): void {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customPresets.value))
}

function startSave(): void {
  if (flat.value) {
    app.toast('当前是平坦响应，先调好曲线再存为预设', 'info')
    return
  }
  saving.value = true
  newName.value = ''
}

function savePreset(): void {
  const name = newName.value.trim()
  if (!name) return
  if (name.length > 8) {
    app.toast('名字 8 个字以内', 'info')
    return
  }
  if (PRESETS.some((preset) => preset.name === name)) {
    app.toast('不能覆盖内置预设，换个名字', 'info')
    return
  }
  customPresets.value = [...customPresets.value.filter((preset) => preset.name !== name), { name, gains: [...gains.value] }]
  persistCustom()
  saving.value = false
  newName.value = ''
}

function removePreset(name: string): void {
  customPresets.value = customPresets.value.filter((preset) => preset.name !== name)
  persistCustom()
}

/** 当前增益是否命中某个预设（容差 0.25，浮点/滑杆步进损耗下也能认出来） */
const activePreset = computed(() =>
  allPresets.value.find((preset) =>
    preset.gains.every((value, index) => Math.abs(value - gains.value[index]) <= 0.25)
  )
)

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
  void app.patchSettings({
    equalizer: { enabled: enabled.value, gains: [...gains.value], night: night.value, preamp: preamp.value }
  })
}

function onPreampInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  preamp.value = Number.isFinite(value) ? value : 0
  wave.setPreamp(preamp.value)
}

function toggle(): void {
  enabled.value = !enabled.value
  wave.setEqualizer(gains.value, enabled.value)
  commit()
}

function applyPreset(preset: Preset): void {
  gains.value = [...preset.gains]
  enabled.value = true
  // 只有「夜间」档带限幅；切到任何别的预设都把它收掉
  night.value = preset.name === '夜间'
  wave.setEqualizer(gains.value, enabled.value)
  wave.setNightLimiter(night.value)
  commit()
}

function reset(): void {
  gains.value = EQ_BANDS.map(() => 0)
  night.value = false
  preamp.value = 0
  wave.setEqualizer(gains.value, enabled.value)
  wave.setNightLimiter(false)
  wave.setPreamp(0)
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

    <div class="presets">
      <button
        v-for="preset in allPresets"
        :key="preset.name"
        :class="{ active: activePreset === preset }"
        :title="preset.name === '夜间' ? '压低动态、收敛高频，深夜听不吵人' : undefined"
        @click="applyPreset(preset)"
      >
        <span>{{ preset.name }}</span>
        <span
          v-if="isCustom(preset)"
          class="del"
          title="删除该预设"
          @click.stop="removePreset(preset.name)"
        >×</span>
      </button>
      <button v-if="!saving" class="preset-add" title="把当前曲线存成自己的预设" @click="startSave">
        ＋存为预设
      </button>
    </div>

    <div v-if="saving" class="save-row">
      <input
        v-model="newName"
        class="save-input"
        placeholder="预设名字（≤8 字）"
        maxlength="8"
        @keydown.enter="savePreset"
      />
      <button class="save-ok" @click="savePreset">保存</button>
      <button class="save-cancel" @click="saving = false">取消</button>
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

    <div class="eq-preamp">
      <span class="preamp-label">总增益</span>
      <input
        class="preamp-slider"
        type="range"
        :min="-PREAMP_MAX"
        :max="PREAMP_MAX"
        step="0.5"
        :value="preamp"
        aria-label="总增益补偿"
        @input="onPreampInput"
        @change="commit"
      />
      <span class="preamp-val">{{ preamp > 0 ? '+' : '' }}{{ preamp.toFixed(1) }} dB</span>
    </div>

    <div class="eq-foot">
      <span class="hint">{{ night ? '夜间限幅中 · 动态已压低' : flat ? '当前为平坦响应' : '松手后保存' }}</span>
      <button class="reset" :disabled="flat && !night" @click="reset">重置</button>
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
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.presets button {
  flex: 1 1 auto;
  min-width: 44px;
  padding: 4.5px 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
  transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease;
}
.presets button .del {
  color: var(--text-3);
  font-size: 11px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.presets button:hover .del {
  opacity: 1;
}
.presets button .del:hover {
  color: #ff7b7b;
}
.presets .preset-add {
  border-style: dashed;
  color: var(--text-3);
}
.presets .preset-add:hover {
  color: var(--text-1);
  border-color: var(--text-3);
  background: rgba(255, 255, 255, 0.05);
}
.save-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.save-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-1);
  font-size: 11px;
}
.save-input:focus {
  outline: none;
  border-color: rgba(110, 231, 255, 0.5);
}
.save-ok,
.save-cancel {
  flex: none;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
}
.save-ok {
  color: #6ee7ff;
  border-color: rgba(110, 231, 255, 0.5);
}
.presets button:hover {
  color: var(--text-1);
  background: rgba(255, 255, 255, 0.1);
}
.presets button.active {
  color: #6ee7ff;
  border-color: rgba(110, 231, 255, 0.5);
  background: rgba(110, 231, 255, 0.14);
}
.off .presets {
  opacity: 0.45;
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
.eq-preamp {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  font-size: 10px;
  color: var(--text-3);
}
.preamp-label {
  flex: none;
}
.preamp-slider {
  flex: 1;
  height: 4px;
  accent-color: #6ee7ff;
  cursor: pointer;
}
.preamp-val {
  flex: none;
  min-width: 46px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.off .eq-preamp {
  opacity: 0.45;
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
