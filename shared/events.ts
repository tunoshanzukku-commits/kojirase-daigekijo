import type { RoomSnapshot, PlayerSnapshot, ScriptData, PlayerScore, RoomStatus } from './types'

export interface ClientToServerEvents {
  create_room: (payload: { playerName: string }) => void
  join_room: (payload: { roomCode: string; playerName: string }) => void
  add_local_player: (payload: { playerName: string }) => void
  remove_local_player: (payload: { playerId: string }) => void
  set_genre: (payload: { genre: string }) => void
  set_live_audio: (payload: { enabled: boolean }) => void
  start_game: () => void
  set_ready: (payload: { isReady: boolean }) => void
  start_recording: () => void
  send_reaction: (payload: { emoji: string }) => void
  send_bgm: (payload: { bgmId: string | null }) => void
  send_sfx: (payload: { sfxId: string }) => void
  send_volume: (payload: { level: number }) => void
  stop_recording: () => void
  return_to_lobby: () => void
  abort_game: () => void
  rejoin: (payload: { token: string }) => void
  leave_room: () => void // 意図的な退出（猶予なしで即削除。事故切断とは区別する）
  kick_device: (payload: { deviceId: string }) => void
  // 簡易時刻同期。録音開始時刻をサーバー時計に換算するためだけに使う。
  time_ping: (payload: { clientSent: number }) => void
  // data は SDP / ICE候補。サーバーは中身を理解せず素通しする。
  rtc_signal: (payload: { toDeviceId: string; data: unknown }) => void
}

export interface ServerToClientEvents {
  room_created: (payload: { roomCode: string; room: RoomSnapshot; token: string; deviceId: string }) => void
  room_joined: (payload: { room: RoomSnapshot; token: string; deviceId: string }) => void
  player_joined: (payload: { player: PlayerSnapshot }) => void
  genre_changed: (payload: { genre: string }) => void
  live_audio_changed: (payload: { enabled: boolean }) => void
  // aiMode = この回が実AIで進むか。RoomSnapshot.aiAvailable（＝「いま始めたら」の見込み）と違い、
  // 開始時に確定したこのゲームの事実。他の部屋が枠を取った直後でも表示が嘘にならない。
  script_ready: (payload: { script: ScriptData; aiMode: boolean }) => void
  player_left: (payload: { playerName: string }) => void
  room_dissolved: () => void
  error: (payload: { message: string }) => void
  ready_updated: (payload: { playerName: string; isReady: boolean; allReady: boolean }) => void
  recording_started: () => void
  reaction_received: (payload: { emoji: string; playerName: string }) => void
  bgm_changed: (payload: { bgmId: string | null; playerName: string }) => void
  sfx_played: (payload: { sfxId: string; playerName: string }) => void
  volume_update: (payload: { level: number }) => void
  recording_stopped: () => void
  evaluation_complete: (payload: { scores: PlayerScore[]; leftPlayers: string[] }) => void
  player_returned: (payload: { playerName: string }) => void
  room_reset: (payload: { room: RoomSnapshot }) => void
  game_aborted: (payload: { room: RoomSnapshot }) => void
  script_generating: () => void
  script_failed: (payload: { message: string }) => void
  evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void
  rejoined: (payload: {
    room: RoomSnapshot
    status: RoomStatus
    deviceId: string
    selfPlayerNames: string[]   // この端末に乗っている人（selfName の複数形）
  }) => void
  rejoin_failed: (payload: { message: string }) => void
  player_disconnected: (payload: { playerName: string }) => void
  player_reconnected: (payload: { playerName: string }) => void
  // clientSent はそのままエコーする（クライアントが往復時間を測るため）。
  time_pong: (payload: { clientSent: number; serverNow: number }) => void
  // 合成が終わった。url は**パス**（例 /work/ABCD/<token>）で、
  // クライアントが SERVER_URL を前置して使う。
  work_ready: (payload: { url: string }) => void
  // 合成できなかった。クライアントは今までどおりローカルのテイクを出す。
  work_failed: () => void
  // fromDeviceId はサーバーが解決して付ける（クライアントの自己申告は使わない）。
  rtc_signal: (payload: { fromDeviceId: string; data: unknown }) => void
}
