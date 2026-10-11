import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bgmSegments, sfxHits, buildFfmpegArgs } from '../src/mixdownPlan'
import type { TimelineEntry } from '../src/roomStore'
import { AUDIO_CREDIT_LINE } from '@shared/credits'

const bgm = (atMs: number, id: string | null): TimelineEntry => ({ atMs, kind: 'bgm', id })
const sfx = (atMs: number, id: string): TimelineEntry => ({ atMs, kind: 'sfx', id })

test('BGM 区間は次の bgm エントリで閉じる', () => {
  const tl = [bgm(0, 'horror'), bgm(5000, 'comedy')]
  assert.deepEqual(bgmSegments(tl, 12_000), [
    { id: 'horror', startMs: 0, endMs: 5000 },
    { id: 'comedy', startMs: 5000, endMs: 12_000 },
  ])
})

test('最後の BGM 区間は録音の実尺で閉じる', () => {
  assert.deepEqual(bgmSegments([bgm(2000, 'battle')], 9000), [
    { id: 'battle', startMs: 2000, endMs: 9000 },
  ])
})

test('id が null のエントリは区間を閉じるだけで新しい区間を作らない', () => {
  const tl = [bgm(0, 'horror'), bgm(3000, null), bgm(8000, 'comedy')]
  assert.deepEqual(bgmSegments(tl, 10_000), [
    { id: 'horror', startMs: 0, endMs: 3000 },
    { id: 'comedy', startMs: 8000, endMs: 10_000 },
  ])
})

test('sfx エントリは BGM 区間の切れ目に影響しない', () => {
  const tl = [bgm(0, 'horror'), sfx(1000, 'drum'), bgm(4000, null)]
  assert.deepEqual(bgmSegments(tl, 10_000), [{ id: 'horror', startMs: 0, endMs: 4000 }])
})

test('長さ 0 以下になる区間は落とす', () => {
  const tl = [bgm(5000, 'horror'), bgm(5000, 'comedy')]
  assert.deepEqual(bgmSegments(tl, 9000), [{ id: 'comedy', startMs: 5000, endMs: 9000 }])
})

test('実尺を超えた位置で始まる区間は落とす', () => {
  assert.deepEqual(bgmSegments([bgm(20_000, 'horror')], 9000), [])
})

test('sfxHits は sfx だけを拾い実尺を超えたものは落とす', () => {
  const tl = [bgm(0, 'horror'), sfx(1000, 'drum'), sfx(50_000, 'boom')]
  assert.deepEqual(sfxHits(tl, 9000), [{ id: 'drum', atMs: 1000 }])
})

test('タイムラインは 60 件までしか読まない', () => {
  const tl: TimelineEntry[] = []
  for (let i = 0; i < 100; i++) tl.push(sfx(i * 10, 'drum'))
  assert.equal(sfxHits(tl, 60_000).length, 60)
})

// --- buildFfmpegArgs ---

const PLAN = {
  tracks: [
    { path: '/tmp/a.webm', delayMs: 0 },
    { path: '/tmp/b.mp4', delayMs: 250 },
  ],
  timeline: [bgm(0, 'horror'), sfx(3000, 'drum')],
  durationMs: 10_000,
  audioDir: '/app/audio',
  outPath: '/tmp/out.m4a',
}

test('声のトラックが先頭から順に -i に並ぶ', () => {
  const args = buildFfmpegArgs(PLAN)
  assert.equal(args.indexOf('/tmp/a.webm'), args.indexOf('/tmp/b.mp4') - 2)
})

test('BGM は -stream_loop -1 付きで入力に並ぶ（録音より短くても最後まで鳴る）', () => {
  const args = buildFfmpegArgs(PLAN)
  const i = args.findIndex(a => a.endsWith('horror.mp3'))
  assert.ok(i > 0)
  assert.equal(args[i - 1], '-i')
  assert.equal(args[i - 2], '-1')
  assert.equal(args[i - 3], '-stream_loop')
})

test('SE は stream_loop なしで入力に並ぶ', () => {
  const args = buildFfmpegArgs(PLAN)
  const i = args.findIndex(a => a.endsWith('drum.mp3'))
  assert.equal(args[i - 1], '-i')
  assert.notEqual(args[i - 2], '-1')
})

test('端末ごとの遅れが adelay に反映される', () => {
  const filter = buildFfmpegArgs(PLAN)[buildFfmpegArgs(PLAN).indexOf('-filter_complex') + 1]
  assert.match(filter, /\[0:a\][^;]*adelay=delays=0:all=1/)
  assert.match(filter, /\[1:a\][^;]*adelay=delays=250:all=1/)
})

test('amix は normalize=0（人数が増えても音が小さくならない）', () => {
  const filter = buildFfmpegArgs(PLAN)[buildFfmpegArgs(PLAN).indexOf('-filter_complex') + 1]
  assert.match(filter, /amix=inputs=4:normalize=0:dropout_transition=0/)
  assert.match(filter, /alimiter/)
})

test('BGM のフェードは 0.1 秒（audioBus.ts の FADE_SEC と同値）', () => {
  const filter = buildFfmpegArgs(PLAN)[buildFfmpegArgs(PLAN).indexOf('-filter_complex') + 1]
  assert.match(filter, /afade=t=in:st=0:d=0\.1/)
  assert.match(filter, /afade=t=out:st=9\.900:d=0\.1/) // toFixed(3) なので 9.9 ではなく 9.900
})

test('出力は m4a/AAC で、-t が録音の実尺に一致する', () => {
  const args = buildFfmpegArgs(PLAN)
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(args[args.indexOf('-t') + 1], '10.000')
  assert.equal(args[args.length - 1], '/tmp/out.m4a')
})

test('BGM も SE も無ければ声だけで組み立てる', () => {
  const args = buildFfmpegArgs({ ...PLAN, timeline: [] })
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /amix=inputs=2:normalize=0/)
})

test('声が1本でも組み立てられる（1人プレイ）', () => {
  const args = buildFfmpegArgs({ ...PLAN, tracks: [{ path: '/tmp/a.webm', delayMs: 0 }], timeline: [] })
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /amix=inputs=1:normalize=0/)
})

// OtoLogic（CC BY 4.0）の素材を含む作品を配るので、ファイル自体にクレジットを持たせる
test('BGM か SE を使った作品にはクレジットが comment メタデータとして入る', () => {
  for (const timeline of [PLAN.timeline, [bgm(0, 'horror')], [sfx(3000, 'drum')]]) {
    const args = buildFfmpegArgs({ ...PLAN, timeline })
    const i = args.indexOf('-metadata')
    assert.ok(i > 0, `metadata missing for ${JSON.stringify(timeline)}`)
    assert.equal(args[i + 1], `comment=${AUDIO_CREDIT_LINE}`)
    assert.ok(i < args.length - 1 && args[args.length - 1] === '/tmp/out.m4a') // 出力パスより前
  }
})

test('声だけの作品（BGM も SE も鳴っていない）にはクレジットを入れない', () => {
  // 実尺の外で鳴らした BGM/SE は合成に入らないので、これも「声だけ」扱い
  for (const timeline of [[], [bgm(20_000, 'horror'), sfx(50_000, 'boom')]]) {
    const args = buildFfmpegArgs({ ...PLAN, timeline })
    assert.equal(args.indexOf('-metadata'), -1)
  }
})

test('入力が1本も無ければ投げる（呼び出し側が先に弾く契約）', () => {
  assert.throws(() => buildFfmpegArgs({ ...PLAN, tracks: [], timeline: [] }), /no inputs/)
})
