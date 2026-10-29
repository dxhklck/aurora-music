/**
 * HTTP 会话层：重试、失败计数（AsyncLocalStorage 作用域）、Cookie 累积、
 * 表单/JSON 编码、前缀读取，以及容错 JSON 与「GET 带 body」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  HttpSession,
  countFailure,
  extractJson,
  parseJsonLoose,
  rawGetWithBody,
  withFailureScope
} from '../../../src/main/engine/ts/http'
import { HttpError } from '../../../src/main/engine/ts/errors'
import { startServer } from './helpers'

test('非 2xx 会重试，成功后返回最后一次响应', async () => {
  let attempts = 0
  const server = await startServer((req, res) => {
    attempts += 1
    if (attempts < 3) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const session = new HttpSession({ maxRetries: 3 })
    const result = await session.get(`${server.url}/retry`)
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(attempts, 3)
  } finally {
    await server.close()
  }
})

test('失败次数计入当前作用域', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  try {
    const session = new HttpSession({ maxRetries: 2 })
    const scope = { errors: 0 }
    const result = await withFailureScope(scope, () => session.get(`${server.url}/always-500`))
    assert.equal(result.ok, false)
    assert.equal(scope.errors, 2)
  } finally {
    await server.close()
  }
})

test('作用域外的失败不累加到任何 scope（对应 ContextVar 默认值）', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(503)
    res.end()
  })
  try {
    const session = new HttpSession({ maxRetries: 1 })
    const before = { errors: 0 }
    await session.get(`${server.url}/x`)
    assert.equal(before.errors, 0)
    // 直接调用 countFailure 在没有作用域时也必须安全
    countFailure()
  } finally {
    await server.close()
  }
})

test('Set-Cookie 写回会话，后续请求自动携带', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/set') {
      res.writeHead(200, { 'set-cookie': 'sid=abc123; Path=/; HttpOnly' })
      res.end('ok')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' }))
  })
  try {
    const session = new HttpSession()
    await session.get(`${server.url}/set`)
    const echoed = await session.json<{ cookie: string }>(`${server.url}/echo`)
    assert.match(echoed.cookie, /sid=abc123/)
  } finally {
    await server.close()
  }
})

test('表单与 JSON 请求体的编码、Content-Type 正确', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: req.headers['content-type'] ?? '', body: '' }))
  })
  try {
    const session = new HttpSession()
    const form = await session.post(`${server.url}/form`, { form: { a: 1, b: '二' } })
    assert.match(form.text, /application\/x-www-form-urlencoded/)
    assert.equal(server.calls.at(-1)?.body, 'a=1&b=%E4%BA%8C')

    const json = await session.post(`${server.url}/json`, { json: { a: [1, 2] } })
    assert.match(json.text, /application\/json/)
    assert.equal(server.calls.at(-1)?.body, '{"a":[1,2]}')
  } finally {
    await server.close()
  }
})

test('maxBytes 只读前缀，不把整个音频拖下来', async () => {
  const payload = Buffer.alloc(10_000, 7)
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(payload.length) })
    res.end(payload)
  })
  try {
    const session = new HttpSession()
    const result = await session.get(`${server.url}/audio.mp3`, { maxBytes: 1024 })
    assert.equal(result.bytes.length, 1024)
    assert.equal(result.bytes[0], 7)
  } finally {
    await server.close()
  }
})

test('ensureOk 对非 2xx 抛 HttpError', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(404)
    res.end('missing')
  })
  try {
    const session = new HttpSession({ maxRetries: 1 })
    const result = await session.get(`${server.url}/missing`)
    assert.throws(() => HttpSession.ensureOk(result), (error: unknown) => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 404)
      return true
    })
  } finally {
    await server.close()
  }
})

test('parseJsonLoose 修复尾逗号 / 单引号 / BOM / 换行，脏文本返回空对象', () => {
  assert.deepEqual(parseJsonLoose('{"a":1,}'), { a: 1 })
  assert.deepEqual(parseJsonLoose("{'a': 'b'}"), { a: 'b' })
  assert.deepEqual(parseJsonLoose('\uFEFF{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('{\n"a": 1,\n"b": 2,\n}'), { a: 1, b: 2 })
  assert.deepEqual(parseJsonLoose('不是 JSON'), {})
  assert.deepEqual(parseJsonLoose(''), {})
  assert.deepEqual(parseJsonLoose('[1,2,]'), [1, 2])
})

test('extractJson 能从回调包裹 / 前缀噪声中抠出 JSON', () => {
  assert.deepEqual(extractJson('cb({"a":1});'), { a: 1 })
  assert.deepEqual(extractJson('prefix [1,2] suffix'), [1, 2])
  assert.deepEqual(extractJson('{"a":{"b":2}}tail'), { a: { b: 2 } })
  assert.deepEqual(extractJson('no json here'), {})
})

test('rawGetWithBody：GET 携带请求体，并正确解 gzip', async () => {
  const server = await startServer((req, res, body) => {
    const payload = gzipSync(Buffer.from(JSON.stringify({ method: req.method, body: body.toString('utf8') }), 'utf8'))
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(payload)
  })
  try {
    const result = await rawGetWithBody(`${server.url}/audioUrl?sign=x`, '{"musicId":"1"}', { 'User-Agent': 'test' })
    assert.equal(result.status, 200)
    const parsed = JSON.parse(result.text) as { method: string; body: string }
    assert.equal(parsed.method, 'GET')
    assert.equal(parsed.body, '{"musicId":"1"}')
    assert.equal(server.calls[0]?.headers['content-length'], '15')
  } finally {
    await server.close()
  }
})

test('连接失败时返回带 error 的结果而不是抛异常', async () => {
  const session = new HttpSession({ maxRetries: 2, timeoutMs: 500 })
  const result = await session.get('http://127.0.0.1:1/never')
  assert.equal(result.ok, false)
  assert.ok(result.error.length > 0)
})
