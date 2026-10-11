import { join } from 'node:path'
import { MAX_TIMELINE_ENTRIES } from './roomStore'
import type { TimelineEntry } from './roomStore'
import { AUDIO_CREDIT_LINE } from '@shared/credits'

// ffmpeg の引数を組み立てるだけの純粋モジュール。プロセスも一時ファイルも触らない
// （そちらは mixdown.ts の仕事）。ここを分けているのは、合成の「判断」の部分だけを
// ffmpeg 無しでテストできるようにするため。

/** 1つの BGM が鳴っていた区間 */
export interface BgmSegment { id: string; startMs: number; endMs: number }
/** 1回鳴った SE */
export interface SfxHit { id: string; atMs: number }

export interface PlanTrack {
  path: string      // 一時ファイルに書き出した端末の録音
  delayMs: number   // 録音開始からこの端末の収録開始までの遅れ
}

export interface PlanInput {
  tracks: PlanTrack[]
  timeline: TimelineEntry[]
  durationMs: number
  audioDir: string  // BGM/SE の mp3 の置き場（bgm/ と sfx/ を含むディレクトリ）
  outPath: string
}

// クライアントの audioBus.ts の FADE_SEC と同値。耳で聞いた切り替わりと
// 合成版を揃えるための一致であり、片方だけ変えてはならない。
const FADE_SEC = 0.1
// 全入力をここに揃えてから混ぜる。マイクはモノラル、mp3 はステレオで来るため。
const FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

function sec(ms: number): string {
  return (ms / 1000).toFixed(3)
}

/**
 * タイムラインを「BGM が鳴っていた区間」の列に畳む。
 * 区間は次の bgm エントリで閉じ、最後の区間は録音の実尺で閉じる。
 * id が null のエントリは区間を閉じるだけで新しい区間を開かない。
 */
export function bgmSegments(timeline: TimelineEntry[], durationMs: number): BgmSegment[] {
  const entries = timeline.slice(0, MAX_TIMELINE_ENTRIES).filter(e => e.kind === 'bgm')
  const out: BgmSegment[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.id === null) continue
    const startMs = Math.max(0, e.atMs)
    const endMs = Math.min(entries[i + 1]?.atMs ?? durationMs, durationMs)
    if (endMs - startMs <= 0) continue // 即座に切り替えられた＝鳴っていない
    out.push({ id: e.id, startMs, endMs })
  }
  return out
}

/** タイムラインから SE の発音だけを拾う。実尺を超えたものは落とす。 */
export function sfxHits(timeline: TimelineEntry[], durationMs: number): SfxHit[] {
  return timeline
    .slice(0, MAX_TIMELINE_ENTRIES)
    .filter((e): e is TimelineEntry & { id: string } => e.kind === 'sfx' && e.id !== null)
    .filter(e => e.atMs >= 0 && e.atMs < durationMs)
    .map(e => ({ id: e.id, atMs: e.atMs }))
}

/**
 * ffmpeg の引数一式を組み立てる。
 *
 * 配線はクライアントの audioBus.ts をそのまま再現する：
 *   声・BGM・SE をすべてゲイン 1.0 で1つに混ぜ、最後にリミッタでクリップだけ止める。
 * amix の既定（normalize=1）は入力数で割ってしまい、人数が増えるほど作品が
 * 小さくなるので必ず normalize=0 にする。
 *
 * adelay は `delays=D:all=1` を使う。`D|D` 記法は入力のチャンネル数に依存し、
 * モノラルのマイクでは片チャンネルにしか効かない。
 */
export function buildFfmpegArgs(input: PlanInput): string[] {
  const { tracks, timeline, durationMs, audioDir, outPath } = input
  const segments = bgmSegments(timeline, durationMs)
  const hits = sfxHits(timeline, durationMs)

  const inputArgs: string[] = []
  const filters: string[] = []
  const labels: string[] = []
  let idx = 0

  for (const t of tracks) {
    inputArgs.push('-i', t.path)
    const label = `v${idx}`
    filters.push(`[${idx}:a]${FORMAT},adelay=delays=${Math.round(t.delayMs)}:all=1[${label}]`)
    labels.push(`[${label}]`)
    idx++
  }

  for (const s of segments) {
    // BGM は録音より短いことがある。-stream_loop -1 で無限ループさせ、
    // atrim で区間の長さに切る（クライアントの src.loop = true と同じ挙動）。
    inputArgs.push('-stream_loop', '-1', '-i', join(audioDir, 'bgm', `${s.id}.mp3`))
    const lenSec = (s.endMs - s.startMs) / 1000
    const label = `b${idx}`
    const parts = [`atrim=0:${lenSec.toFixed(3)}`, 'asetpts=N/SR/TB']
    // 区間が短すぎるとフェードが重なって不自然になるので、その場合は掛けない
    if (lenSec > FADE_SEC * 2) {
      parts.push(`afade=t=in:st=0:d=${FADE_SEC}`)
      parts.push(`afade=t=out:st=${(lenSec - FADE_SEC).toFixed(3)}:d=${FADE_SEC}`)
    }
    parts.push(FORMAT, `adelay=delays=${Math.round(s.startMs)}:all=1`)
    filters.push(`[${idx}:a]${parts.join(',')}[${label}]`)
    labels.push(`[${label}]`)
    idx++
  }

  for (const h of hits) {
    inputArgs.push('-i', join(audioDir, 'sfx', `${h.id}.mp3`))
    const label = `s${idx}`
    filters.push(`[${idx}:a]${FORMAT},adelay=delays=${Math.round(h.atMs)}:all=1[${label}]`)
    labels.push(`[${label}]`)
    idx++
  }

  if (labels.length === 0) throw new Error('mixdown: no inputs')

  filters.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,` +
    `alimiter=level_in=1:limit=0.95[out]`,
  )

  // OtoLogic（CC BY 4.0）の音源を含む作品は配られた先でもクレジットが要るので、ファイル自体に持たせる。
  // 実際に合成へ入った BGM/SE があるときだけ。声だけの作品に音源のクレジットを付けるのは不正確。
  const creditArgs = segments.length > 0 || hits.length > 0
    ? ['-metadata', `comment=${AUDIO_CREDIT_LINE}`]
    : []

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-t', sec(durationMs),
    ...creditArgs,
    '-movflags', '+faststart',
    outPath,
  ]
}
