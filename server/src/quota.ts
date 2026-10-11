import { dailyGameLimit, aiEnabled } from './config'

/** JST の YYYY-MM-DD。Railway のコンテナは UTC なので固定オフセットで足す。 */
export function jstDateString(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 10)
}

export interface Quota {
  /** 枠が残っていれば1つ消費して true。残っていなければ何もせず false。 */
  tryConsumeGame(now: Date): boolean
  /** 表示・ログ用。覗くだけで消費しない（日付が変わっていれば used=0 を返すが状態は変えない）。 */
  getState(now: Date): { date: string; used: number; limit: number }
  /** 「いまゲームを始めたら実AIが使えるか」。ロビー表示用。 */
  isAiAvailable(now: Date): boolean
}

// サーバーインスタンスごとに独立した枠を持つファクトリ。
// カウンタはメモリ上のみ。Railway のコンテナはファイルシステムが揮発するため
// ファイルに書いても再デプロイで消え、外部ストアはこの規模に見合わない。
// ＝再デプロイ・クラッシュ再起動で枠は戻る。最後の砦は各コンソールの支払上限。
export function createQuota(): Quota {
  let currentDate = ''
  let used = 0

  function tryConsumeGame(now: Date): boolean {
    const date = jstDateString(now)
    if (date !== currentDate) {
      currentDate = date
      used = 0
    }
    if (used >= dailyGameLimit()) return false
    used++
    return true
  }

  function getState(now: Date): { date: string; used: number; limit: number } {
    const date = jstDateString(now)
    const limit = dailyGameLimit()
    if (date !== currentDate) return { date, used: 0, limit }
    return { date, used, limit }
  }

  function isAiAvailable(now: Date): boolean {
    if (!aiEnabled()) return false
    const { used: u, limit } = getState(now)
    return u < limit
  }

  return { tryConsumeGame, getState, isAiAvailable }
}
