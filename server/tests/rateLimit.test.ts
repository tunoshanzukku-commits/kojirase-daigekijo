import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../src/rateLimit'

test('max 回までは true、超えたら false', () => {
  const limiter = createRateLimiter(1000, 2)
  assert.equal(limiter.allow('a', 0), true)
  assert.equal(limiter.allow('a', 100), true)
  assert.equal(limiter.allow('a', 200), false)
})

test('窓が過ぎたらまた通る', () => {
  const limiter = createRateLimiter(1000, 2)
  limiter.allow('a', 0)
  limiter.allow('a', 0)
  assert.equal(limiter.allow('a', 999), false)
  assert.equal(limiter.allow('a', 1000), true)
})

test('キーごとに独立して数える', () => {
  const limiter = createRateLimiter(1000, 1)
  assert.equal(limiter.allow('a', 0), true)
  assert.equal(limiter.allow('b', 0), true)
  assert.equal(limiter.allow('a', 0), false)
})

test('古いエントリは掃除される（IPごとに溜め続けない）', () => {
  const limiter = createRateLimiter(1000, 1)
  for (let i = 0; i < 10_050; i++) limiter.allow(`ip-${i}`, 0)
  // 窓を抜けた時刻で新規キーを通すと、その際に古いエントリが掃除される
  limiter.allow('trigger', 5000)
  assert.equal(limiter.size(), 1, '古いキーが残っている')
})
