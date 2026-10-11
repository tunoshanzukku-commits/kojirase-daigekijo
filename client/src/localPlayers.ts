import type { PlayerSnapshot } from './types'

// 「この端末に乗っている人」は ctx に別の配列として持たず、players と deviceId から
// 毎回導出する。二重に持つと player_joined / player_left / room_reset のたびに
// 同期を取る必要が生まれ、片方だけ古くなる事故が起きるため。

/** この端末のプレイヤーを参加順のまま返す。deviceId 未確定（トップ画面）なら空。 */
export function localPlayers(players: PlayerSnapshot[], deviceId: string): PlayerSnapshot[] {
  if (!deviceId) return []
  return players.filter(p => p.deviceId === deviceId)
}

/** その名前の人がこの端末にいるか（台本のハイライト判定に使う）。 */
export function isLocalPlayer(players: PlayerSnapshot[], deviceId: string, name: string): boolean {
  if (!deviceId) return false
  return players.some(p => p.deviceId === deviceId && p.name === name)
}

/**
 * player_joined で届いた1人を、サーバーの正準順（orderedPlayers＝端末の参加順→
 * 端末内の追加順）と一致する位置に挿入する。単純に配列末尾へ append すると、
 * 「既にいる端末に後から追加された人」がサーバー上の位置より後ろにずれ、
 * playerColorMap の index がサーバーとクライアントで食い違う（＝同じ人が
 * 画面によって違う色に見える）。
 *
 * - 同じ deviceId が既にあれば、その端末の最後の人の直後に挿入する
 * - 無ければ末尾に追加する（サーバーでも新しい端末は devices Map の最後に入る）
 */
export function insertPlayer(players: PlayerSnapshot[], player: PlayerSnapshot): PlayerSnapshot[] {
  let lastIndexOfDevice = -1
  for (let i = 0; i < players.length; i++) {
    if (players[i]!.deviceId === player.deviceId) lastIndexOfDevice = i
  }
  if (lastIndexOfDevice === -1) return [...players, player]
  const next = [...players]
  next.splice(lastIndexOfDevice + 1, 0, player)
  return next
}
