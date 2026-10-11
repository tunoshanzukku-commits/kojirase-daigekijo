export interface RateLimiter {
  allow(key: string, now: number): boolean
  /** テスト・診断用。保持しているキー数。 */
  size(): number
}

// 掃除を始めるキー数。これを超えたら窓を抜けたエントリを一掃する。
// レート制限モジュール自身がメモリを食い潰しては本末転倒なので必ず入れる。
const PRUNE_THRESHOLD = 10_000

/**
 * 固定ウィンドウ方式のレート制限。
 * スライディングウィンドウより粗い（窓の境界で最大2倍通る）が、
 * 荒らし抑制という目的には十分で、状態が「窓の開始時刻＋回数」だけで済む。
 * 時刻は引数で受け取る＝テストが時計に依存しない。
 */
export function createRateLimiter(windowMs: number, max: number): RateLimiter {
  const hits = new Map<string, { windowStart: number; count: number }>()

  function prune(now: number): void {
    for (const [k, v] of hits) {
      if (now - v.windowStart >= windowMs) hits.delete(k)
    }
  }

  return {
    allow(key, now) {
      if (hits.size > PRUNE_THRESHOLD) prune(now)
      const entry = hits.get(key)
      if (!entry || now - entry.windowStart >= windowMs) {
        hits.set(key, { windowStart: now, count: 1 })
        return true
      }
      if (entry.count >= max) return false
      entry.count++
      return true
    },
    size() {
      return hits.size
    },
  }
}
