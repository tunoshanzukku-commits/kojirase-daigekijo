import Anthropic from '@anthropic-ai/sdk'
import type { ScriptData, PlayerScore } from '@shared/types'
import { renderTemplate } from './prompts'
import type { Prompts } from './prompts'

const MODEL = 'claude-haiku-5-5'
// Haiku 5.5 は同じ文章を Haiku 4.5 より約3割多いトークンで数えるので、4.5 時代の 2000 では
// 10人ぶんの講評が途中で切れうる。課金は使った分だけ。
const MAX_TOKENS = 16000
// 考える処理（thinking）なしなら採点は約3.5秒で、評価中の演出（最短約6.3秒）の間に届く
// （有効だと約8秒・2026-10-10 計測）。thinking 無効のまま effort を xhigh/max にすると 400 になる。
const EFFORT = 'medium'

// Anthropic の構造化出力（output_config.format）が受け付ける JSON Schema は部分集合で、
// integer の minimum/maximum は非対応（送ると 400
// 「For 'integer' type, properties maximum, minimum are not supported」）。
// 1〜5 の範囲は prompts/score-system{,-solo}.md で指示し、下の clampScore で担保する。
// ＝範囲を変えるときは prompts/ の採点プロンプト2本と clampScore を直すこと。
export const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          playerName: { type: 'string' },
          acting: { type: 'integer' },
          emotion: { type: 'integer' },
          kojirase: { type: 'integer' },
          comment: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['playerName', 'acting', 'emotion', 'kojirase', 'comment', 'title'],
      },
    },
  },
  required: ['scores'],
}

/** 文字起こし済みの1本。players が2人以上なら共有録音。 */
export interface TranscribedSource {
  players: string[]
  text: string
}

// 共有録音のラベル。A, B, C… 26本を超えることは実質ない（端末数の上限＝人数上限10）。
function sharedLabel(index: number): string {
  return `録音${String.fromCharCode(0x41 + index)}`
}

// 文面は prompts/score-user-*.md に置き、ここは「並べる」構造だけを持つ。
// 全ソースが1人のときは録音セクションを1文字も出さない＝現行と同一の出力になること。
export function buildScorePrompt(
  prompts: Prompts,
  script: ScriptData,
  sources: TranscribedSource[],
): string {
  const header = renderTemplate(prompts.scoreUserHeader(), { worldSetting: script.worldSetting })

  // 共有録音（2人以上が1本）だけを録音セクションに出し、該当者は参照に差し替える
  const shared = sources.filter(s => s.players.length > 1)
  const referenceOf = new Map<string, string>()
  const sharedBlocks: string[] = []
  if (shared.length > 0) {
    const lines = [prompts.scoreUserSharedHeader()]
    const template = prompts.scoreUserSharedSource()
    shared.forEach((s, i) => {
      const label = sharedLabel(i)
      for (const name of s.players) referenceOf.set(name, `${label} を参照`)
      lines.push(
        renderTemplate(template, {
          label,
          players: s.players.join('・'),
          count: String(s.players.length),
          transcript: s.text || '（無音）',
        }),
      )
    })
    sharedBlocks.push(lines.join('\n'), '')
  }

  const template = prompts.scoreUserPlayer()
  const playerBlocks = sources.flatMap(s =>
    s.players.map(name => {
      const role = script.roles.find(r => r.player === name)
      const scripted = script.entries
        .filter(e => e.player === name)
        .map(e => e.line)
        .join(' / ')
      return renderTemplate(template, {
        playerName: name,
        role: role?.role ?? '不明',
        roleDescription: role?.description ?? '',
        scriptedLines: scripted || '（なし）',
        actualSpeech: referenceOf.get(name) ?? (s.text || '（無音）'),
      })
    }),
  )

  return [header, '', ...sharedBlocks, ...playerBlocks].join('\n')
}

/**
 * 採点対象が1人なら相対評価が成立しない（見比べる相手がいない）ので SYSTEM ごと差し替える。
 * 共有録音があるときは帰属ルールの追記ぶんを連結する（全文の複製は作らない＝
 * 複製すると必ず片方だけ直されて食い違うため）。
 */
export function selectScoreSystem(prompts: Prompts, count: number, hasShared: boolean): string {
  if (count === 1) return prompts.scoreSystemSolo()
  if (hasShared) return [prompts.scoreSystem(), prompts.scoreSystemShared()].join('\n\n')
  return prompts.scoreSystem()
}

/** Messages API に送る中身。実 API を叩かずにモデルと設定を検証できるよう切り出してある。 */
export function buildScoreRequest(prompts: Prompts, script: ScriptData, sources: TranscribedSource[]) {
  const count = sources.reduce((n, s) => n + s.players.length, 0)
  const hasShared = sources.some(s => s.players.length > 1)
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: selectScoreSystem(prompts, count, hasShared),
    messages: [{ role: 'user' as const, content: buildScorePrompt(prompts, script, sources) }],
    thinking: { type: 'disabled' as const },
    output_config: { effort: EFFORT, format: { type: 'json_schema' as const, schema: SCORE_SCHEMA } },
  }
}

type RawScore = { playerName?: string; acting?: unknown; emotion?: unknown; kojirase?: unknown; comment?: unknown; title?: unknown }

// 範囲外・非整数・非数値を 1〜5 の整数にクランプする（throw しない＝ゲームを止めない）。
function clampScore(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 1
  return Math.min(5, Math.max(1, n))
}

// 頑健化（fail-open）: Claude が playerName を取りこぼす/変える/人数分返さなくても、
// ゲーム全体の採点を落とさず expectedNames 全員ぶんを返す。
// 名前一致を最優先 → 一致しない分は未使用エントリを順番で対応付け（プロンプトは順番どおり）
// → それでも足りない分は「採点できませんでした」のプレースホルダで埋める。
// 真に壊れた出力（不正JSON・scores が配列でない）だけは throw（呼び出し側でリトライ/失敗）。
export function parseScores(text: string, expectedNames: string[]): PlayerScore[] {
  const data = JSON.parse(text) as { scores?: RawScore[] }
  if (!Array.isArray(data.scores)) throw new Error('invalid scores shape')
  const entries = data.scores
  const used = new Set<RawScore>()
  const byName = new Map<string, RawScore>()
  for (const s of entries) {
    if (typeof s.playerName === 'string' && !byName.has(s.playerName)) byName.set(s.playerName, s)
  }
  return expectedNames.map(name => {
    let s = byName.get(name)
    if (!s || used.has(s)) {
      s = entries.find(e => !used.has(e)) // 名前で見つからない → 未使用エントリを順番で
    }
    if (!s) {
      return { playerName: name, acting: 1, emotion: 1, kojirase: 1, comment: 'AIの採点を取得できませんでした。', title: '—' }
    }
    used.add(s)
    return {
      playerName: name,
      acting: clampScore(s.acting),
      emotion: clampScore(s.emotion),
      kojirase: clampScore(s.kojirase),
      comment: String(s.comment ?? ''),
      title: String(s.title ?? ''),
    }
  })
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

export type ScoreGenerator = (
  script: ScriptData,
  sources: TranscribedSource[],
) => Promise<PlayerScore[]>

export function createScoreGenerator(prompts: Prompts): ScoreGenerator {
  async function callClaude(
    script: ScriptData,
    sources: TranscribedSource[],
  ): Promise<PlayerScore[]> {
    const names = sources.flatMap(s => s.players)
    const res = await getClient().messages.create(
      buildScoreRequest(prompts, script, sources) as Parameters<Anthropic['messages']['create']>[0],
    )
    const block = (res as { content: Array<{ type: string; text?: string }>; stop_reason?: string }).content.find(
      b => b.type === 'text',
    )
    if (!block?.text) {
      const stop = (res as { stop_reason?: string }).stop_reason ?? 'unknown'
      throw new Error(`Claude 応答に text ブロックがありません (stop_reason=${stop})`)
    }
    return parseScores(block.text, names)
  }

  return async function generateScores(
    script: ScriptData,
    sources: TranscribedSource[],
  ): Promise<PlayerScore[]> {
    return withRetry(() => callClaude(script, sources))
  }
}
