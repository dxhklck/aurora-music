<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '../components/Icon.vue'
import HighlightText from '../components/HighlightText.vue'
import { GUIDE, type GuideEntry, type GuideSection } from '../data/guide'

const route = useRoute()
const keyword = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const rootEl = ref<HTMLElement | null>(null)
const activeId = ref(GUIDE[0]?.id ?? '')
const query = computed(() => keyword.value.trim().toLowerCase())

/** 页面滚动容器是 App.vue 的 .page，不是 window */
let pageEl: HTMLElement | null = null

function entryMatches(entry: GuideEntry, keyword: string): boolean {
  const haystack = [entry.q, entry.a, entry.note ?? '', ...(entry.steps ?? []), ...(entry.keys ?? [])]
    .join(' ')
    .toLowerCase()
  return haystack.includes(keyword)
}

const sections = computed(() => {
  const keyword = query.value
  if (!keyword) return GUIDE
  return GUIDE.map((section) => {
    // 优先只留命中的条目；条目全不中但标题/导语命中时，才整节留下当入口
    const hit = section.entries.filter((entry) => entryMatches(entry, keyword))
    if (hit.length) return { ...section, entries: hit }
    const headHit = `${section.title} ${section.intro}`.toLowerCase().includes(keyword)
    return headHit ? section : null
  }).filter((section): section is GuideSection => section !== null)
})

const hitCount = computed(() => sections.value.reduce((sum, section) => sum + section.entries.length, 0))

/** 滚动到某一节；隐藏的分节（被搜索过滤掉）没有 DOM，直接忽略 */
function jump(id: string, smooth = true): void {
  const el = document.getElementById(`guide-${id}`)
  if (!el) return
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
  activeId.value = id
}

/** 目录高亮：取「顶边已经越过参考线」的最后一个分节 */
function syncActive(): void {
  if (!pageEl) return
  const line = pageEl.getBoundingClientRect().top + 120
  let current = sections.value[0]?.id ?? ''
  for (const section of sections.value) {
    const el = document.getElementById(`guide-${section.id}`)
    if (el && el.getBoundingClientRect().top <= line) current = section.id
  }
  activeId.value = current
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing =
    !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  if (event.key === '/' && !typing) {
    event.preventDefault()
    inputEl.value?.focus()
    return
  }
  if (event.key === 'Escape' && document.activeElement === inputEl.value) {
    keyword.value = ''
    inputEl.value?.blur()
  }
}

onMounted(async () => {
  pageEl = (rootEl.value?.closest('.page') as HTMLElement | null) ?? null
  pageEl?.addEventListener('scroll', syncActive, { passive: true })
  window.addEventListener('keydown', onKeydown)

  const target = route.query.s
  if (typeof target === 'string' && target) {
    await nextTick()
    jump(target, false)
  } else {
    syncActive()
  }
})

onBeforeUnmount(() => {
  pageEl?.removeEventListener('scroll', syncActive)
  window.removeEventListener('keydown', onKeydown)
})

// 搜索把当前分节过滤掉后，目录高亮会悬空，回落到第一节
watch(sections, async (list) => {
  await nextTick()
  if (!list.some((section) => section.id === activeId.value)) {
    activeId.value = list[0]?.id ?? ''
  }
  syncActive()
})
</script>

<template>
  <div ref="rootEl" class="guide">
    <header class="head">
      <div class="head-text">
        <h1>使用指南</h1>
        <p>全部内容都在本地，离线可看；随时按 <kbd>F1</kbd> 回到这里。</p>
      </div>
      <label class="search">
        <Icon name="search" :size="14" />
        <input
          ref="inputEl"
          v-model="keyword"
          type="text"
          placeholder="搜功能、按钮或问题…"
          spellcheck="false"
        />
        <kbd>/</kbd>
      </label>
    </header>

    <div class="layout">
      <nav class="toc">
        <button
          v-for="section in sections"
          :key="section.id"
          class="toc-item"
          :class="{ active: activeId === section.id }"
          @click="jump(section.id)"
        >
          <Icon :name="section.icon" :size="15" />
          <span>{{ section.title }}</span>
          <em>{{ section.entries.length }}</em>
        </button>
        <p v-if="query" class="toc-count">命中 {{ hitCount }} 条</p>
      </nav>

      <div class="body">
        <section v-for="section in sections" :id="`guide-${section.id}`" :key="section.id" class="sec">
          <div class="sec-head">
            <span class="ico"><Icon :name="section.icon" :size="16" /></span>
            <div class="sec-text">
              <strong>{{ section.title }}</strong>
              <small><HighlightText :text="section.intro" :query="keyword" /></small>
            </div>
          </div>

          <article v-for="(entry, index) in section.entries" :key="index" class="entry">
            <h3><HighlightText :text="entry.q" :query="keyword" /></h3>
            <p><HighlightText :text="entry.a" :query="keyword" /></p>

            <ol v-if="entry.steps" class="steps">
              <li v-for="(step, i) in entry.steps" :key="i">
                <HighlightText :text="step" :query="keyword" />
              </li>
            </ol>

            <ul v-if="entry.keys" class="keys">
              <li v-for="(key, i) in entry.keys" :key="i">
                <HighlightText :text="key" :query="keyword" />
              </li>
            </ul>

            <p v-if="entry.note" class="note">
              <HighlightText :text="entry.note" :query="keyword" />
            </p>
          </article>
        </section>

        <div v-if="!sections.length" class="empty">
          <strong>没有匹配的内容</strong>
          <span>换个关键词试试，或清空搜索查看全部。</span>
          <button class="btn" @click="keyword = ''">清空搜索</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide {
  max-width: 1040px;
  padding-bottom: 40px;
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 10px 0 18px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 750;
}
.head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.head kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text-2);
}

.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  width: 260px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text-3);
}
.search:focus-within {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--text-2);
}
.search input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  font-size: 12px;
  color: var(--text);
}
.search input::placeholder {
  color: var(--text-3);
}
.search kbd {
  font-family: inherit;
  font-size: 10.5px;
  padding: 1px 5px;
  border-radius: 5px;
  border: 1px solid var(--border);
  color: var(--text-3);
}

.layout {
  display: grid;
  grid-template-columns: 188px minmax(0, 1fr);
  gap: 26px;
  align-items: start;
}

.toc {
  position: sticky;
  top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.toc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  font-size: 12px;
  color: var(--text-3);
  text-align: left;
}
.toc-item span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc-item em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-3);
  opacity: 0.7;
}
.toc-item:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-2);
}
.toc-item.active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.toc-item.active em {
  color: var(--accent);
  opacity: 0.8;
}
.toc-count {
  margin: 8px 10px 0;
  font-size: 11px;
  color: var(--text-3);
}

.sec {
  scroll-margin-top: 6px;
  margin-bottom: 22px;
}
.sec-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.sec-head .ico {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  flex-shrink: 0;
}
.sec-text strong {
  display: block;
  font-size: 14px;
  font-weight: 650;
}
.sec-text small {
  color: var(--text-3);
  font-size: 11.5px;
}

.entry {
  margin-top: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel);
}
.entry:hover {
  background: var(--panel-strong);
  border-color: var(--border-strong);
}
.entry h3 {
  margin: 0 0 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}
.entry p {
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-2);
}

.steps {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-2);
}
.steps li::marker {
  color: var(--text-3);
}

.keys {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 9px 0 0;
  padding: 0;
}
.keys li {
  font-size: 11.5px;
  padding: 3px 8px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.entry p.note {
  margin: 8px 0 0;
  padding: 7px 10px;
  border-radius: 0 8px 8px 0;
  border-left: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  font-size: 11.5px;
  color: var(--text-2);
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .toc {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
  }
  .toc-count {
    display: none;
  }
}
</style>
