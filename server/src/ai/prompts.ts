import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// プロンプトの文面はソースに直書きせず prompts/ の .md から読む。
// 最も頻繁に書き換える部分なので、TypeScript を触らずに編集できるようにする。
// 計算とループはコード側、文面はファイル側、という線引き。

export const REQUIRED_FILES = [
  'script-system.md',
  'script-user.md',
  'script-user-solo.md',
  'score-system.md',
  'score-system-solo.md',
  'score-system-shared.md',
  'score-user-header.md',
  'score-user-player.md',
  'score-user-shared-header.md',
  'score-user-shared-source.md',
] as const

interface Loaded {
  files: Map<string, string>
  genres: Map<string, string>
}

/** リポジトリ直下 prompts/。cwd 基準にすると起動ディレクトリ次第で取りこぼす。 */
export function promptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // server/src/ai
  return resolve(here, '../../../prompts')
}

/**
 * {{名前}} を差し替える。テンプレートエンジンは入れない（依存を増やす価値がない）。
 * 必要な変数が渡っていなければ throw する：差し替え漏れをそのまま送ると
 * モデルに「{{playerCount}}」という文字列が届いてしまうため。
 * 検出はテンプレート側だけを見るので、値に {{ }} が含まれていても誤検知しない。
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const needed = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]!)
  const missing = [...new Set(needed.filter(n => !(n in vars)))]
  if (missing.length > 0) {
    throw new Error(`プロンプトの差し替え漏れ: ${missing.map(n => `{{${n}}}`).join(', ')}`)
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k]!)
}

export interface Prompts {
  scriptSystem(): string
  scriptUserTemplate(): string
  scriptUserSoloTemplate(): string
  scoreSystem(): string
  scoreSystemSolo(): string
  scoreSystemShared(): string
  scoreUserHeader(): string
  scoreUserPlayer(): string
  scoreUserSharedHeader(): string
  scoreUserSharedSource(): string
  genreFlavor(genreId: string): string
  counts: { prompts: number; genres: number }
}

/**
 * 必須ファイルを読み込む。欠損・空ファイルは throw する。
 *
 * plays/ は1本壊れても他の台本で代替できるのでスキップして続行するが、
 * プロンプトには代替が無い。空のまま動くと「それらしい失敗」を返しながら
 * 1ゲームごとに枠と実費を焼き続けるので、起動時に落として気づけるようにする。
 * ジャンル別の作風だけは欠けてもその行を省いて続行する。
 */
export function createPrompts(dir: string = promptsDir()): Prompts {
  let cache: Loaded | null = null

  function initPrompts(): { prompts: number; genres: number } {
    const files = new Map<string, string>()
    for (const name of REQUIRED_FILES) {
      const path = join(dir, name)
      let text: string
      try {
        text = readFileSync(path, 'utf-8')
      } catch {
        throw new Error(`必須のプロンプトファイルが読めません: ${path}`)
      }
      if (text.trim().length === 0) throw new Error(`プロンプトファイルが空です: ${name}`)
      files.set(name, text.trim())
    }

    const genres = new Map<string, string>()
    const genresDir = join(dir, 'genres')
    try {
      for (const f of readdirSync(genresDir).filter(f => f.endsWith('.md'))) {
        const text = readFileSync(join(genresDir, f), 'utf-8').trim()
        if (text) genres.set(f.replace(/\.md$/, ''), text)
      }
    } catch {
      console.warn(`[server] ジャンル作風ディレクトリを読めません（作風なしで続行）: ${genresDir}`)
    }

    cache = { files, genres }
    return { prompts: files.size, genres: genres.size }
  }

  function get(name: (typeof REQUIRED_FILES)[number]): string {
    if (cache === null) initPrompts()
    return cache!.files.get(name)!
  }

  function scriptSystem(): string {
    return get('script-system.md')
  }
  function scriptUserTemplate(): string {
    return get('script-user.md')
  }
  function scriptUserSoloTemplate(): string {
    return get('script-user-solo.md')
  }
  function scoreSystem(): string {
    return get('score-system.md')
  }
  function scoreSystemSolo(): string {
    return get('score-system-solo.md')
  }
  function scoreSystemShared(): string {
    return get('score-system-shared.md')
  }
  function scoreUserHeader(): string {
    return get('score-user-header.md')
  }
  function scoreUserPlayer(): string {
    return get('score-user-player.md')
  }
  function scoreUserSharedHeader(): string {
    return get('score-user-shared-header.md')
  }
  function scoreUserSharedSource(): string {
    return get('score-user-shared-source.md')
  }

  /** 未配置のジャンルは空文字（その行を省いて劇は成立する）。 */
  function genreFlavor(genreId: string): string {
    if (cache === null) initPrompts()
    return cache!.genres.get(genreId) ?? ''
  }

  const counts = initPrompts()

  return {
    scriptSystem, scriptUserTemplate, scriptUserSoloTemplate, scoreSystem, scoreSystemSolo, scoreSystemShared,
    scoreUserHeader, scoreUserPlayer, scoreUserSharedHeader, scoreUserSharedSource, genreFlavor, counts,
  }
}
