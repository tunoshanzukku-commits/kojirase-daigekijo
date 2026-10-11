import { randomUUID } from 'node:crypto'
import type { RoomStatus, RoomSnapshot, PlayerSnapshot, ScriptData, PlayerScore } from '@shared/types'
import { generateUniqueRoomCode } from './roomCode'
import type { Quota } from './quota'

/** 1つのブラウザ接続（＝1台のスマホ）。音声・切断・準備完了はすべてこの単位。 */
export interface Device {
  id: string                     // 安定ID。再接続しても変わらない＝各コレクションのキー
  socketId: string               // 接続のたびに変わる。socketIndex で逆引きする
  token: string                  // 再接続クレデンシャル（端末ごとに1つ・不透明・ランダム）
  isHost: boolean
  isReady: boolean
  disconnectedAt: number | null   // 事故切断の猶予中は切断時刻、在室中は null
  playerIds: string[]            // この端末に乗っている人（追加順。[0] が代表）
  signalCount: number            // 1ゲーム中に中継した WebRTC シグナル数（resetRoom で 0 に戻す）
  timeSyncCount: number          // 1ゲーム中に投げた時刻同期 ping 数（resetRoom で 0 に戻す）
}

/** 役を持つ1人。端末に属する。 */
export interface Player {
  id: string
  name: string
  deviceId: string
}

/** 録音中に鳴らした BGM/SE の1件。合成時にこの順で重ね直す。 */
export interface TimelineEntry {
  atMs: number              // 録音開始からの経過ミリ秒
  kind: 'bgm' | 'sfx'
  id: string | null         // bgm の停止を null で表す。sfx では常に非 null
}

// タイムラインの上限。ffmpeg の入力本数が青天井にならないための蓋であり、
// 正常なプレイでこの数に届くことはない（届いたら荒らしである）。
export const MAX_TIMELINE_ENTRIES = 60

export interface Room {
  code: string
  status: RoomStatus
  genre: string
  script: ScriptData | null
  scores: PlayerScore[]
  devices: Map<string, Device>      // deviceId キー（挿入順＝端末の参加順）
  players: Map<string, Player>      // playerId キー
  socketIndex: Map<string, string>  // socketId → deviceId
  hostDeviceId: string
  createdAt: number
  lastActivityAt: number
  bgm: string | null
  // ホストがロビーで決める。録音中に他端末の声が聞こえるか（ジャンルと同じく再戦で保持）
  liveAudio: boolean
  volumes: Map<string, { level: number; ts: number }>      // deviceId
  lastVolumeBroadcast: number
  recordingRoster: string[]
  returned: Set<string>                                     // deviceId
  generatingScript: boolean
  // このゲームが実AIで進むか（start_game で確定し、そのゲームの間は変えない）
  aiMode: boolean
  // 録音アップロードの収集ゲート（C2）
  // 録音の開始時刻（サーバー時計）。各端末が申告する startedAt をこれと引き算して
  // 「頭のズレ」に直す。0 は「まだ録音していない」を表す。
  recordingStartedAt: number
  // 録音の実尺。beginAudioCollection で確定する。合成の -t に使う
  recordingDurationMs: number
  // 録音中に鳴らした BGM/SE。合成のためだけに持つ（中継の挙動には影響しない）
  audioTimeline: TimelineEntry[]
  // 合成済みの作品（m4a）。メモリにだけ持ち、リセット・解散で消える
  work: Buffer | null
  // 作品の取得に必要な不透明トークン。部屋コードは総当たりできるので必須
  workToken: string | null
  // deviceId ＝ 端末ごとに音声1本。delayMs は録音開始からこの端末の収録開始までの遅れ
  audio: Map<string, { buffer: Buffer; mime: string; delayMs: number }>
  collectingAudio: boolean
  uploadExpected: Set<string>                               // deviceId
  uploadTimer: ReturnType<typeof setTimeout> | null
  recordingTimer: ReturnType<typeof setTimeout> | null
  evaluationSeq: number
  // 非ホストの事故切断→猶予満了で退出させるタイマー（deviceId ごと）
  graceTimers: Map<string, ReturnType<typeof setTimeout>>   // deviceId
}

/** 端末を作り、最初の1人（＝代表プレイヤー）を乗せる。 */
export function addDevice(room: Room, socketId: string, name: string, isHost: boolean): Device {
  const device: Device = {
    id: randomUUID(),
    socketId,
    token: randomUUID(),
    isHost,
    isReady: false,
    disconnectedAt: null,
    playerIds: [],
    signalCount: 0,
    timeSyncCount: 0,
  }
  room.devices.set(device.id, device)
  room.socketIndex.set(socketId, device.id)
  addPlayerToDevice(room, device, name)
  return device
}

export function addPlayerToDevice(room: Room, device: Device, name: string): Player {
  const player: Player = { id: randomUUID(), name, deviceId: device.id }
  room.players.set(player.id, player)
  device.playerIds.push(player.id)
  return player
}

export function removePlayerFromDevice(room: Room, playerId: string): Player | undefined {
  const player = room.players.get(playerId)
  if (!player) return undefined
  const device = room.devices.get(player.deviceId)
  if (device) device.playerIds = device.playerIds.filter(id => id !== playerId)
  room.players.delete(playerId)
  return player
}

export function deviceBySocket(room: Room, socketId: string): Device | undefined {
  const id = room.socketIndex.get(socketId)
  return id ? room.devices.get(id) : undefined
}

/**
 * 参加順（端末の参加順 → 端末内の追加順）。Map は挿入順を保つのでこれで確定する。
 * プレイヤー色(1P〜10P)・台本生成へ渡す names・recordingRoster の3箇所が
 * 同じ順序を使う。順序の定義はこの関数1つに閉じること。
 */
export function orderedPlayers(room: Room): Player[] {
  const out: Player[] = []
  for (const device of room.devices.values()) {
    for (const pid of device.playerIds) {
      const p = room.players.get(pid)
      if (p) out.push(p)
    }
  }
  return out
}

export function playerNames(room: Room): string[] {
  return orderedPlayers(room).map(p => p.name)
}

export function hasPlayerName(room: Room, name: string): boolean {
  for (const p of room.players.values()) {
    if (p.name === name) return true
  }
  return false
}

/** 端末ごと外す。消えた Player を返す（呼び出し側が player_left を人数分流すため）。 */
export function removeDevice(room: Room, deviceId: string): Player[] {
  const device = room.devices.get(deviceId)
  if (!device) return []
  const removed: Player[] = []
  for (const pid of device.playerIds) {
    const p = room.players.get(pid)
    if (p) {
      removed.push(p)
      room.players.delete(pid)
    }
  }
  room.devices.delete(deviceId)
  room.socketIndex.delete(device.socketId)
  room.volumes.delete(deviceId)
  room.returned.delete(deviceId)
  room.audio.delete(deviceId)
  room.uploadExpected.delete(deviceId)
  clearGraceTimer(room, deviceId)
  return removed
}

function clearGraceTimer(room: Room, deviceId: string): void {
  const timer = room.graceTimers.get(deviceId)
  if (timer) {
    clearTimeout(timer)
    room.graceTimers.delete(deviceId)
  }
}

function clearRoomTimers(room: Room): void {
  if (room.uploadTimer) {
    clearTimeout(room.uploadTimer)
    room.uploadTimer = null
  }
  if (room.recordingTimer) {
    clearTimeout(room.recordingTimer)
    room.recordingTimer = null
  }
  // graceTimers はここでは触らない。resetRoom（中断/room_reset/評価失敗）から呼ばれるため、
  // ここで消すと切断中の端末を誰も削除せず「復帰待ち…」のゴーストが永久に残る。
  // 部屋ごと消える delete/cleanup でだけ解除する。
}

function clearAllGraceTimers(room: Room): void {
  for (const timer of room.graceTimers.values()) clearTimeout(timer)
  room.graceTimers.clear()
}

/**
 * 事故切断→再接続で socketId が変わるので索引を張り替える。
 * audio / uploadExpected / volumes / returned は deviceId キーなので触らない
 * （ここが socketId キーだった頃の「付け替え」が消えた理由）。
 */
export function reattachDevice(room: Room, device: Device, newSocketId: string): void {
  room.socketIndex.delete(device.socketId)
  device.socketId = newSocketId
  room.socketIndex.set(newSocketId, device.id)
  device.disconnectedAt = null
  clearGraceTimer(room, device.id)
}

/** 進行判定は「いま接続している端末」だけで行う（切断中の端末でゲームを止めない） */
export function activeDevices(room: Room): Device[] {
  return [...room.devices.values()].filter(d => d.disconnectedAt == null)
}

/** 接続中の端末に乗っている人の名前（採点対象の判定に使う） */
export function activePlayerNames(room: Room): string[] {
  const out: string[] = []
  for (const device of activeDevices(room)) {
    for (const pid of device.playerIds) {
      const p = room.players.get(pid)
      if (p) out.push(p.name)
    }
  }
  return out
}

export function touch(room: Room): void {
  room.lastActivityAt = Date.now()
}

export function setReady(room: Room, socketId: string, isReady: boolean): Device | undefined {
  const device = deviceBySocket(room, socketId)
  if (device) device.isReady = isReady
  return device
}

export function allReady(room: Room): boolean {
  const active = activeDevices(room)
  return active.length > 0 && active.every(d => d.isReady)
}

export function allReturned(room: Room): boolean {
  const active = activeDevices(room)
  return active.length > 0 && active.every(d => room.returned.has(d.id))
}

export function toPlayerSnapshot(room: Room, player: Player): PlayerSnapshot {
  const device = room.devices.get(player.deviceId)
  return {
    id: player.id,
    deviceId: player.deviceId,
    name: player.name,
    // ホストバッジは端末の代表プレイヤー（playerIds[0]）にだけ立てる
    isHost: !!device?.isHost && device.playerIds[0] === player.id,
    isReady: !!device?.isReady,
    connected: device?.disconnectedAt == null,
  }
}

export function toSnapshot(room: Room, quota: Quota): RoomSnapshot {
  return {
    code: room.code,
    status: room.status,
    genre: room.genre,
    players: orderedPlayers(room).map(p => toPlayerSnapshot(room, p)),
    script: room.script,
    scores: room.scores,
    bgm: room.bgm,
    // room.aiMode（進行中ゲームの確定値）ではなく毎回その場で計算する。
    // ロビーに出す「いま始めたらAIか」は他の部屋が枠を使えば変わるため。
    aiAvailable: quota.isAiAvailable(new Date()),
    liveAudio: room.liveAudio,
  }
}

export function resetRoom(room: Room): void {
  room.evaluationSeq++ // 進行中の非同期評価を無効化（stale な evaluation_complete を防ぐ）
  room.status = 'waiting'
  room.script = null
  room.scores = []
  room.bgm = null
  room.recordingRoster = []
  room.volumes.clear()
  room.returned.clear()
  room.generatingScript = false
  room.aiMode = true // 次のゲームの start_game で改めて確定する
  room.recordingStartedAt = 0
  room.recordingDurationMs = 0
  room.audioTimeline = []
  room.work = null
  room.workToken = null
  room.audio.clear()
  room.collectingAudio = false
  room.uploadExpected.clear()
  clearRoomTimers(room)
  room.lastVolumeBroadcast = 0
  for (const d of room.devices.values()) {
    d.isReady = false
    d.signalCount = 0 // 次のゲームぶんのシグナル枠を戻す
    d.timeSyncCount = 0 // 次のゲームぶんの時刻同期枠を戻す
  }
  // genre と liveAudio は保持（同じ部屋で再戦するとき毎回付け直させない）
}

export interface RoomStore {
  exists(code: string): boolean
  get(code: string): Room | undefined
  create(hostSocketId: string, name: string): Room
  findBySocket(socketId: string): Room | undefined
  delete(code: string): void
  findByToken(token: string): { room: Room; device: Device } | undefined
  cleanup(now: number, maxIdleMs: number): string[]
}

// サーバーインスタンスごとに独立した Room 集合を持つファクトリ。
// テストは buildServer() の呼び出しごとに新しい store を得るので、
// 状態はテスト間で自然に分離される（グローバルリセット関数が不要）。
export function createRoomStore(): RoomStore {
  const rooms = new Map<string, Room>()

  function exists(code: string): boolean {
    return rooms.has(code)
  }

  function get(code: string): Room | undefined {
    return rooms.get(code)
  }

  function create(hostSocketId: string, name: string): Room {
    const code = generateUniqueRoomCode(exists)
    const now = Date.now()
    const room: Room = {
      code,
      status: 'waiting',
      genre: '',
      script: null,
      scores: [],
      devices: new Map(),
      players: new Map(),
      socketIndex: new Map(),
      hostDeviceId: '',
      createdAt: now,
      lastActivityAt: now,
      bgm: null,
      liveAudio: false,
      volumes: new Map(),
      lastVolumeBroadcast: 0,
      recordingRoster: [],
      returned: new Set(),
      generatingScript: false,
      aiMode: true,
      recordingStartedAt: 0,
      recordingDurationMs: 0,
      audioTimeline: [],
      work: null,
      workToken: null,
      audio: new Map(),
      collectingAudio: false,
      uploadExpected: new Set(),
      uploadTimer: null,
      recordingTimer: null,
      evaluationSeq: 0,
      graceTimers: new Map(),
    }
    const device = addDevice(room, hostSocketId, name, true)
    room.hostDeviceId = device.id
    rooms.set(code, room)
    return room
  }

  function findBySocket(socketId: string): Room | undefined {
    for (const room of rooms.values()) {
      if (room.socketIndex.has(socketId)) return room
    }
    return undefined
  }

  function deleteRoom(code: string): void {
    const room = rooms.get(code)
    if (room) {
      clearRoomTimers(room)
      clearAllGraceTimers(room)
    }
    rooms.delete(code)
  }

  function findByToken(token: string): { room: Room; device: Device } | undefined {
    for (const room of rooms.values()) {
      for (const device of room.devices.values()) {
        if (device.token === token) return { room, device }
      }
    }
    return undefined
  }

  function cleanup(now: number, maxIdleMs: number): string[] {
    const deleted: string[] = []
    for (const [code, room] of rooms) {
      if (room.devices.size === 0 || now - room.lastActivityAt > maxIdleMs) {
        clearRoomTimers(room)
        clearAllGraceTimers(room)
        rooms.delete(code)
        deleted.push(code)
      }
    }
    return deleted
  }

  return { exists, get, create, findBySocket, delete: deleteRoom, findByToken, cleanup }
}
