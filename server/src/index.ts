import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { buildServer, resolveDistDir } from './server'
import { probeFfmpeg } from './mixdown'

// リポジトリ直下の .env（.env.example もここ）を優先的に読む。
// サーバーは server/ から起動するため既定の cwd 読み込みだと root .env を取りこぼす。
const here = dirname(fileURLToPath(import.meta.url)) // server/src
config({ path: resolve(here, '../../.env') }) // repo 直下 .env
config() // フォールバック: cwd（server/）の .env も許容（override せず）
import { GENRES } from '@shared/constants'

// プロンプトが欠けたまま起動すると、採点は「それらしい失敗」を返しながら
// 1ゲームごとに枠と実費を焼き続ける。buildServer() が createPrompts() を呼ぶ際に
// throw するので、listen する前に落ちて気づける。
const { httpServer, rooms, prompts, plays } = buildServer()
const PORT = Number(process.env.PORT) || 3001
const ONE_HOUR = 60 * 60 * 1000
const CLEANUP_INTERVAL = 5 * 60 * 1000

setInterval(() => {
  const deleted = rooms.cleanup(Date.now(), ONE_HOUR)
  if (deleted.length > 0) console.log(`[server] cleaned up rooms: ${deleted.join(', ')}`)
}, CLEANUP_INTERVAL)

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[server] ANTHROPIC_API_KEY 未設定：台本生成は手書き台本（簡易モード）で動作します')
}

if (!process.env.GROQ_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  console.warn('[server] GROQ_API_KEY / ANTHROPIC_API_KEY 未設定：AI評価はスタブモードで動作します')
}

httpServer.listen(PORT, () => {
  const isProduction = process.env.NODE_ENV === 'production'
  const mode = isProduction ? 'production' : 'development'
  console.log(`[server] mode: ${mode} / listening on ${PORT} / genres loaded: ${GENRES.length}`)
  console.log(`[server] 手書き台本: ${plays.count} 本`)
  console.log(`[server] プロンプト: ${prompts.counts.prompts} ファイル / ジャンル作風: ${prompts.counts.genres} 件`)
  if (isProduction) {
    // NODE_ENV=production を渡し忘れたまま公開したり、client を build せずに本番起動した場合に
    // ログだけで「静的配信 OFF」「dist が無い＝ビルド忘れ」に気づけるようにする。
    const distDir = resolveDistDir()
    console.log(`[server] client/dist: ${distDir} (exists: ${existsSync(distDir)})`)
  } else {
    console.log('[server] development: CORS 有効・静的配信は無効（client は Vite で別途起動）')
  }
  // 合成機能が生きているかを起動時に1回だけ知らせる。無くてもサーバーは動く
  // （作品が作れなくなるだけで、ゲームは最後まで通常どおり進む）。
  void probeFfmpeg().then(ok => {
    console.log(ok
      ? '[server] ffmpeg あり：作品の合成は有効です'
      : '[server] ffmpeg なし：作品の合成は無効です（ゲームは通常どおり動きます）')
  })
})
