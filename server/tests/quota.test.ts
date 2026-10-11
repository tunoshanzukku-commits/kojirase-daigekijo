import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { jstDateString, createQuota } from '../src/quota'
import type { Quota } from '../src/quota'

let quota: Quota

beforeEach(() => {
  quota = createQuota()
  process.env.DAILY_GAME_LIMIT = '2'
})

afterEach(() => {
  delete process.env.DAILY_GAME_LIMIT
  delete process.env.AI_ENABLED
})

test('jstDateString は UTC を JST の日付に直す', () => {
  // UTC 15:30 は JST では翌日 00:30
  assert.equal(jstDateString(new Date('2026-08-13T15:30:00Z')), '2026-08-14')
  assert.equal(jstDateString(new Date('2026-08-13T14:59:00Z')), '2026-08-13')
})

test('tryConsumeGame は上限まで true、超えたら false', () => {
  const now = new Date('2026-08-13T01:00:00Z')
  assert.equal(quota.tryConsumeGame(now), true)
  assert.equal(quota.tryConsumeGame(now), true)
  assert.equal(quota.tryConsumeGame(now), false)
})

test('上限に達しても used は増えない（false のとき消費しない）', () => {
  const now = new Date('2026-08-13T01:00:00Z')
  quota.tryConsumeGame(now)
  quota.tryConsumeGame(now)
  quota.tryConsumeGame(now)
  quota.tryConsumeGame(now)
  assert.equal(quota.getState(now).used, 2)
})

test('JST の日付が変わると枠がリセットされる', () => {
  const day1 = new Date('2026-08-13T01:00:00Z')
  quota.tryConsumeGame(day1)
  quota.tryConsumeGame(day1)
  assert.equal(quota.tryConsumeGame(day1), false)
  const day2 = new Date('2026-08-13T15:30:00Z') // JST で翌日
  assert.equal(quota.tryConsumeGame(day2), true)
  assert.equal(quota.getState(day2).used, 1)
})

test('DAILY_GAME_LIMIT=0 なら一度も消費できない', () => {
  process.env.DAILY_GAME_LIMIT = '0'
  assert.equal(quota.tryConsumeGame(new Date('2026-08-13T01:00:00Z')), false)
})

test('getQuotaState は日付が変わっていれば used=0 を返す（副作用なし）', () => {
  const day1 = new Date('2026-08-13T01:00:00Z')
  quota.tryConsumeGame(day1)
  const day2 = new Date('2026-08-13T15:30:00Z')
  assert.equal(quota.getState(day2).used, 0)
  // 翌日を覗いても内部状態は day1 のまま＝消費数が巻き戻っていないことを直接確かめる。
  // （ここで tryConsumeGame(day1) を見ると、状態が day2 に書き換わっていても
  //   「日付が変わった」判定でリセットされ true を返すので、副作用の有無を区別できない）
  assert.equal(quota.getState(day1).used, 1)
})

test('isAiAvailable は残枠があれば true', () => {
  const now = new Date('2026-08-13T01:00:00Z')
  assert.equal(quota.isAiAvailable(now), true)
  quota.tryConsumeGame(now)
  quota.tryConsumeGame(now)
  assert.equal(quota.isAiAvailable(now), false)
})

test('isAiAvailable は AI_ENABLED=false なら枠が残っていても false', () => {
  process.env.AI_ENABLED = 'false'
  assert.equal(quota.isAiAvailable(new Date('2026-08-13T01:00:00Z')), false)
})
