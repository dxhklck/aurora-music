<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string
    confirmText?: string
    cancelText?: string
    /** 危险动作：确认按钮用红色，并默认把焦点放在取消上 */
    danger?: boolean
    busy?: boolean
  }>(),
  { confirmText: '确定', cancelText: '取消', danger: false, busy: false }
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <div class="mask" @click.self="!busy && emit('cancel')">
    <div class="dialog" :class="{ danger }">
      <h3>{{ title }}</h3>
      <div class="body"><slot /></div>
      <div class="foot">
        <button class="btn" :disabled="busy" autofocus @click="emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          class="btn"
          :class="danger ? 'danger' : 'primary'"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? '处理中…' : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(6px);
}
.dialog {
  width: 420px;
  max-width: calc(100vw - 48px);
  padding: 20px 22px 16px;
  border-radius: 18px;
  /* 实底 + 半透明叠加：纯 rgba 面板会让背后的封面透上来 */
  background-color: var(--bg);
  background-image: linear-gradient(var(--panel-strong), var(--panel-strong));
  border: 1px solid var(--border);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
}
.dialog h3 {
  margin: 0 0 12px;
  font-size: 14.5px;
  color: var(--text-1);
}
.body {
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-2);
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.btn.danger {
  background: linear-gradient(120deg, #e5484d, #b4232b);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 8px 24px rgba(229, 72, 77, 0.35);
}
.btn.danger:hover {
  filter: brightness(1.08);
}
</style>
