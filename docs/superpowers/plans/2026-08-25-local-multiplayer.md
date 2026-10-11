# ローカル複数プレイヤー（携帯回し・混在）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1台のスマホに複数のプレイヤーを乗せて遊べるようにし（携帯回し・オンライン混在）、1本の音声に入った複数人を台本照合で採点できるようにする。

**Architecture:** `socketId` が「接続」と「プレイヤー」を兼ねている現状を **Device**（1接続＝1台）と **Player**（役を持つ1人）に分け、`Room` のコレクションのキーを再接続で変わらない `deviceId` に移す。採点は Evaluator の入力を「人ごとの音声」から「音声ソースごと（＋そこに入っている人の名前）」に変え、共有録音があるときだけプロンプトに録音セクションを差し込む。

**Tech Stack:** TypeScript / Node 20 / Express 4 / Socket.io 4 / React 18 / Vite / Tailwind / node:test（`tsx --test`）/ Groq Whisper / Anthropic Claude Haiku 4.5

**Spec:** `docs/superpowers/specs/2026-08-25-local-multiplayer-design.md`

## Global Constraints

- **録音は1発どり**。全員が1台を囲み台本の順に掛け合う。録音を途中で止める機能は作らない
- **モード切り替えを作らない**。ロビーの「＋この端末にプレイヤーを追加」だけで携帯回しと混在の両方を成立させる
- 部屋の人数上限は `MAX_PLAYERS`（10人）。**端末ごとの上限は設けない**。`MIN_PLAYERS`（1）も変更しない
- **`RECORDING_LIMIT_SEC`（150秒）は変更しない**
- **ホスト切断時の即解散は変更しない**（繰り越し課題）
- **全ソースが1人のとき、採点プロンプトは現行とバイト単位で同一**であること（既存のオンラインプレイの採点品質に回帰を持ち込まない）
- プレイヤー色は参加順で固定。値は `#b8352c` `#3a4f7a` `#46603f` `#7d5b16` `#5f4c6b` `#3f6b67` `#6b3f2e` `#2f4550` `#656124` `#241c17`（1P〜10P順）。本文地 `#f0e7d2` に対し最小 4.76:1、パネル地 `#f7f1e3` に対し最小 5.20:1
- **参加順の定義**: 端末の作成・参加順 → その端末内での追加順。1P〜10P の色・台本生成へ渡す `names`・`recordingRoster` の3箇所が同じ順序を使う
- プロンプトの文面は**ソースに直書きせず `prompts/*.md` に置く**（既存の方針）
- Anthropic の構造化出力は integer の `minimum`/`maximum`、string の `maxLength`/`minLength` **すべて非対応**。`SCORE_SCHEMA` にこれらを足さないこと
- **`tsc --noEmit` が実質のゲート**。server は `tsx` 実行のため型チェックが走らない。各タスクの最後に必ず走らせる
- 統合テストは「**先に両方 listen してから emit**」で書くこと（`io.to` は送信者にも配信されるため、逐次 await だと Windows で100%取りこぼす）
- コミットメッセージは日本語。末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## コマンド早見表

```bash
# サーバーのテスト全部
(cd server && npm test)
# サーバーのテスト1ファイル
(cd server && npx tsx --test tests/roomStore.test.ts)
# クライアントのテスト
(cd client && npm test)
# 型チェック（実質のゲート）
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
# 手動確認用の開発サーバー
(cd server && npm run dev)   # :3000
(cd client && npm run dev)   # :5173
```

## File Structure

| ファイル | 責務 | タスク |
|---|---|---|
| `shared/types.ts` | `PlayerSnapshot` に `id` / `deviceId` | 1 |
| `shared/events.ts` | `add_local_player` / `remove_local_player` / `kick_device` / payload の `deviceId` | 1, 2 |
| `server/src/roomStore.ts` | Device / Player の分割、deviceId キー、参加順の唯一の定義 | 1 |
| `server/src/handlers.ts` | 端末単位の進行制御、ローカル追加/削除、採点集計 | 1, 2, 3 |
| `server/src/uploadRoute.ts` | socketId → device 解決 | 1 |
| `server/src/ai/evaluate.ts` | `AudioSource` を受けてソースごとに文字起こし | 3 |
| `server/src/ai/scoreGen.ts` | 共有録音セクションの組み立て、system の連結 | 4 |
| `server/src/ai/prompts.ts` | 新しいテンプレートのアクセサ | 4 |
| `prompts/score-system-shared.md` | 帰属ルールの**追記ぶん**（全文の複製ではない） | 4 |
| `prompts/score-user-shared-header.md` | 録音セクションの見出し文 | 4 |
| `prompts/score-user-shared-source.md` | 録音1本ぶんのテンプレート | 4 |
| `client/src/playerColors.ts` | 1P〜10P の色（純粋関数・テストあり） | 5 |
| `client/src/localPlayers.ts` | 「この端末の人」の導出（純粋関数・テストあり） | 6 |
| `client/src/useGameSocket.ts` | `deviceId` の保持、新アクション | 6 |
| `client/src/App.tsx` | `GameContext.deviceId` | 6 |
| `client/src/screens/LobbyScreen.tsx` | 端末グループ表示・追加/削除UI | 7 |
| `client/src/screens/CastingScreen.tsx` | この端末の配役を人数分 | 8 |
| `client/src/screens/PrepareScreen.tsx` | 台本の色分け・名前バッジ・準備完了の文言 | 8 |
| `client/src/screens/RecordingScreen.tsx` | 台本の色分け・名前バッジ | 8 |
| `client/src/screens/ResultScreen.tsx` | 共有ボタンの分岐・㊞の色 | 9 |
| `doc/仕様書.md` ほか | 仕様書の更新 | 10 |

## 仕様からの追加判断（実装中に決めたこと）

設計書には `score-system-shared.md` の1本しか書いていないが、「文面は `prompts/*.md` に置く」という既存方針に従うと、ユーザープロンプト側の録音セクションの文面も同様に外出しすべきである。よって **`score-user-shared-header.md` と `score-user-shared-source.md` の2本を追加**し、計3本を `REQUIRED_FILES` に入れる。設計書の意図に反する変更ではなく、その方針の適用漏れを埋めるもの。

---

## Task 1: Device / Player の分割（挙動は変えない）

`socketId` キーを `deviceId` キーへ移す機械的な改造。**この時点では1端末＝1人のまま**で、外から見た挙動は現行と同一。既存の31本のテストが安全網になる。

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/events.ts`
- Modify: `server/src/roomStore.ts`（ほぼ全面書き換え）
- Modify: `server/src/handlers.ts`
- Modify: `server/src/uploadRoute.ts`
- Modify: `client/src/useGameSocket.ts`（型を通すための最小追随）
- Test: `server/tests/roomStore.test.ts`
- Test: `server/tests/testUtils.ts` ほか既存テスト（イベント名・payload の追随）

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `Device { id, socketId, token, isHost, isReady, disconnectedAt, playerIds }`
  - `Player { id, name, deviceId }`
  - `addDevice(room, socketId, name, isHost): Device`
  - `addPlayerToDevice(room, device, name): Player`
  - `removePlayerFromDevice(room, playerId): Player | undefined`
  - `removeDevice(room, deviceId): Player[]`（消えた Player を返す）
  - `deviceBySocket(room, socketId): Device | undefined`
  - `orderedPlayers(room): Player[]` / `playerNames(room): string[]`（参加順の唯一の定義）
  - `reattachDevice(room, device, newSocketId): void`
  - `toPlayerSnapshot(room, player): PlayerSnapshot`
  - `setReady(room, socketId, isReady): Device | undefined`
  - `RoomStore.findByToken(token): { room, device } | undefined`
  - イベント `kick_device: { deviceId }`、`rejoined` の `selfPlayerNames: string[]` と `deviceId`

- [ ] **Step 1: `reattachDevice` が再キーしないことを固定する失敗テストを書く**

`server/tests/roomStore.test.ts` の末尾に追記する。

```ts
import { createRoomStore, reattachDevice, deviceBySocket } from '../src/roomStore'

test('reattachDevice は audio / uploadExpected / volumes / returned を再キーしない', () => {
  const rooms = createRoomStore()
  const room = rooms.create('sock-1', 'たろう')
  const device = deviceBySocket(room, 'sock-1')!

  // 収集ウィンドウ中を模した状態を作る
  room.audio.set(device.id, { buffer: Buffer.from('a'), mime: 'audio/webm' })
  room.uploadExpected.add(device.id)
  room.volumes.set(device.id, { level: 0.5, ts: 123 })
  room.returned.add(device.id)

  reattachDevice(room, device, 'sock-2')

  // socketId だけが動く
  assert.equal(device.socketId, 'sock-2')
  assert.equal(deviceBySocket(room, 'sock-2')?.id, device.id)
  assert.equal(deviceBySocket(room, 'sock-1'), undefined)
  assert.equal(device.disconnectedAt, null)

  // deviceId キーのコレクションは一切動かない
  assert.equal(room.audio.get(device.id)?.mime, 'audio/webm')
  assert.equal(room.audio.size, 1)
  assert.ok(room.uploadExpected.has(device.id))
  assert.equal(room.volumes.get(device.id)?.level, 0.5)
  assert.ok(room.returned.has(device.id))
})

test('orderedPlayers は端末の参加順 → 端末内の追加順を返す', () => {
  const rooms = createRoomStore()
  const room = rooms.create('sock-1', 'たろう')
  const d1 = deviceBySocket(room, 'sock-1')!
  addPlayerToDevice(room, d1, 'じろう')
  const d2 = addDevice(room, 'sock-2', 'はなこ', false)
  addPlayerToDevice(room, d2, 'さぶろう')
  assert.deepEqual(playerNames(room), ['たろう', 'じろう', 'はなこ', 'さぶろう'])
})
```

import 行に `addDevice, addPlayerToDevice, playerNames` を足すこと。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd server && npx tsx --test tests/roomStore.test.ts)`
Expected: FAIL（`reattachDevice` / `deviceBySocket` / `addDevice` が export されていない）

- [ ] **Step 3: `shared/types.ts` の `PlayerSnapshot` を広げる**

```ts
export interface PlayerSnapshot {
  id: string          // プレイヤーの安定ID
  deviceId: string    // 同じ値の人が同じ端末にいる（グルーピング用。資格情報ではない）
  name: string
  isHost: boolean     // 端末の代表プレイヤー（playerIds[0]）にだけ立つ
  isReady: boolean    // 端末の値をそのまま配る
  connected: boolean  // 端末の接続状態
}
```

- [ ] **Step 4: `server/src/roomStore.ts` を書き換える**

全面を以下で置き換える。

```ts
import { randomUUID } from 'node:crypto'
import type { RoomStatus, RoomSnapshot, PlayerSnapshot, ScriptData, PlayerScore } from '@shared/types'
import { generateUniqueRoomCode } from './roomCode'
import type { Quota } from './quota'

/** 1つのブラウザ接続（＝1台のスマホ）。音声・切断・準備完了はすべてこの単位。 */
export interface Device {
  id: string                     // 安定ID。再接続しても変わらない＝各コレクションのキー
  socketId: string               // 接続のたびに変わる。socketIndex で逆引きする
  token: string                  // 再接続クレデンシャル（端末ごとに1つ）
  isHost: boolean
  isReady: boolean
  disconnectedAt: number | null   // 事故切断の猶予中は切断時刻、在室中は null
  playerIds: string[]            // この端末に乗っている人（追加順。[0] が代表）
}

/** 役を持つ1人。端末に属する。 */
export interface Player {
  id: string
  name: string
  deviceId: string
}

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
  volumes: Map<string, { level: number; ts: number }>      // deviceId
  lastVolumeBroadcast: number
  recordingRoster: string[]
  returned: Set<string>                                     // deviceId
  generatingScript: boolean
  aiMode: boolean
  audio: Map<string, { buffer: Buffer; mime: string }>      // deviceId ＝ 端末ごとに音声1本
  collectingAudio: boolean
  uploadExpected: Set<string>                               // deviceId
  uploadTimer: ReturnType<typeof setTimeout> | null
  recordingTimer: ReturnType<typeof setTimeout> | null
  evaluationSeq: number
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

export function clearGraceTimerFor(room: Room, deviceId: string): void {
  clearGraceTimer(room, deviceId)
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
  room.audio.clear()
  room.collectingAudio = false
  room.uploadExpected.clear()
  clearRoomTimers(room)
  room.lastVolumeBroadcast = 0
  for (const d of room.devices.values()) d.isReady = false
  // genre は保持（同じ部屋で再戦）
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
      volumes: new Map(),
      lastVolumeBroadcast: 0,
      recordingRoster: [],
      returned: new Set(),
      generatingScript: false,
      aiMode: true,
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
```

- [ ] **Step 5: `shared/events.ts` を更新する**

```ts
// ClientToServerEvents の kick_player を置き換える
kick_device: (payload: { deviceId: string }) => void
```

```ts
// ServerToClientEvents の3つの payload に deviceId を足し、rejoined を変える
room_created: (payload: { roomCode: string; room: RoomSnapshot; token: string; deviceId: string }) => void
room_joined: (payload: { room: RoomSnapshot; token: string; deviceId: string }) => void
rejoined: (payload: {
  room: RoomSnapshot
  status: RoomStatus
  deviceId: string
  selfPlayerNames: string[]   // この端末に乗っている人（selfName の複数形）
}) => void
```

- [ ] **Step 6: `server/src/handlers.ts` を更新する**

import を差し替える。

```ts
import {
  addDevice, addPlayerToDevice, hasPlayerName, toSnapshot, toPlayerSnapshot, touch,
  removeDevice, setReady, allReady, resetRoom, allReturned,
  reattachDevice, deviceBySocket, orderedPlayers, playerNames,
  activeDevices, activePlayerNames,
} from './roomStore'
import type { Room, RoomStore, Device } from './roomStore'
```

ホスト判定のヘルパーを `createHandlers` の内側、`finalizeEvaluation` の前に置く。

```ts
  // ホスト判定は「この接続の端末が部屋のホスト端末か」。socketId 直比較はもう使えない。
  function isHostSocket(room: Room, socketId: string): boolean {
    return deviceBySocket(room, socketId)?.id === room.hostDeviceId
  }

  // 端末に乗っている人の名前（参加順）
  function namesOf(room: Room, device: Device): string[] {
    return device.playerIds.map(pid => room.players.get(pid)?.name).filter((n): n is string => !!n)
  }

  // 端末の代表プレイヤー名（リアクション/BGM/SEの送信者表示に使う）
  function representativeName(room: Room, device: Device): string | undefined {
    const first = device.playerIds[0]
    return first ? room.players.get(first)?.name : undefined
  }
```

`finalizeEvaluation` の集計部分を書き換える（`sources` 化は Task 3。ここでは名前解決だけ端末経由にする）。

```ts
    const present = activePlayerNames(room)
    const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
    const performers = room.recordingRoster.filter(n => present.includes(n))
    const script = room.script
    const audioByName = new Map<string, { buffer: Buffer; mime: string }>()
    for (const [deviceId, a] of room.audio) {
      const device = room.devices.get(deviceId)
      if (!device) continue
      // Task 1 時点では1端末＝1人。Task 3 で AudioSource に置き換える。
      const name = representativeName(room, device)
      if (name) audioByName.set(name, a)
    }
```

`removeNonHostAndNotify` を端末単位にする。

```ts
  // 非ホスト端末をルームから外し、退出を全員へ通知して収集/復帰のデッドロックを解消する。
  // leave_room（即時）と猶予満了の両方から呼ぶ唯一の経路。
  function removeDeviceAndNotify(io: IO, room: Room, deviceId: string): void {
    const removed = removeDevice(room, deviceId)
    if (removed.length === 0) return
    for (const player of removed) {
      io.to(room.code).emit('player_left', { playerName: player.name })
    }
    if (room.devices.size === 0) {
      rooms.delete(room.code)
      return
    }
    touch(room)
    if (room.collectingAudio && room.uploadExpected.size === 0) {
      void finalizeEvaluation(io, room)
    }
    if (room.status === 'evaluating' && allReturned(room)) {
      resetRoom(room)
      io.to(room.code).emit('room_reset', { room: toSnapshot(room, quota) })
    }
  }
```

`beginAudioCollection` の期待集合を端末に。

```ts
    // 切断中の端末は録音していない＝待っても永久に来ないので期待に入れない
    room.uploadExpected = new Set(activeDevices(room).map(d => d.id))
```

各ハンドラを書き換える。

```ts
    socket.on('create_room', ({ playerName }) => {
      // …（publicEnabled / レート制限 / 名前検証は現行のまま）…
      const room = rooms.create(socket.id, name)
      socket.join(room.code)
      const device = deviceBySocket(room, socket.id)!
      socket.emit('room_created', {
        roomCode: room.code, room: toSnapshot(room, quota), token: device.token, deviceId: device.id,
      })
    })

    socket.on('join_room', ({ roomCode, playerName }) => {
      // …（コード検証 / status / generatingScript / collectingAudio のガードは現行のまま）…
      if (room.players.size >= MAX_PLAYERS) {
        socket.emit('error', { message: '満員です' })
        return
      }
      // …（名前検証 / hasPlayerName は現行のまま）…
      const device = addDevice(room, socket.id, name, false)
      const player = room.players.get(device.playerIds[0]!)!
      if (room.status === 'evaluating') room.returned.add(device.id)
      touch(room)
      socket.join(room.code)
      socket.emit('room_joined', {
        room: toSnapshot(room, quota), token: device.token, deviceId: device.id,
      })
      socket.to(room.code).emit('player_joined', { player: toPlayerSnapshot(room, player) })
    })

    socket.on('set_genre', ({ genre }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      // …以降は現行のまま…
    })

    socket.on('start_game', async () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id) || room.status !== 'waiting') return
      // …
      const names = playerNames(room)   // 参加順。roomStore が唯一の定義
      // …以降は現行のまま（room.players.size < MIN_PLAYERS の判定もそのまま）…
    })

    socket.on('set_ready', ({ isReady }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = setReady(room, socket.id, !!isReady)
      if (!device) return
      touch(room)
      // 端末に乗っている人数分流す。クライアントの readyMap は名前キーなので、
      // 1件だけだと3人乗った端末の残り2人が「未準備」のまま見える。
      const ready = allReady(room)
      for (const playerName of namesOf(room, device)) {
        io.to(room.code).emit('ready_updated', { playerName, isReady: device.isReady, allReady: ready })
      }
    })

    socket.on('start_recording', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (room.status !== 'casting') return
      const code = room.code
      room.status = 'recording'
      room.recordingRoster = playerNames(room)
      // …以降は現行のまま…
    })

    // send_reaction / send_sfx / send_bgm は playerName の取り方だけ変える
    socket.on('send_reaction', ({ emoji }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'recording') return
      if (!isValidEmoji(emoji)) return
      const device = deviceBySocket(room, socket.id)
      const playerName = device && representativeName(room, device)
      if (!playerName) return
      socket.to(room.code).emit('reaction_received', { emoji, playerName })
    })
    // send_sfx / send_bgm も同じ差し替え（bgm は room.bgm = bgmId を維持）

    socket.on('send_volume', ({ level }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'recording') return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      const now = Date.now()
      room.volumes.set(device.id, { level, ts: now })
      // …以降は現行のまま…
    })

    socket.on('stop_recording', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id) || room.status !== 'recording') return
      beginAudioCollection(io, room)
    })

    socket.on('return_to_lobby', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'evaluating') return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      room.returned.add(device.id)
      touch(room)
      // 端末単位で処理するが通知は人数分（クライアントの「n/m 人」表示を嘘にしない）
      for (const playerName of namesOf(room, device)) {
        io.to(room.code).emit('player_returned', { playerName })
      }
      if (allReturned(room)) {
        resetRoom(room)
        io.to(room.code).emit('room_reset', { room: toSnapshot(room, quota) })
      }
    })

    socket.on('rejoin', ({ token }) => {
      const found = rooms.findByToken(token ?? '')
      if (!found) {
        socket.emit('rejoin_failed', { message: 'ルームに戻れませんでした' })
        return
      }
      const { room, device } = found
      const selfPlayerNames = namesOf(room, device)
      if (device.socketId === socket.id) {
        // 同一ソケットからの再送。張り替えると自分の returned/audio/uploadExpected を
        // 消しかねないので reattachDevice は呼ばず、現状のスナップショットだけ返す。
        socket.emit('rejoined', {
          room: toSnapshot(room, quota), status: room.status, deviceId: device.id, selfPlayerNames,
        })
        return
      }
      const otherRoom = rooms.findBySocket(socket.id)
      if (otherRoom && otherRoom !== room) return // 既に別ルームに所属＝二重登録になるので無視
      const wasDisconnected = device.disconnectedAt != null // reattach が null に戻す前に控える
      reattachDevice(room, device, socket.id)
      touch(room)
      socket.join(room.code)
      socket.emit('rejoined', {
        room: toSnapshot(room, quota), status: room.status, deviceId: device.id, selfPlayerNames,
      })
      if (wasDisconnected) {
        for (const playerName of selfPlayerNames) {
          socket.to(room.code).emit('player_reconnected', { playerName })
        }
      }
    })

    socket.on('leave_room', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      if (device.isHost) {
        socket.to(room.code).emit('room_dissolved')
        rooms.delete(room.code)
        return
      }
      socket.leave(room.code) // 自分の退出通知を自分で受けない
      removeDeviceAndNotify(io, room, device.id)
    })

    // 切断中の端末をホストが今すぐ外す。中の全員が抜ける。
    socket.on('kick_device', ({ deviceId }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (room.status !== 'waiting' && room.status !== 'evaluating') return
      const target = room.devices.get(deviceId)
      if (!target || target.isHost) return
      // 接続中は対象外。復帰済みならホストの画面が古いだけなので黙って無視する。
      if (target.disconnectedAt == null) return
      removeDeviceAndNotify(io, room, target.id)
    })

    socket.on('abort_game', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      // …以降は現行のまま…
    })

    socket.on('disconnect', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return // leave_room 済み（意図的退出）はここに来ない
      if (device.isHost) {
        // ホストは対象外＝従来どおり即解散（ホスト移譲は繰り越し課題）
        socket.to(room.code).emit('room_dissolved')
        rooms.delete(room.code)
        return
      }
      device.disconnectedAt = Date.now()
      for (const playerName of namesOf(room, device)) {
        socket.to(room.code).emit('player_disconnected', { playerName })
      }
      room.uploadExpected.delete(device.id) // 切断者は録音を送れない＝期待から外す
      touch(room)
      if (room.collectingAudio && room.uploadExpected.size === 0) {
        void finalizeEvaluation(io, room)
      }
      if (room.status === 'evaluating' && allReturned(room)) {
        resetRoom(room)
        io.to(room.code).emit('room_reset', { room: toSnapshot(room, quota) })
      }
      const code = room.code
      const deviceId = device.id
      const timer = setTimeout(() => {
        if (rooms.get(code) !== room) return // 解散済み
        const d = room.devices.get(deviceId)
        if (!d || d.disconnectedAt == null) return // 復帰済み or 既に削除済み
        removeDeviceAndNotify(io, room, deviceId)
      }, limits.graceMs)
      timer.unref()
      room.graceTimers.set(deviceId, timer)
    })
```

- [ ] **Step 7: `server/src/uploadRoute.ts` を更新する**

`socketId` から端末を解決してから触る。

```ts
import { touch, deviceBySocket } from './roomStore'
```

```ts
        const room = rooms.findBySocket(socketId)
        const device = room ? deviceBySocket(room, socketId) : undefined
        if (!room || !device || !room.collectingAudio || !room.uploadExpected.has(device.id)) {
          res.status(409).json({ ok: false })
          return
        }
        const file = req.file
        if (file && file.buffer.length > 0) {
          room.audio.set(device.id, { buffer: file.buffer, mime: file.mimetype })
          const name = room.players.get(device.playerIds[0] ?? '')?.name ?? socketId
          console.log(`[server] audio received: ${name} ${file.buffer.length} bytes ${file.mimetype}`)
        }
        room.uploadExpected.delete(device.id)
```

`MulterError` のフォールバック側も同じ解決に揃えること（`room.uploadExpected.delete(socketId)` を `device.id` に）。

- [ ] **Step 8: `client/src/useGameSocket.ts` を型が通る最小限だけ直す**

```ts
    function onRejoined(
      { room, status, selfPlayerNames }:
        { room: RoomSnapshot; status: RoomStatus; deviceId: string; selfPlayerNames: string[] },
    ) {
      setDisconnected(false)
      const selfName = selfPlayerNames[0] ?? ''
      const me = room.players.find(p => p.name === selfName)
      // …以降は現行のまま（playerName: selfName）…
    }
```

```ts
    kickPlayer(playerName) { … }   // ↓ に置き換える
    kickDevice(deviceId: string) {
      socket.emit('kick_device', { deviceId })
    },
```

`GameActions` の `kickPlayer` を `kickDevice: (deviceId: string) => void` に変え、`LobbyScreen.tsx` の呼び出しを暫定で `actions.kickDevice(p.deviceId)` にする（本格的なグループ表示は Task 7）。

- [ ] **Step 9: 既存テストをイベント名・payload に追随させる**

`server/tests/testUtils.ts` の `makeRoom` は `room_created` / `room_joined` から `deviceId` も返すようにする。

```ts
export async function makeRoom(port: number): Promise<{
  host: Socket; guest: Socket; roomCode: string
  hostToken: string; guestToken: string
  hostDeviceId: string; guestDeviceId: string
}> {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const hc = await once<{ roomCode: string; token: string; deviceId: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode: hc.roomCode, playerName: 'はなこ' })
  const gj = await once<{ token: string; deviceId: string }>(guest, 'room_joined')
  await once(host, 'player_joined')
  return {
    host, guest, roomCode: hc.roomCode,
    hostToken: hc.token, guestToken: gj.token,
    hostDeviceId: hc.deviceId, guestDeviceId: gj.deviceId,
  }
}
```

`server/tests/handlers.kick.test.ts` は `kick_player` → `kick_device` に置き換える。名前ではなく deviceId を渡す形になる。

```ts
test('ホストは切断中の端末をキックできる', async () => {
  const { host, guest, roomCode, guestDeviceId } = await makeRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const left = once<{ playerName: string }>(host, 'player_left')
  host.emit('kick_device', { deviceId: guestDeviceId })
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(server.rooms.get(roomCode)?.players.size, 1)
  assert.equal(server.rooms.get(roomCode)?.devices.size, 1)
  host.disconnect()
})

test('存在しない deviceId の kick_device は無視される', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  host.emit('kick_device', { deviceId: 'no-such-device' })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  host.disconnect()
})
```

他のテストは `room.players.get(socketId)` のような直接アクセスがあれば `deviceBySocket` 経由に、`players.size` の期待値はそのまま（1端末1人なので変わらない）。`handlers.reconnect.test.ts` の `rejoined` 受信は `selfPlayerNames[0]` を見るように直す。

- [ ] **Step 10: 全テストと型チェックを走らせる**

Run:
```bash
(cd server && npm test)
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
```
Expected: すべて PASS / エラーなし。**挙動を変えていないので、既存テストは1本も落ちてはいけない**。落ちたものがあれば、それは追随漏れではなく挙動が変わった証拠なので原因を潰すこと。

- [ ] **Step 11: コミット**

```bash
git add shared server client
git commit -m "$(cat <<'MSG'
refactor: socketId キーを deviceId キーへ移し Device/Player を分ける

1接続=1人という前提を Device(1台) と Player(1人) に分離する。
audio/uploadExpected/volumes/returned/graceTimers は意味的に
元から端末ごとだったので、キーを安定した deviceId にした。
これで再接続時の5種類の付け替えが不要になる。

この時点では1端末=1人のままで挙動は変えていない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 2: ローカルプレイヤーの追加・削除（サーバー）

**Files:**
- Modify: `shared/events.ts`
- Modify: `server/src/handlers.ts`
- Test: `server/tests/handlers.localPlayer.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の `addPlayerToDevice` / `removePlayerFromDevice` / `deviceBySocket` / `toPlayerSnapshot` / `hasPlayerName`
- Produces: イベント `add_local_player: { playerName }` / `remove_local_player: { playerId }`

- [ ] **Step 1: 失敗する統合テストを書く**

`server/tests/handlers.localPlayer.test.ts` を新規作成する。

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRoom, makeCastingRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => { server = await startTestServer() })
afterEach(async () => { await server.close() })

test('ホストは自分の端末にプレイヤーを追加できる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const joined = once<{ player: { name: string; deviceId: string; isHost: boolean } }>(guest, 'player_joined')
  host.emit('add_local_player', { playerName: 'じろう' })
  const { player } = await joined
  assert.equal(player.name, 'じろう')
  assert.equal(player.isHost, false) // 代表ではないのでホストバッジは付かない
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 3)
  assert.equal(room.devices.size, 2) // 端末は増えない
  host.disconnect(); guest.disconnect()
})

test('ゲストの端末にも追加できる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const joined = once(host, 'player_joined')
  guest.emit('add_local_player', { playerName: 'じろう' })
  await joined
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 3)
  assert.equal(room.devices.size, 2)
  host.disconnect(); guest.disconnect()
})

test('重複した名前は拒否される', async () => {
  const { host, guest } = await makeRoom(server.port)
  const err = once<{ message: string }>(host, 'error')
  host.emit('add_local_player', { playerName: 'はなこ' })
  assert.match((await err).message, /使われています/)
  host.disconnect(); guest.disconnect()
})

test('長すぎる名前は拒否される', async () => {
  const { host, guest } = await makeRoom(server.port)
  const err = once<{ message: string }>(host, 'error')
  host.emit('add_local_player', { playerName: 'あいうえおかきくけこさ' }) // 11文字
  assert.match((await err).message, /名前は/)
  host.disconnect(); guest.disconnect()
})

test('満員（10人）では追加できない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  for (let i = 0; i < 8; i++) {
    const joined = once(guest, 'player_joined')
    host.emit('add_local_player', { playerName: `ひと${i}` })
    await joined
  }
  assert.equal(server.rooms.get(roomCode)!.players.size, 10)
  const err = once<{ message: string }>(host, 'error')
  host.emit('add_local_player', { playerName: 'あふれ' })
  assert.match((await err).message, /満員/)
  host.disconnect(); guest.disconnect()
})

test('ゲーム進行中（casting）は追加できない', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  host.emit('add_local_player', { playerName: 'じろう' })
  await expectNoEvent(guest, 'player_joined', 300)
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('追加したプレイヤーを削除できる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const joined = once<{ player: { id: string } }>(guest, 'player_joined')
  host.emit('add_local_player', { playerName: 'じろう' })
  const playerId = (await joined).player.id
  const left = once<{ playerName: string }>(guest, 'player_left')
  host.emit('remove_local_player', { playerId })
  assert.equal((await left).playerName, 'じろう')
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('代表プレイヤーは remove_local_player で消せない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const room = server.rooms.get(roomCode)!
  const hostDevice = [...room.devices.values()].find(d => d.isHost)!
  host.emit('remove_local_player', { playerId: hostDevice.playerIds[0]! })
  await expectNoEvent(guest, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('他端末のプレイヤーは削除できない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const room = server.rooms.get(roomCode)!
  const guestDevice = [...room.devices.values()].find(d => !d.isHost)!
  host.emit('remove_local_player', { playerId: guestDevice.playerIds[0]! })
  await expectNoEvent(guest, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd server && npx tsx --test tests/handlers.localPlayer.test.ts)`
Expected: FAIL（`add_local_player` を誰も受けないので、すべて timeout / 人数が増えない）

- [ ] **Step 3: `shared/events.ts` にイベントを足す**

```ts
  // ClientToServerEvents に追加
  add_local_player: (payload: { playerName: string }) => void
  remove_local_player: (payload: { playerId: string }) => void
```

- [ ] **Step 4: `server/src/handlers.ts` にハンドラを実装する**

`join_room` の直後に置く。ガードは `join_room` と同じ3つ（status / generatingScript / collectingAudio）を通す。

```ts
    // この端末にもう1人乗せる（携帯回し・混在の入口）。
    // ガードは join_room と揃える：新しい人が部屋に増えるという点で同じ操作だから。
    socket.on('add_local_player', ({ playerName }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      if (room.status !== 'waiting' && room.status !== 'evaluating') {
        socket.emit('error', { message: 'ゲーム進行中は追加できません' })
        return
      }
      if (room.generatingScript || room.collectingAudio) {
        socket.emit('error', { message: 'ゲーム進行中は追加できません' })
        return
      }
      if (room.players.size >= MAX_PLAYERS) {
        socket.emit('error', { message: '満員です' })
        return
      }
      const name = sanitizeName(playerName ?? '')
      if (!isValidName(name)) {
        socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
        return
      }
      if (hasPlayerName(room, name)) {
        socket.emit('error', { message: 'その名前は使われています' })
        return
      }
      const player = addPlayerToDevice(room, device, name)
      touch(room)
      // 自分にも配る（自端末の一覧にも即座に出す）。join_room と違い
      // 追加した本人が「増えた」ことを知る必要があるため socket.to ではなく io.to。
      io.to(room.code).emit('player_joined', { player: toPlayerSnapshot(room, player) })
    })

    // この端末から1人降ろす。代表プレイヤー（playerIds[0]）は対象外＝
    // 端末ごと抜けるのは leave_room の仕事。
    socket.on('remove_local_player', ({ playerId }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      if (room.status !== 'waiting' && room.status !== 'evaluating') return
      if (room.generatingScript || room.collectingAudio) return
      const player = room.players.get(playerId)
      if (!player || player.deviceId !== device.id) return // 他端末の人は消せない
      if (device.playerIds[0] === playerId) return          // 代表は消せない
      const removed = removePlayerFromDevice(room, playerId)
      if (!removed) return
      touch(room)
      io.to(room.code).emit('player_left', { playerName: removed.name })
    })
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `(cd server && npx tsx --test tests/handlers.localPlayer.test.ts)`
Expected: PASS（9本すべて）

- [ ] **Step 6: 回帰がないことを確認する**

Run:
```bash
(cd server && npm test)
(cd server && npx tsc --noEmit)
```
Expected: すべて PASS

- [ ] **Step 7: コミット**

```bash
git add shared/events.ts server/src/handlers.ts server/tests/handlers.localPlayer.test.ts
git commit -m "$(cat <<'MSG'
feat: 端末にローカルプレイヤーを追加・削除できるようにする

add_local_player / remove_local_player を追加。ガードは join_room と
同じ3つ(status/generatingScript/collectingAudio)を通す。部屋が新しい
人を受け入れられる条件は、追加元が端末でも同じだから。

代表プレイヤー(playerIds[0])は remove では消せない。端末ごと抜ける
のは leave_room の仕事なので、経路を分けておく。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 3: Evaluator を AudioSource 化（挙動は変えない）

「人ごとの音声」から「音声ソースごと（＋そこに入っている人）」へ入力を変える。**この時点でも全ソース1人なので出力は現行と同一**。

**Files:**
- Modify: `server/src/ai/evaluate.ts`
- Modify: `server/src/ai/scoreGen.ts`（`ScoreGenerator` の型のみ）
- Modify: `server/src/ai/index.ts`（型の再輸出があれば）
- Modify: `server/src/handlers.ts`（`finalizeEvaluation`）
- Test: `server/tests/ai/evaluate.test.ts`
- Test: `server/tests/handlers.evaluation.test.ts`

**Interfaces:**
- Consumes: Task 1 の `activeDevices` / `activePlayerNames`
- Produces:
  - `AudioSource { players: string[]; audio: { buffer: Buffer; mime: string } | null }`
  - `TranscribedSource { players: string[]; text: string }`
  - `Evaluator = (script, performers: string[], sources: AudioSource[]) => Promise<PlayerScore[]>`
  - `ScoreGenerator = (script, sources: TranscribedSource[]) => Promise<PlayerScore[]>`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/ai/evaluate.test.ts` に追記する。

```ts
test('createEvaluator は1本の音声を1回だけ文字起こしし、乗っている全員を渡す', async () => {
  process.env.GROQ_API_KEY = 'x'
  process.env.ANTHROPIC_API_KEY = 'x'
  let transcribeCalls = 0
  let received: { players: string[]; text: string }[] = []
  const evaluate = createEvaluator({
    transcribe: async () => { transcribeCalls++; return 'もう黙ってらんない それは' },
    generateScores: async (_script, sources) => {
      received = sources
      return sources.flatMap(s => s.players).map(name => ({
        playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: '', title: '',
      }))
    },
  })
  const scores = await evaluate(SCRIPT, ['たろう', 'はなこ'], [
    { players: ['たろう', 'はなこ'], audio: { buffer: Buffer.from('a'), mime: 'audio/webm' } },
  ])
  assert.equal(transcribeCalls, 1) // 人数(2)ではなく音声の本数(1)
  assert.deepEqual(received, [{ players: ['たろう', 'はなこ'], text: 'もう黙ってらんない それは' }])
  assert.equal(scores.length, 2)
})

test('audio が null のソースは文字起こしせず空文字で渡す', async () => {
  process.env.GROQ_API_KEY = 'x'
  process.env.ANTHROPIC_API_KEY = 'x'
  let transcribeCalls = 0
  let received: { players: string[]; text: string }[] = []
  const evaluate = createEvaluator({
    transcribe: async () => { transcribeCalls++; return 'x' },
    generateScores: async (_s, sources) => {
      received = sources
      return []
    },
  })
  await evaluate(SCRIPT, ['たろう'], [{ players: ['たろう'], audio: null }])
  assert.equal(transcribeCalls, 0)
  assert.deepEqual(received, [{ players: ['たろう'], text: '' }])
})
```

`SCRIPT` はこのファイルの既存の定義を使う（無ければ `scoreGen.test.ts` と同じものをこのファイルにも置く）。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd server && npx tsx --test tests/ai/evaluate.test.ts)`
Expected: FAIL（`evaluate` の3番目の引数が `Map` を期待しているため型・実行ともに合わない）

- [ ] **Step 3: `server/src/ai/evaluate.ts` を書き換える**

```ts
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
```

- [ ] **Step 4: `server/src/ai/scoreGen.ts` の型を合わせる**

```ts
/** 文字起こし済みの1本。players が2人以上なら共有録音。 */
export interface TranscribedSource {
  players: string[]
  text: string
}

export type ScoreGenerator = (
  script: ScriptData,
  sources: TranscribedSource[],
) => Promise<PlayerScore[]>
```

`buildScorePrompt` と `createScoreGenerator` の引数名 `transcripts` を `sources` に変え、中身は**この段階では**次のように「1人ソースだけを従来どおり扱う」形にする（共有録音の分岐は Task 4）。

```ts
export function buildScorePrompt(
  prompts: Prompts,
  script: ScriptData,
  sources: TranscribedSource[],
): string {
  const header = renderTemplate(prompts.scoreUserHeader(), { worldSetting: script.worldSetting })
  const template = prompts.scoreUserPlayer()
  const blocks = sources.flatMap(s =>
    s.players.map(name => {
      const role = script.roles.find(r => r.player === name)
      const scripted = script.entries
        .filter(e => e.player === name)
        .map(e => e.line)
        .join(' / ')
      return renderTemplate(template, {
        playerName: name,
        role: role?.role ?? '不明',
        roleDescription: role?.description ?? '',
        scriptedLines: scripted || '（なし）',
        actualSpeech: s.text || '（無音）',
      })
    }),
  )
  return [header, '', ...blocks].join('\n')
}
```

`createScoreGenerator` 内の `selectScoreSystem(prompts, transcripts.length)` は `sources.flatMap(s => s.players).length` に、`parseScores(block.text, transcripts.map(t => t.playerName))` は `parseScores(block.text, sources.flatMap(s => s.players))` にする。

- [ ] **Step 5: `server/src/handlers.ts` の `finalizeEvaluation` を書き換える**

Task 1 で暫定的に入れた `audioByName` の組み立てを、`sources` に置き換える。

```ts
    const active = activeDevices(room)
    const present = activePlayerNames(room)
    const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
    const performers = room.recordingRoster.filter(n => present.includes(n))
    const script = room.script
    // 音声ソース＝接続中の端末。その端末に乗っていて、かつ今回の採点対象の人だけを載せる。
    const sources: AudioSource[] = active
      .map(d => ({
        players: namesOf(room, d).filter(n => performers.includes(n)),
        audio: room.audio.get(d.id) ?? null,
      }))
      .filter(s => s.players.length > 0)
```

import に `import type { AudioSource } from './ai/evaluate'` を足す。

- [ ] **Step 6: `server/tests/handlers.evaluation.test.ts` に1端末3人のケースを足す**

このファイルの既存のパターン（`ai.evaluate` を差し替えて呼び出し引数を検査する形）に合わせて追記する。既存テストが `startTestServer({ ai: … })` でどう注入しているかを読んでから、同じ形で書くこと。

```ts
test('1端末に3人乗っていると uploadExpected は1件、sources は3人1本になる', async () => {
  let seen: { players: string[] }[] = []
  await server.close()
  server = await startTestServer({
    ai: {
      evaluate: async (_script, performers, sources) => {
        seen = sources
        return performers.map(name => ({
          playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: '', title: '',
        }))
      },
    },
  })
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  for (const name of ['はなこ', 'じろう']) {
    const joined = once(host, 'player_joined')
    host.emit('add_local_player', { playerName: name })
    await joined
  }
  host.emit('set_genre', { genre: 'comedy' })
  const ready = once(host, 'script_ready')
  host.emit('start_game')
  await ready
  const started = once(host, 'recording_started')
  host.emit('start_recording')
  await started
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 3)
  const stopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  assert.equal(room.uploadExpected.size, 1) // 人数(3)ではなく台数(1)
  const done = once(host, 'evaluation_complete')
  // アップロードは来ないのでタイムアウト経路で確定する。テストサーバーは
  // uploadTimeoutMs を短くして起動すること（既存テストの流儀に合わせる）
  await done
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0]!.players, ['たろう', 'はなこ', 'じろう'])
  host.disconnect()
})
```

`ai` の注入方法と `uploadTimeoutMs` の短縮は、同ファイルの既存テストの書き方をそのまま踏襲すること。

- [ ] **Step 7: テストが通ることを確認する**

Run:
```bash
(cd server && npx tsx --test tests/ai/evaluate.test.ts)
(cd server && npx tsx --test tests/handlers.evaluation.test.ts)
```
Expected: PASS

- [ ] **Step 8: 全体の回帰確認**

Run:
```bash
(cd server && npm test)
(cd server && npx tsc --noEmit)
```
Expected: すべて PASS

- [ ] **Step 9: コミット**

```bash
git add server
git commit -m "$(cat <<'MSG'
refactor: 採点の入力を人ごとの音声から音声ソースごとに変える

Evaluator が受け取るのを Map<name, audio> から AudioSource[] に
変更する。1端末=1本=1..N人という録音の実態にデータの形を合わせた。

副産物として文字起こしの呼び出しが人数分から端末数分に減る。
この時点では全ソース1人なので採点結果は現行と同一。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 4: 共有録音のプロンプト

**Files:**
- Create: `prompts/score-system-shared.md`
- Create: `prompts/score-user-shared-header.md`
- Create: `prompts/score-user-shared-source.md`
- Modify: `server/src/ai/prompts.ts`
- Modify: `server/src/ai/scoreGen.ts`
- Test: `server/tests/ai/scoreGen.test.ts`
- Test: `server/tests/ai/prompts.test.ts`

**Interfaces:**
- Consumes: Task 3 の `TranscribedSource`
- Produces:
  - `Prompts.scoreSystemShared()` / `scoreUserSharedHeader()` / `scoreUserSharedSource()`
  - `selectScoreSystem(prompts, playerCount: number, hasShared: boolean): string`

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/ai/scoreGen.test.ts` に追記する。**1本目が回帰防止の要**。

```ts
test('全ソースが1人なら現行と同一のプロンプトを出す（回帰防止）', () => {
  const prompts = createPrompts()
  // 「現行と同じ」の基準＝録音セクションが1文字も入らないこと
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう'], text: 'いらっしゃいませー！' },
    { players: ['はなこ'], text: 'いつものー' },
  ])
  assert.doesNotMatch(p, /【録音】/)
  assert.doesNotMatch(p, /録音A/)
  assert.doesNotMatch(p, /を参照/)
  assert.match(p, /いらっしゃいませー！/)
  assert.match(p, /いつものー/)
  // 期待する全体の形：ヘッダ → 空行 → プレイヤーブロックのみ
  const header = renderTemplate(prompts.scoreUserHeader(), { worldSetting: SCRIPT.worldSetting })
  assert.ok(p.startsWith(header + '\n\n'))
})

test('共有録音があると録音セクションが入り、該当者の発話は参照になる', () => {
  const prompts = createPrompts()
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう', 'はなこ'], text: 'いらっしゃいませ いつもの' },
  ])
  assert.match(p, /【録音】/)
  assert.match(p, /録音A/)
  assert.match(p, /たろう・はなこ/)
  assert.match(p, /いらっしゃいませ いつもの/)
  // 2人とも「録音A を参照」になり、文字起こし本文は1回しか出ない
  assert.equal((p.match(/録音A を参照/g) ?? []).length, 2)
  assert.equal((p.match(/いらっしゃいませ いつもの/g) ?? []).length, 1)
  assert.doesNotMatch(p, /\{\{/)
})

test('共有録音と単独録音が混在すると単独側は本文がそのまま入る', () => {
  const prompts = createPrompts()
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう', 'はなこ'], text: '共有のはつわ' },
    { players: ['じろう'], text: 'ひとりのはつわ' },
  ])
  assert.match(p, /録音A を参照/)
  assert.match(p, /ひとりのはつわ/)
  assert.doesNotMatch(p, /じろう[\s\S]*?録音A を参照/)
})

test('selectScoreSystem は共有録音があるとき追記ぶんを連結する', () => {
  const prompts = createPrompts()
  const normal = selectScoreSystem(prompts, 3, false)
  const shared = selectScoreSystem(prompts, 3, true)
  const solo = selectScoreSystem(prompts, 1, false)
  assert.equal(normal, prompts.scoreSystem())            // 現行と完全に同じ
  assert.ok(shared.startsWith(prompts.scoreSystem()))     // 全文の複製ではなく追記
  assert.ok(shared.includes(prompts.scoreSystemShared()))
  assert.equal(solo, prompts.scoreSystemSolo())
})

test('1人プレイは共有録音フラグに関係なくソロ用システムを使う', () => {
  const prompts = createPrompts()
  assert.equal(selectScoreSystem(prompts, 1, true), prompts.scoreSystemSolo())
})
```

`renderTemplate` を import に足すこと。

`server/tests/ai/prompts.test.ts` にも追記する。

```ts
test('新しいプロンプトファイルは必須である', () => {
  assert.ok(REQUIRED_FILES.includes('score-system-shared.md'))
  assert.ok(REQUIRED_FILES.includes('score-user-shared-header.md'))
  assert.ok(REQUIRED_FILES.includes('score-user-shared-source.md'))
})
```

同ファイルの既存テスト（「必須ファイルが欠けると throw する」形のもの）が新しい3本もカバーすることを確認する。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd server && npx tsx --test tests/ai/scoreGen.test.ts)`
Expected: FAIL（`scoreSystemShared` が存在しない・`selectScoreSystem` の引数が2つしかない）

- [ ] **Step 3: プロンプトファイルを3本作る**

`prompts/score-user-shared-header.md`:

```markdown
【録音】この回には、複数人が同じマイクの前で演じた録音があります。
```

`prompts/score-user-shared-source.md`:

```markdown
▼ {{label}}（{{players}} の{{count}}人が同じマイクの前で演じています）
文字起こし：{{transcript}}
```

`prompts/score-system-shared.md`（**全文の複製ではなく追記ぶんだけ**）:

```markdown
## 共有録音の読み方（重要）

この回には、複数人が1台の端末を囲んで演じた録音が含まれます。その録音の文字起こしは**話者を区別しません**。誰が言ったかは、次の2つだけを手がかりに判断してください。

- **台詞の内容**: 台本のどの台詞に対応するか。対応が付けば、その台詞を持つ人の発話です
- **順番**: 文字起こしは概ね発話順に並びます。台本の並びと突き合わせてください

判断できない発話は、**誰の加点にも減点にも使わないでください**。「たぶんこの人だろう」で点を動かすと、黙っていた人が隣の熱演で得をします。

台本の台詞に対応する発話がその録音の中に見当たらない人は、これまでどおり「無音」として扱ってください。同じ録音に他人の声が入っていることは、その人が演じた証拠にはなりません。

アドリブや台本にない発話は、**役と世界観に照らして誰のものか判断が付く場合にだけ**その人の評価に使ってください。
```

- [ ] **Step 4: `server/src/ai/prompts.ts` を更新する**

```ts
export const REQUIRED_FILES = [
  'script-system.md',
  'script-user.md',
  'script-user-solo.md',
  'score-system.md',
  'score-system-solo.md',
  'score-system-shared.md',
  'score-user-header.md',
  'score-user-player.md',
  'score-user-shared-header.md',
  'score-user-shared-source.md',
] as const
```

`Prompts` インターフェースとファクトリの返り値に3つ足す。

```ts
export interface Prompts {
  // …既存…
  scoreSystemShared(): string
  scoreUserSharedHeader(): string
  scoreUserSharedSource(): string
  // …既存…
}
```

```ts
  function scoreSystemShared(): string {
    return get('score-system-shared.md')
  }
  function scoreUserSharedHeader(): string {
    return get('score-user-shared-header.md')
  }
  function scoreUserSharedSource(): string {
    return get('score-user-shared-source.md')
  }
```

`return { … }` にも3つ追加すること。

- [ ] **Step 5: `server/src/ai/scoreGen.ts` に共有録音の分岐を入れる**

```ts
// 共有録音のラベル。A, B, C… 26本を超えることは実質ない（端末数の上限＝人数上限10）。
function sharedLabel(index: number): string {
  return `録音${String.fromCharCode(0x41 + index)}`
}

// 文面は prompts/score-user-*.md に置き、ここは「並べる」構造だけを持つ。
// 全ソースが1人のときは録音セクションを1文字も出さない＝現行と同一の出力になること。
export function buildScorePrompt(
  prompts: Prompts,
  script: ScriptData,
  sources: TranscribedSource[],
): string {
  const header = renderTemplate(prompts.scoreUserHeader(), { worldSetting: script.worldSetting })

  // 共有録音（2人以上が1本）だけを録音セクションに出し、該当者は参照に差し替える
  const shared = sources.filter(s => s.players.length > 1)
  const referenceOf = new Map<string, string>()
  const sharedBlocks: string[] = []
  if (shared.length > 0) {
    const lines = [prompts.scoreUserSharedHeader()]
    const template = prompts.scoreUserSharedSource()
    shared.forEach((s, i) => {
      const label = sharedLabel(i)
      for (const name of s.players) referenceOf.set(name, `${label} を参照`)
      lines.push(
        renderTemplate(template, {
          label,
          players: s.players.join('・'),
          count: String(s.players.length),
          transcript: s.text || '（無音）',
        }),
      )
    })
    sharedBlocks.push(lines.join('\n'), '')
  }

  const template = prompts.scoreUserPlayer()
  const playerBlocks = sources.flatMap(s =>
    s.players.map(name => {
      const role = script.roles.find(r => r.player === name)
      const scripted = script.entries
        .filter(e => e.player === name)
        .map(e => e.line)
        .join(' / ')
      return renderTemplate(template, {
        playerName: name,
        role: role?.role ?? '不明',
        roleDescription: role?.description ?? '',
        scriptedLines: scripted || '（なし）',
        actualSpeech: referenceOf.get(name) ?? (s.text || '（無音）'),
      })
    }),
  )

  return [header, '', ...sharedBlocks, ...playerBlocks].join('\n')
}
```

`selectScoreSystem` を書き換える。

```ts
/**
 * 採点対象が1人なら相対評価が成立しない（見比べる相手がいない）ので SYSTEM ごと差し替える。
 * 共有録音があるときは帰属ルールの追記ぶんを連結する（全文の複製は作らない＝
 * 複製すると必ず片方だけ直されて食い違うため）。
 */
export function selectScoreSystem(prompts: Prompts, count: number, hasShared: boolean): string {
  if (count === 1) return prompts.scoreSystemSolo()
  if (hasShared) return [prompts.scoreSystem(), prompts.scoreSystemShared()].join('\n\n')
  return prompts.scoreSystem()
}
```

`createScoreGenerator` の呼び出しを合わせる。

```ts
    const names = sources.flatMap(s => s.players)
    const hasShared = sources.some(s => s.players.length > 1)
    const res = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: selectScoreSystem(prompts, names.length, hasShared),
      messages: [{ role: 'user', content: buildScorePrompt(prompts, script, sources) }],
      output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
    } as Parameters<Anthropic['messages']['create']>[0])
```

`parseScores(block.text, names)` にすること。

- [ ] **Step 6: テストが通ることを確認する**

Run:
```bash
(cd server && npx tsx --test tests/ai/scoreGen.test.ts)
(cd server && npx tsx --test tests/ai/prompts.test.ts)
```
Expected: PASS

- [ ] **Step 7: 全体の回帰確認**

Run:
```bash
(cd server && npm test)
(cd server && npx tsc --noEmit)
```
Expected: すべて PASS

- [ ] **Step 8: コミット**

```bash
git add prompts server
git commit -m "$(cat <<'MSG'
feat: 1本の音声に入った複数人を台本照合で採点する

共有録音があるときだけ録音セクションを差し込み、該当者の「実際の
発話」を参照に変える。全ソースが1人なら録音セクションを1文字も
出さない＝現行と同一のプロンプトになる（回帰防止をテストで固定）。

帰属ルールは score-system.md の複製ではなく追記ぶんを別ファイルに
置いて連結する。複製すると必ず片方だけ直されて食い違うため。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 5: プレイヤー色（1P〜10P）

**Files:**
- Create: `client/src/playerColors.ts`
- Test: `client/tests/playerColors.test.ts`（新規）

**Interfaces:**
- Consumes: なし
- Produces:
  - `PLAYER_COLORS: readonly string[]`（10色）
  - `playerColor(index: number): string`
  - `playerColorMap(players: { name: string }[]): Record<string, string>`

- [ ] **Step 1: 失敗するテストを書く**

`client/tests/playerColors.test.ts` を新規作成する。

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLAYER_COLORS, playerColor, playerColorMap } from '../src/playerColors'

test('10色ある', () => {
  assert.equal(PLAYER_COLORS.length, 10)
})

test('1P は朱、10P は墨', () => {
  assert.equal(playerColor(0), '#b8352c')
  assert.equal(playerColor(9), '#241c17')
})

test('11人目以降は循環する', () => {
  assert.equal(playerColor(10), playerColor(0))
  assert.equal(playerColor(23), playerColor(3))
})

test('負の index でも落ちない', () => {
  assert.equal(playerColor(-1), playerColor(9))
})

test('色はすべて異なる', () => {
  assert.equal(new Set(PLAYER_COLORS).size, 10)
})

test('playerColorMap は参加順で名前に色を割り当てる', () => {
  const map = playerColorMap([{ name: 'ミチ' }, { name: 'タロウ' }, { name: 'ハナコ' }])
  assert.equal(map['ミチ'], '#b8352c')
  assert.equal(map['タロウ'], '#3a4f7a')
  assert.equal(map['ハナコ'], '#46603f')
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd client && npx tsx --test tests/playerColors.test.ts)`
Expected: FAIL（`../src/playerColors` が存在しない）

- [ ] **Step 3: `client/src/playerColors.ts` を作る**

```ts
// プレイヤーの固定色（1P〜10P）。参加順に割り当て、ロビー・配役・台本・結果の
// すべてで「同じ人が同じ色」になるようにする。1P/2P という昭和のゲーム機の見立て。
//
// 既存の GENRE_ACCENT と同じ昭和の差し色から採っているが、こちらは紙の上に
// 罫と文字として乗る（GENRE_ACCENT は帯の地として明色の文字を載せる）。
// 要求されるコントラストの向きが逆なので、値は共有せず独立に持つ。
//
// コントラスト実測値（WCAG）:
//   本文地 #f0e7d2 に対して最小 4.76:1（1P 朱）
//   パネル地 #f7f1e3 に対して最小 5.20:1（1P 朱）
// 4P 山吹と 9P 鶯茶は GENRE_ACCENT の原色だと本文地で 4.5:1 を切るため暗くしてある。
// 色を足す・変えるときは両方の地で 4.5:1 以上を確認すること。
export const PLAYER_COLORS = [
  '#b8352c', // 1P  朱
  '#3a4f7a', // 2P  群青
  '#46603f', // 3P  深緑
  '#7d5b16', // 4P  山吹（GENRE_ACCENT.comedy より暗い）
  '#5f4c6b', // 5P  葡萄鼠
  '#3f6b67', // 6P  錆浅葱
  '#6b3f2e', // 7P  海老茶
  '#2f4550', // 8P  藍鉄
  '#656124', // 9P  鶯茶
  '#241c17', // 10P 墨
] as const

/** 参加順の index から色を引く。上限を超えたら循環する（MAX_PLAYERS=10 なので通常は起きない）。 */
export function playerColor(index: number): string {
  const n = PLAYER_COLORS.length
  return PLAYER_COLORS[((index % n) + n) % n]!
}

/** 参加順に並んだプレイヤー配列から「名前 → 色」を引ける表を作る。 */
export function playerColorMap(players: { name: string }[]): Record<string, string> {
  const map: Record<string, string> = {}
  players.forEach((p, i) => {
    map[p.name] = playerColor(i)
  })
  return map
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `(cd client && npx tsx --test tests/playerColors.test.ts)`
Expected: PASS（6本）

- [ ] **Step 5: コミット**

```bash
git add client/src/playerColors.ts client/tests/playerColors.test.ts
git commit -m "$(cat <<'MSG'
feat: プレイヤーの固定色(1P〜10P)を足す

参加順に色を割り当て、ロビー・配役・台本・結果で同じ人が同じ色に
なるようにする。GENRE_ACCENT とは要求されるコントラストの向きが
逆(紙に乗せる vs 帯の地)なので値は共有せず独立に持つ。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 6: クライアント基盤（deviceId と「この端末の人」）

**Files:**
- Create: `client/src/localPlayers.ts`
- Test: `client/tests/localPlayers.test.ts`（新規）
- Modify: `client/src/App.tsx`
- Modify: `client/src/useGameSocket.ts`
- Modify: `client/src/types.ts`（`shared/types.ts` の再輸出なら確認のみ）

**Interfaces:**
- Consumes: Task 1 の `PlayerSnapshot.deviceId`、`room_created`/`room_joined`/`rejoined` の `deviceId`
- Produces:
  - `GameContext.deviceId: string`
  - `localPlayers(players, deviceId): PlayerSnapshot[]`
  - `isLocalPlayer(players, deviceId, name): boolean`
  - `GameActions.addLocalPlayer(name: string)` / `removeLocalPlayer(playerId: string)`

- [ ] **Step 1: 失敗するテストを書く**

`client/tests/localPlayers.test.ts` を新規作成する。

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localPlayers, isLocalPlayer } from '../src/localPlayers'
import type { PlayerSnapshot } from '../src/types'

const P = (name: string, deviceId: string, id = name): PlayerSnapshot => ({
  id, deviceId, name, isHost: false, isReady: false, connected: true,
})

const PLAYERS = [P('ミチ', 'd1'), P('タロウ', 'd1'), P('ジロウ', 'd2')]

test('localPlayers は同じ deviceId の人だけを参加順で返す', () => {
  assert.deepEqual(localPlayers(PLAYERS, 'd1').map(p => p.name), ['ミチ', 'タロウ'])
  assert.deepEqual(localPlayers(PLAYERS, 'd2').map(p => p.name), ['ジロウ'])
})

test('deviceId が空なら空配列（トップ画面など未参加の状態）', () => {
  assert.deepEqual(localPlayers(PLAYERS, ''), [])
})

test('isLocalPlayer はこの端末の人にだけ true', () => {
  assert.equal(isLocalPlayer(PLAYERS, 'd1', 'タロウ'), true)
  assert.equal(isLocalPlayer(PLAYERS, 'd1', 'ジロウ'), false)
  assert.equal(isLocalPlayer(PLAYERS, '', 'ミチ'), false)
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd client && npx tsx --test tests/localPlayers.test.ts)`
Expected: FAIL（`../src/localPlayers` が存在しない）

- [ ] **Step 3: `client/src/localPlayers.ts` を作る**

```ts
import type { PlayerSnapshot } from './types'

// 「この端末に乗っている人」は ctx に別の配列として持たず、players と deviceId から
// 毎回導出する。二重に持つと player_joined / player_left / room_reset のたびに
// 同期を取る必要が生まれ、片方だけ古くなる事故が起きるため。

/** この端末のプレイヤーを参加順のまま返す。deviceId 未確定（トップ画面）なら空。 */
export function localPlayers(players: PlayerSnapshot[], deviceId: string): PlayerSnapshot[] {
  if (!deviceId) return []
  return players.filter(p => p.deviceId === deviceId)
}

/** その名前の人がこの端末にいるか（台本のハイライト判定に使う）。 */
export function isLocalPlayer(players: PlayerSnapshot[], deviceId: string, name: string): boolean {
  if (!deviceId) return false
  return players.some(p => p.deviceId === deviceId && p.name === name)
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `(cd client && npx tsx --test tests/localPlayers.test.ts)`
Expected: PASS（3本）

- [ ] **Step 5: `GameContext` に `deviceId` を足す**

`client/src/App.tsx`:

```ts
export interface GameContext {
  playerName: string      // この端末の代表プレイヤー名（トップの入力保持と1人時のシェア文言）
  deviceId: string        // この端末のID。players の deviceId と突き合わせて「この端末の人」を出す
  isHost: boolean
  // …以降は現行のまま…
}
```

```ts
const INITIAL_CTX: GameContext = {
  playerName: '',
  deviceId: '',
  isHost: false,
  // …以降は現行のまま…
}
```

`clearToTop` が `INITIAL_CTX` に戻す作りなら `deviceId` も自動で空に戻る。個別に列挙している箇所があれば `deviceId: ''` を足すこと。

- [ ] **Step 6: `client/src/useGameSocket.ts` を更新する**

```ts
    function onRoomCreated(
      { roomCode, room, token, deviceId }:
        { roomCode: string; room: RoomSnapshot; token: string; deviceId: string },
    ) {
      sessionStorage.setItem(TOKEN_KEY, token)
      setError('')
      setCtx(prev => ({
        ...prev, roomCode, deviceId, isHost: true,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores,
        aiAvailable: room.aiAvailable,
      }))
      setScreen('lobby')
    }

    function onRoomJoined(
      { room, token, deviceId }: { room: RoomSnapshot; token: string; deviceId: string },
    ) {
      sessionStorage.setItem(TOKEN_KEY, token)
      setError('')
      setCtx(prev => ({
        ...prev, roomCode: room.code, deviceId, isHost: false,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores,
        aiAvailable: room.aiAvailable,
      }))
      setScreen('lobby')
    }

    function onRejoined(
      { room, status, deviceId, selfPlayerNames }:
        { room: RoomSnapshot; status: RoomStatus; deviceId: string; selfPlayerNames: string[] },
    ) {
      setDisconnected(false)
      const selfName = selfPlayerNames[0] ?? ''
      const me = room.players.find(p => p.name === selfName)
      const readyMap: Record<string, boolean> = {}
      room.players.forEach(p => { readyMap[p.name] = p.isReady })
      setCtx(prev => ({
        ...prev,
        playerName: selfName,
        deviceId,
        isHost: me?.isHost ?? false,
        // …以降は現行のまま…
      }))
      // …画面遷移は現行のまま…
    }
```

`GameActions` に2つ足す。

```ts
export interface GameActions {
  // …既存…
  addLocalPlayer: (playerName: string) => void
  removeLocalPlayer: (playerId: string) => void
  kickDevice: (deviceId: string) => void   // Task 1 で kickPlayer から改名済み
  // …既存…
}
```

```ts
    addLocalPlayer(playerName) {
      // 一覧への反映は player_joined 受信で行う（楽観的更新にしない＝
      // サーバーが満員/重複で弾いたときに表示がズレない）
      socket.emit('add_local_player', { playerName })
    },
    removeLocalPlayer(playerId) {
      socket.emit('remove_local_player', { playerId })
    },
```

- [ ] **Step 7: 型チェックとテスト**

Run:
```bash
(cd client && npm test)
(cd client && npx tsc --noEmit)
```
Expected: PASS / エラーなし。`LobbyScreen.tsx` で型エラーが出たら Task 1 Step 8 で入れた暫定呼び出しを直す。

- [ ] **Step 8: コミット**

```bash
git add client
git commit -m "$(cat <<'MSG'
feat: クライアントに deviceId と「この端末の人」の導出を足す

localPlayers は ctx に別配列として持たず players と deviceId から
毎回導出する。二重に持つと player_joined/left/room_reset のたびに
同期が要り、片方だけ古くなる事故が起きるため。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 7: ロビーの端末グループ表示と追加UI

**このタスクから先は自動テストで守れない。** ゲートは `tsc --noEmit` と手動確認。

**Files:**
- Modify: `client/src/screens/LobbyScreen.tsx`

**Interfaces:**
- Consumes: Task 5 の `playerColorMap`、Task 6 の `localPlayers` / `ctx.deviceId` / `actions.addLocalPlayer` / `removeLocalPlayer` / `kickDevice`
- Produces: なし（画面のみ）

- [ ] **Step 1: 参加者一覧を端末ごとにグループ化する**

`ctx.players` は参加順に並んでいるので、`deviceId` で group by すれば端末の参加順が保たれる。

```tsx
import { playerColorMap } from '../playerColors'

// 参加順を保ったまま端末ごとにまとめる（Map は挿入順を保つ）
function groupByDevice(players: PlayerSnapshot[]): { deviceId: string; members: PlayerSnapshot[] }[] {
  const groups = new Map<string, PlayerSnapshot[]>()
  for (const p of players) {
    const list = groups.get(p.deviceId)
    if (list) list.push(p)
    else groups.set(p.deviceId, [p])
  }
  return [...groups].map(([deviceId, members]) => ({ deviceId, members }))
}
```

コンポーネント本体で使う。

```tsx
  const colors = playerColorMap(ctx.players)
  const groups = groupByDevice(ctx.players)
  const isFull = ctx.players.length >= MAX_PLAYERS
```

`MAX_PLAYERS` を `@shared/constants` の import に足す。

- [ ] **Step 2: 一覧の描画をグループ表示に差し替える**

現行の「参加者」パネルの中身を置き換える。

```tsx
      <div className="washi-panel mb-4">
        <p className="font-bold mb-3 text-usuzumi text-sm">参加者 {ctx.players.length} / {MAX_PLAYERS}</p>
        <div className="space-y-3">
          {groups.map(g => {
            const isMine = g.deviceId === ctx.deviceId
            const offline = g.members[0]?.connected === false
            return (
              <div key={g.deviceId} className="border border-kei p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-usuzumi text-xs font-bold tracking-wider">
                    {isMine ? 'この端末' : 'オンライン'}
                    {g.members.length > 1 && `（${g.members.length}人）`}
                  </p>
                  {offline && <span className="text-xs text-shu font-bold">復帰待ち…</span>}
                </div>
                {g.members.map((p, i) => (
                  <div key={p.id} className={`flex items-center gap-3 py-2 ${i > 0 ? 'rule' : ''}`}>
                    <div
                      className="seal h-8 w-8 text-sm flex-shrink-0"
                      style={{ background: colors[p.name] }}
                    >
                      {p.name[0]}
                    </div>
                    <span className="text-sumi">{p.name}</span>
                    {p.isHost && (
                      <span className="text-xs bg-sumi text-kinari px-2 py-0.5 font-bold">ホスト</span>
                    )}
                    {isMine && i > 0 && (
                      <button
                        onClick={() => actions.removeLocalPlayer(p.id)}
                        aria-label={`${p.name} を外す`}
                        className="ml-auto text-xs px-2 py-1 border border-kei text-usuzumi hover:text-shu hover:border-shu transition-colors"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {isMine && <AddPlayerRow disabled={isFull} onAdd={actions.addLocalPlayer} taken={ctx.players.map(p => p.name)} />}
                {ctx.isHost && !isMine && offline && (
                  <button
                    onClick={() => setKickTarget(g.deviceId)}
                    className="mt-2 text-xs px-2 py-1 border border-shu text-shu hover:bg-shu/10 font-bold transition-colors"
                  >
                    退出させる
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
```

`seal` クラスが背景色を持っている場合、`style` の `background` が勝つよう `index.css` の `.seal` に `background` を指定していないか確認し、必要なら `style={{ background: colors[p.name] }}` のままで上書きできることを確かめる。

- [ ] **Step 3: 追加フォームのコンポーネントを足す**

`LobbyScreen.tsx` の先頭（`export default` の前）に置く。

import { NAME_MAX, MAX_PLAYERS } from '@shared/constants'

/**
 * この端末にプレイヤーを足すインライン入力。
 * 重複と文字数はここでも弾く：サーバーの error を待つと3人分を続けて
 * 入れるときにテンポが落ちるため（サーバー側の検証は残したまま）。
 */
function AddPlayerRow({
  disabled, onAdd, taken,
}: {
  disabled: boolean
  onAdd: (name: string) => void
  taken: string[]
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [err, setErr] = useState('')

  if (disabled) {
    return <p className="text-usuzumi text-xs mt-2">満員です（{MAX_PLAYERS}人まで）</p>
  }
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-2 py-2 border border-dashed border-sumi text-sumi text-sm font-medium hover:bg-sumi/5 transition-colors"
      >
        ＋ この端末にプレイヤーを追加
      </button>
    )
  }

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    if (trimmed.length > NAME_MAX) {
      setErr(`名前は${NAME_MAX}文字までです`)
      return
    }
    if (taken.includes(trimmed)) {
      setErr('その名前は使われています')
      return
    }
    onAdd(trimmed)
    setName('')
    setErr('')
    // 続けて足せるよう入力欄は開いたままにする
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={e => { setName(e.target.value); setErr('') }}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
          maxLength={NAME_MAX}
          autoFocus
          placeholder="名前"
          className="field flex-1"
        />
        <button onClick={submit} className="btn-outline w-24 text-sm">追加</button>
      </div>
      {err && <p className="text-shu text-xs mt-1">{err}</p>}
      <button
        onClick={() => { setOpen(false); setName(''); setErr('') }}
        className="text-usuzumi text-xs mt-1 hover:text-shu transition-colors"
      >
        閉じる
      </button>
    </div>
  )
}
```

- [ ] **Step 4: キックの確認ダイアログを端末単位の文言にする**

`kickTarget` の型を `string | null`（deviceId）に変え、ダイアログを差し替える。

```tsx
  const kickGroup = kickTarget ? groups.find(g => g.deviceId === kickTarget) : undefined
  const kickNames = kickGroup?.members.map(m => m.name).join('・') ?? ''
```

```tsx
      <ConfirmDialog
        open={kickTarget !== null}
        title="この端末を退出させますか？"
        message={
          kickGroup && kickGroup.members.length > 1
            ? `${kickNames} の${kickGroup.members.length}人が退出します。`
            : `${kickNames} が退出します。`
        }
        confirmLabel="退出させる"
        cancelLabel="やめる"
        onConfirm={() => { if (kickTarget) actions.kickDevice(kickTarget); setKickTarget(null) }}
        onCancel={() => setKickTarget(null)}
      />
```

- [ ] **Step 5: 型チェック**

Run: `(cd client && npx tsc --noEmit)`
Expected: エラーなし

- [ ] **Step 6: 手動で確認する**

`(cd server && npm run dev)` と `(cd client && npm run dev)` を起動し、ブラウザで確認する。

確認項目:
1. ルームを作り「＋この端末にプレイヤーを追加」で2人足す → 一覧が「この端末（3人）」になり、2人目・3人目に × が出る。1人目（代表）には × が出ない
2. 既にいる名前を入れる → サーバーを待たずその場に赤字で「その名前は使われています」
3. × で削除できる
4. 別タブでルームに参加 → 「オンライン」グループとして別枠に出る。そのタブでも追加できる
5. 10人まで足すと追加ボタンが「満員です（10人まで）」に変わる
6. ㊞ の色が 1P 朱 → 2P 群青 → 3P 深緑 の順になっている

- [ ] **Step 7: コミット**

```bash
git add client/src/screens/LobbyScreen.tsx
git commit -m "$(cat <<'MSG'
feat: ロビーを端末ごとのグループ表示にして追加UIを置く

「（あなた）」の人単位の表記をやめ、「この端末」というグループ見出し
に置き換える。3人乗っていると「あなた」が誰を指すか決まらないため。

重複と文字数はクライアント側でも弾く。3人分を続けて入れるときに
往復を待たずに直せるほうがテンポが良い（サーバー検証は残す）。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 8: 配役・準備・録音の3画面（色分けと名前バッジ）

**Files:**
- Modify: `client/src/screens/CastingScreen.tsx`
- Modify: `client/src/screens/PrepareScreen.tsx`
- Modify: `client/src/screens/RecordingScreen.tsx`

**Interfaces:**
- Consumes: Task 5 の `playerColorMap`、Task 6 の `localPlayers` / `isLocalPlayer`
- Produces: なし（画面のみ）

- [ ] **Step 1: 台本行の共通コンポーネントを作る**

準備画面と録音画面で同じ描き分けをするので、`PrepareScreen.tsx` に置いて録音画面から import するのではなく、独立させる。`client/src/components/ScriptLine.tsx` を新規作成する。

```tsx
import type { ScriptEntry } from '../types'

/**
 * 台本の1行。この端末のプレイヤーの台詞だけ「プレイヤー色の太罫 ＋ 名前バッジ」に、
 * 他端末は灰の細罫にする。全員に色を付けると「この端末の誰が言う番か」が埋もれるため、
 * 局所/遠隔の区別は色ではなく罫の太さで出す。
 *
 * 名前バッジは1台を囲んで読むときに必須。キャラ名だけでは誰の番か分からない。
 */
export default function ScriptLine({
  entry, local, color,
}: {
  entry: ScriptEntry
  local: boolean
  color?: string
}) {
  return (
    <div
      className={`bg-kinari px-4 py-3 ${local ? 'border-l-4' : 'border-l-2 border-kei'}`}
      style={local ? { borderLeftColor: color } : undefined}
    >
      <p className="text-xs font-bold mb-1 flex items-center gap-2">
        <span style={local ? { color } : undefined} className={local ? '' : 'text-usuzumi'}>
          {entry.character}
        </span>
        {local && (
          <span
            className="text-[10px] text-kinari px-1.5 py-0.5 font-bold"
            style={{ background: color }}
          >
            {entry.player}
          </span>
        )}
      </p>
      {entry.action && <p className="text-usuzumi text-xs italic mb-1.5">〔{entry.action}〕</p>}
      <p className={`text-sm leading-relaxed ${local ? 'text-sumi font-bold' : 'text-usuzumi'}`}>
        「{entry.line}」
      </p>
    </div>
  )
}
```

- [ ] **Step 2: `PrepareScreen.tsx` の台本表示を差し替える**

```tsx
import ScriptLine from '../components/ScriptLine'
import { playerColorMap } from '../playerColors'
import { localPlayers, isLocalPlayer } from '../localPlayers'
```

`myPlayer` を使っていた箇所を置き換える。

モック台本（`ctx.script` が無い開発時）は `ctx.players` が空で色も引けないため、判定を2つのヘルパーに閉じ込めてから使う。

```tsx
  const entries = ctx.script?.entries ?? FULL_SCRIPT
  const colors = playerColorMap(ctx.players)
  const mine = localPlayers(ctx.players, ctx.deviceId)

  // モック台本のときは ctx.players が空なので、従来どおり1人だけをローカル扱いにする
  const mockPlayer = ctx.script ? null : getMockPlayer(ctx.isHost, ctx.playerName)
  const isLocal = (name: string) =>
    mockPlayer !== null ? name === mockPlayer : isLocalPlayer(ctx.players, ctx.deviceId, name)
  const colorFor = (name: string) => colors[name] ?? '#b8352c' // モック時は1P色に倒す
```

```tsx
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <ScriptLine
              key={i}
              entry={entry}
              local={isLocal(entry.player)}
              color={colorFor(entry.player)}
            />
          ))}
        </div>
        {/* 凡例。この端末に2人以上いるときだけ意味がある */}
        {mine.length > 1 ? (
          <div className="flex flex-wrap gap-3 mt-3">
            {mine.map(p => (
              <span key={p.id} className="flex items-center gap-1 text-xs text-usuzumi">
                <span className="inline-block w-3 h-3" style={{ background: colors[p.name] }} />
                {p.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs mt-3" style={{ color: colorFor(mine[0]?.name ?? '') }}>
            ■ の行があなたのセリフです
          </p>
        )}
```

- [ ] **Step 3: 準備完了ボタンの文言を人数に合わせる**

```tsx
  const mineCount = mine.length
```

```tsx
        {isReady
          ? (mineCount > 1 ? `${mineCount}人とも準備OK` : '準備OK')
          : (mineCount > 1 ? `${mineCount}人とも準備完了にする` : '準備完了')}
```

既存のボタンのラベル箇所に合わせて差し込むこと（文言だけの変更で、`actions.setReady` の呼び出しは変えない）。

- [ ] **Step 4: `RecordingScreen.tsx` の台本表示を同じ形に差し替える**

`PrepareScreen` と同じ `ScriptLine` / `playerColorMap` / `isLocalPlayer` を使う。`myPlayer` による分岐を置き換え、凡例は場所を取るので出さない（準備フェーズで見ている前提）。

- [ ] **Step 5: `CastingScreen.tsx` をこの端末の人数分の配役に変える**

```tsx
  const colors = playerColorMap(ctx.players)
  const mine = localPlayers(ctx.players, ctx.deviceId)
  const mineNames = mine.map(p => p.name)
  const myRoles = roles.filter(r => mineNames.includes(r.player))
  const otherRoles = roles.filter(r => !mineNames.includes(r.player))
```

「My role」パネルを配列で回す。

```tsx
      <div className="washi-panel mb-4">
        <p className="text-usuzumi text-xs font-bold tracking-wider mb-3">
          {mine.length > 1 ? 'この端末の配役' : 'あなたの役'}
        </p>
        {myRoles.map((r, i) => (
          <div key={r.player} className={i > 0 ? 'rule pt-4 mt-4' : ''}>
            <div className="text-center mb-4">
              <p className="text-xs font-bold tracking-wider mb-1" style={{ color: colors[r.player] }}>
                {r.player} の役
              </p>
              <h2 className="washi-band font-display text-2xl">{r.role}</h2>
            </div>
            <p className="text-usuzumi text-sm leading-relaxed mb-4">{r.description}</p>
            <p className="text-usuzumi text-xs font-bold mb-2">セリフ</p>
            <div className="space-y-3">
              {entries.filter(e => e.player === r.player).map((entry, j) => (
                <div key={j} className={j > 0 ? 'rule pt-3' : ''}>
                  {entry.action && (
                    <p className="text-usuzumi text-xs italic mb-1">〔{entry.action}〕</p>
                  )}
                  <p className="text-sumi text-sm leading-relaxed">「{entry.line}」</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
```

「他のプレイヤーの役」の㊞にも色を付ける（`style={{ background: colors[r.player] }}`）。

モック台本のフォールバックは Step 2 と同じ方針で残すこと。

- [ ] **Step 6: 型チェック**

Run: `(cd client && npx tsc --noEmit)`
Expected: エラーなし

- [ ] **Step 7: 手動で確認する**

1. 1台に3人でゲームを開始 → 配役画面に3人分の役カードが縦に並ぶ
2. 準備画面の台本で、3人の台詞がそれぞれ 1P/2P/3P の色の太罫＋名前バッジになる。他端末の人の行は灰の細罫でバッジなし
3. 凡例に3人分の色と名前が出る
4. 準備完了ボタンが「3人とも準備完了にする」になる
5. 録音画面でも同じ色分けが出る
6. 1人だけの端末では従来どおり「■ の行があなたのセリフです」が出る

- [ ] **Step 8: コミット**

```bash
git add client/src/components/ScriptLine.tsx client/src/screens
git commit -m "$(cat <<'MSG'
feat: 台本にプレイヤー色の罫と名前バッジを出す

1台を囲んで読むとき、キャラ名だけでは誰が言う番か分からないので
名前バッジを足す。局所/遠隔の区別は色ではなく罫の太さで出す
（全員に色を付けると「この端末の誰の番か」が埋もれるため）。

配役画面はこの端末の人数分の役カードを並べる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 9: 結果画面

**Files:**
- Modify: `client/src/screens/ResultScreen.tsx`

**Interfaces:**
- Consumes: Task 5 の `playerColorMap`、Task 6 の `localPlayers`
- Produces: なし（画面のみ）

- [ ] **Step 1: 「自分の…」系を端末の人数で分岐させる**

```tsx
import { playerColorMap } from '../playerColors'
import { localPlayers } from '../localPlayers'
```

```tsx
  const colors = playerColorMap(ctx.players)
  const mine = localPlayers(ctx.players, ctx.deviceId)
  const soloDevice = mine.length <= 1   // この端末が1人か
  // 「自分の結果」は端末に1人のときだけ意味がある。3人乗っていると
  // 誰の結果を指すか決まらないので、全体シェアに寄せる。
  const hasMyScore = soloDevice && ctx.scores.some(r => r.playerName === ctx.playerName)
```

- [ ] **Step 2: 「自分の演技を聞く」の文言と共有テキストを変える**

```tsx
  async function shareTake() {
    const blob = getLastTake()
    if (!blob) return
    const ext = (blob.type.split('/')[1] ?? 'webm').split(';')[0]
    const text = soloDevice
      ? `${ctx.playerName} の熱演！ #こじらせ大劇場`
      : `${genreLabel(ctx.genre)}を演じてきた！ #こじらせ大劇場`
    await shareOrDownload(blob, `kojirase-take.${ext}`, text)
  }
```

`genreLabel` の import を足す（`../genres`）。

```tsx
      {takeUrl && (
        <div className="washi-panel mb-4">
          <p className="font-bold mb-2 text-usuzumi text-sm">
            {soloDevice ? '自分の演技を聞く' : 'みんなの熱演を聞く'}
          </p>
          {/* audio と共有ボタンは現行のまま */}
        </div>
      )}
```

- [ ] **Step 3: スコア一覧の㊞に色を付ける**

一覧の各行にある㊞（`seal` クラスの要素）に `style={{ background: colors[r.playerName] }}` を足す。`isMe` による強調は `soloDevice` のときだけ効かせ、複数人の端末では出さない（誰が「me」か決まらないため）。

- [ ] **Step 4: 型チェック**

Run: `(cd client && npx tsc --noEmit)`
Expected: エラーなし

- [ ] **Step 5: 手動で確認する**

1. 1台に3人で1ゲーム通す → 結果画面に「自分の結果を X でシェア」が**出ない**
2. 「みんなの熱演を聞く」になっており、再生できる
3. 「みんなの結果を X でシェア」は出る
4. ㊞ の色が 1P/2P/3P になっている
5. 1人だけの端末（オンライン参加のタブ）では「自分の結果を X でシェア」「自分の演技を聞く」が従来どおり出る
6. 「楽屋へのお便り」が従来どおり送れる

- [ ] **Step 6: コミット**

```bash
git add client/src/screens/ResultScreen.tsx
git commit -m "$(cat <<'MSG'
feat: 端末に複数人いるときの結果画面を全体共有に寄せる

「自分の結果」「自分の演技」は端末に1人のときだけ意味があるので、
2人以上乗っている端末では出さずルーム全体の共有だけにする。
音声も元から全員分なので「みんなの熱演を聞く」に言い換える。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 10: 通し確認と仕様書の更新

**Files:**
- Modify: `doc/仕様書.md`
- Modify: `doc/frontend仕様書.md`
- Modify: `doc/backend仕様書.md`

- [ ] **Step 1: 全テストと型チェックを通す**

Run:
```bash
(cd server && npm test)
(cd client && npm test)
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
```
Expected: すべて PASS / エラーなし

- [ ] **Step 2: 携帯回し（1台のみ）を実機で通す**

スマホの実機（またはスマホ幅のブラウザ）で本番相当の環境を使うこと。**マイクは HTTPS か localhost でしか使えない**。

1. ルームを作り、この端末にプレイヤーを2人追加（計3人）
2. ジャンルを選んで開始 → 3人分の役が出る
3. 台本の色分けと名前バッジが、腕を伸ばした距離から読めるか確認する（読めなければ文字サイズを上げる）
4. 3人で1台を囲んで台本の順に掛け合い、1発どりで録音
5. 結果を確認：**3人それぞれに別々のスコアとコメントが付いているか**。誰かのコメントが他人の演技を指していないか
6. 「みんなの熱演を聞く」で全員の声が入っているか

- [ ] **Step 3: 混在（1台に3人＋オンライン1人）を実機で通す**

1. 上の部屋に別端末から1人参加
2. ロビーが「この端末（3人）」と「オンライン」の2グループで出る
3. 開始 → 録音 → 結果まで通す
4. **4人ぶんのスコアが出て、オンラインの1人が共有録音の3人と混ざっていないか**確認する

- [ ] **Step 4: 帰属精度の判定と記録**

Step 2・3 で帰属が明らかにおかしい（黙っていた人が高得点、コメントが他人の演技を指している）場合は、設計書 8.6 節のとおり **タイムスタンプ付き文字起こし（`response_format: verbose_json`）** を次の手として検討する。**このタスクでは実装せず**、結果を設計書 13 節に追記するだけにとどめること。

- [ ] **Step 5: 切断・再接続を確認する**

1. 3人乗った端末をリロード → 3人とも一緒に戻る（`selfPlayerNames`）
2. オンライン参加の端末を切断 → その端末の人が「復帰待ち…」になる。ホストから「退出させる」で外せる
3. 2人乗った端末を切断してキック → 確認ダイアログが「◯◯・△△ の2人が退出します」になる

- [ ] **Step 6: 仕様書を更新する**

`doc/仕様書.md` の「3. 進行フロー」に、②の後へ次を足す。

```markdown
②' 1台で複数人プレイする場合
      → ロビーの「＋この端末にプレイヤーを追加」で人数分の名前を入れる
      → 携帯回し（全員が1台）とオンライン混在（1台に数人＋別端末）の
        どちらも同じ操作で成立する（モード切り替えは無い）
      → 録音は1台のマイクで1発どり。AIが台本と照合して発話を各人に帰属させる
```

「プレイ人数」の行に「1〜10人（1台に複数人可）」と補記する。

`doc/backend仕様書.md` に Device / Player の分離と deviceId キーを、`doc/frontend仕様書.md` にプレイヤー色（1P〜10P）と端末グループ表示を、それぞれ設計書を参照する形で1段落ずつ足す。

- [ ] **Step 7: 設計書の繰り越し節を更新する**

`docs/superpowers/specs/2026-08-25-local-multiplayer-design.md` の 13 節に、Step 4 の判定結果（帰属精度が実用に足りたか、次の手が要るか）を1行で追記する。

- [ ] **Step 8: コミット**

```bash
git add doc docs
git commit -m "$(cat <<'MSG'
docs: 1台で複数人プレイの仕様を仕様書に反映する

実機での通し確認の結果と、帰属精度の判定も設計書に追記する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Self-Review（この計画を書いたあとの確認結果）

**1. 仕様カバレッジ:** 設計書の全13節を照合した。

| 設計書の節 | 実装タスク |
|---|---|
| 4. データモデル | Task 1 |
| 5. ロビーとプレイヤー追加 | Task 2（サーバー）・Task 7（画面） |
| 6. プレイヤー色 | Task 5 |
| 7. 配役・準備・録音 | Task 8（`recorder.ts` は無変更＝実装なしが正） |
| 8. 音声の収集と採点 | Task 3・Task 4 |
| 9. 切断・再接続・退出・ホスト | Task 1（9.3 は「触らない」＝実装なしが正） |
| 10. 結果画面と共有 | Task 9 |
| 11. テスト方針 | 各タスクに分散＋Task 10 |
| 12. 変更しないもの | Global Constraints |
| 13. 繰り越し | Task 10 Step 7 |

**2. 未解決だったギャップと対処:**
- 設計書 8.4 節はプロンプトファイルを1本しか挙げていなかったが、「文面は `prompts/*.md` に置く」という既存方針に従うとユーザープロンプト側も外出しが要る。**3本に増やして冒頭の「仕様からの追加判断」に明記した**
- 設計書には `set_ready` と `return_to_lobby` の通知粒度が書かれていなかった。クライアントの `readyMap` と「n/m 人」表示が名前キーであるため、**どちらも端末の人数分 emit する**ことを Task 1 Step 6 で明示した

**3. 型の一貫性:** `Device` / `Player` / `AudioSource` / `TranscribedSource` / `playerColor` / `localPlayers` の名前と引数は Task 1 → 3 → 4 → 5 → 6 で一貫している。`kick_player` → `kick_device` の改名は Task 1 で server / client / テストを同時に直しており、途中で片方だけ古い名前が残る状態を作らない。
