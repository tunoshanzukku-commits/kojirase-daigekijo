// プレイ後の感想の受け皿。サーバーは感想を保存しない（このアプリに保存層は無い）＝
// 受け取ったものを外部の Webhook へ転送するだけ。転送先を差し替えるときに触るのは
// このファイルだけで、ルート側（feedbackRoute.ts）は無改造で済む。

import { MAX_FEEDBACK_LENGTH } from '@shared/constants'

export interface FeedbackMeta {
  genre?: string
  playerCount?: number
  aiMode?: boolean
}

export type ValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'not_string' | 'empty' | 'too_long' }

/**
 * クライアントの maxLength は当てにしない（curl で直接叩ける）ので、
 * 長さも型もサーバー側で必ず見る。
 */
export function validateFeedback(raw: unknown): ValidationResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_string' }
  const text = raw.trim()
  if (text.length === 0) return { ok: false, reason: 'empty' }
  if (text.length > MAX_FEEDBACK_LENGTH) return { ok: false, reason: 'too_long' }
  return { ok: true, text }
}

export function buildDiscordPayload(
  text: string,
  meta: FeedbackMeta,
): { content: string; allowed_mentions: { parse: never[] } } {
  const parts: string[] = []
  if (meta.genre) parts.push(meta.genre)
  if (typeof meta.playerCount === 'number') parts.push(`${meta.playerCount}人`)
  if (typeof meta.aiMode === 'boolean') parts.push(meta.aiMode ? 'AI採点' : '簡易モード')
  const header = parts.length > 0 ? `（${parts.join(' / ')}）\n` : ''
  return {
    content: `${header}${text}`,
    // ⚠️ Discord の Webhook は既定で @everyone / @here を実際に飛ばす。感想欄は誰でも
    // 書けるので、これを止めないとチャンネル全員を鳴らす手段を公開することになる。
    allowed_mentions: { parse: [] },
  }
}

export type FeedbackSender = (text: string, meta: FeedbackMeta) => Promise<void>

/**
 * 転送先が未設定ならログに出すだけ（機能としては成立させる）。
 * 転送の成否はクライアントに返さない＝呼び出し側は待つだけでよい。
 */
export function createFeedbackSender(): FeedbackSender {
  return async function sendFeedback(text, meta) {
    const url = process.env.FEEDBACK_WEBHOOK_URL?.trim()
    const payload = buildDiscordPayload(text, meta)
    if (!url) {
      console.log(`[server] feedback (転送先未設定):\n${payload.content}`)
      return
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) console.error(`[server] feedback webhook failed: ${res.status}`)
  }
}
