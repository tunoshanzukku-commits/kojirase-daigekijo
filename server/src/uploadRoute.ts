import type { Express, NextFunction, Request, Response } from 'express'
import multer, { MulterError } from 'multer'
import type { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { touch, deviceBySocket } from './roomStore'
import type { RoomStore } from './roomStore'
import type { Handlers } from './handlers'
import type { Limits } from './limits'
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'

type IO = Server<ClientToServerEvents, ServerToClientEvents>

// Whisper の入力上限に整合させる
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

// 端末の収録開始が録音開始からどれだけ遅れてよいか。時刻同期の誤差や
// getUserMedia の許可ダイアログを見込んでも十分な幅を取りつつ、壊れた値で
// 作品の頭に無音が延々入るのを防ぐ蓋でもある。
const MAX_START_DELAY_MS = 10_000

// 端末が申告した収録開始時刻（サーバー時計）を「録音開始からの遅れ」に直す。
// 解釈できない値・録音開始前・過大値はすべて安全側（0 または上限）へ倒す。
// ここで例外を投げてはいけない：採点は音声が届くことに依存しており、
// 頭合わせはそれより優先度が低い。
export function resolveDelayMs(raw: unknown, recordingStartedAt: number): number {
  if (recordingStartedAt <= 0) return 0
  if (typeof raw !== 'string') return 0
  const startedAt = Number(raw.trim())
  if (!Number.isFinite(startedAt)) return 0
  const delay = startedAt - recordingStartedAt
  if (!(delay > 0)) return 0 // 負値・NaN・0 はすべてここに落ちる
  return Math.min(delay, MAX_START_DELAY_MS)
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

// 録音済み音声の受け口。socketId から部屋を解決するのでクライアントは roomCode を送らない。
// マイク拒否のクライアントは音声なし＋skip=1 を送り、サーバーの待機を解く。
export function createUploadRoute(deps: {
  rooms: RoomStore
  finalizeEvaluation: Handlers['finalizeEvaluation']
  limits: Limits
}): (app: Express, io: IO) => void {
  const { rooms, finalizeEvaluation, limits } = deps

  // 最大10人 × 複数ゲームを想定した緩めの値。正常なプレイを止めないことを優先し、
  // 絞るのは日次上限の役目とする。ここはメモリ枯渇を防ぐための粗い網。
  let uploadLimiter = createRateLimiter(limits.uploadRateWindowMs, limits.uploadRateMax)

  return function registerUploadRoute(app: Express, io: IO): void {
    app.post(
      '/upload',
      // multer より前に置くのが肝。後ろだと最大25MBをRAMに展開してから弾くことになり、
      // メモリ枯渇を防ぐという目的を果たさない。
      // req.ip を優先する: server.ts の trust proxy 設定により、1段のプロキシ構成では
      // Express が正しいクライアントアドレスを計算してくれる。extractIp はあくまで
      // req.ip が取れない場合のフォールバック。
      (req: Request, res: Response, next: NextFunction) => {
        const ip = req.ip ?? extractIp(req.headers['x-forwarded-for'], undefined)
        if (!uploadLimiter.allow(ip, Date.now())) {
          console.log(`[server] rate limited: /upload ip=${ip}`)
          res.status(429).json({ ok: false })
          return
        }
        next()
      },
      upload.single('audio'),
      (req: Request, res: Response) => {
        const socketId = typeof req.body?.socketId === 'string' ? req.body.socketId : ''
        if (!socketId) {
          res.status(400).json({ ok: false })
          return
        }
        const room = rooms.findBySocket(socketId)
        const device = room ? deviceBySocket(room, socketId) : undefined
        if (!room || !device || !room.collectingAudio || !room.uploadExpected.has(device.id)) {
          res.status(409).json({ ok: false })
          return
        }
        const file = req.file
        if (file && file.buffer.length > 0) {
          const delayMs = resolveDelayMs(req.body?.startedAt, room.recordingStartedAt)
          room.audio.set(device.id, { buffer: file.buffer, mime: file.mimetype, delayMs })
          const name = room.players.get(device.playerIds[0] ?? '')?.name ?? socketId
          console.log(`[server] audio received: ${name} ${file.buffer.length} bytes ${file.mimetype} +${delayMs}ms`)
        }
        room.uploadExpected.delete(device.id)
        touch(room)
        res.json({ ok: true })
        if (room.uploadExpected.size === 0) void finalizeEvaluation(io, room)
      },
    )

    // multer の limits.fileSize 超過は MulterError としてここに落ちる（既定のままだと
    // 500 HTML になり JSON 契約が崩れる上、ルート本体が走らず uploadExpected も解放されない）。
    // socketId の復旧はあくまでベストエフォート：multer はフォームフィールドを到着順に
    // パースし、クライアントは socketId を audio より前に追加しているため通常は取れるが、
    // 保証はない。取れなければ何もしない — 最終的な安全網は既存のタイムアウトに委ねる。
    app.use('/upload', (err: unknown, req: Request, res: Response, next: NextFunction) => {
      if (!(err instanceof MulterError)) {
        next(err)
        return
      }
      console.log(`[server] upload rejected: ${err.message} (limit ${MAX_UPLOAD_BYTES} bytes)`)
      res.status(413).json({ ok: false })
      const socketId = typeof req.body?.socketId === 'string' ? req.body.socketId : ''
      if (!socketId) return
      const room = rooms.findBySocket(socketId)
      const device = room ? deviceBySocket(room, socketId) : undefined
      if (!room || !device || !room.collectingAudio || !room.uploadExpected.has(device.id)) return
      room.uploadExpected.delete(device.id)
      touch(room)
      if (room.uploadExpected.size === 0) void finalizeEvaluation(io, room)
    })
  }
}
