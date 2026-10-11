import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'
import { validateFeedback } from './feedback'
import type { FeedbackMeta, FeedbackSender } from './feedback'
import type { Limits } from './limits'

/** 送られてきた値のうち、転送してよいものだけを拾う（プレイヤー名は意図的に拾わない）。 */
function pickMeta(body: unknown): FeedbackMeta {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    genre: typeof b.genre === 'string' ? b.genre : undefined,
    playerCount: typeof b.playerCount === 'number' ? b.playerCount : undefined,
    aiMode: typeof b.aiMode === 'boolean' ? b.aiMode : undefined,
  }
}

// プレイ後の感想の受け口。ゲーム進行と無関係なので Socket.io ではなく HTTP。
// ルームにも属さないため、ロビーへ戻ったあとでも送れる。
export function createFeedbackRoute(deps: {
  sendFeedback: FeedbackSender
  limits: Limits
}): (app: Express) => void {
  const { sendFeedback, limits } = deps

  // 感想は「書けたら書く」ものなので、正常な利用で連打されることはない。
  // 荒らしがチャンネルを埋めるのを止めるための粗い網。
  let feedbackLimiter = createRateLimiter(limits.feedbackRateWindowMs, limits.feedbackRateMax)

  return function registerFeedbackRoute(app: Express): void {
    app.post(
      '/feedback',
      // JSON パースより前に置くのが肝（/upload と同じ理由）。後ろだと弾くと決まっている
      // リクエストのボディを先に展開することになる。
      (req: Request, res: Response, next: NextFunction) => {
        const ip = req.ip ?? extractIp(req.headers['x-forwarded-for'], undefined)
        if (!feedbackLimiter.allow(ip, Date.now())) {
          console.log(`[server] rate limited: /feedback ip=${ip}`)
          res.status(429).json({ ok: false })
          return
        }
        next()
      },
      // アプリ全体には付けない。JSON を受けるのはこのルートだけ。
      express.json({ limit: '4kb' }),
      (req: Request, res: Response) => {
        const result = validateFeedback((req.body as Record<string, unknown> | undefined)?.text)
        if (!result.ok) {
          res.status(400).json({ ok: false, reason: result.reason })
          return
        }
        // 転送の完了は待たない。転送先が落ちていることをプレイヤーの責任にしないため、
        // 失敗してもログに残すだけで 200 を返す（書いた本文はもう戻ってこない）。
        void sendFeedback(result.text, pickMeta(req.body)).catch(err => {
          console.error('[server] feedback failed:', err)
        })
        res.json({ ok: true })
      },
    )
  }
}
