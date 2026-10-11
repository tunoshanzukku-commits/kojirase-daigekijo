# 切断レジリエンスB5「本人再接続」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 非ホストの事故切断で本人を即削除せず60秒の猶予スロットで保持し、セッショントークン＋自動再接続で進行中の同じ部屋・同じ画面へ戻せるようにする。

**Architecture:** サーバーは `room.players` を socketId キーのまま維持し（案A）、Player に `token`/`disconnectedAt` を追加。切断→即削除せず猶予タイマー、再接続（`rejoin(token)`）で旧socketId→新socketId に付け替え（re-key）。`allReady`/`allReturned`/`uploadExpected` は切断中を除外。意図的退出は明示 `leave_room` で即削除（猶予なし）。クライアントは `reconnection:true`＋localStorage のトークンで再接続/リロード復帰し、`rejoined` の snapshot＋status から画面を復元。ホストは対象外（従来どおり解散）。

**Tech Stack:** TypeScript / Node20（server: tsx `--test`、型チェックは別途 `tsc --noEmit`）/ React18 + Vite（client: `tsc && vite build`）/ Socket.IO / 共有型は `shared/`（`@shared/*`、`client/src/types.ts` は `export * from '@shared/types'`）。

## Global Constraints

- 設計書: [docs/superpowers/specs/2026-07-25-backend-disconnect-resilience-B5-reconnect-design.md](../specs/2026-07-25-backend-disconnect-resilience-B5-reconnect-design.md)。
- **対象は非ホストのみ**。ホスト切断/`leave_room` は従来どおり `room_dissolved`＋`deleteRoom`。猶予・再接続はホストに適用しない。
- **猶予は約60秒**。テスト用に上書きフック（`__setGraceForTest`/`__resetGraceForTest`）を用意し、既存の `__setUploadTimeoutForTest` と同じ流儀にする。
- **意図的退出＝`leave_room` イベント**（disconnect reason 文字列に依存しない）。`leave_room` は即削除、`disconnect`（leave_room を経ない切断）は猶予。
- **`allReady`/`allReturned`/`uploadExpected` は `disconnectedAt==null`（接続中）のみで判定**。
- **fail-open/finalize/generationトークン/収集ゲート/abort_game を壊さない**。
- **server は tsx が型チェックしないため、`npx tsc --noEmit`（server）を検証ゲートにする**。`PlayerSnapshot.connected`・`Player.token/disconnectedAt` 追加で影響する全リテラルを網羅する。client は `npm run build`（tsc && vite build）clean。
- コミットの `Co-Authored-By` は `Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: 共有型・イベント契約＋roomStore データモデル/ヘルパー

**Files:**
- Modify: `shared/types.ts`（`PlayerSnapshot.connected`）
- Modify: `shared/events.ts`（`rejoin`/`leave_room`/`rejoined`/`rejoin_failed`/`player_disconnected`/`player_reconnected`、`room_created`/`room_joined` に token）
- Modify: `server/src/roomStore.ts`（Player 拡張・graceTimers・helpers・除外・snapshot）
- Test: `server/src/roomStore.test.ts`（新ヘルパーと除外のユニットテスト）

**Interfaces:**
- Produces:
  - `PlayerSnapshot { name; isHost; isReady; connected: boolean }`
  - `Player { …; token: string; disconnectedAt: number | null }`
  - `findPlayerByToken(token: string): { room: Room; player: Player } | undefined`
  - `reattachPlayer(room: Room, player: Player, newSocketId: string): void`
  - `allReady`/`allReturned` は接続中のみで判定、`toSnapshot` は `connected` を含む
  - S→C `rejoined: { room: RoomSnapshot; status: RoomStatus; selfName: string }`, `rejoin_failed: { message: string }`, `player_disconnected: { playerName: string }`, `player_reconnected: { playerName: string }`
  - C→S `rejoin: { token: string }`, `leave_room: ()`
  - `room_created`/`room_joined` payload に `token: string`

- [ ] **Step 1: 失敗するテストを書く（roomStore.test.ts）**

`server/src/roomStore.test.ts` の末尾に追加（import に `findPlayerByToken, reattachPlayer` を追加）:

```ts
test('addPlayer は一意な token と disconnectedAt=null を持つ', () => {
  const room = createRoom('sock-h', 'ホスト')
  const guest = addPlayer(room, 'sock-g', 'ゲスト', false)
  const host = room.players.get('sock-h')!
  assert.equal(typeof guest.token, 'string')
  assert.ok(guest.token.length > 0)
  assert.notEqual(guest.token, host.token)
  assert.equal(guest.disconnectedAt, null)
})

test('findPlayerByToken は token から room と player を引ける', () => {
  _clearAllRooms()
  const room = createRoom('sock-h', 'ホスト')
  const guest = addPlayer(room, 'sock-g', 'ゲスト', false)
  const found = findPlayerByToken(guest.token)
  assert.equal(found?.room.code, room.code)
  assert.equal(found?.player.name, 'ゲスト')
  assert.equal(findPlayerByToken('nope'), undefined)
})

test('reattachPlayer は socketId を付け替え disconnectedAt を消す', () => {
  _clearAllRooms()
  const room = createRoom('sock-h', 'ホスト')
  const guest = addPlayer(room, 'old-sock', 'ゲスト', false)
  guest.disconnectedAt = Date.now()
  reattachPlayer(room, guest, 'new-sock')
  assert.equal(room.players.has('old-sock'), false)
  assert.equal(room.players.get('new-sock')?.name, 'ゲスト')
  assert.equal(guest.socketId, 'new-sock')
  assert.equal(guest.disconnectedAt, null)
})

test('allReady は切断中プレイヤーを除外して判定', () => {
  _clearAllRooms()
  const room = createRoom('sock-h', 'ホスト')
  const g = addPlayer(room, 'sock-g', 'ゲスト', false)
  setReady(room, 'sock-h', true) // ホストだけ ready
  assert.equal(allReady(room), false)
  g.disconnectedAt = Date.now() // ゲスト切断中 → 除外
  assert.equal(allReady(room), true)
})

test('toSnapshot は connected を含む', () => {
  _clearAllRooms()
  const room = createRoom('sock-h', 'ホスト')
  const g = addPlayer(room, 'sock-g', 'ゲスト', false)
  g.disconnectedAt = Date.now()
  const snap = toSnapshot(room)
  const gs = snap.players.find(p => p.name === 'ゲスト')!
  assert.equal(gs.connected, false)
  assert.equal(snap.players.find(p => p.name === 'ホスト')!.connected, true)
})
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd server && npm test`
Expected: 上記5テストが FAIL（`findPlayerByToken`/`reattachPlayer` 未定義、`token`/`disconnectedAt`/`connected` 未実装）。

- [ ] **Step 3: shared 型とイベントを実装**

`shared/types.ts` の `PlayerSnapshot` に `connected` を追加:

```ts
export interface PlayerSnapshot {
  name: string
  isHost: boolean
  isReady: boolean
  connected: boolean
}
```

`shared/events.ts` の import に `RoomStatus` を追加し、イベントを追加:

```ts
import type { RoomSnapshot, PlayerSnapshot, ScriptData, PlayerScore, RoomStatus } from './types'
```

`ClientToServerEvents` に追加（`abort_game` の直後）:

```ts
  abort_game: () => void
  rejoin: (payload: { token: string }) => void
  leave_room: () => void
```

`ServerToClientEvents` の `room_created`/`room_joined` を変更し、末尾に4イベントを追加:

```ts
  room_created: (payload: { roomCode: string; room: RoomSnapshot; token: string }) => void
  room_joined: (payload: { room: RoomSnapshot; token: string }) => void
```
```ts
  evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void
  rejoined: (payload: { room: RoomSnapshot; status: RoomStatus; selfName: string }) => void
  rejoin_failed: (payload: { message: string }) => void
  player_disconnected: (payload: { playerName: string }) => void
  player_reconnected: (payload: { playerName: string }) => void
```

- [ ] **Step 4: roomStore を実装**

`server/src/roomStore.ts`:

冒頭に import 追加:
```ts
import { randomUUID } from 'node:crypto'
```

`Player` を拡張:
```ts
export interface Player {
  socketId: string
  name: string
  isHost: boolean
  isReady: boolean
  token: string
  disconnectedAt: number | null
}
```

`Room` に `graceTimers` を追加（`evaluationSeq` の下）:
```ts
  evaluationSeq: number
  graceTimers: Map<string, ReturnType<typeof setTimeout>>
```

`addPlayer` を変更:
```ts
export function addPlayer(room: Room, socketId: string, name: string, isHost: boolean): Player {
  const player: Player = { socketId, name, isHost, isReady: false, token: randomUUID(), disconnectedAt: null }
  room.players.set(socketId, player)
  return player
}
```

`createRoom` の room 初期化に `graceTimers: new Map(),` を追加（`evaluationSeq: 0,` の直後）。

`removePlayer` に graceTimer 掃除を追加（`uploadExpected.delete` の後）:
```ts
  room.uploadExpected.delete(socketId)
  const gt = room.graceTimers.get(socketId)
  if (gt) { clearTimeout(gt); room.graceTimers.delete(socketId) }
  return player
```

`clearRoomTimers` に graceTimers クリアを追加:
```ts
function clearRoomTimers(room: Room): void {
  if (room.uploadTimer) { clearTimeout(room.uploadTimer); room.uploadTimer = null }
  if (room.recordingTimer) { clearTimeout(room.recordingTimer); room.recordingTimer = null }
  for (const t of room.graceTimers.values()) clearTimeout(t)
  room.graceTimers.clear()
}
```

新ヘルパーを追加（`findRoomBySocket` の下あたり）:
```ts
export function findPlayerByToken(token: string): { room: Room; player: Player } | undefined {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (player.token === token) return { room, player }
    }
  }
  return undefined
}

// 事故切断→再接続で socketId が変わるため、旧socketId のエントリを新socketId へ付け替える。
// 旧socketId の transient/timer は掃除（録音中復帰は音声なし前提のため再マップ不要）。
export function reattachPlayer(room: Room, player: Player, newSocketId: string): void {
  const oldSocketId = player.socketId
  room.players.delete(oldSocketId)
  room.volumes.delete(oldSocketId)
  room.returned.delete(oldSocketId)
  room.audio.delete(oldSocketId)
  room.uploadExpected.delete(oldSocketId)
  const gt = room.graceTimers.get(oldSocketId)
  if (gt) { clearTimeout(gt); room.graceTimers.delete(oldSocketId) }
  player.socketId = newSocketId
  player.disconnectedAt = null
  room.players.set(newSocketId, player)
}
```

`allReady` を接続中のみに:
```ts
export function allReady(room: Room): boolean {
  const active = [...room.players.values()].filter(p => p.disconnectedAt == null)
  return active.length > 0 && active.every(p => p.isReady)
}
```

`toSnapshot` の player map に `connected` を追加:
```ts
    players: [...room.players.values()].map(p => ({
      name: p.name,
      isHost: p.isHost,
      isReady: p.isReady,
      connected: p.disconnectedAt == null,
    })),
```

`allReturned` を接続中のみに:
```ts
export function allReturned(room: Room): boolean {
  const active = [...room.players.values()].filter(p => p.disconnectedAt == null)
  return active.length > 0 && active.every(p => room.returned.has(p.socketId))
}
```

- [ ] **Step 5: テストと型チェックを実行**

Run: `cd server && npm test`
Expected: 追加5テスト PASS、既存も PASS。

Run: `cd server && npx tsc --noEmit`
Expected: 型エラー無し（`PlayerSnapshot.connected`・`Player` 拡張で壊れるリテラルがあれば修正。特に `handlers.ts` の `player_joined` emit は Task 2 で対応するが、この時点で tsc が落ちるなら該当箇所に `connected: true` を仮追加してよい）。

- [ ] **Step 6: コミット**

```bash
git add shared/types.ts shared/events.ts server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "feat: 再接続の土台（token/disconnectedAt・graceTimers・findPlayerByToken/reattach・除外・connected）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: サーバー — token 返却・leave_room・切断の猶予化

**Files:**
- Modify: `server/src/handlers.ts`（create_room/join_room で token、`removeNonHostAndNotify` 抽出、`leave_room`、`disconnect` 猶予化、`beginAudioCollection` の uploadExpected 除外、grace 定数＋テストフック）
- Test: `server/src/handlers.reconnect.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の `findPlayerByToken`/`reattachPlayer`/除外/`Player.token/disconnectedAt`/`graceTimers`。
- Produces: `__setGraceForTest(ms)`/`__resetGraceForTest()`。`room_created`/`room_joined` が token を返す。`leave_room`/猶予切断の挙動。

- [ ] **Step 1: grace 定数とテストフックを追加**

`server/src/handlers.ts` の `recordingLimitMs` フック群の下に追加:
```ts
const DEFAULT_GRACE_MS = 60_000
let graceMs = DEFAULT_GRACE_MS
export function __setGraceForTest(ms: number): void { graceMs = ms }
export function __resetGraceForTest(): void { graceMs = DEFAULT_GRACE_MS }
```

- [ ] **Step 2: 非ホスト退出処理を module 関数に抽出**

`beginAudioCollection` の近く（module スコープ）に追加。現在の `disconnect` の非ホスト分岐と等価だが、他プレイヤーへの配信は `io.to`（自分は既に居ない/退出中）で行う:
```ts
// 非ホストをルームから外し、退出を全員へ通知して収集/復帰のデッドロックを解消する。
// leave_room（即時）と猶予満了の両方から呼ぶ。
function removeNonHostAndNotify(io: IO, room: Room, socketId: string): void {
  const player = removePlayer(room, socketId)
  if (!player) return
  io.to(room.code).emit('player_left', { playerName: player.name })
  if (room.players.size === 0) {
    deleteRoom(room.code)
    return
  }
  touch(room)
  if (room.collectingAudio && room.uploadExpected.size === 0) {
    void finalizeEvaluation(io, room)
  }
  if (room.status === 'evaluating' && allReturned(room)) {
    resetRoom(room)
    io.to(room.code).emit('room_reset', { room: toSnapshot(room) })
  }
}
```
（import に `removePlayer`,`deleteRoom` があることを確認。`removePlayer` は既に import 済み、`deleteRoom` も import 済み。）

- [ ] **Step 3: create_room/join_room で token を返す**

`create_room` の emit を変更:
```ts
    const room = createRoom(socket.id, name)
    socket.join(room.code)
    const token = room.players.get(socket.id)!.token
    socket.emit('room_created', { roomCode: room.code, room: toSnapshot(room), token })
```

`join_room` の `player_joined` emit の直前/該当 emit を変更（`addPlayer` の戻り値 `player` を使用）:
```ts
    socket.emit('room_joined', { room: toSnapshot(room), token: player.token })
    socket.to(room.code).emit('player_joined', {
      player: { name: player.name, isHost: player.isHost, isReady: player.isReady, connected: true },
    })
```

- [ ] **Step 4: leave_room ハンドラを追加**

`return_to_lobby` ハンドラの近くに追加:
```ts
  socket.on('leave_room', () => {
    const room = findRoomBySocket(socket.id)
    if (!room) return
    const player = room.players.get(socket.id)
    if (!player) return
    if (player.isHost) {
      socket.to(room.code).emit('room_dissolved')
      deleteRoom(room.code)
      return
    }
    removeNonHostAndNotify(io, room, socket.id)
  })
```

- [ ] **Step 5: beginAudioCollection の uploadExpected を接続中のみに**

`beginAudioCollection` 内の `room.uploadExpected = new Set(room.players.keys())` を変更:
```ts
  room.uploadExpected = new Set(
    [...room.players.values()].filter(p => p.disconnectedAt == null).map(p => p.socketId),
  )
```

- [ ] **Step 6: disconnect を猶予化**

`disconnect` ハンドラ全体を置き換え:
```ts
  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id)
    if (!room) return
    const player = room.players.get(socket.id)
    if (!player) return
    if (player.isHost) {
      socket.to(room.code).emit('room_dissolved')
      deleteRoom(room.code)
      return
    }
    // 非ホストの事故切断 → 猶予（意図的退出は leave_room 経由で既に player 不在）
    player.disconnectedAt = Date.now()
    socket.to(room.code).emit('player_disconnected', { playerName: player.name })
    room.uploadExpected.delete(socket.id) // 収集中なら期待から外す（切断者は録音しない）
    touch(room)
    if (room.collectingAudio && room.uploadExpected.size === 0) {
      void finalizeEvaluation(io, room)
    }
    const code = room.code
    const socketId = socket.id
    const timer = setTimeout(() => {
      const r = getRoom(code)
      if (r !== room) return
      const p = room.players.get(socketId)
      if (!p || p.disconnectedAt == null) return // 復帰済み or 既に削除済み
      removeNonHostAndNotify(io, room, socketId)
    }, graceMs)
    timer.unref()
    room.graceTimers.set(socketId, timer)
  })
```
（`getRoom` が import 済みであることを確認。既に import 済み。）

- [ ] **Step 7: 失敗するテストを書く（handlers.reconnect.test.ts）**

`server/src/handlers.reconnect.test.ts` を新規作成。参考: `handlers.recording.test.ts` のハーネス。makeWaitingRoom を再掲（このファイル内ローカル）:
```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent } from './testUtils'
import { _clearAllRooms, getRoom } from './roomStore'
import { __setGraceForTest, __resetGraceForTest } from './handlers'

let server: Awaited<ReturnType<typeof startTestServer>>
beforeEach(async () => { _clearAllRooms(); server = await startTestServer() })
afterEach(async () => { __resetGraceForTest(); await server.close() })

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

async function makeRoom(port: number) {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const hc = await once<{ roomCode: string; token: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode: hc.roomCode, playerName: 'はなこ' })
  const gj = await once<{ token: string }>(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest, roomCode: hc.roomCode, hostToken: hc.token, guestToken: gj.token }
}

test('room_created / room_joined は token を返す', async () => {
  const { host, guest, hostToken, guestToken } = await makeRoom(server.port)
  assert.ok(hostToken && guestToken && hostToken !== guestToken)
  host.disconnect(); guest.disconnect()
})

test('非ホストの事故切断は即 player_left せず player_disconnected を配信（猶予保持）', async () => {
  __setGraceForTest(10_000)
  const { host, guest, roomCode } = await makeRoom(server.port)
  const dc = once<{ playerName: string }>(host, 'player_disconnected')
  guest.disconnect() // 事故切断（leave_room を経ない）
  const p = await dc
  assert.equal(p.playerName, 'はなこ')
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(getRoom(roomCode)?.players.size, 2) // まだ保持
  host.disconnect()
})

test('猶予内に rejoin(token) で復帰＝rejoined と player_reconnected', async () => {
  __setGraceForTest(10_000)
  const { host, guest, roomCode, guestToken } = await makeRoom(server.port)
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  const reconnected = once<{ playerName: string }>(host, 'player_reconnected')
  g2.emit('rejoin', { token: guestToken })
  const rj = await once<{ status: string; selfName: string }>(g2, 'rejoined')
  assert.equal(rj.selfName, 'はなこ')
  assert.equal(rj.status, 'waiting')
  assert.equal((await reconnected).playerName, 'はなこ')
  assert.equal(getRoom(roomCode)?.players.size, 2)
  host.disconnect(); g2.disconnect()
})

test('猶予満了で player_left（未復帰）', async () => {
  __setGraceForTest(200)
  const { host, guest, roomCode } = await makeRoom(server.port)
  const left = once<{ playerName: string }>(host, 'player_left')
  guest.disconnect()
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(getRoom(roomCode)?.players.size, 1)
  host.disconnect()
})

test('leave_room は即 player_left（猶予なし）', async () => {
  __setGraceForTest(10_000)
  const { host, guest } = await makeRoom(server.port)
  const left = once<{ playerName: string }>(host, 'player_left')
  guest.emit('leave_room')
  assert.equal((await left).playerName, 'はなこ')
  host.disconnect(); guest.disconnect()
})

test('無効トークンの rejoin は rejoin_failed', async () => {
  const c = connectClient(server.port)
  c.emit('rejoin', { token: 'bogus' })
  const f = await once<{ message: string }>(c, 'rejoin_failed')
  assert.ok(f.message)
  c.disconnect()
})
```
> 注: この時点で `rejoin` ハンドラは未実装のため「rejoin 系」テストは Task 3 で通す。Task 2 では `rejoin_failed`/`rejoined` を出す `rejoin` ハンドラが無い＝該当2テストは FAIL のままでよい（Step 8 の期待に明記）。トークン返却・猶予・leave_room・満了の4テストは Task 2 で GREEN にする。

- [ ] **Step 8: テストと型チェックを実行**

Run: `cd server && npm test`（`handlers.reconnect.test.ts` を `server/package.json` の `test` スクリプトへ追加してから）
Expected: token 返却／猶予保持／満了 player_left／leave_room 即時 の4テスト PASS。`rejoin` 系2テスト（復帰・rejoin_failed）は Task 3 まで FAIL（許容）。

`server/package.json` の `test` に ` src/handlers.reconnect.test.ts` を追記する。

Run: `cd server && npx tsc --noEmit`
Expected: 型エラー無し。

- [ ] **Step 9: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.reconnect.test.ts server/package.json
git commit -m "feat: token返却・leave_room・非ホスト切断を60秒猶予化（サーバー）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: サーバー — rejoin ハンドラ（付け替え＋状態復元）

**Files:**
- Modify: `server/src/handlers.ts`（`rejoin` ハンドラ追加）
- Test: `server/src/handlers.reconnect.test.ts`（rejoin 系を GREEN に・各 status の rejoin を追加）

**Interfaces:**
- Consumes: Task 1 の `findPlayerByToken`/`reattachPlayer`、Task 2 の猶予。
- Produces: `rejoin` → `rejoined`/`rejoin_failed`。

- [ ] **Step 1: rejoin ハンドラを実装**

`leave_room` ハンドラの近くに追加:
```ts
  socket.on('rejoin', ({ token }) => {
    const found = findPlayerByToken(token ?? '')
    if (!found) {
      socket.emit('rejoin_failed', { message: 'ルームに戻れませんでした' })
      return
    }
    const { room, player } = found
    reattachPlayer(room, player, socket.id) // 旧socketId→新socketId・disconnectedAt=null・graceTimer解除
    touch(room)
    socket.join(room.code)
    socket.emit('rejoined', { room: toSnapshot(room), status: room.status, selfName: player.name })
    socket.to(room.code).emit('player_reconnected', { playerName: player.name })
  })
```
（import に `findPlayerByToken`,`reattachPlayer` を追加。）

- [ ] **Step 2: casting/recording/evaluating の rejoin テストを追加**

`handlers.reconnect.test.ts` に、`handlers.recording.test.ts` の `makeRecordingRoom` パターンを参考に、進行中に落として rejoin する検証を追加（recording 状態を作るヘルパーはローカルに用意 or testUtils の makeRecordingRoom を import して guestToken を取得）。最小限、recording 状態での rejoin を1件:
```ts
import { makeRecordingRoom } from './testUtils'

test('recording 中に切断→rejoin で status=recording を復元', async () => {
  __setGraceForTest(10_000)
  __setRecordingLimitForTest(10_000)
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  // guest の token は makeRecordingRoom が返さないため、room から取得
  const guestToken = [...getRoom(roomCode)!.players.values()].find(p => !p.isHost)!.token
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  const rj = await once<{ status: string }>(g2, 'rejoined')
  assert.equal(rj.status, 'recording')
  host.disconnect(); g2.disconnect()
})
```
（import に `__setRecordingLimitForTest, __resetRecordingLimitForTest` を追加し、afterEach で reset。）

- [ ] **Step 3: テストと型チェックを実行**

Run: `cd server && npm test`
Expected: `handlers.reconnect.test.ts` 全 PASS（Task 2 で FAIL だった rejoin 系も GREEN）。既存も PASS。

Run: `cd server && npx tsc --noEmit`
Expected: 型エラー無し。

- [ ] **Step 4: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.reconnect.test.ts
git commit -m "feat: rejoin ハンドラ（token で付け替え・rejoined で状態復元）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: クライアント — 再接続の中核（socket/token/rejoin/状態復元/切断オーバーレイ）

**Files:**
- Modify: `client/src/socket.ts`（`reconnection:true`）
- Modify: `client/src/useGameSocket.ts`（token 保存・onConnect で rejoin・rejoined/rejoin_failed/onDisconnect・leaveRoom emit・リロード復帰）
- Modify: `client/src/App.tsx`（切断中オーバーレイ・`GameContext.rejoinedNoRecord`）

**Interfaces:**
- Consumes: Task 1〜3 の `token`/`rejoin`/`rejoined`/`rejoin_failed`/`player_disconnected`/`player_reconnected`/`leave_room`。
- Produces: `GameContext.rejoinedNoRecord: boolean`（録音中復帰フラグ・Task 5 の RecordingScreen が参照）。

- [ ] **Step 1: socket を自動再接続に**

`client/src/socket.ts` を変更:
```ts
// 再接続はトークン方式（rejoin）で復帰する。事故切断でも猶予内なら同じ部屋へ戻れる。
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 500,
})
```

- [ ] **Step 2: GameContext に rejoinedNoRecord を追加**

`client/src/App.tsx` の `GameContext` に `rejoinedNoRecord: boolean` を追加し、`INITIAL_CTX` に `rejoinedNoRecord: false,` を追加。

- [ ] **Step 3: token 保存/破棄と rejoin 配線（useGameSocket.ts）**

冒頭に定数:
```ts
const TOKEN_KEY = 'aishibai:reconnectToken'
```

`onRoomCreated`/`onRoomJoined` の payload に `token` を受け取り保存:
```ts
    function onRoomCreated({ roomCode, room, token }: { roomCode: string; room: RoomSnapshot; token: string }) {
      localStorage.setItem(TOKEN_KEY, token)
      setError('')
      setCtx(prev => ({ ...prev, roomCode, isHost: true,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores }))
      setScreen('lobby')
    }
    function onRoomJoined({ room, token }: { room: RoomSnapshot; token: string }) {
      localStorage.setItem(TOKEN_KEY, token)
      setError('')
      setCtx(prev => ({ ...prev, roomCode: room.code, isHost: false,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores }))
      setScreen('lobby')
    }
```

新規ハンドラを追加（effect 内）:
```ts
    function onConnect() {
      const token = localStorage.getItem(TOKEN_KEY)
      if (token) socket.emit('rejoin', { token }) // 自動再接続 or リロード復帰
    }
    function onRejoined({ room, status, selfName }: { room: RoomSnapshot; status: RoomStatus; selfName: string }) {
      setDisconnected(false)
      const me = room.players.find(p => p.name === selfName)
      const readyMap: Record<string, boolean> = {}
      room.players.forEach(p => { readyMap[p.name] = p.isReady })
      const noRecord = status === 'recording'
      setCtx(prev => ({
        ...prev,
        playerName: selfName,
        isHost: me?.isHost ?? false,
        roomCode: room.code,
        genre: room.genre,
        players: room.players,
        script: room.script,
        scores: room.scores,
        readyMap,
        leftPlayers: [],
        returnedPlayers: [],
        rejoinedNoRecord: noRecord,
      }))
      // status から画面復元
      if (status === 'waiting') setScreen('lobby')
      else if (status === 'casting') setScreen('casting')
      else if (status === 'recording') setScreen('recording')
      else if (status === 'evaluating') setScreen(room.scores.length > 0 ? 'result' : 'evaluating')
      else setScreen('lobby')
    }
    function onRejoinFailed() {
      localStorage.removeItem(TOKEN_KEY)
      setDisconnected(false)
      resetToTop() // App から Param で受け取る（下記）
      pushToast('ルームに戻れませんでした', 'error')
    }
    function onPlayerDisconnected({ playerName }: { playerName: string }) {
      setCtx(prev => ({ ...prev, players: prev.players.map(p => p.name === playerName ? { ...p, connected: false } : p) }))
      pushToast(`${playerName} の接続が切れました（復帰待ち…）`, 'info')
    }
    function onPlayerReconnected({ playerName }: { playerName: string }) {
      setCtx(prev => ({ ...prev, players: prev.players.map(p => p.name === playerName ? { ...p, connected: true } : p) }))
      pushToast(`${playerName} が復帰しました`, 'info')
    }
```
> `RoomStatus` を import: `import type { RoomSnapshot, PlayerSnapshot, ScriptData, RoomStatus } from './types'`。
> `setDisconnected` と `resetToTop` は新規 Param（Step 5 で App から渡す）。`resetToTop` を渡すため、App では `resetToTop` の定義を `useGameSocket(...)` 呼び出しより**上に移動**する（現状は下にあるため）。`RoomStatus` を import に追加。

`onDisconnect` を変更（事故切断でオーバーレイ表示。socket.io が自動再接続を試みる）:
```ts
    function onDisconnect(reason: string) {
      cancelRecording()
      // 自分が退出/解散でトークンを消している場合は再接続しない
      if (localStorage.getItem(TOKEN_KEY)) setDisconnected(true) // 「再接続中…」表示
    }
```

登録/解除リストに追加:
```ts
    socket.on('connect', onConnect)
    socket.on('rejoined', onRejoined)
    socket.on('rejoin_failed', onRejoinFailed)
    socket.on('player_disconnected', onPlayerDisconnected)
    socket.on('player_reconnected', onPlayerReconnected)
```
（cleanup にも対応する `socket.off(...)` を追加。）

リロード復帰（effect 末尾・登録の後）:
```ts
    if (localStorage.getItem(TOKEN_KEY) && !socket.connected) socket.connect()
```

- [ ] **Step 4: leaveRoom を leave_room 経由に、createRoom/joinRoom で古いトークン破棄**

```ts
    createRoom(playerName) {
      localStorage.removeItem(TOKEN_KEY)
      if (!socket.connected) socket.connect()
      setCtx(prev => ({ ...prev, playerName }))
      socket.emit('create_room', { playerName })
    },
    joinRoom(roomCode, playerName) {
      localStorage.removeItem(TOKEN_KEY)
      if (!socket.connected) socket.connect()
      setCtx(prev => ({ ...prev, playerName }))
      socket.emit('join_room', { roomCode, playerName })
    },
    ...
    leaveRoom() {
      socket.emit('leave_room')   // 意図的退出＝サーバー即削除（猶予なし）
      localStorage.removeItem(TOKEN_KEY)
      socket.disconnect()
    },
```
`onGameAborted`/`onRoomReset`/`onDissolved` でもトークンは破棄しない（同じ部屋の継続のため）。ただし `resetToTop`（App）ではトークン破棄する（Step 5）。

- [ ] **Step 5: App に切断オーバーレイと disconnected 状態を追加**

`client/src/App.tsx`:
- `const [disconnected, setDisconnected] = useState(false)` を追加。
- **`resetToTop` の定義を `useGameSocket(...)` 呼び出しより上へ移動**し、`localStorage.removeItem('aishibai:reconnectToken')` と `setDisconnected(false)` を追加。
- `useGameSocket({ ..., setDisconnected, resetToTop })` を渡す（`useGameSocket.ts` の `Params` に `setDisconnected: (v: boolean) => void` と `resetToTop: () => void` を追加）。
- 解散ダイアログの近くに「再接続中…」オーバーレイ:
```tsx
      {disconnected && (
        <div className="fixed inset-0 z-[65] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 shadow-lg border border-sky-100 text-center max-w-xs w-full">
            <div className="text-4xl mb-3">📶</div>
            <p className="font-bold text-slate-900 mb-1">接続が切れました</p>
            <p className="text-slate-500 text-sm">再接続中…</p>
          </div>
        </div>
      )}
```

- [ ] **Step 6: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` clean（`token`/`connected`/`RoomStatus`/`rejoinedNoRecord` の整合を tsc が検査）。

- [ ] **Step 7: コミット**

```bash
git add client/src/socket.ts client/src/useGameSocket.ts client/src/App.tsx
git commit -m "feat: クライアント再接続（reconnection:true・token・rejoin・状態復元・切断オーバーレイ・leave_room）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: クライアント — 復帰待ち表示・復帰トースト・録音中バナー

**Files:**
- Modify: `client/src/screens/RecordingScreen.tsx`（rejoinedNoRecord バナー＋録音非起動＝phase 初期値）
- Modify: `client/src/screens/LobbyScreen.tsx` / `CastingScreen.tsx` / `PrepareScreen.tsx`（参加者一覧に「復帰待ち…」バッジ）

**Interfaces:**
- Consumes: `GameContext.rejoinedNoRecord`（Task 4）、`RoomSnapshot.players[].connected`（Task 1 経由で ctx.players に反映）。

- [ ] **Step 1: 参加者一覧に「復帰待ち…」バッジ**

`ctx.players` を名前で一覧表示している各画面（`LobbyScreen.tsx`/`CastingScreen.tsx`/`PrepareScreen.tsx`）で、`p.connected === false` のプレイヤーに小さなバッジを添える。例（プレイヤー名の隣）:
```tsx
{p.connected === false && (
  <span className="ml-2 text-xs text-amber-600">📶 復帰待ち…</span>
)}
```
> 各画面の既存の players.map の該当箇所に挿入（実ファイルの構造に合わせる）。PrepareScreen は準備状況一覧、CastingScreen は「他のプレイヤーの役」一覧、LobbyScreen は参加者一覧。少なくとも LobbyScreen と PrepareScreen に入れる（CastingScreen は任意）。

- [ ] **Step 2: RecordingScreen に録音中復帰バナー＋録音非起動**

`client/src/screens/RecordingScreen.tsx`:
- phase 初期値を rejoin 時は録音フェーズから開始（カウントダウンを飛ばす）:
```tsx
  const [phase, setPhase] = useState<'countdown' | 'recording'>(ctx.rejoinedNoRecord ? 'recording' : 'countdown')
```
- 録音フェーズ表示の先頭（タイマー sticky の下あたり）に、`ctx.rejoinedNoRecord` のときバナー:
```tsx
      {ctx.rejoinedNoRecord && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-3 mb-4 text-center">
          <p className="text-amber-700 text-sm font-bold">⚠️ 接続が切れたため、この録音は記録されません</p>
          <p className="text-amber-600 text-xs mt-0.5">演技はそのまま続けてOKです</p>
        </div>
      )}
```
- **録音は起動しない**: RecordingScreen は録音の開始/停止を socket レイヤ（`onRecordingStarted`/`onRecordingStopped`）で行う設計のため、rejoin 時は `recording_started` が飛ばず recorder は起動しない＝追加のガード不要。ただし `onRecordingStopped`（useGameSocket）が `stopAndUpload` を呼ぶため、**録音を開始していない場合に `stopAndUpload` が安全に no-op であること**を `client/src/recorder.ts` で確認（アクティブなレコーダーが無ければアップロードしない）。no-op でない場合は、`ctx.rejoinedNoRecord` を見てアップロードを抑止するガードを `onRecordingStopped` に追加する。

- [ ] **Step 3: ビルドで型検証**

Run: `cd client && npm run build`
Expected: clean。

- [ ] **Step 4: コミット**

```bash
git add client/src/screens/RecordingScreen.tsx client/src/screens/LobbyScreen.tsx client/src/screens/CastingScreen.tsx client/src/screens/PrepareScreen.tsx
git commit -m "feat: 復帰待ちバッジ・復帰トースト・録音中復帰バナー（記録されません表示）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 実機/2タブ目視確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: dev 起動**
server（`npm --prefix server run dev`）＋client（`npm --prefix client run dev`）。2タブ（localhost:5173）でホスト＋ゲスト。

- [ ] **Step 2: 事故切断→自動復帰（配役/準備）**
配役 or 準備でゲスト側タブを**オフライン化（DevTools Network offline）→オンライン**に戻す。→ ゲストが同じ画面へ自動復帰、ホスト側に「復帰待ち…」→「復帰しました」。60秒以内。

- [ ] **Step 3: リロード復帰**
ゲスト側タブを**リロード**。→ localStorage のトークンで同じ部屋・同じ画面へ自動復帰。

- [ ] **Step 4: 録音中の復帰**
録音中にゲストをオフライン→オンライン。→ 録音画面に戻り「⚠️ 接続が切れたため録音されません（演技はOK）」バナー。結果は全員分出る（当該ゲストは音声なし＝最低点）。

- [ ] **Step 5: 猶予切れ・意図的退出**
ゲストを60秒以上オフライン→戻らず→「退出しました」。別途、ゲストが「退出」ボタン→即退出（復帰しない）。ホスト切断→従来どおり全員トップ（解散）。

---

## 完了条件
- サーバー全テスト PASS ＋ `server` の `npx tsc --noEmit` clean。
- `client` の `npm run build` clean。
- 2タブ目視: 事故切断/リロードで同一画面へ自動復帰・復帰待ち表示・録音中バナー・猶予切れで退出・意図退出/ホスト切断は従来どおり。
