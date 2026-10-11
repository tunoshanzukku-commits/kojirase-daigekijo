import { RECORDING_LIMIT_SEC } from '@shared/constants'

// サーバー全体の調整値を1箇所に集める。handlers.ts は自分に関係する5つだけを読み、
// uploadRoute.ts/feedbackRoute.ts（Task 5 でファクトリ化）が残り4つ（アップロード/感想の
// レート制限）を読む。1つの型に集めることで、サーバー全体の上限値がここだけで見渡せる。
export interface Limits {
  /** ルーム乱造の抑制。60秒の窓で作れる上限（既定値は handlers.ts に元あった DEFAULT_ROOM_CREATE_MAX） */
  roomCreateMax: number
  /** 上記の窓の長さ（既定値は handlers.ts に元あった ROOM_CREATE_WINDOW_MS） */
  roomCreateWindowMs: number
  /** 音声収集ウィンドウのタイムアウト（既定値は handlers.ts に元あった DEFAULT_UPLOAD_TIMEOUT_MS） */
  uploadTimeoutMs: number
  /** 録音時間の自動終了までの上限（既定値は handlers.ts に元あった DEFAULT_RECORDING_LIMIT_MS） */
  recordingLimitMs: number
  /** 非ホストの事故切断からスロットを保持する猶予（既定値は handlers.ts に元あった DEFAULT_GRACE_MS） */
  graceMs: number
  /** /upload のレート制限の窓（既定値は uploadRoute.ts に元あった UPLOAD_WINDOW_MS。Task 5 が使う） */
  uploadRateWindowMs: number
  /** /upload のレート制限の上限（既定値は uploadRoute.ts に元あった UPLOAD_MAX。Task 5 が使う） */
  uploadRateMax: number
  /** /feedback のレート制限の窓（既定値は feedbackRoute.ts に元あった FEEDBACK_WINDOW_MS。Task 5 が使う） */
  feedbackRateWindowMs: number
  /** /feedback のレート制限の上限（既定値は feedbackRoute.ts に元あった FEEDBACK_MAX。Task 5 が使う） */
  feedbackRateMax: number
  /** 1端末が1ゲーム中に中継できる WebRTC シグナルの数。超過分は黙って捨てる */
  rtcSignalMaxPerGame: number
  /** 1端末が1ゲーム中に投げられる時刻同期 ping の数。超過分は黙って捨てる */
  timeSyncMaxPerGame: number
  /** /work のレート制限の窓 */
  workRateWindowMs: number
  /** /work のレート制限の上限 */
  workRateMax: number
}

export const DEFAULT_LIMITS: Limits = {
  roomCreateMax: 5,
  roomCreateWindowMs: 60_000,
  uploadTimeoutMs: 15_000,
  recordingLimitMs: RECORDING_LIMIT_SEC * 1000,
  graceMs: 60_000,
  uploadRateWindowMs: 60_000,
  uploadRateMax: 30,
  feedbackRateWindowMs: 60_000,
  feedbackRateMax: 3,
  // 上限6台＝1端末あたり5ピア。1接続で offer/answer 各1＋ICE候補が多くて30程度なので
  // 5ピアで概ね160件。異常時のバーストを見込んでその3倍を取る。正常なプレイを
  // 止めないことを優先し、ここは荒らし対策の粗い網に徹する。
  rtcSignalMaxPerGame: 500,
  // 1回の同期は3往復。入室時と script_ready で最大2回同期しても6回で足りる。
  // 再接続を挟んでも枯れないよう、余裕を見て20に置く。
  timeSyncMaxPerGame: 20,
  // 作品は結果画面で何度も聞き返される。10人が数回ずつ再生しても届かない値にする。
  workRateWindowMs: 60_000,
  workRateMax: 60,
}

// 素朴な spread だと、明示的に渡された undefined（例: { uploadRateMax: undefined }）が
// 既定値を undefined で上書きしてしまう。createRateLimiter(60_000, undefined) は
// entry.count >= max が常に false になり、レート制限が無音で無効化される。
// それを防ぐため、undefined のキーは無視して既定値を残す。
export function resolveLimits(partial?: Partial<Limits>): Limits {
  const result = { ...DEFAULT_LIMITS }
  if (partial) {
    for (const key of Object.keys(partial) as (keyof Limits)[]) {
      const value = partial[key]
      if (value !== undefined) result[key] = value
    }
  }
  return result
}
