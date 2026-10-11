import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { ScriptData, RoleInfo, ScriptEntry } from '@shared/types'
import { GENRE_IDS, MAX_PLAYERS } from '@shared/constants'
import { generateStubScript } from './scriptStub'

export interface PlayRole {
  role: string
  description: string
}

export interface PlayEntry {
  roleIndex: number
  action?: string
  line: string
}

export interface Play {
  id: string
  genre: string
  title: string
  minPlayers: number
  maxPlayers: number
  worldSetting: string
  roles: PlayRole[]
  entries: PlayEntry[]
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 不正なら null を返す（throw しない）。呼び出し側は1本落として先へ進む。 */
export function parsePlay(raw: unknown): Play | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>

  if (!isNonEmptyString(p.id)) return null
  if (!isNonEmptyString(p.genre) || !GENRE_IDS.includes(p.genre)) return null
  if (!isNonEmptyString(p.title)) return null
  if (!isNonEmptyString(p.worldSetting)) return null

  const min = p.minPlayers
  const max = p.maxPlayers
  if (!Number.isInteger(min) || (min as number) < 1) return null
  if (!Number.isInteger(max) || (max as number) < (min as number)) return null
  if ((max as number) > MAX_PLAYERS) return null

  if (!Array.isArray(p.roles)) return null
  const roles: PlayRole[] = []
  for (const r of p.roles) {
    if (typeof r !== 'object' || r === null) return null
    const rr = r as Record<string, unknown>
    if (!isNonEmptyString(rr.role) || !isNonEmptyString(rr.description)) return null
    roles.push({ role: rr.role, description: rr.description })
  }
  // 最大人数ぶんの役が無いと、その人数で選ばれたときに割り当てられない
  if (roles.length < (max as number)) return null

  if (!Array.isArray(p.entries) || p.entries.length === 0) return null
  const entries: PlayEntry[] = []
  for (const e of p.entries) {
    if (typeof e !== 'object' || e === null) return null
    const ee = e as Record<string, unknown>
    if (!Number.isInteger(ee.roleIndex)) return null
    const idx = ee.roleIndex as number
    if (idx < 0 || idx >= roles.length) return null
    if (!isNonEmptyString(ee.line)) return null
    if (ee.action !== undefined && !isNonEmptyString(ee.action)) return null
    entries.push({ roleIndex: idx, action: ee.action as string | undefined, line: ee.line })
  }

  return {
    id: p.id,
    genre: p.genre,
    title: p.title,
    minPlayers: min as number,
    maxPlayers: max as number,
    worldSetting: p.worldSetting,
    roles,
    entries,
  }
}

/**
 * `<dir>/<ジャンル>/*.json` を読む。壊れた1本でサーバーを落とさない。
 *
 * ディレクトリ名がジャンルの正で、JSON の genre が食い違う台本は置き間違いとして捨てる。
 * 直下に残った .json は読まないが、黙って無視すると気づけないので警告を出す
 * （読み込み結果が0本でも generateStubScript に落ちて動いてしまい、
 * 実プレイヤーに開発用のプレースホルダ文言が出るため）。
 */
export function loadPlays(dir: string): Play[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    console.warn(`[server] 台本ディレクトリを読めません: ${dir}`)
    return []
  }

  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.json')) {
      console.warn(`[server] 台本は <ジャンル>/ の下に置いてください。直下のファイルは読み込みません: ${e.name}`)
    }
  }

  const plays: Play[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const genre = e.name
    if (!GENRE_IDS.includes(genre)) {
      console.warn(`[server] ジャンル名でないディレクトリを無視します: ${genre}`)
      continue
    }
    const genreDir = join(dir, genre)
    let files: string[]
    try {
      files = readdirSync(genreDir).filter(f => f.endsWith('.json'))
    } catch {
      console.warn(`[server] 台本ディレクトリを読めません: ${genreDir}`)
      continue
    }
    for (const file of files) {
      const rel = `${genre}/${file}`
      try {
        const play = parsePlay(JSON.parse(readFileSync(join(genreDir, file), 'utf-8')))
        if (!play) {
          console.warn(`[server] 台本の形式が不正なのでスキップ: ${rel}`)
          continue
        }
        if (play.genre !== genre) {
          console.warn(`[server] genre がディレクトリと一致しないのでスキップ: ${rel}（genre=${play.genre}）`)
          continue
        }
        plays.push(play)
      } catch (err) {
        console.warn(`[server] 台本を読めないのでスキップ: ${rel}`, err)
      }
    }
  }
  return plays
}

function randomPick(xs: Play[]): Play {
  return xs[Math.floor(Math.random() * xs.length)]!
}

/**
 * ①ジャンル一致かつ人数が合う → ②ジャンル不問で人数が合う → ③null。
 * ②があるので「そのジャンルの台本がまだ無い」組み合わせでも穴が空かない。
 */
export function selectPlay(
  plays: Play[],
  genre: string,
  playerCount: number,
  pick: (xs: Play[]) => Play = randomPick,
): Play | null {
  const fits = (p: Play) => playerCount >= p.minPlayers && playerCount <= p.maxPlayers
  const sameGenre = plays.filter(p => p.genre === genre && fits(p))
  if (sameGenre.length > 0) return pick(sameGenre)
  const anyGenre = plays.filter(fits)
  if (anyGenre.length > 0) return pick(anyGenre)
  return null
}

/**
 * 参加人数 N で ScriptData に変換する。
 * 役は先頭から N 件、セリフは roleIndex < N のものだけを順序を保って残す。
 * ＝台本作者は「先頭 minPlayers 役だけでも成立する」ように書く必要がある。
 */
export function toScriptData(play: Play, playerNames: string[]): ScriptData {
  const n = playerNames.length
  const roles: RoleInfo[] = playerNames.map((player, i) => ({
    player,
    role: play.roles[i]!.role,
    description: play.roles[i]!.description,
  }))
  const entries: ScriptEntry[] = play.entries
    .filter(e => e.roleIndex < n)
    .map(e => ({
      player: playerNames[e.roleIndex]!,
      character: play.roles[e.roleIndex]!.role,
      action: e.action,
      line: e.line,
    }))
  return { worldSetting: play.worldSetting, roles, entries }
}

/** リポジトリ直下 plays/。cwd 基準にすると起動ディレクトリ次第で取りこぼす。 */
export function playsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // server/src/ai
  return resolve(here, '../../../plays')
}

export interface ScriptLibrary {
  generate(genre: string, playerNames: string[]): ScriptData
  count: number
}

/** 上限到達時の台本生成。generateStubScript と同じシグネチャで差し替えられる。 */
export function createScriptLibrary(plays: Play[]): ScriptLibrary {
  function generate(genre: string, playerNames: string[]): ScriptData {
    const play = selectPlay(plays, genre, playerNames.length)
    if (!play) return generateStubScript(genre, playerNames)
    return toScriptData(play, playerNames)
  }

  return { generate, count: plays.length }
}
