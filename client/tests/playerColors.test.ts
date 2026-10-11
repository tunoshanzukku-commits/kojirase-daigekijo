import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLAYER_COLORS, playerColor, playerColorMap } from '../src/playerColors'

test('10色ある', () => {
  assert.equal(PLAYER_COLORS.length, 10)
})

test('1P は朱、10P は墨', () => {
  assert.equal(playerColor(0), '#b8352c')
  assert.equal(playerColor(9), '#241c17')
})

test('11人目以降は循環する', () => {
  assert.equal(playerColor(10), playerColor(0))
  assert.equal(playerColor(23), playerColor(3))
})

test('負の index でも落ちない', () => {
  assert.equal(playerColor(-1), playerColor(9))
})

test('色はすべて異なる', () => {
  assert.equal(new Set(PLAYER_COLORS).size, 10)
})

test('playerColorMap は参加順で名前に色を割り当てる', () => {
  const map = playerColorMap([{ name: 'ミチ' }, { name: 'タロウ' }, { name: 'ハナコ' }])
  assert.equal(map['ミチ'], '#b8352c')
  assert.equal(map['タロウ'], '#3a4f7a')
  assert.equal(map['ハナコ'], '#46603f')
})
