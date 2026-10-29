/**
 * 极简 HTML 解析与选择器。
 *
 * 为什么不用 cheerio / jsdom：引擎要打进 Electron 主进程，多一个依赖就多一份
 * 体积与升级风险；而这里只需要「找几个节点、取文本/属性」这点能力。支持的
 * 选择器就是音源实际用到的那些子集：
 *
 *   tag | .cls | tag.cls | #id | tag.cls1.cls2
 *   [attr] | [attr=value] | [attr*=value] | [attr^=value]
 *   后代组合（空格分隔），以及 `a, b` 并集
 *
 * 不支持的写法会在解析时抛错——宁可让音源在自检里红掉，也不要静默选错节点。
 */

import { decodeEntities } from './text'

export interface HtmlNode {
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
  parent: HtmlNode | null
  text: string
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea'])

/** 解实体：属性与文本共用同一套（`&nbsp;` 这类命名实体也要解，否则字段标签会失配） */
function decodeAttr(value: string): string {
  return decodeEntities(value)
}

/** 解析 HTML 为轻量树；容忍未闭合标签（音源页面并不都是合法 HTML） */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], parent: null, text: '' }
  let cursor = root
  const text = html ?? ''
  let index = 0

  while (index < text.length) {
    const lt = text.indexOf('<', index)
    if (lt < 0) {
      appendText(cursor, text.slice(index))
      break
    }
    if (lt > index) appendText(cursor, text.slice(index, lt))

    // 注释 / doctype / CDATA
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      index = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<!', lt) || text.startsWith('<?', lt)) {
      const end = text.indexOf('>', lt)
      index = end < 0 ? text.length : end + 1
      continue
    }

    const gt = findTagEnd(text, lt)
    if (gt < 0) {
      appendText(cursor, text.slice(lt))
      break
    }
    const raw = text.slice(lt + 1, gt)
    index = gt + 1

    if (raw.startsWith('/')) {
      const tagName = raw.slice(1).trim().toLowerCase()
      // 向上找到最近的同名节点再出栈，容忍错配
      let node: HtmlNode | null = cursor
      while (node && node.tag !== tagName) node = node.parent
      if (node && node.parent) cursor = node.parent
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const space = body.search(/[\s>]/)
    const tagName = (space < 0 ? body : body.slice(0, space)).trim().toLowerCase()
    if (!tagName) continue
    const node: HtmlNode = {
      tag: tagName,
      attrs: parseAttrs(space < 0 ? '' : body.slice(space)),
      children: [],
      parent: cursor,
      text: ''
    }
    cursor.children.push(node)

    if (selfClosing || VOID_TAGS.has(tagName)) continue
    if (RAW_TEXT_TAGS.has(tagName)) {
      const closeIndex = text.toLowerCase().indexOf(`</${tagName}`, index)
      if (closeIndex < 0) {
        node.text = text.slice(index)
        index = text.length
      } else {
        node.text = text.slice(index, closeIndex)
        const closeGt = text.indexOf('>', closeIndex)
        index = closeGt < 0 ? text.length : closeGt + 1
      }
      continue
    }
    cursor = node
  }
  return root
}

/**
 * 找到标签的结束 `>`。
 *
 * **只把双引号当作引号定界符**。单引号属性（`class='username'`）很常见，但
 * 属性值里的英文撇号（`title='don't stop'`）会让「单引号开合」永远配不上，
 * 扫描就会一路吃到最后都找不到 `>`，整个页面后半段被当成一个标签吞掉——
 * OpenGameArt 的详情页正是这样丢掉全部元数据的。
 * 双引号属性里出现 `"` 的概率远低于撇号，这个取舍在实践中更稳。
 */
function findTagEnd(text: string, start: number): number {
  let inDouble = false
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '"') {
      inDouble = !inDouble
      continue
    }
    if (ch === '>' && !inDouble) return index
    // 兜底：引号里不该出现 `<`，出现说明这个引号是误判，立刻退出引号态
    if (inDouble && ch === '<') inDouble = false
  }
  return -1
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([:@\w.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let matched: RegExpExecArray | null
  while ((matched = pattern.exec(raw)) !== null) {
    const name = matched[1].toLowerCase()
    if (!name || name === '/') continue
    const value = matched[2] ?? matched[3] ?? matched[4] ?? ''
    attrs[name] = decodeAttr(value)
  }
  return attrs
}

function appendText(node: HtmlNode, chunk: string): void {
  if (!chunk) return
  // 文本节点也要解实体：OpenGameArt 的字段标签是 `Author:&nbsp;`，
  // 不解的话会变成字面量 "&nbsp;"，后面所有按行匹配元数据的逻辑都会失配
  node.text += decodeAttr(chunk)
}

/** 取节点下全部文本（不含 script/style），`sep` 控制块级元素之间的分隔符 */
export function textOf(node: HtmlNode | null, sep = ''): string {
  if (!node) return ''
  const parts: string[] = []
  const walk = (current: HtmlNode): void => {
    if (current.tag === 'script' || current.tag === 'style') return
    if (current.text) parts.push(current.text)
    for (const child of current.children) {
      walk(child)
      if (sep) parts.push(sep)
    }
  }
  walk(node)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/** 取节点自身直属的文本（`''.join(str(child) for child in tag.contents)` 的近似） */
export function ownText(node: HtmlNode | null): string {
  if (!node) return ''
  return node.text.replace(/\s+/g, ' ').trim()
}

interface SimpleSelector {
  tag: string
  id: string
  classes: string[]
  attrs: Array<{ name: string; op?: '=' | '*=' | '^=' | '$='; value?: string }>
}

interface ComplexSelector {
  steps: SimpleSelector[]
}

function parseSelector(selector: string): ComplexSelector[] {
  return selector.split(',').map((group) => {
    const steps: SimpleSelector[] = []
    for (const rawStep of group.trim().split(/\s+/)) {
      if (!rawStep) continue
      steps.push(parseSimple(rawStep))
    }
    if (!steps.length) throw new Error(`空选择器：${selector}`)
    return { steps }
  })
}

function parseSimple(raw: string): SimpleSelector {
  const simple: SimpleSelector = { tag: '', id: '', classes: [], attrs: [] }
  let index = 0
  // tag 名（可省略）
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(raw)
  if (tagMatch) {
    simple.tag = tagMatch[0].toLowerCase()
    index = tagMatch[0].length
  }
  while (index < raw.length) {
    const ch = raw[index]
    if (ch === '.' || ch === '#') {
      const nameMatch = /^[\w-]+/.exec(raw.slice(index + 1))
      if (!nameMatch) throw new Error(`选择器写法不支持：${raw}`)
      if (ch === '.') simple.classes.push(nameMatch[0])
      else simple.id = nameMatch[0]
      index += 1 + nameMatch[0].length
      continue
    }
    if (ch === '[') {
      const end = raw.indexOf(']', index)
      if (end < 0) throw new Error(`选择器属性未闭合：${raw}`)
      const inside = raw.slice(index + 1, end)
      const attrMatch = /^([\w-:]+)\s*(?:([*^$]?=)\s*"?([^"\]]*)"?)?$/.exec(inside.trim())
      if (!attrMatch) throw new Error(`属性选择器写法不支持：${inside}`)
      simple.attrs.push({
        name: attrMatch[1].toLowerCase(),
        op: attrMatch[2] as SimpleSelector['attrs'][number]['op'],
        value: attrMatch[3]
      })
      index = end + 1
      continue
    }
    throw new Error(`选择器写法不支持：${raw}`)
  }
  if (!simple.tag && !simple.id && !simple.classes.length && !simple.attrs.length) {
    throw new Error(`空选择器片段：${raw}`)
  }
  return simple
}

function matchSimple(node: HtmlNode, simple: SimpleSelector): boolean {
  if (simple.tag && node.tag !== simple.tag) return false
  if (simple.id && node.attrs.id !== simple.id) return false
  if (simple.classes.length) {
    const classes = (node.attrs.class ?? '').split(/\s+/)
    for (const required of simple.classes) {
      if (!classes.includes(required)) return false
    }
  }
  for (const attr of simple.attrs) {
    const value = node.attrs[attr.name]
    if (value === undefined) return false
    if (!attr.op || attr.value === undefined) continue
    if (attr.op === '=' && value !== attr.value) return false
    if (attr.op === '*=' && !value.includes(attr.value)) return false
    if (attr.op === '^=' && !value.startsWith(attr.value)) return false
    if (attr.op === '$=' && !value.endsWith(attr.value)) return false
  }
  return true
}

function matchesChain(node: HtmlNode, steps: SimpleSelector[], stepIndex: number): boolean {
  if (!matchSimple(node, steps[stepIndex])) return false
  if (stepIndex === 0) return true
  let parent = node.parent
  while (parent) {
    if (matchesChain(parent, steps, stepIndex - 1)) return true
    parent = parent.parent
  }
  return false
}

/** 收集所有后代节点（含自身之后代，不含自身） */
function descendants(node: HtmlNode, output: HtmlNode[] = []): HtmlNode[] {
  for (const child of node.children) {
    output.push(child)
    descendants(child, output)
  }
  return output
}

export function selectAll(root: HtmlNode, selector: string): HtmlNode[] {
  const groups = parseSelector(selector)
  const pool = descendants(root)
  const matched: HtmlNode[] = []
  const seen = new Set<HtmlNode>()
  for (const node of pool) {
    for (const group of groups) {
      if (matchesChain(node, group.steps, group.steps.length - 1)) {
        if (!seen.has(node)) {
          seen.add(node)
          matched.push(node)
        }
        break
      }
    }
  }
  return matched
}

export function selectOne(root: HtmlNode, selector: string): HtmlNode | null {
  return selectAll(root, selector)[0] ?? null
}

/** 取属性的简写 */
export function attrOf(node: HtmlNode | null, name: string): string {
  return node?.attrs[name.toLowerCase()] ?? ''
}

/**
 * 取节点在**文档序**上的全部后继元素（等价 bs4 的 `find_all_next`）。
 *
 * 不能按「先取自己的后续兄弟、再上溯父级」的方式实现——那样会得到
 * 「深层兄弟优先」的顺序，跨层级时与文档序不一致。OpenGameArt 依赖这个顺序
 * 逐个扫描搜索结果，顺序一错就会漏掉或重复条目。这里直接做一次全树 DFS 再切片。
 */
export function followingNodes(node: HtmlNode): HtmlNode[] {
  const root = rootOf(node)
  const flat = descendants(root)
  const index = flat.indexOf(node)
  if (index < 0) return []
  return flat.slice(index + 1)
}

function rootOf(node: HtmlNode): HtmlNode {
  let current = node
  while (current.parent) current = current.parent
  return current
}

/** 按标签名收集（h1/h2/h3 这类） */
export function findByTags(root: HtmlNode, tags: string[]): HtmlNode[] {
  return descendants(root).filter((node) => tags.includes(node.tag))
}
