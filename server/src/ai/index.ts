import type { ScriptData, PlayerScore } from '@shared/types'
import type { Prompts } from './prompts'
import type { ScriptLibrary } from './scriptLibrary'
import { createScriptGenerator } from './scriptGen'
import { createScoreGenerator } from './scoreGen'
import type { TranscribedSource } from './scoreGen'
import { createTranscriber } from '../transcribe'
import { createEvaluator } from './evaluate'
import type { AudioSource } from './evaluate'

export interface Ai {
  generateScript(genre: string, playerNames: string[]): Promise<ScriptData>
  generateScores(script: ScriptData, sources: TranscribedSource[]): Promise<PlayerScore[]>
  transcribe(audio: { buffer: Buffer; mime: string }): Promise<string>
  evaluate(
    script: ScriptData | null,
    performers: string[],
    sources: AudioSource[],
  ): Promise<PlayerScore[]>
}

// evaluate は transcribe/generateScores に依存するため、ここで解決する。
// overrides で transcribe/generateScores を差し替えた場合、evaluate の既定実装が
// 参照するのも（新しく作った実装ではなく）差し替え後のものになる。
export function createAi(deps: { prompts: Prompts; plays: ScriptLibrary; overrides?: Partial<Ai> }): Ai {
  const generateScript = deps.overrides?.generateScript ?? createScriptGenerator(deps.prompts, deps.plays)
  const generateScores = deps.overrides?.generateScores ?? createScoreGenerator(deps.prompts)
  const transcribe = deps.overrides?.transcribe ?? createTranscriber()
  const evaluate = deps.overrides?.evaluate ?? createEvaluator({ transcribe, generateScores })
  return { generateScript, generateScores, transcribe, evaluate }
}
