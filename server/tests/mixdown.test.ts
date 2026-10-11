import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMixdown, probeFfmpeg } from '../src/mixdown'

const here = dirname(fileURLToPath(import.meta.url))
const AUDIO_DIR = resolve(here, '../../client/public/audio')

// 素材として本物の mp3 を使う（マイク録音の代わり）。webm/mp4 を用意しなくても
// 「複数の入力を遅延つきで混ぜて m4a が出る」ことは検証できる。
function realAudio(): Buffer {
  return readFileSync(resolve(AUDIO_DIR, 'sfx/drum.mp3'))
}

test('ffmpeg が使えるかを調べられる', async () => {
  const ok = await probeFfmpeg()
  assert.equal(typeof ok, 'boolean')
})

test('複数トラックと BGM/SE を混ぜて m4a が返る', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const out = await mixdown({
    tracks: [
      { buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 },
      { buffer: realAudio(), mime: 'audio/mpeg', delayMs: 300 },
    ],
    timeline: [
      { atMs: 0, kind: 'bgm', id: 'comedy' },
      { atMs: 500, kind: 'sfx', id: 'drum' },
    ],
    durationMs: 3000,
    audioDir: AUDIO_DIR,
  })
  assert.ok(out.length > 1000, `中身のある m4a が返ること (got ${out.length} bytes)`)
  // ISO BMFF は先頭ボックスが ftyp（4バイト長 + 'ftyp'）
  assert.equal(out.subarray(4, 8).toString('ascii'), 'ftyp')
})

test('トラック1本・BGM なしでも合成できる（1人プレイ）', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const out = await mixdown({
    tracks: [{ buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 }],
    timeline: [],
    durationMs: 2000,
    audioDir: AUDIO_DIR,
  })
  assert.equal(out.subarray(4, 8).toString('ascii'), 'ftyp')
})

test('トラックが空なら reject する', async () => {
  const mixdown = createMixdown()
  await assert.rejects(
    () => mixdown({ tracks: [], timeline: [], durationMs: 1000, audioDir: AUDIO_DIR }),
    /no inputs/,
  )
})

test('壊れた音声を渡しても reject するだけで例外は漏れない', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  await assert.rejects(() => mixdown({
    tracks: [{ buffer: Buffer.from('これは音声ではない'), mime: 'audio/webm', delayMs: 0 }],
    timeline: [],
    durationMs: 1000,
    audioDir: AUDIO_DIR,
  }))
})

test('同時に投げても直列に処理され、すべて解決する', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const one = () => mixdown({
    tracks: [{ buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 }],
    timeline: [],
    durationMs: 1000,
    audioDir: AUDIO_DIR,
  })
  const outs = await Promise.all([one(), one(), one()])
  for (const out of outs) assert.ok(out.length > 500)
})

test('失敗が後続をブロックしない（キューが詰まらない）', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const bad = mixdown({
    tracks: [{ buffer: Buffer.from('だめ'), mime: 'audio/webm', delayMs: 0 }],
    timeline: [], durationMs: 1000, audioDir: AUDIO_DIR,
  }).catch(() => 'failed' as const)
  const good = mixdown({
    tracks: [{ buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 }],
    timeline: [], durationMs: 1000, audioDir: AUDIO_DIR,
  })
  assert.equal(await bad, 'failed')
  assert.ok((await good).length > 500)
})
