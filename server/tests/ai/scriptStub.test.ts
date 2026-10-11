import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateStubScript } from '../../src/ai/scriptStub'

test('generateStubScript は全プレイヤー分の役とセリフを生成', () => {
  const names = ['たろう', 'はなこ', 'けんじ']
  const script = generateStubScript('jidai', names)
  assert.equal(script.roles.length, 3)
  assert.deepEqual(script.roles.map(r => r.player), names)
  assert.ok(script.entries.length >= names.length)
  for (const entry of script.entries) {
    assert.ok(names.includes(entry.player), `未知のプレイヤー: ${entry.player}`)
  }
  assert.ok(script.worldSetting.length > 0)
})

test('generateStubScript は未知ジャンルでも生成できる', () => {
  const script = generateStubScript('', ['A'])
  assert.ok(script.worldSetting.length > 0)
  assert.equal(script.roles.length, 1)
})
