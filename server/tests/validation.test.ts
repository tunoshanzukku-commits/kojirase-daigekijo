import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeName, isValidName, normalizeRoomCode, isValidRoomCode, isValidGenre,
  isValidEmoji, isValidBgmId, isValidSfxId,
} from '../src/validation'

test('sanitizeName は前後空白除去と制御文字除去を行う', () => {
  assert.equal(sanitizeName('  たろう  '), 'たろう')
  const dirty = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(10) + 'c'
  assert.equal(sanitizeName(dirty), 'abc')
})

test('isValidName は 1〜10 文字を許可', () => {
  assert.equal(isValidName(''), false)
  assert.equal(isValidName('a'), true)
  assert.equal(isValidName('あ'.repeat(10)), true)
  assert.equal(isValidName('あ'.repeat(11)), false)
})

test('normalizeRoomCode は大文字化・不正文字除去・4文字上限', () => {
  assert.equal(normalizeRoomCode('ab-cd'), 'ABCD')
  assert.equal(normalizeRoomCode('abcde'), 'ABCD')
  assert.equal(normalizeRoomCode('a1o9i!'), 'A') // 数字/記号除去・I,O除外
})

test('isValidRoomCode は許可文字4文字のみ true', () => {
  assert.equal(isValidRoomCode('ABCD'), true)
  assert.equal(isValidRoomCode('ABC'), false)
  assert.equal(isValidRoomCode('ABIO'), false)
})

test('isValidGenre は定義済みジャンルのみ true', () => {
  assert.equal(isValidGenre('romance'), true)
  assert.equal(isValidGenre('chaos'), true)
  assert.equal(isValidGenre('unknown'), false)
})

test('isValidEmoji は許可絵文字のみ true', () => {
  assert.equal(isValidEmoji('🔥'), true)
  assert.equal(isValidEmoji('💩'), false)
  assert.equal(isValidEmoji(''), false)
  assert.equal(isValidEmoji(123 as unknown as string), false)
})

test('isValidBgmId は許可ID と null を true、それ以外 false', () => {
  assert.equal(isValidBgmId('dramatic'), true)
  assert.equal(isValidBgmId(null), true)
  assert.equal(isValidBgmId('rock'), false)
  assert.equal(isValidBgmId(undefined as unknown as string), false)
})

test('isValidSfxId は許可IDのみ true', () => {
  assert.equal(isValidSfxId('drum'), true)
  assert.equal(isValidSfxId('explode'), false)
  assert.equal(isValidSfxId(null as unknown as string), false)
})
