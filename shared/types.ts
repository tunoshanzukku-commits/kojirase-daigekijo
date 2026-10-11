export interface ScriptEntry {
  player: string
  character: string
  action?: string
  line: string
}

export interface RoleInfo {
  player: string
  role: string
  description: string
}

export interface ScriptData {
  worldSetting: string
  roles: RoleInfo[]
  entries: ScriptEntry[]
}

export interface PlayerScore {
  playerName: string
  acting: number
  emotion: number
  kojirase: number
  comment: string
  title: string
}

export type RoomStatus =
  | 'waiting'
  | 'casting'
  | 'preparing'
  | 'recording'
  | 'evaluating'
  | 'result'

export interface PlayerSnapshot {
  id: string          // プレイヤーの安定ID
  deviceId: string    // 同じ値の人が同じ端末にいる（グルーピング用。資格情報ではない）
  name: string
  isHost: boolean     // 端末の代表プレイヤー（playerIds[0]）にだけ立つ
  isReady: boolean    // 端末の値をそのまま配る
  connected: boolean  // 端末の接続状態。false = 事故切断の猶予中（クライアントは「復帰待ち…」表示）
}

export interface RoomSnapshot {
  code: string
  status: RoomStatus
  genre: string
  players: PlayerSnapshot[]
  script: ScriptData | null
  scores: PlayerScore[]
  bgm: string | null // 再接続時に録音中のBGMも復元できるようにする
  aiAvailable: boolean // 「いまゲームを始めたら実AIが使えるか」。表示用で、進行中のゲームのモードとは別物
  liveAudio: boolean // ホストがロビーで決める。録音中に他端末の声が聞こえるか
}
