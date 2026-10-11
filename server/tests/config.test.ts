import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { dailyGameLimit, aiEnabled, publicEnabled } from '../src/config'

const KEYS = ['DAILY_GAME_LIMIT', 'AI_ENABLED', 'PUBLIC_ENABLED'] as const

afterEach(() => {
  for (const k of KEYS) delete process.env[k]
})

test('dailyGameLimit は未設定なら既定 5', () => {
  assert.equal(dailyGameLimit(), 5)
})

test('dailyGameLimit は整数文字列を数値にする', () => {
  process.env.DAILY_GAME_LIMIT = '20'
  assert.equal(dailyGameLimit(), 20)
})

test('dailyGameLimit は 0 を許可する（全ゲームを簡易モードにできる）', () => {
  process.env.DAILY_GAME_LIMIT = '0'
  assert.equal(dailyGameLimit(), 0)
})

test('dailyGameLimit は不正値・負数・小数を既定へフォールバックする', () => {
  for (const bad of ['abc', '-1', '1.5', '']) {
    process.env.DAILY_GAME_LIMIT = bad
    assert.equal(dailyGameLimit(), 5, `"${bad}" は既定に落ちるべき`)
  }
})

test('dailyGameLimit は空白だけの値を既定へフォールバックする（Number("  ")=0 に落ちない）', () => {
  for (const blank of ['  ', '\t', '\n ']) {
    process.env.DAILY_GAME_LIMIT = blank
    assert.equal(dailyGameLimit(), 5, `${JSON.stringify(blank)} は既定に落ちるべき`)
  }
})

test('dailyGameLimit は前後に空白がある整数を読める', () => {
  process.env.DAILY_GAME_LIMIT = ' 3 '
  assert.equal(dailyGameLimit(), 3)
})

test('aiEnabled / publicEnabled は未設定なら true', () => {
  assert.equal(aiEnabled(), true)
  assert.equal(publicEnabled(), true)
})

test('aiEnabled は false / FALSE を false と解釈する', () => {
  process.env.AI_ENABLED = 'false'
  assert.equal(aiEnabled(), false)
  process.env.AI_ENABLED = 'FALSE'
  assert.equal(aiEnabled(), false)
})

test('publicEnabled は不正値なら既定 true（設定ミスでサービスを止めない）', () => {
  process.env.PUBLIC_ENABLED = 'yes'
  assert.equal(publicEnabled(), true)
})

test('環境変数は呼び出しごとに読む（差し替えが即反映される）', () => {
  assert.equal(dailyGameLimit(), 5)
  process.env.DAILY_GAME_LIMIT = '99'
  assert.equal(dailyGameLimit(), 99)
})
