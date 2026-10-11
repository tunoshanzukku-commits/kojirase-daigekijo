import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestServer } from './testUtils'

// buildServer() は process.env.NODE_ENV を呼び出し時に読むため、ここで 'production' に
// 固定してから起動する。他の全テスト（162件）へ波及しないよう、失敗時も含めて
// 必ず afterEach で元の値に戻す。client/dist は実ビルドを汚さないよう毎回テンポラリに作る。
const STUB_HTML = '<!doctype html><html><body>stub-index</body></html>'

let originalNodeEnv: string | undefined
let distDir: string
let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  distDir = mkdtempSync(join(tmpdir(), 'kojirase-dist-'))
  writeFileSync(join(distDir, 'index.html'), STUB_HTML)
  server = await startTestServer({ distDir })
})

afterEach(async () => {
  await server.close()
  rmSync(distDir, { recursive: true, force: true })
  process.env.NODE_ENV = originalNodeEnv
})

test('production: /health は JSON を返す（HTML に飲まれない）', async () => {
  const res = await fetch(`http://localhost:${server.port}/health`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
  assert.deepEqual(await res.json(), { ok: true })
})

test('production: 拡張子なしの未知パスは index.html を返す（SPA フォールバック）', async () => {
  const res = await fetch(`http://localhost:${server.port}/lobby`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type')?.includes('text/html'), true)
  assert.equal(await res.text(), STUB_HTML)
})

test('production: 存在しないアセットは 404（index.html を返さない）', async () => {
  const res = await fetch(`http://localhost:${server.port}/assets/nope.js`)
  assert.equal(res.status, 404)
  assert.notEqual(res.headers.get('content-type')?.includes('text/html'), true)
})

test('production: POST /upload は SPA フォールバックに飲まれず実ルートへ届く', async () => {
  const res = await fetch(`http://localhost:${server.port}/upload`, { method: 'POST' })
  // socketId 無しの不正リクエストなので 200 にはならないが、重要なのは
  // index.html（text/html, 200）に飲まれていないこと＝実ルートに到達した証拠。
  assert.notEqual(res.headers.get('content-type')?.includes('text/html'), true)
  assert.notEqual(res.status, 200)
})
