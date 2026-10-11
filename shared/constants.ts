export interface Genre {
  id: string
  label: string
  emoji: string
}

export const GENRES: Genre[] = [
  { id: 'romance', label: '恋愛ドラマ',   emoji: '💕' },
  { id: 'horror',  label: 'ホラー',       emoji: '👻' },
  { id: 'comedy',  label: 'コメディ',     emoji: '😂' },
  { id: 'jidai',   label: '時代劇',       emoji: '⚔️' },
  { id: 'sf',      label: 'SF・未来',     emoji: '🚀' },
  { id: 'mystery', label: 'ミステリー',   emoji: '🔍' },
  { id: 'emotion', label: '感動・涙活',   emoji: '😢' },
  { id: 'chaos',   label: 'カオスモード', emoji: '🌀' },
]

export const GENRE_IDS: string[] = GENRES.map(g => g.id)

export function genreLabel(id: string): string {
  return GENRES.find(g => g.id === id)?.label ?? ''
}

export const NAME_MAX = 10
export const ROOM_CODE_LEN = 4
// 1人プレイ（一人芝居）を許可する。サーバーとクライアントで別々に数字を
// 直書きすると片方だけ直したときに食い違うため、ここ1箇所に置く。
export const MIN_PLAYERS = 1
export const MAX_PLAYERS = 10
// 感想（任意）の文字数上限。クライアントの maxLength とサーバーの検証が
// 食い違わないよう、MIN_PLAYERS と同じくここ1箇所に置く。
export const MAX_FEEDBACK_LENGTH = 1000
// A〜Z から紛らわしい I, O を除いた24文字
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

// 録音中インタラクション（RecordingScreen の現行定義に一致させること）
export const EMOJIS = ['👏', '😂', '🔥', '😍', '💪'] as const
export const BGM_IDS = ['dramatic', 'horror', 'comedy', 'battle'] as const
export const SFX_IDS = ['drum', 'boom', 'fanfare', 'scream', 'laugh', 'bell'] as const

// 録音時間の上限（サーバーが自動終了させる）＝「台本の想定時間 ＋ 1分」。
// 想定時間はいまは固定値。将来ここを台本から算出する関数に差し替えられるよう
// 1箇所に閉じ込めてある（RECORDING_LIMIT_SEC 以外を直接参照しないこと）。
export const SCRIPT_ESTIMATE_SEC = 90
export const RECORDING_BUFFER_SEC = 60
export const RECORDING_LIMIT_SEC = SCRIPT_ESTIMATE_SEC + RECORDING_BUFFER_SEC // 150

// ライブ音声（WebRTC mesh）を許す端末数の上限。mesh の接続数は端末数の2乗で
// 増えるため（6台＝15接続）、スマホの CPU と帯域が保つ範囲で切る。
// 部屋の人数上限（MAX_PLAYERS）とは別物：1台に複数人乗るので端末数 ≦ 人数。
export const MAX_LIVE_AUDIO_DEVICES = 6
