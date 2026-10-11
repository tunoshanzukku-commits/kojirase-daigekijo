import { NAME_MAX, GENRE_IDS, ROOM_CODE_ALPHABET, ROOM_CODE_LEN, EMOJIS, BGM_IDS, SFX_IDS } from '@shared/constants'

const ALLOWED = new Set(ROOM_CODE_ALPHABET.split(''))

function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f
}

export function sanitizeName(raw: string): string {
  let out = ''
  for (const ch of raw) {
    if (!isControlChar(ch.codePointAt(0) ?? 0)) out += ch
  }
  return out.trim()
}

export function isValidName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX
}

export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter(c => ALLOWED.has(c))
    .join('')
    .slice(0, ROOM_CODE_LEN)
}

export function isValidRoomCode(code: string): boolean {
  return code.length === ROOM_CODE_LEN && code.split('').every(c => ALLOWED.has(c))
}

export function isValidGenre(genre: string): boolean {
  return GENRE_IDS.includes(genre)
}

export function isValidEmoji(v: unknown): v is string {
  return typeof v === 'string' && (EMOJIS as readonly string[]).includes(v)
}

export function isValidBgmId(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && (BGM_IDS as readonly string[]).includes(v))
}

export function isValidSfxId(v: unknown): v is string {
  return typeof v === 'string' && (SFX_IDS as readonly string[]).includes(v)
}
