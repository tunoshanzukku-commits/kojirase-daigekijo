import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRoomCode, generateUniqueRoomCode } from '../src/roomCode'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '@shared/constants'

test('generateRoomCode は許可文字のみで ROOM_CODE_LEN 文字', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode()
    assert.equal(code.length, ROOM_CODE_LEN)
    for (const ch of code) {
      assert.ok(ROOM_CODE_ALPHABET.includes(ch), `想定外の文字: ${ch}`)
    }
  }
})

test('generateRoomCode は I と O を含まない', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode()
    assert.ok(!code.includes('I'))
    assert.ok(!code.includes('O'))
  }
})

test('generateUniqueRoomCode は既存コードを避けて再生成する', () => {
  const taken = new Set<string>()
  const first = generateUniqueRoomCode(c => taken.has(c))
  taken.add(first)
  const second = generateUniqueRoomCode(c => taken.has(c))
  assert.notEqual(first, second)
})
