import type { PlayerScore } from '@shared/types'

// 名前から安定的に 1..5 を導出（同名なら同結果＝テスト決定的）。項目ごとに salt を変える。
function stableScore(name: string, salt: number): number {
  let h = salt >>> 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return (h % 5) + 1
}

export function generateStubScores(playerNames: string[]): PlayerScore[] {
  return playerNames.map(name => ({
    playerName: name,
    acting: stableScore(name, 1),
    emotion: stableScore(name, 2),
    kojirase: stableScore(name, 3),
    comment: `「${name}」の演技をAIが講評しました。（スタブ）`,
    title: '演技派（スタブ）',
  }))
}
