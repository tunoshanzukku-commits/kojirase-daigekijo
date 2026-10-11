// Groq Whisper（OpenAI 互換）。プロバイダ固有値はこの3定数に隔離してある。
// OpenAI へ乗り換える場合は BASE_URL / MODEL / キー名を変えるだけで他モジュールに波及しない。
const BASE_URL = 'https://api.groq.com/openai/v1'
const MODEL = 'whisper-large-v3-turbo'

const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

// Whisper 系はファイル名の拡張子で入力形式を判定するため mime→拡張子が必須。
export function extForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase() // 'audio/webm;codecs=opus' → 'audio/webm'
  return MIME_EXT[base] ?? 'webm'
}

async function callGroq(audio: { buffer: Buffer; mime: string }): Promise<string> {
  const ext = extForMime(audio.mime)
  const form = new FormData()
  form.append('file', new Blob([audio.buffer], { type: audio.mime }), `audio.${ext}`)
  form.append('model', MODEL)
  form.append('language', 'ja')
  form.append('response_format', 'json')
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY ?? ''}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Groq transcription failed: ${res.status}`)
  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn() // 1回だけリトライ
  }
}

export type Transcriber = (audio: { buffer: Buffer; mime: string }) => Promise<string>

export function createTranscriber(): Transcriber {
  return async function transcribe(audio: { buffer: Buffer; mime: string }): Promise<string> {
    return withRetry(() => callGroq(audio))
  }
}
