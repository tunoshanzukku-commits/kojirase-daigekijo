import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { buildFfmpegArgs } from './mixdownPlan'
import type { TimelineEntry } from './roomStore'

// ffmpeg を実際に動かす層。引数の組み立ては mixdownPlan.ts が持つ。

export interface MixTrack {
  buffer: Buffer
  mime: string
  delayMs: number
}

export interface MixInput {
  tracks: MixTrack[]
  timeline: TimelineEntry[]
  durationMs: number
  audioDir: string
}

export type Mixdown = (input: MixInput) => Promise<Buffer>

// 30 秒。2分半の素材を数本混ぜるのに実測で数秒しかかからないので、
// これを超えたら何かが刺さっている＝殺してよい。
const TIMEOUT_MS = 30_000

// バイナリの決め方。FFMPEG_BINARY は Railway で apt 版へ切り替える逃げ道
// （設計書 12 節）。どちらも無ければ PATH の ffmpeg に賭ける。
function ffmpegBinary(): string {
  const override = process.env.FFMPEG_BINARY?.trim()
  if (override) return override
  return ffmpegStatic ?? 'ffmpeg'
}

const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

// ffmpeg はコンテナを中身から判定できるが、拡張子があるほうが確実に当たる。
function extForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? 'webm'
}

function run(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      // 全部ためると壊れた入力で巨大になりうる。診断に足るぶんだけ持つ。
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    timer.unref()
    child.on('error', err => {
      clearTimeout(timer)
      reject(err) // バイナリが無い等
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))
    })
  })
}

/** ffmpeg が起動できるか。起動ログ用。結果は覚えない（1回しか呼ばれない想定）。 */
export async function probeFfmpeg(): Promise<boolean> {
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-version'])
    return true
  } catch {
    return false
  }
}

// 同時実行を1本に絞る。複数の部屋が同時に採点を終えたときに ffmpeg が
// 並列で立ち上がり、Railway の小さいインスタンスを踏み抜くのを防ぐ。
// 失敗しても鎖を切らない（catch を挟まないと後続が全部巻き添えで落ちる）。
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn)
  chain = result.catch(() => undefined)
  return result
}

export function createMixdown(): Mixdown {
  return async function mixdown(input: MixInput): Promise<Buffer> {
    if (input.tracks.length === 0) throw new Error('mixdown: no inputs')
    return enqueue(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kojirase-mix-'))
      try {
        const tracks = await Promise.all(
          input.tracks.map(async (t, i) => {
            const path = join(dir, `take${i}.${extForMime(t.mime)}`)
            await writeFile(path, t.buffer)
            return { path, delayMs: t.delayMs }
          }),
        )
        const outPath = join(dir, 'work.m4a')
        await run(buildFfmpegArgs({
          tracks,
          timeline: input.timeline,
          durationMs: input.durationMs,
          audioDir: input.audioDir,
          outPath,
        }))
        return await readFile(outPath)
      } finally {
        // 成功しても失敗しても必ず消す。残すとコンテナの /tmp が育っていく。
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }
}
