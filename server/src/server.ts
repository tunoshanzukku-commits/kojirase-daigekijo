import express from 'express'
import compression from 'compression'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import cors from 'cors'
import { fileURLToPath } from 'node:url'
import { dirname, extname, resolve } from 'node:path'
import { createHandlers } from './handlers'
import { createUploadRoute } from './uploadRoute'
import { createFeedbackRoute } from './feedbackRoute'
import { createRoomStore } from './roomStore'
import type { RoomStore } from './roomStore'
import { createQuota } from './quota'
import type { Quota } from './quota'
import { resolveLimits } from './limits'
import type { Limits } from './limits'
import { createPrompts } from './ai/prompts'
import type { Prompts } from './ai/prompts'
import { createScriptLibrary, loadPlays, playsDir } from './ai/scriptLibrary'
import type { ScriptLibrary } from './ai/scriptLibrary'
import { createAi } from './ai'
import type { Ai } from './ai'
import { createFeedbackSender } from './feedback'
import type { FeedbackSender } from './feedback'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { existsSync } from 'node:fs'
import { createWorkRoute } from './workRoute'
import { createMixdown } from './mixdown'
import type { Mixdown } from './mixdown'

// client/dist の場所を一箇所で定義する（index.ts の起動ログもここを参照し、パス解決ロジックの重複を避ける）。
export function resolveDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // server/src
  return resolve(here, '../../client/dist')
}

// BGM/SE の mp3 の置き場。本番は client/dist（静的配信が見ているのと同じ場所）、
// 開発では client/dist がまだ無いので public を直接見る。
// 解決を1か所に閉じ込める（2か所で別々に解決すると distDir 差し替え時にズレる）。
export function resolveAudioDir(distDir: string): string {
  const fromDist = resolve(distDir, 'audio')
  if (existsSync(fromDist)) return fromDist
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../client/public/audio')
}

export function buildServer(options: {
  distDir?: string
  rooms?: RoomStore
  quota?: Quota
  prompts?: Prompts
  plays?: ScriptLibrary
  ai?: Partial<Ai>
  sendFeedback?: FeedbackSender
  limits?: Partial<Limits>
  mixdown?: Mixdown
} = {}) {
  const isProduction = process.env.NODE_ENV === 'production'

  // 組み立て順: rooms → prompts/plays/quota → ai → handlers → routes
  const rooms = options.rooms ?? createRoomStore()
  const prompts = options.prompts ?? createPrompts()
  const plays = options.plays ?? createScriptLibrary(loadPlays(playsDir()))
  const quota = options.quota ?? createQuota()
  const ai = createAi({ prompts, plays, overrides: options.ai })
  const sendFeedback = options.sendFeedback ?? createFeedbackSender()
  // handlers・uploadRoute・feedbackRoute で共有するので一度だけ解決する。
  const limits = resolveLimits(options.limits)
  // distDir は静的配信より前に解決する。合成が BGM/SE の置き場をここから導くため。
  const distDir = options.distDir ?? resolveDistDir()
  const mixdown = options.mixdown ?? createMixdown()
  const handlers = createHandlers({
    rooms, quota, ai, plays, limits, mixdown, audioDir: resolveAudioDir(distDir),
  })
  const app = express()

  // Railway/Render はプロキシ経由。設定しないと req.ip が全員同じになり、
  // レート制限が全ユーザーをまとめて1人として扱ってしまう。
  // ⚠️ この設定は Socket.IO には効かない（そちらは clientIp.ts で個別に取る）。
  app.set('trust proxy', 1)

  // gzip 圧縮。プロキシ（Railway/Render 等）は自動で圧縮してくれないため、
  // 約247KBのJSバンドルを78KB相当まで縮める前提が成立するにはここが必須。
  // 静的配信より前に置くことで client/dist のアセットにも効かせる。
  app.use(compression())

  // 本番は client と同一オリジンなので CORS は不要（公開サーバーに origin:'*' を残さない）。
  // 開発だけ Vite(5173) → server(3001) の別オリジンになるため許可する。
  if (!isProduction) app.use(cors())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  const httpServer = createServer(app)
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    isProduction ? {} : { cors: { origin: '*' } },
  )

  createUploadRoute({ rooms, finalizeEvaluation: handlers.finalizeEvaluation, limits })(app, io)
  createFeedbackRoute({ sendFeedback, limits })(app)
  createWorkRoute({ rooms, limits })(app)
  io.on('connection', socket => handlers.registerHandlers(io, socket))

  // 静的配信と SPA フォールバックは必ず最後に登録する。
  // 先に置くと /health・/upload・/socket.io が index.html に飲まれてゲームが起動しない。
  if (isProduction) {
    app.use(express.static(distDir))
    app.get('*', (req, res) => {
      // /assets/ 配下や拡張子付きパスは静的ファイルの意図が明らかなので、
      // express.static で見つからなければ 404 を返す（index.html に飲ませない）。
      // 拡張子なしのパスだけが SPA のクライアントサイドルートとして index.html を受け取る。
      const looksLikeAsset = req.path.startsWith('/assets/') || extname(req.path) !== ''
      if (looksLikeAsset) {
        res.status(404).end()
        return
      }
      res.sendFile(resolve(distDir, 'index.html'))
    })
  }

  return { app, httpServer, io, rooms, quota, prompts, plays, ai, sendFeedback }
}
