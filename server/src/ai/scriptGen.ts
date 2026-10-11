import Anthropic from '@anthropic-ai/sdk'
import type { ScriptData } from '@shared/types'
import { genreLabel } from '@shared/constants'
import type { ScriptLibrary } from './scriptLibrary'
import { renderTemplate } from './prompts'
import type { Prompts } from './prompts'

const MODEL = 'claude-haiku-5-5'
// 人数に比例して台本が伸びるため、10人×4行ぶんの JSON が収まる余裕を持たせる。
// Haiku 5.5 は同じ文章を Haiku 4.5 より約3割多いトークンで数えるので、4.5 時代の 8000 では
// 大人数の台本が途中で切れうる（非ストリーミングなので気づきにくい）。課金は使った分だけ。
const MAX_TOKENS = 16000
// 考える処理（thinking）を有効にするとオチの質は上がるが、生成に約40〜50秒かかる
// （無効なら約11秒・2026-10-10 計測）。待ち時間を優先して無効にしている。
// thinking 無効のまま effort を xhigh/max にすると 400 になる。
const EFFORT = 'medium'

// 台本の行数はプレイヤー数に比例させる。各プレイヤーに3〜4回ずつ台詞を回す前提。
// 少人数でも一幕として成立する下限を置く。
const LINES_PER_PLAYER_MIN = 3
const LINES_PER_PLAYER_MAX = 4
const LINES_FLOOR_MIN = 8
const LINES_FLOOR_MAX = 12

// ソロは1人が喋り続けるため、人数比例ではなく固定。
// 10〜12行・本文360字以内で推定120秒前後（上限150秒）に収まる。
const SOLO_LINES_MIN = 10
const SOLO_LINES_MAX = 12

const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    worldSetting: { type: 'string' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          player: { type: 'string' },
          role: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['player', 'role', 'description'],
      },
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          player: { type: 'string' },
          character: { type: 'string' },
          action: { type: 'string' },
          line: { type: 'string' },
        },
        required: ['player', 'character', 'action', 'line'],
      },
    },
  },
  required: ['worldSetting', 'roles', 'entries'],
}

export function buildUserPrompt(prompts: Prompts, genre: string, playerNames: string[]): string {
  const n = playerNames.length
  const solo = n === 1
  return renderTemplate(solo ? prompts.scriptUserSoloTemplate() : prompts.scriptUserTemplate(), {
    genreLabel: genreLabel(genre) || '即興劇',
    genreFlavor: prompts.genreFlavor(genre), // 未配置のジャンルは空文字＝その行が消える
    playerNames: playerNames.join('、'),
    playerCount: String(n),
    lineMin: String(solo ? SOLO_LINES_MIN : Math.max(LINES_FLOOR_MIN, n * LINES_PER_PLAYER_MIN)),
    lineMax: String(solo ? SOLO_LINES_MAX : Math.max(LINES_FLOOR_MAX, n * LINES_PER_PLAYER_MAX)),
  })
}

/** Messages API に送る中身。実 API を叩かずにモデルと設定を検証できるよう切り出してある。 */
export function buildScriptRequest(prompts: Prompts, genre: string, playerNames: string[]) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: prompts.scriptSystem(),
    messages: [{ role: 'user' as const, content: buildUserPrompt(prompts, genre, playerNames) }],
    thinking: { type: 'disabled' as const },
    output_config: { effort: EFFORT, format: { type: 'json_schema' as const, schema: SCRIPT_SCHEMA } },
  }
}

export function parseScript(text: string, playerNames: string[]): ScriptData {
  const data = JSON.parse(text) as {
    worldSetting?: unknown
    roles?: Array<{ player?: string; role?: string; description?: string }>
    entries?: Array<{ player?: string; character?: string; action?: string; line?: string }>
  }
  if (
    typeof data.worldSetting !== 'string' ||
    !Array.isArray(data.roles) ||
    !Array.isArray(data.entries) ||
    data.entries.length === 0
  ) {
    throw new Error('invalid script shape')
  }
  const roleNames = new Set(data.roles.map(r => r.player))
  for (const n of playerNames) {
    if (!roleNames.has(n)) throw new Error(`missing role for ${n}`)
  }
  // ソロは一人芝居の指示だが、モデルが架空の2役目（サポート窓口など）を足して
  // 対話劇を書いてしまう方向に寄りうる。「相手の台詞は書かない」という執筆規約が
  // 実行時に破られないよう、余分な役・他プレイヤー名の entries を弾く。
  if (playerNames.length === 1) {
    if (data.roles.length !== 1) throw new Error('ソロなのに複数役が返ってきた')
    const stray = data.entries.find(e => e.player !== playerNames[0])
    if (stray) throw new Error(`ソロなのに他プレイヤー名の entries が混ざっている: ${String(stray.player)}`)
  }
  return {
    worldSetting: data.worldSetting,
    roles: data.roles.map(r => ({
      player: String(r.player),
      role: String(r.role ?? ''),
      description: String(r.description ?? ''),
    })),
    entries: data.entries.map(e => ({
      player: String(e.player),
      character: String(e.character ?? ''),
      action: e.action ? String(e.action) : undefined,
      line: String(e.line ?? ''),
    })),
  }
}

let anthropic: Anthropic | null = null
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic())
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn() // 1回だけリトライ
  }
}

export function createScriptGenerator(prompts: Prompts, plays: ScriptLibrary) {
  async function callClaude(genre: string, playerNames: string[]): Promise<ScriptData> {
    const res = await getClient().messages.create(
      buildScriptRequest(prompts, genre, playerNames) as Parameters<Anthropic['messages']['create']>[0],
    )
    const block = (res as { content: Array<{ type: string; text?: string }>; stop_reason?: string }).content.find(
      b => b.type === 'text',
    )
    if (!block?.text) {
      const stop = (res as { stop_reason?: string }).stop_reason ?? 'unknown'
      throw new Error(`Claude 応答に text ブロックがありません (stop_reason=${stop})`)
    }
    return parseScript(block.text, playerNames)
  }

  return async function generateScript(genre: string, playerNames: string[]): Promise<ScriptData> {
    // キー未設定は「開発中」だけでなく「本番の設定ミス」でも起こる。
    // ここでスタブに落とすと実プレイヤーに開発用のプレースホルダ文言が出てしまうので、
    // 簡易モードと同じ手書き台本を使う（scriptLibrary は scriptGen を参照しない＝循環しない）。
    if (!process.env.ANTHROPIC_API_KEY) return plays.generate(genre, playerNames)
    return withRetry(() => callClaude(genre, playerNames))
  }
}
