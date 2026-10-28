<script setup lang="ts">
import Icon from './Icon.vue'
import { useAppStore } from '../stores/app'

const app = useAppStore()
</script>

<template>
  <div class="toasts">
    <transition-group name="toast">
      <div v-for="toast in app.toasts" :key="toast.id" class="toast glass" :class="toast.type">
        <span class="dot" />
        <span class="msg">{{ toast.message }}</span>
        <button class="close" @click="app.toasts = app.toasts.filter((item) => item.id !== toast.id)">
          <Icon name="close" :size="12" />
        </button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 24px;
  bottom: calc(var(--player) + 20px);
  z-index: 120;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 10px 14px;
  border-radius: 12px;
  background: rgba(22, 22, 30, 0.92);
  box-shadow: var(--shadow);
  font-size: 12.5px;
  max-width: 380px;
  pointer-events: auto;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px currentColor;
  flex-shrink: 0;
}
.toast.error .dot {
  background: var(--danger);
}
.toast.success .dot {
  background: #3ddc97;
}

.msg {
  flex: 1;
  color: var(--text);
  line-height: 1.45;
}

.close {
  color: var(--text-3);
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
}
.close:hover {
  background: var(--panel-strong);
  color: var(--text);
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.28s var(--ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px) scale(0.96);
}
</style>
