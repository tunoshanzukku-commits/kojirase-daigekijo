import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './testUtils'
import { MAX_FEEDBACK_LENGTH } from '@shared/constants'
import type { FeedbackMeta } from '../src/feedback'

let server: Awaited<ReturnType<typeof startTestServer>>
let sent: { text: string; meta: FeedbackMeta }[]

beforeEach(async () => {
  sent = []
  // テストが外部へ通信しないよう転送を差し替える。
  server = await startTestServer({
    sendFeedback: async (text, meta) => { sent.push({ text, meta }) },
  })
})
afterEach(async () => {
  await server.close()
})

function postFeedback(port: number, body: unknown) {
  return fetch(`http://localhost:${port}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST /feedback は本文とメタ情報を転送する', async () => {
  const res = await postFeedback(server.port, {
    text: '面白かった',
    genre: 'コメディ',
    playerCount: 3,
    aiMode: true,
  })
  assert.equal(res.status, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '面白かった')
  assert.equal(sent[0].meta.genre, 'コメディ')
  assert.equal(sent[0].meta.playerCount, 3)
})

test('POST /feedback は空の本文を 400 で弾き、転送しない', async () => {
  const res = await postFeedback(server.port, { text: '   ' })
  assert.equal(res.status, 400)
  assert.equal(sent.length, 0)
})

test('POST /feedback は上限を超える本文を 400 で弾く', async () => {
  const res = await postFeedback(server.port, { text: 'あ'.repeat(MAX_FEEDBACK_LENGTH + 1) })
  assert.equal(res.status, 400)
  assert.equal(sent.length, 0)
})

// プレイヤー名は送らない設計。クライアントが余計に付けてきても転送先には出さない。
test('POST /feedback はプレイヤー名を受け取っても転送しない', async () => {
  await postFeedback(server.port, { text: '面白かった', playerName: 'たろう' })
  assert.equal(sent.length, 1)
  assert.ok(!JSON.stringify(sent[0]).includes('たろう'), 'プレイヤー名が転送されている')
})

// 転送先の障害をプレイヤーの責任にしない（書いた本文はもう戻ってこない）。
test('POST /feedback は転送が失敗しても 200 を返す', async () => {
  await server.close()
  server = await startTestServer({
    sendFeedback: async () => { throw new Error('webhook down') },
  })
  const res = await postFeedback(server.port, { text: '面白かった' })
  assert.equal(res.status, 200)
})

test('POST /feedback は同一IPからの連投を 429 で弾く', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await postFeedback(server.port, { text: `${i}回目` })).status, 200)
  }
  const res = await postFeedback(server.port, { text: '4回目' })
  assert.equal(res.status, 429)
  assert.equal(sent.length, 3, '弾かれた分が転送されている')
})
