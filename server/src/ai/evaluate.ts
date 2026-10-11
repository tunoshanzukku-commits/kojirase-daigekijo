import type { ScriptData, PlayerScore } from '@shared/types'
import { generateStubScores } from './scoreStub'
import type { Transcriber } from '../transcribe'
import type { ScoreGenerator } from './scoreGen'

/** 1本の録音と、そこに入っている人。1端末＝1本＝1..N人。 */
export interface AudioSource {
  players: string[]                                 // 参加順
  audio: { buffer: Buffer; mime: string } | null    // null = マイク拒否・未着
}

export type Evaluator = (
  script: ScriptData | null,
  performers: string[],
  sources: AudioSource[],
) => Promise<PlayerScore[]>

// 鍵未設定 or 台本なしはスタブ（ネットワーク無し）。実行時は各ソースを並列で
// 文字起こしし、個別失敗は空文字に劣化（全体は落とさない）。採点(generateScores)の
// 失敗はそのまま throw され、呼び出し側(finalizeEvaluation)で evaluation_failed になる。
export function createEvaluator(deps: { transcribe: Transcriber; generateScores: ScoreGenerator }): Evaluator {
  return async function evaluatePerformance(script, performers, sources) {
    if (!process.env.GROQ_API_KEY || !process.env.ANTHROPIC_API_KEY || !script) {
      return generateStubScores(performers)
    }
    const transcribed = await Promise.all(
      sources.map(async src => {
        if (!src.audio) return { players: src.players, text: '' }
        try {
          return { players: src.players, text: await deps.transcribe(src.audio) }
        } catch (err) {
          console.error(`[server] transcription failed for ${src.players.join('・')}:`, err)
          return { players: src.players, text: '' } // 個別失敗は空文字に劣化
        }
      }),
    )
    return deps.generateScores(script, transcribed)
  }
}
