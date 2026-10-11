import type { ScriptData, RoleInfo, ScriptEntry } from '@shared/types'
import { genreLabel } from '@shared/constants'

export function generateStubScript(genre: string, playerNames: string[]): ScriptData {
  const label = genreLabel(genre) || '即興劇'

  const roles: RoleInfo[] = playerNames.map((name, i) => ({
    player: name,
    role: `${label}の登場人物${i + 1}`,
    description: `${name} が演じる、${label}の世界の登場人物です。（スタブ）`,
  }))

  const entries: ScriptEntry[] = playerNames.map((name, i) => ({
    player: name,
    character: `${label}の登場人物${i + 1}`,
    action: i === 0 ? '幕が上がる' : undefined,
    line: `わたしは${name}。ここは${label}の世界だ。（スタブのセリフ）`,
  }))

  return {
    worldSetting: `これは「${label}」ジャンルのスタブ台本です。本番では Claude API が生成します。`,
    roles,
    entries,
  }
}
