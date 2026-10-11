import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFeedback, buildDiscordPayload } from '../src/feedback'
import { MAX_FEEDBACK_LENGTH } from '@shared/constants'

test('validateFeedback は本文を前後の空白を落として返す', () => {
  const r = validateFeedback('  面白かった  ')
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.text, '面白かった')
})

// 誤タップで空の感想が飛んでくるとチャンネルがノイズで埋まる。
test('validateFeedback は空文字と空白だけの入力を弾く', () => {
  assert.equal(validateFeedback('').ok, false)
  assert.equal(validateFeedback('   \n  ').ok, false)
})

// クライアントの maxLength は当てにしない（curl で直接叩ける）。
test('validateFeedback は上限を超える本文を弾く', () => {
  assert.equal(validateFeedback('あ'.repeat(MAX_FEEDBACK_LENGTH)).ok, true)
  assert.equal(validateFeedback('あ'.repeat(MAX_FEEDBACK_LENGTH + 1)).ok, false)
})

test('validateFeedback は文字列でない値を弾く', () => {
  for (const v of [undefined, null, 42, {}, ['あ']]) {
    assert.equal(validateFeedback(v).ok, false, `${JSON.stringify(v)} が通ってしまう`)
  }
})

test('buildDiscordPayload は本文とメタ情報を載せる', () => {
  const p = buildDiscordPayload('面白かった', { genre: 'コメディ', playerCount: 3, aiMode: true })
  assert.match(p.content, /面白かった/)
  assert.match(p.content, /コメディ/)
  assert.match(p.content, /3/)
})

// ⚠️ Discord の Webhook は既定で @everyone / @here を実際に飛ばす。
// 感想欄は誰でも書けるので、これを止めないとチャンネル全員を鳴らす手段を公開することになる。
test('buildDiscordPayload はメンションを一切飛ばさない', () => {
  const p = buildDiscordPayload('@everyone こんにちは', { genre: 'コメディ', playerCount: 1, aiMode: false })
  assert.deepEqual(p.allowed_mentions, { parse: [] })
})

// メタが欠けていても落とさない（クライアントの都合で送られないことがある）。
test('buildDiscordPayload はメタ情報が無くても本文を載せる', () => {
  const p = buildDiscordPayload('面白かった', {})
  assert.match(p.content, /面白かった/)
})
