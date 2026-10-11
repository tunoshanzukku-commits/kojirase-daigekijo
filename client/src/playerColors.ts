// プレイヤーの固定色（1P〜10P）。参加順に割り当て、ロビー・配役・台本・結果の
// すべてで「同じ人が同じ色」になるようにする。1P/2P という昭和のゲーム機の見立て。
//
// 既存の GENRE_ACCENT と同じ昭和の差し色から採っているが、こちらは紙の上に
// 罫と文字として乗る（GENRE_ACCENT は帯の地として明色の文字を載せる）。
// 要求されるコントラストの向きが逆なので、値は共有せず独立に持つ。
//
// コントラスト実測値（WCAG）:
//   本文地 #f0e7d2 に対して最小 4.76:1（1P 朱）
//   パネル地 #f7f1e3 に対して最小 5.20:1（1P 朱）
// 4P 山吹と 9P 鶯茶は GENRE_ACCENT の原色だと本文地で 4.5:1 を切るため暗くしてある。
// 色を足す・変えるときは両方の地で 4.5:1 以上を確認すること。
export const PLAYER_COLORS = [
  '#b8352c', // 1P  朱
  '#3a4f7a', // 2P  群青
  '#46603f', // 3P  深緑
  '#7d5b16', // 4P  山吹（GENRE_ACCENT.comedy より暗い）
  '#5f4c6b', // 5P  葡萄鼠
  '#3f6b67', // 6P  錆浅葱
  '#6b3f2e', // 7P  海老茶
  '#2f4550', // 8P  藍鉄
  '#656124', // 9P  鶯茶
  '#241c17', // 10P 墨
] as const

/** 参加順の index から色を引く。上限を超えたら循環する（MAX_PLAYERS=10 なので通常は起きない）。 */
export function playerColor(index: number): string {
  const n = PLAYER_COLORS.length
  return PLAYER_COLORS[((index % n) + n) % n]!
}

/** 参加順に並んだプレイヤー配列から「名前 → 色」を引ける表を作る。 */
export function playerColorMap(players: { name: string }[]): Record<string, string> {
  const map: Record<string, string> = {}
  players.forEach((p, i) => {
    map[p.name] = playerColor(i)
  })
  return map
}
