# Phase B1（準備フェーズ同期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 準備画面(prepare)の準備完了状態を `set_ready`/`ready_updated` で全員同期し、ホストの `start_recording` で全員を録音画面へ遷移させる。

**Architecture:** Phase A の Socket.io ＋ インメモリルーム＋ `@shared` 型共有パターンをそのまま拡張。サーバーは `Player.isReady`（既存）を `set_ready` で更新し `ready_updated`（allReady 付き）を配信、`start_recording`（host のみ）で `status='recording'` にして `recording_started` を配信。クライアントは `GameContext.readyMap` と `useGameSocket` のリスナ／アクションを足し、`PrepareScreen` をモックから実接続化する。

**Tech Stack:** TypeScript, React 18 + Vite（client）, Node + Express + Socket.io（server, tsx 実行）, socket.io-client, node:test。

## Global Constraints

- 設計書：`docs/superpowers/specs/2026-07-14-backend-phaseB1-prepare-design.md`。Phase B 全体メモ：`docs/superpowers/phase-b-kickoff.md`。
- イベント名（追加分）：C→S `set_ready {isReady}` / `start_recording`（host のみ）。S→C `ready_updated {playerName, isReady, allReady}` / `recording_started`。
- `set_ready` は誰でも自分の状態のみ更新。`start_recording` はホスト（`room.hostSocketId === socket.id`）のみ受理、非ホストは無視。放送は `io.to(room.code)`（全員）。
- `allReady` = `players.size > 0 && 全員 isReady`。
- 共有型・定数の単一の真実源は `shared/`。既存の `@shared/*` エイリアス・`socket.to`(他全員)/`io.to`(全員) の使い分け・host 権限パターンを踏襲。
- サーバーテストは `node:test`＋硬化済み `testUtils`（once に 3s timeout / io.close teardown / reconnection:false）。`tsx --test` は必ず `timeout` で囲む（GREEN は約1秒で完了）。
- クライアントは 2-space indent・セミコロンなし。`tsc --noEmit` と `vite build` がクリーンであること。
- B1 スコープ外（触らない）：録音中インタラクション（reaction/bgm/sfx/volume）、`stop_recording`→評価→結果→`return_to_lobby`、録音5分自動終了、Phase A 繰り越し（start_game のガード等）。

---

## ファイル構成

- `shared/events.ts` — 4イベント追加（Task 1）
- `server/src/roomStore.ts` — `setReady`/`allReady` 追加（Task 2）
- `server/src/roomStore.test.ts` — テスト追加（Task 2）
- `server/src/handlers.ts` — `set_ready`/`start_recording` ハンドラ追加（Task 3）
- `server/src/handlers.prepare.test.ts` — 新規統合テスト（Task 3）
- `server/package.json` — test script に prepare テスト追加（Task 3）
- `client/src/App.tsx` — `GameContext.readyMap` ＋ `INITIAL_CTX`（Task 4）、`<PrepareScreen>` 配線（Task 5）
- `client/src/useGameSocket.ts` — リスナ＋アクション追加（Task 4）
- `client/src/screens/PrepareScreen.tsx` — 実接続化（Task 5）

---

## Task 1: shared/events.ts に4イベント追加

**Files:**
- Modify: `shared/events.ts`

**Interfaces:**
- Produces: `ClientToServerEvents` に `set_ready`/`start_recording`、`ServerToClientEvents` に `ready_updated`/`recording_started`。

- [ ] **Step 1: `shared/events.ts` を全文置換**

```typescript
import type { RoomSnapshot, PlayerSnapshot, ScriptData } from './types'

export interface ClientToServerEvents {
  create_room: (payload: { playerName: string }) => void
  join_room: (payload: { roomCode: string; playerName: string }) => void
  set_genre: (payload: { genre: string }) => void
  start_game: () => void
  set_ready: (payload: { isReady: boolean }) => void
  start_recording: () => void
}

export interface ServerToClientEvents {
  room_created: (payload: { roomCode: string; room: RoomSnapshot }) => void
  room_joined: (payload: { room: RoomSnapshot }) => void
  player_joined: (payload: { player: PlayerSnapshot }) => void
  genre_changed: (payload: { genre: string }) => void
  script_ready: (payload: { script: ScriptData }) => void
  player_left: (payload: { playerName: string }) => void
  room_dissolved: () => void
  error: (payload: { message: string }) => void
  ready_updated: (payload: { playerName: string; isReady: boolean; allReady: boolean }) => void
  recording_started: () => void
}
```

- [ ] **Step 2: 型チェック（server / client 両方）**

Run: `cd server && npx tsc --noEmit`
Expected: exit 0。
Run: `cd client && npx tsc --noEmit`
Expected: exit 0（新イベントは追加のみで既存コード非破壊）。

- [ ] **Step 3: Commit**

```bash
git add shared/events.ts
git commit -m "feat: shared/events に set_ready/start_recording/ready_updated/recording_started を追加"
```

---

## Task 2: roomStore に setReady / allReady（TDD）

**Files:**
- Modify: `server/src/roomStore.ts`, `server/src/roomStore.test.ts`

**Interfaces:**
- Consumes: 既存 `createRoom`, `addPlayer`（roomStore）。
- Produces: `setReady(room: Room, socketId: string, isReady: boolean): Player | undefined`、`allReady(room: Room): boolean`。

- [ ] **Step 1: 失敗するテストを追加（`server/src/roomStore.test.ts`）**

import 行に `setReady, allReady` を追加する。現在の import：

```typescript
import {
  createRoom, roomExists, addPlayer, hasPlayerName, toSnapshot,
  findRoomBySocket, removePlayer, cleanupRooms, _clearAllRooms,
} from './roomStore'
```

を以下に置換：

```typescript
import {
  createRoom, roomExists, addPlayer, hasPlayerName, toSnapshot,
  findRoomBySocket, removePlayer, cleanupRooms, _clearAllRooms,
  setReady, allReady,
} from './roomStore'
```

ファイル末尾（最後の `test(...)` の後）に以下を追加：

```typescript
test('setReady は指定プレイヤーを更新し allReady に反映される', () => {
  const room = createRoom('h', 'たろう')
  addPlayer(room, 'g1', 'はなこ', false)
  assert.equal(allReady(room), false)
  setReady(room, 'h', true)
  assert.equal(allReady(room), false) // はなこ未完了
  setReady(room, 'g1', true)
  assert.equal(allReady(room), true)  // 全員完了
  setReady(room, 'g1', false)
  assert.equal(allReady(room), false)
})

test('setReady は未知の socket では undefined を返し何も変えない', () => {
  const room = createRoom('h', 'たろう')
  assert.equal(setReady(room, 'nope', true), undefined)
  assert.equal(allReady(room), false) // host は未完了のまま
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL（`setReady`/`allReady` が export されていない）。

- [ ] **Step 3: `server/src/roomStore.ts` に実装を追加**

`touch` 関数の直後（`toSnapshot` の前）に追加：

```typescript
export function setReady(room: Room, socketId: string, isReady: boolean): Player | undefined {
  const player = room.players.get(socketId)
  if (player) player.isReady = isReady
  return player
}

export function allReady(room: Room): boolean {
  return room.players.size > 0 && [...room.players.values()].every(p => p.isReady)
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: PASS（既存4＋新規2＝6 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "feat: roomStore に setReady/allReady を追加"
```

---

## Task 3: prepare ハンドラ set_ready / start_recording（TDD 統合）

**Files:**
- Create: `server/src/handlers.prepare.test.ts`
- Modify: `server/src/handlers.ts`, `server/package.json`

**Interfaces:**
- Consumes: `setReady`, `allReady`, `findRoomBySocket`, `touch`（roomStore）、`startTestServer`/`connectClient`/`once`（testUtils）。
- Produces: `registerHandlers` に `set_ready`/`start_recording` を追加。

- [ ] **Step 1: 失敗するテストを書く（`server/src/handlers.prepare.test.ts`）**

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once } from './testUtils'
import { _clearAllRooms } from './roomStore'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

async function makeRoomWithTwo() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest, roomCode }
}

test('set_ready は ready_updated を配信し、全員完了までは allReady=false', async () => {
  const { host, guest } = await makeRoomWithTwo()
  const guestSaw = once<{ playerName: string; isReady: boolean; allReady: boolean }>(guest, 'ready_updated')
  host.emit('set_ready', { isReady: true })
  const u = await guestSaw
  assert.equal(u.playerName, 'たろう')
  assert.equal(u.isReady, true)
  assert.equal(u.allReady, false)
  host.disconnect(); guest.disconnect()
})

test('全員 set_ready で allReady=true になる', async () => {
  const { host, guest } = await makeRoomWithTwo()
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  const hostSaw = once<{ allReady: boolean }>(host, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  const u = await hostSaw
  assert.equal(u.allReady, true)
  host.disconnect(); guest.disconnect()
})

test('set_ready(false) で allReady が false に戻る', async () => {
  const { host, guest } = await makeRoomWithTwo()
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  const hostSaw = once<{ allReady: boolean }>(host, 'ready_updated')
  guest.emit('set_ready', { isReady: false })
  const u = await hostSaw
  assert.equal(u.allReady, false)
  host.disconnect(); guest.disconnect()
})

test('ホストの start_recording は全員に recording_started を配信', async () => {
  const { host, guest } = await makeRoomWithTwo()
  const guestRec = once(guest, 'recording_started')
  host.emit('start_recording')
  await guestRec
  host.disconnect(); guest.disconnect()
})

test('非ホストの start_recording は無視される', async () => {
  const { host, guest } = await makeRoomWithTwo()
  let hostGotRec = false
  host.on('recording_started', () => { hostGotRec = true })
  guest.emit('start_recording')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(hostGotRec, false)
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 2: `server/package.json` の test script に prepare テストを追加**

`"test"` を以下に置換（末尾に `src/handlers.prepare.test.ts` を追加）：

```json
    "test": "tsx --test src/roomCode.test.ts src/validation.test.ts src/roomStore.test.ts src/ai/scriptStub.test.ts src/handlers.connection.test.ts src/handlers.game.test.ts src/handlers.disconnect.test.ts src/handlers.prepare.test.ts"
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd server && timeout 40 npx tsx --test src/handlers.prepare.test.ts`
Expected: FAIL（`set_ready`/`start_recording` 未実装のため `ready_updated`/`recording_started` が来ず once が 3s で reject → 各テスト失敗）。

- [ ] **Step 4: `server/src/handlers.ts` に実装を追加**

roomStore の import 行を以下に置換（`setReady, allReady` を追加）：

```typescript
import {
  createRoom, getRoom, addPlayer, hasPlayerName, toSnapshot, touch, findRoomBySocket,
  removePlayer, deleteRoom, setReady, allReady,
} from './roomStore'
```

`start_game` ハンドラの閉じ `})` の後、`socket.on('disconnect', ...)` の前に以下を挿入：

```typescript
  socket.on('set_ready', ({ isReady }) => {
    const room = findRoomBySocket(socket.id)
    if (!room) return
    const player = setReady(room, socket.id, !!isReady)
    if (!player) return
    touch(room)
    io.to(room.code).emit('ready_updated', {
      playerName: player.name,
      isReady: player.isReady,
      allReady: allReady(room),
    })
  })

  socket.on('start_recording', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id) return
    room.status = 'recording'
    touch(room)
    io.to(room.code).emit('recording_started')
  })
```

- [ ] **Step 5: prepare テストと全スイートが通ることを確認**

Run: `cd server && timeout 40 npx tsx --test src/handlers.prepare.test.ts`
Expected: PASS（5 tests）。
Run: `cd server && npx tsc --noEmit`
Expected: exit 0。
Run: `cd server && timeout 90 npx tsx --test src/roomCode.test.ts src/validation.test.ts src/roomStore.test.ts src/ai/scriptStub.test.ts src/handlers.connection.test.ts src/handlers.game.test.ts src/handlers.disconnect.test.ts src/handlers.prepare.test.ts`
Expected: 全ファイル PASS（合計 31 tests：既存24 ＋ roomStore+2 ＋ prepare+5）。

- [ ] **Step 6: Commit**

```bash
git add server/src/handlers.ts server/src/handlers.prepare.test.ts server/package.json
git commit -m "feat: set_ready / start_recording ハンドラ（準備状態同期・録音開始配信）"
```

---

## Task 4: client GameContext.readyMap ＋ useGameSocket 拡張

**Files:**
- Modify: `client/src/App.tsx`, `client/src/useGameSocket.ts`

**Interfaces:**
- Consumes: `@shared` 経由のイベント型（Task 1）。
- Produces: `GameContext.readyMap: Record<string, boolean>`、`GameActions.setReady`/`startRecording`、`ready_updated`/`recording_started` リスナ。

- [ ] **Step 1: `client/src/App.tsx` の GameContext に readyMap を追加**

`GameContext` インターフェースの `players: PlayerSnapshot[]` の直後に1行追加：

```typescript
  players: PlayerSnapshot[]
  readyMap: Record<string, boolean>
  script: ScriptData | null
```

`INITIAL_CTX` の `players: [],` の直後に1行追加：

```typescript
  players: [],
  readyMap: {},
  script: null,
```

- [ ] **Step 2: `client/src/useGameSocket.ts` を全文置換**

```typescript
import { useEffect } from 'react'
import { socket } from './socket'
import type { Screen, GameContext } from './App'
import type { RoomSnapshot, PlayerSnapshot, ScriptData } from './types'

interface Params {
  setCtx: React.Dispatch<React.SetStateAction<GameContext>>
  setScreen: (s: Screen) => void
  setError: (msg: string) => void
  pushToast: (text: string, tone?: 'error' | 'info') => void
  setDissolved: (v: boolean) => void
}

export interface GameActions {
  createRoom: (playerName: string) => void
  joinRoom: (roomCode: string, playerName: string) => void
  setGenre: (genre: string) => void
  startGame: () => void
  setReady: (isReady: boolean) => void
  startRecording: () => void
  leaveRoom: () => void
}

export function useGameSocket({ setCtx, setScreen, setError, pushToast, setDissolved }: Params): GameActions {
  useEffect(() => {
    function onRoomCreated({ roomCode, room }: { roomCode: string; room: RoomSnapshot }) {
      setError('')
      setCtx(prev => ({
        ...prev, roomCode, isHost: true,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores,
      }))
      setScreen('lobby')
    }
    function onRoomJoined({ room }: { room: RoomSnapshot }) {
      setError('')
      setCtx(prev => ({
        ...prev, roomCode: room.code, isHost: false,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores,
      }))
      setScreen('lobby')
    }
    function onPlayerJoined({ player }: { player: PlayerSnapshot }) {
      setCtx(prev => ({ ...prev, players: [...prev.players, player] }))
    }
    function onPlayerLeft({ playerName }: { playerName: string }) {
      setCtx(prev => ({ ...prev, players: prev.players.filter(p => p.name !== playerName) }))
      pushToast(`${playerName} が退出しました`, 'info')
    }
    function onGenreChanged({ genre }: { genre: string }) {
      setCtx(prev => ({ ...prev, genre }))
    }
    function onScriptReady({ script }: { script: ScriptData }) {
      setCtx(prev => ({ ...prev, script }))
      setScreen('casting')
    }
    function onReadyUpdated({ playerName, isReady }: { playerName: string; isReady: boolean; allReady: boolean }) {
      setCtx(prev => ({ ...prev, readyMap: { ...prev.readyMap, [playerName]: isReady } }))
    }
    function onRecordingStarted() {
      setScreen('recording')
    }
    function onDissolved() {
      setDissolved(true)
    }
    function onError({ message }: { message: string }) {
      setError(message)      // Top画面のフォーム直下インライン表示用
      pushToast(message, 'error') // Top以外の画面でも握り潰されないようトースト表示
    }

    socket.on('room_created', onRoomCreated)
    socket.on('room_joined', onRoomJoined)
    socket.on('player_joined', onPlayerJoined)
    socket.on('player_left', onPlayerLeft)
    socket.on('genre_changed', onGenreChanged)
    socket.on('script_ready', onScriptReady)
    socket.on('ready_updated', onReadyUpdated)
    socket.on('recording_started', onRecordingStarted)
    socket.on('room_dissolved', onDissolved)
    socket.on('error', onError)

    return () => {
      socket.off('room_created', onRoomCreated)
      socket.off('room_joined', onRoomJoined)
      socket.off('player_joined', onPlayerJoined)
      socket.off('player_left', onPlayerLeft)
      socket.off('genre_changed', onGenreChanged)
      socket.off('script_ready', onScriptReady)
      socket.off('ready_updated', onReadyUpdated)
      socket.off('recording_started', onRecordingStarted)
      socket.off('room_dissolved', onDissolved)
      socket.off('error', onError)
    }
  }, [setCtx, setScreen, setError, pushToast, setDissolved])

  return {
    createRoom(playerName) {
      if (!socket.connected) socket.connect()
      setCtx(prev => ({ ...prev, playerName })) // 自分の名前を保持（配役画面の自己判定・ロビーの「あなた」表示に必要）
      socket.emit('create_room', { playerName })
    },
    joinRoom(roomCode, playerName) {
      if (!socket.connected) socket.connect()
      setCtx(prev => ({ ...prev, playerName }))
      socket.emit('join_room', { roomCode, playerName })
    },
    setGenre(genre) {
      socket.emit('set_genre', { genre })
    },
    startGame() {
      socket.emit('start_game')
    },
    setReady(isReady) {
      socket.emit('set_ready', { isReady })
    },
    startRecording() {
      socket.emit('start_recording')
    },
    leaveRoom() {
      socket.disconnect()
    },
  }
}
```

- [ ] **Step 3: 型チェック（PrepareScreen 未変更でもクリーンなこと）**

Run: `cd client && npx tsc --noEmit`
Expected: exit 0（readyMap は追加のみ・PrepareScreen は未変更で `onNavigate` を使い続けるため非破壊）。

- [ ] **Step 4: Commit**

```bash
git add client/src/App.tsx client/src/useGameSocket.ts
git commit -m "feat: client に readyMap と ready_updated/recording_started 配線・setReady/startRecording アクション追加"
```

---

## Task 5: PrepareScreen 実接続化

**Files:**
- Modify: `client/src/screens/PrepareScreen.tsx`, `client/src/App.tsx`

**Interfaces:**
- Consumes: `GameContext`（`readyMap`/`players`/`script`/`playerName`）、`GameActions`（`setReady`/`startRecording`）。
- Produces: props `{ ctx: GameContext; actions: GameActions }`。

- [ ] **Step 1: `client/src/screens/PrepareScreen.tsx` を全文置換**

```typescript
import { useState, useEffect, useCallback } from 'react'
import type { GameContext } from '../App'
import type { GameActions } from '../useGameSocket'
import { FULL_SCRIPT, getMockPlayer } from '../mockScript'

interface Props {
  ctx: GameContext
  actions: GameActions
}

const SKIP_UNLOCK_SEC = 30

type MicStatus = 'pending' | 'granted' | 'denied'

export default function PrepareScreen({ ctx, actions }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const [micStatus, setMicStatus] = useState<MicStatus>('pending')

  const requestMic = useCallback(async () => {
    setMicStatus('pending')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // 許可の確認だけ行い、録音は録音画面で開始するため即停止
      stream.getTracks().forEach(t => t.stop())
      setMicStatus('granted')
    } catch {
      setMicStatus('denied')
    }
  }, [])

  useEffect(() => { requestMic() }, [requestMic])

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const entries = ctx.script?.entries ?? FULL_SCRIPT
  const myPlayer = ctx.script ? ctx.playerName : getMockPlayer(ctx.isHost, ctx.playerName)

  const isReady = ctx.readyMap[ctx.playerName] === true
  const readyCount = ctx.players.filter(p => ctx.readyMap[p.name] === true).length
  const allReady = ctx.players.length > 0 && ctx.players.every(p => ctx.readyMap[p.name] === true)
  const timerExpired = elapsed >= SKIP_UNLOCK_SEC

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto pb-10">
      <div className="text-center py-6">
        <h1 className="text-2xl font-bold text-slate-900">準備タイム</h1>
        <p className="text-slate-500 text-sm mt-1">台本をよく読んで準備しよう</p>
      </div>

      {/* Full script */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 shadow-sm border border-sky-100">
        <p className="text-amber-600 text-xs font-bold tracking-wider mb-3">台本</p>
        <div className="space-y-2">
          {entries.map((entry, i) => {
            const isMe = entry.player === myPlayer
            return (
              <div
                key={i}
                className={`rounded-xl px-4 py-3 ${
                  isMe
                    ? 'bg-purple-50 border-l-4 border-purple-400'
                    : 'bg-sky-50 border-l-4 border-sky-200'
                }`}
              >
                <p className={`text-xs font-bold mb-1 ${isMe ? 'text-purple-600' : 'text-slate-400'}`}>
                  {entry.character}
                </p>
                {entry.action && (
                  <p className={`text-xs italic mb-1.5 ${isMe ? 'text-amber-600' : 'text-slate-400'}`}>
                    🎭 {entry.action}
                  </p>
                )}
                <p className={`text-sm leading-relaxed ${isMe ? 'text-slate-900 font-bold' : 'text-slate-500'}`}>
                  「{entry.line}」
                </p>
              </div>
            )
          })}
        </div>
        <p className="text-purple-500 text-xs mt-3">■ 紫色のハイライトがあなたのセリフです</p>
      </div>

      {/* マイク許可状態 */}
      {micStatus === 'denied' ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
          <p className="text-red-600 text-sm font-bold mb-1">🎤 マイクが使えません</p>
          <p className="text-red-500 text-xs leading-relaxed mb-3">
            録音にはマイクの許可が必要です。ブラウザのアドレスバーからマイクを許可して、再試行してください。
          </p>
          <button
            onClick={requestMic}
            className="w-full py-2 bg-red-500 hover:bg-red-400 text-white font-bold rounded-xl text-sm transition-colors"
          >
            マイク許可を再試行
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-4 px-1">
          <span
            className={`text-xs px-2 py-1 rounded-full font-medium ${
              micStatus === 'granted'
                ? 'bg-emerald-100 text-emerald-600'
                : 'bg-slate-100 text-slate-400'
            }`}
          >
            {micStatus === 'granted' ? '🎤 マイクOK' : '🎤 マイクを確認中...'}
          </span>
        </div>
      )}

      {/* Ready status */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-6 shadow-sm border border-sky-100">
        <p className="font-bold mb-3 text-slate-600 text-sm">
          準備状況{' '}
          <span className="text-purple-600">{readyCount}/{ctx.players.length}</span>
        </p>
        <div className="space-y-2">
          {ctx.players.map((p, i) => {
            const ready = ctx.readyMap[p.name] === true
            return (
              <div key={i} className="flex items-center justify-between">
                <span className="text-slate-700 text-sm">
                  {p.name}
                  {p.name === ctx.playerName && (
                    <span className="text-slate-400 text-xs ml-1">（あなた）</span>
                  )}
                </span>
                <span className={`text-sm font-medium ${ready ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {ready ? '✓ 準備完了' : '読み中...'}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* 全員：準備完了トグルボタン */}
      <button
        onClick={() => actions.setReady(!isReady)}
        disabled={micStatus !== 'granted'}
        className={`w-full py-4 font-bold text-lg rounded-2xl transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${
          isReady
            ? 'bg-emerald-50 border-2 border-emerald-400 text-emerald-700 hover:bg-red-50 hover:border-red-300 hover:text-red-500'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white'
        }`}
      >
        {isReady ? '✓ 準備完了（タップで取り消し）' : '準備完了！'}
      </button>

      {/* ホスト：録音開始ボタン */}
      {ctx.isHost && (
        <div className="mt-4 bg-white/80 backdrop-blur rounded-2xl p-4 shadow-sm border border-sky-100">
          <div className="flex items-center gap-4">
            {/* 円形タイマー */}
            <div className="flex-shrink-0 relative w-14 h-14">
              <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r="24" fill="none" stroke="#e0f2fe" strokeWidth="5" />
                <circle
                  cx="28" cy="28" r="24"
                  fill="none"
                  stroke={allReady ? '#9333ea' : timerExpired ? '#f59e0b' : '#7c3aed'}
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 24}`}
                  strokeDashoffset={`${2 * Math.PI * 24 * (timerExpired || allReady ? 0 : (SKIP_UNLOCK_SEC - elapsed) / SKIP_UNLOCK_SEC)}`}
                  style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-700">
                {allReady || timerExpired ? '✓' : SKIP_UNLOCK_SEC - elapsed}
              </span>
            </div>
            <button
              onClick={() => actions.startRecording()}
              disabled={!allReady && !timerExpired}
              className={`flex-1 py-3 font-bold rounded-2xl transition-colors text-sm ${
                allReady
                  ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-sm'
                  : timerExpired
                  ? 'bg-amber-500 hover:bg-amber-400 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {allReady
                ? '全員準備完了！録音開始 🎬'
                : timerExpired
                ? `スキップして開始 (${readyCount}/${ctx.players.length} 人完了)`
                : `録音開始 (${readyCount}/${ctx.players.length} 人準備完了)`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `client/src/App.tsx` の PrepareScreen 呼び出しを更新**

以下の行：

```typescript
      {screen === 'prepare'    && <PrepareScreen ctx={ctx} onNavigate={navigate} />}
```

を以下に置換（`onNavigate` を渡さず `actions` を渡す）：

```typescript
      {screen === 'prepare'    && <PrepareScreen ctx={ctx} actions={actions} />}
```

- [ ] **Step 3: 型チェックとビルド**

Run: `cd client && npx tsc --noEmit`
Expected: exit 0。
Run: `cd client && npm run build`
Expected: 成功（`✓ built`）。

- [ ] **Step 4: Commit**

```bash
git add client/src/screens/PrepareScreen.tsx client/src/App.tsx
git commit -m "feat: PrepareScreen を set_ready/ready_updated・start_recording に実接続化"
```

---

## Task 6: 2クライアント E2E と2タブ結合検証

**Files:**
- （一時ファイル）`server/_e2e_prepare.mjs`（検証後に削除）

**Interfaces:**
- Consumes: 稼働中の dev サーバー（:3001）と全ハンドラ。

- [ ] **Step 1: 検証スクリプトを作成（`server/_e2e_prepare.mjs`）**

```javascript
import { io } from 'socket.io-client'

const URL = 'http://localhost:3001'
const results = []
const ok = (n) => { results.push(['PASS', n]); console.log('PASS -', n) }
const fail = (n, d) => { results.push(['FAIL', n]); console.log('FAIL -', n, '::', d) }

const connect = () => io(URL, { forceNew: true, transports: ['websocket'], reconnection: false })
const once = (sock, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => { sock.off(ev, h); rej(new Error('timeout waiting ' + ev)) }, ms)
    function h(p) { clearTimeout(t); res(p) }
    sock.once(ev, h)
  })

async function main() {
  // 部屋を作り2人揃えてゲーム開始（casting へ）まで
  const host = connect()
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once(host, 'room_created')
  const guest = connect()
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'jidai' })
  await once(guest, 'genre_changed')
  host.emit('start_game')
  await Promise.all([once(host, 'script_ready'), once(guest, 'script_ready')])

  // set_ready: 片方だけ → allReady=false
  const g1 = once(guest, 'ready_updated')
  host.emit('set_ready', { isReady: true })
  const u1 = await g1
  if (u1.playerName === 'たろう' && u1.isReady === true && u1.allReady === false)
    ok('set_ready(host) -> ready_updated to guest, allReady=false')
  else fail('set_ready partial', JSON.stringify(u1))

  // 両方 → allReady=true
  const h2 = once(host, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  const u2 = await h2
  if (u2.allReady === true) ok('both ready -> allReady=true')
  else fail('allReady', JSON.stringify(u2))

  // host start_recording -> 両者 recording_started
  const rh = once(host, 'recording_started'), rg = once(guest, 'recording_started')
  host.emit('start_recording')
  await Promise.all([rh, rg])
  ok('host start_recording -> recording_started to both')

  host.close(); guest.close()
  const failed = results.filter(r => r[0] === 'FAIL').length
  console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`)
  process.exit(failed ? 1 : 0)
}
main().catch(e => { console.log('FATAL', e); process.exit(1) })
```

- [ ] **Step 2: dev サーバーを起動して検証**

別ターミナルで `cd server && npm run dev`（:3001）を起動しておく。次に：

Run: `cd server && timeout 40 node _e2e_prepare.mjs`
Expected: `3/3 checks passed`（exit 0）。

- [ ] **Step 3: 一時ファイルを削除**

Run: `rm -f server/_e2e_prepare.mjs`

- [ ] **Step 4: 2タブ結合検証（任意・ブラウザ）**

`cd server && npm run dev` と `cd client && npm run dev` を起動し、ブラウザ2タブで：
1. タブA作成→タブB参加→ホストがジャンル選択→開始→両者 casting へ。
2. 両タブで「台本を読む →」→ prepare へ（各自）。
3. 各タブで「準備完了！」→ 両タブの準備状況が同期（✓ 準備完了）。
4. 全員完了でホストの「録音開始」ボタンが紫（全員準備完了！録音開始🎬）に→押すと両タブが録音画面へ。
5. （別途）片方だけ準備完了→ホストは30秒経過でアンバー「スキップして開始」に→押すと両タブが録音画面へ。

Expected: すべて期待どおり。ズレがあれば該当タスクへ戻る。

- [ ] **Step 5: Commit（検証のみ・コード変更なしなら省略可）**

このタスクはコード変更を伴わない（検証のみ）。一時ファイルは削除済みのためコミット不要。B1 完了。

---

## Self-Review 結果

- **Spec coverage:** 設計書 §3(イベント)=Task1、§4(サーバー setReady/allReady + handlers)=Task2/3、§5(client readyMap/hook/PrepareScreen/App)=Task4/5、§7(テスト)=各TDD＋Task6。§2(決定A/B)は Task3 の start_recording 統合・Task5 のクライアントタイマー維持に反映。§8(実装順序)＝Task1-6。
- **Placeholder scan:** プレースホルダ無し。全コード・コマンド・期待値を明記。
- **Type consistency:** `set_ready`/`start_recording`/`ready_updated`/`recording_started` は Task1 定義と Task3(server)・Task4(client) 消費で一致。`setReady(room, socketId, isReady): Player|undefined`・`allReady(room): boolean` は Task2 定義と Task3 消費で一致。`GameActions.setReady/startRecording`・`GameContext.readyMap` は Task4 定義と Task5 消費で一致。
- **スコープ:** B1（準備同期＋録音遷移）に限定。録音中/評価/結果は B2/B3、Phase A 繰り越しは対象外と明記。
