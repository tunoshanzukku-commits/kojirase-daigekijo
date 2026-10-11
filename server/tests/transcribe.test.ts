import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTranscriber, extForMime } from '../src/transcribe'

test('extForMime は codecs 付き mime と各種 mime を拡張子に変換', () => {
  assert.equal(extForMime('audio/webm;codecs=opus'), 'webm')
  assert.equal(extForMime('audio/webm'), 'webm')
  assert.equal(extForMime('audio/mp4'), 'mp4')
  assert.equal(extForMime('audio/ogg'), 'ogg')
  assert.equal(extForMime('audio/wav'), 'wav')
  assert.equal(extForMime('audio/mpeg'), 'mp3')
  assert.equal(extForMime('application/octet-stream'), 'webm') // 既定
})

test('transcribe は Groq 応答の text を返す（fetch をモック）', async () => {
  const orig = globalThis.fetch
  process.env.GROQ_API_KEY = 'test-key'
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 })) as typeof fetch
  try {
    const transcribe = createTranscriber()
    const text = await transcribe({ buffer: Buffer.from([1, 2, 3]), mime: 'audio/webm' })
    assert.equal(text, 'こんにちは')
  } finally {
    globalThis.fetch = orig
    delete process.env.GROQ_API_KEY
  }
})

test('transcribe は 1 回リトライする（1回目失敗→2回目成功）', async () => {
  const orig = globalThis.fetch
  process.env.GROQ_API_KEY = 'test-key'
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) throw new Error('network')
    return new Response(JSON.stringify({ text: 'やあ' }), { status: 200 })
  }) as typeof fetch
  try {
    const transcribe = createTranscriber()
    const text = await transcribe({ buffer: Buffer.from([1]), mime: 'audio/webm' })
    assert.equal(text, 'やあ')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = orig
    delete process.env.GROQ_API_KEY
  }
})

test('transcribe は 2 回失敗すると throw', async () => {
  const orig = globalThis.fetch
  process.env.GROQ_API_KEY = 'test-key'
  globalThis.fetch = (async () => new Response('err', { status: 500 })) as typeof fetch
  try {
    const transcribe = createTranscriber()
    await assert.rejects(() => transcribe({ buffer: Buffer.from([1]), mime: 'audio/webm' }))
  } finally {
    globalThis.fetch = orig
    delete process.env.GROQ_API_KEY
  }
})
