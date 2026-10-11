import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '@shared/constants'

export function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export function generateUniqueRoomCode(exists: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = generateRoomCode()
    if (!exists(code)) return code
  }
  throw new Error('ルームコードの生成に失敗しました')
}
