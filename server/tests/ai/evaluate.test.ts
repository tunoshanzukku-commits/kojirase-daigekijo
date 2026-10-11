import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createEvaluator } from '../../src/ai/evaluate'
import type { ScriptData, PlayerScore } from '@shared/types'

const SCRIPT: ScriptData = {
  worldSetting: 'ある町',
  roles: [
    { player: 'A', role: '主役', description: 'x' },
    { player: 'B', role: '脇役', description: 'y' },
  ],
  entries: [
    { player: 'A', character: '主役', action: '', line: 'せりふA' },
    { player: 'B', character: '脇役', action: '', line: 'せりふB' },
  ],
}

afterEach(() => {
  delete process.env.GROQ_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})

test('鍵未設定ならスタブスコアを返す（ネットワーク無し）', async () => {
  const evaluate = createEvaluator({
    transcribe: async () => { throw new Error('should not be called') },
    generateScores: async () => { throw new Error('should not be called') },
  })
  const scores = await evaluate(SCRIPT, ['A', 'B'], [])
  assert.equal(scores.length, 2)
  assert.deepEqual(scores.map(s => s.playerName).sort(), ['A', 'B'])
})

test('個別 transcribe 失敗は空文字に劣化して全員採点が返る', async () => {
  process.env.GROQ_API_KEY = 'k'
  process.env.ANTHROPIC_API_KEY = 'k'
  const evaluate = createEvaluator({
    transcribe: async () => { throw new Error('boom') }, // 常に失敗
    generateScores: async (_script, sources) =>
      sources.flatMap(s => s.players.map(name => ({
        playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: s.text || '（無音）', title: 'スタブ称号',
      }))),
  })
  const sources = [
    { players: ['A'], audio: { buffer: Buffer.from([1]), mime: 'audio/webm' } },
    { players: ['B'], audio: null },
  ]
  const scores = await evaluate(SCRIPT, ['A', 'B'], sources)
  assert.equal(scores.length, 2)
  assert.ok(scores.every(s => s.comment === '（無音）')) // A(失敗)も B(音声なし)も空文字
})

test('音声のある performer は文字起こし結果が採点に渡る', async () => {
  process.env.GROQ_API_KEY = 'k'
  process.env.ANTHROPIC_API_KEY = 'k'
  let received: { players: string[]; text: string }[] = []
  const evaluate = createEvaluator({
    transcribe: async () => 'しゃべった',
    generateScores: async (_script, sources) => {
      received = sources
      return sources.flatMap(s => s.players.map(name => ({ playerName: name, acting: 4, emotion: 4, kojirase: 4, comment: 'ok', title: 'スタブ称号' })))
    },
  })
  const sources = [{ players: ['A'], audio: { buffer: Buffer.from([1]), mime: 'audio/webm' } }]
  await evaluate(SCRIPT, ['A'], sources)
  assert.deepEqual(received, [{ players: ['A'], text: 'しゃべった' }])
})

test('generateScores が throw したら evaluate も throw', async () => {
  process.env.GROQ_API_KEY = 'k'
  process.env.ANTHROPIC_API_KEY = 'k'
  const evaluate = createEvaluator({
    transcribe: async () => 'x',
    generateScores: async (): Promise<PlayerScore[]> => { throw new Error('claude down') },
  })
  const sources = [{ players: ['A'], audio: { buffer: Buffer.from([1]), mime: 'audio/webm' } }]
  await assert.rejects(() => evaluate(SCRIPT, ['A'], sources))
})

test('createEvaluator は1本の音声を1回だけ文字起こしし、乗っている全員を渡す', async () => {
  process.env.GROQ_API_KEY = 'x'
  process.env.ANTHROPIC_API_KEY = 'x'
  let transcribeCalls = 0
  let received: { players: string[]; text: string }[] = []
  const evaluate = createEvaluator({
    transcribe: async () => { transcribeCalls++; return 'もう黙ってらんない それは' },
    generateScores: async (_script, sources) => {
      received = sources
      return sources.flatMap(s => s.players).map(name => ({
        playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: '', title: '',
      }))
    },
  })
  const scores = await evaluate(SCRIPT, ['たろう', 'はなこ'], [
    { players: ['たろう', 'はなこ'], audio: { buffer: Buffer.from('a'), mime: 'audio/webm' } },
  ])
  assert.equal(transcribeCalls, 1) // 人数(2)ではなく音声の本数(1)
  assert.deepEqual(received, [{ players: ['たろう', 'はなこ'], text: 'もう黙ってらんない それは' }])
  assert.equal(scores.length, 2)
})

test('audio が null のソースは文字起こしせず空文字で渡す', async () => {
  process.env.GROQ_API_KEY = 'x'
  process.env.ANTHROPIC_API_KEY = 'x'
  let transcribeCalls = 0
  let received: { players: string[]; text: string }[] = []
  const evaluate = createEvaluator({
    transcribe: async () => { transcribeCalls++; return 'x' },
    generateScores: async (_s, sources) => {
      received = sources
      return []
    },
  })
  await evaluate(SCRIPT, ['たろう'], [{ players: ['たろう'], audio: null }])
  assert.equal(transcribeCalls, 0)
  assert.deepEqual(received, [{ players: ['たろう'], text: '' }])
})
