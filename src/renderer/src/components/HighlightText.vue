<script setup lang="ts">
import { computed } from 'vue'

/** 把命中的片段包成 <mark>，其余原样输出；纯文本渲染，不碰 v-html */
const props = defineProps<{ text: string; query?: string }>()

interface Part {
  text: string
  hit: boolean
}

const parts = computed<Part[]>(() => {
  const keyword = (props.query ?? '').trim()
  if (!keyword) return [{ text: props.text, hit: false }]

  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped, 'gi')
  const out: Part[] = []
  let last = 0
  for (const match of props.text.matchAll(re)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: props.text.slice(last, at), hit: false })
    out.push({ text: match[0], hit: true })
    last = at + match[0].length
  }
  if (!out.length) return [{ text: props.text, hit: false }]
  if (last < props.text.length) out.push({ text: props.text.slice(last), hit: false })
  return out
})
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <mark v-if="part.hit" class="hit">{{ part.text }}</mark>
    <span v-else>{{ part.text }}</span>
  </template>
</template>

<style scoped>
.hit {
  background: color-mix(in srgb, var(--accent) 34%, transparent);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
}
</style>
