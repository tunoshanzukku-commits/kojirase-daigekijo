import { socket } from './socket'
import { pickBestOffset, type SyncSample } from './timeSyncPure'

// サーバー時計との差。録音開始時刻を全端末で同じ物差しに載せるためだけに使う。
// 同期できていなければ 0＝補正なし（今日と同じ挙動）に落ちる。
let offsetMs = 0

const ROUNDS = 3
const GAP_MS = 200
const GIVE_UP_MS = ROUNDS * GAP_MS + 2000

let syncing = false

/** サーバー時計での「いま」。同期に失敗していれば端末の時計そのまま。 */
export function serverNow(): number {
  return Date.now() + offsetMs
}

/** 部屋を出るとき用。次の部屋へ古い補正を持ち越さない。 */
export function resetTimeSync(): void {
  offsetMs = 0
}

/**
 * 3往復して offset を測り直す。多重呼び出しは無視する（冪等）。
 * 失敗しても何も起きない＝offset は前の値のまま。録音も採点も止めない。
 */
export function syncClock(): void {
  if (syncing) return
  syncing = true
  const samples: SyncSample[] = []
  let sent = 0

  function finish(): void {
    if (!syncing) return
    syncing = false
    socket.off('time_pong', onPong)
    window.clearTimeout(giveUp)
    if (samples.length > 0) offsetMs = pickBestOffset(samples)
  }

  function onPong({ clientSent, serverNow: srv }: { clientSent: number; serverNow: number }): void {
    const rtt = Date.now() - clientSent
    // 往路と復路が等しいと仮定して、サーバーの「いま」を自分の時計へ写す
    samples.push({ rtt, offset: srv - (clientSent + rtt / 2) })
    if (samples.length >= ROUNDS) finish()
  }

  function tick(): void {
    if (sent >= ROUNDS) return
    sent++
    socket.emit('time_ping', { clientSent: Date.now() })
    if (sent < ROUNDS) window.setTimeout(tick, GAP_MS)
  }

  socket.on('time_pong', onPong)
  // 応答が欠けても必ず後始末する（listener を積み残さない）
  const giveUp = window.setTimeout(finish, GIVE_UP_MS)
  tick()
}
