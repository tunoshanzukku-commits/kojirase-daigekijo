import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateStubScores } from '../../src/ai/scoreStub'

test('generateStubScores は名前ごとに1件返す', () => {
  const scores = generateStubScores(['たろう', 'はなこ'])
  assert.equal(scores.length, 2)
  assert.deepEqual(scores.map(s => s.playerName), ['たろう', 'はなこ'])
})

test('各スコアは 1〜5、comment は非空', () => {
  const scores = generateStubScores(['たろう', 'はなこ', 'けんじ'])
  for (const s of scores) {
    for (const v of [s.acting, s.emotion, s.kojirase]) {
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 5, `score out of range: ${v}`)
    }
    assert.ok(s.comment.length > 0)
  }
})

test('同じ名前には決定的（テスト再現性）', () => {
  const a = generateStubScores(['たろう'])[0]
  const b = generateStubScores(['たろう'])[0]
  assert.deepEqual(a, b)
})

test('空入力は空配列', () => {
  assert.deepEqual(generateStubScores([]), [])
})
