# Phase B3 評価スタブ→結果→ロビー復帰 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 録音終了→評価(スタブ)→結果→ロビー復帰をサーバー同期し、EvaluatingScreen/ResultScreen を実接続化、既知バグ（結果後に新規参加不可）を room_reset で解消する。

**Architecture:** Phase A/B1/B2 と同じ。`shared/` にイベント追記、`server/` にスタブ評価・ハンドラ・resetRoom、`client/` は useGameSocket＋ctx 拡張と画面配線。`recording_stopped`(即時遷移) と `evaluation_complete`(スコア到着) を分離し Phase C の実評価遅延に備える。

**Tech Stack:** TypeScript(tsx)、Socket.io、React+Vite、`node:test`＋硬化済み `testUtils`。

## Global Constraints

- **離脱者算出**：`leftPlayers = recordingRoster \ (stop_recording 時点の在室者)`。録音開始時に `recordingRoster` をスナップショット。
- **`stop_recording`**：host のみ・`status==='recording'` のみ受理。`recording_stopped` と `evaluation_complete{scores, leftPlayers}` を **`io.to`（全員・host含む）** で配信。`room.status='evaluating'`。
- **`return_to_lobby`**：全員・`status==='evaluating'` のみ。`player_returned{playerName}` を `io.to`。**在室者全員が復帰**したら `resetRoom` ＋ `room_reset{room}` を `io.to`。
- **`resetRoom`**：`status='waiting'`, `script=null`, `scores=[]`, `bgm=null`, `recordingRoster=[]`, `volumes.clear()`, `returned.clear()`, `lastVolumeBroadcast=0`, 全員 `isReady=false`。**genre は保持**。players・host も保持。
- **disconnect 拡張**：ゲストが `status==='evaluating'` 中に離脱→残り全員が復帰済みなら `resetRoom`＋`room_reset`（デッドロック回避）。host 離脱は既存 `room_dissolved`。
- **EvaluatingScreen**：5ステップ演出の**最終ステップ到達 AND `ctx.scores.length>0`** で結果へ遷移（受信ドリブン）。
- **既知バグ回帰**：`room_reset` 後は `status==='waiting'` なので新規 `join_room` が通ること（統合テストで担保）。
- クライアントは 2-space インデント・セミコロンなし。サーバーは 2-space・セミコロンあり。

## File Structure

- `shared/events.ts`（変更）：C→S 2、S→C 4 イベント追加。`PlayerScore` を import に追加。
- `server/src/ai/scoreStub.ts`（新規）＋`server/src/ai/scoreStub.test.ts`（新規）。
- `server/src/roomStore.ts`（変更）：`recordingRoster`/`returned`、`createRoom` 初期化、`removePlayer` 掃除、`resetRoom`/`allReturned`。
- `server/src/roomStore.test.ts`（変更）：上記テスト。
- `server/src/handlers.ts`（変更）：`start_recording` 拡張、`stop_recording`/`return_to_lobby` 追加、`disconnect` 拡張。
- `server/src/handlers.evaluation.test.ts`（新規）：統合テスト。
- `server/package.json`（変更）：test スクリプトに新規2本追加。
- `client/src/App.tsx`（変更）：`GameContext` に `leftPlayers`/`returnedPlayers`、`INITIAL_CTX`、EvaluatingScreen に `ctx`、ResultScreen に `actions`。
- `client/src/useGameSocket.ts`（変更）：4 リスナ＋2 アクション。
- `client/src/screens/RecordingScreen.tsx`（変更）：録音終了→`stopRecording`、ゲストのデモボタン撤去。
- `client/src/screens/EvaluatingScreen.tsx`（変更）：受信ドリブン遷移。
- `client/src/screens/ResultScreen.tsx`（変更）：`ctx.scores`＋グレーカード＋`returnToLobby`。

---

### Task 1: shared イベント契約

**Files:**
- Modify: `shared/events.ts`

**Interfaces:**
- Produces: C→S `stop_recording`/`return_to_lobby`、S→C `recording_stopped`/`evaluation_complete`/`player_returned`/`room_reset`。

- [ ] **Step 1: import に PlayerScore 追加**

`shared/events.ts:1` を次に変更：

```typescript
import type { RoomSnapshot, PlayerSnapshot, ScriptData, PlayerScore } from './types'
```

- [ ] **Step 2: イベント追加**

`ClientToServerEvents` の末尾（`send_volume` の後）に追加：

```typescript
  stop_recording: () => void
  return_to_lobby: () => void
```

`ServerToClientEvents` の末尾（`volume_update` の後）に追加：

```typescript
  recording_stopped: () => void
  evaluation_complete: (payload: { scores: PlayerScore[]; leftPlayers: string[] }) => void
  player_returned: (payload: { playerName: string }) => void
  room_reset: (payload: { room: RoomSnapshot }) => void
```

- [ ] **Step 3: 型チェック（両側）**

Run: `cd server && npx tsc --noEmit` → PASS
Run: `cd client && npx tsc --noEmit` → PASS（既存コードは新イベント未使用なので影響なし）

- [ ] **Step 4: コミット**

```bash
git add shared/events.ts
git commit -m "feat: shared に評価→結果→ロビー復帰のイベント契約を追加"
```

---

### Task 2: スタブ評価（scoreStub.ts）

**Files:**
- Create: `server/src/ai/scoreStub.ts`
- Test: `server/src/ai/scoreStub.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Produces: `generateStubScores(playerNames: string[]): PlayerScore[]`。Task 4 の `stop_recording` が使う。

- [ ] **Step 1: テストを書く（RED）**

`server/src/ai/scoreStub.test.ts` を新規作成：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateStubScores } from './scoreStub'

test('generateStubScores は名前ごとに1件返す', () => {
  const scores = generateStubScores(['たろう', 'はなこ'])
  assert.equal(scores.length, 2)
  assert.deepEqual(scores.map(s => s.playerName), ['たろう', 'はなこ'])
})

test('各スコアは 1〜5、comment は非空', () => {
  const scores = generateStubScores(['たろう', 'はなこ', 'けんじ'])
  for (const s of scores) {
    for (const v of [s.acting, s.emotion, s.kojirase]) {
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 5, `score out of range: ${v}`)
    }
    assert.ok(s.comment.length > 0)
  }
})

test('同じ名前には決定的（テスト再現性）', () => {
  const a = generateStubScores(['たろう'])[0]
  const b = generateStubScores(['たろう'])[0]
  assert.deepEqual(a, b)
})

test('空入力は空配列', () => {
  assert.deepEqual(generateStubScores([]), [])
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/ai/scoreStub.test.ts`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: scoreStub.ts を実装**

`server/src/ai/scoreStub.ts` を新規作成：

```typescript
import type { PlayerScore } from '@shared/types'

// 名前から安定的に 1..5 を導出（同名なら同結果＝テスト決定的）。項目ごとに salt を変える。
function stableScore(name: string, salt: number): number {
  let h = salt >>> 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return (h % 5) + 1
}

export function generateStubScores(playerNames: string[]): PlayerScore[] {
  return playerNames.map(name => ({
    playerName: name,
    acting: stableScore(name, 1),
    emotion: stableScore(name, 2),
    kojirase: stableScore(name, 3),
    comment: `「${name}」の演技をAIが講評しました。（スタブ）`,
  }))
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/ai/scoreStub.test.ts`
Expected: PASS（4件）

- [ ] **Step 5: package.json の test に追加**

`server/package.json` の `"test"` スクリプト末尾に `src/ai/scoreStub.test.ts` を追加（1行のまま）。

- [ ] **Step 6: コミット**

```bash
git add server/src/ai/scoreStub.ts server/src/ai/scoreStub.test.ts server/package.json
git commit -m "feat: スタブ評価 generateStubScores（Phase C で Whisper+Claude に差替）"
```

---

### Task 3: roomStore に復帰・名簿状態＋resetRoom

**Files:**
- Modify: `server/src/roomStore.ts`
- Test: `server/src/roomStore.test.ts`

**Interfaces:**
- Consumes: なし。
- Produces: `Room.recordingRoster: string[]`、`Room.returned: Set<string>`、`resetRoom(room): void`、`allReturned(room): boolean`。Task 4 が使う。

- [ ] **Step 1: テストを書く（RED）**

`server/src/roomStore.test.ts` の末尾に追加（冒頭 import に `resetRoom`, `allReturned` を追加）：

```typescript
test('createRoom は recordingRoster 空・returned 空で初期化', () => {
  const room = createRoom('sock-h', 'ホスト')
  assert.deepEqual(room.recordingRoster, [])
  assert.equal(room.returned.size, 0)
})

test('removePlayer は returned からも削除', () => {
  const room = createRoom('sock-h', 'ホスト')
  addPlayer(room, 'sock-g', 'ゲスト', false)
  room.returned.add('sock-g')
  removePlayer(room, 'sock-g')
  assert.equal(room.returned.has('sock-g'), false)
})

test('allReturned は在室者全員が returned のとき true', () => {
  const room = createRoom('sock-h', 'ホスト')
  addPlayer(room, 'sock-g', 'ゲスト', false)
  room.returned.add('sock-h')
  assert.equal(allReturned(room), false)
  room.returned.add('sock-g')
  assert.equal(allReturned(room), true)
})

test('resetRoom は進行状態をクリアし genre を保持、isReady を false に', () => {
  const room = createRoom('sock-h', 'ホスト')
  addPlayer(room, 'sock-g', 'ゲスト', false)
  room.genre = 'comedy'
  room.status = 'evaluating'
  room.scores = [{ playerName: 'ホスト', acting: 3, emotion: 3, kojirase: 3, comment: 'x' }]
  room.bgm = 'dramatic'
  room.recordingRoster = ['ホスト', 'ゲスト']
  room.returned.add('sock-h')
  room.volumes.set('sock-h', { level: 0.5, ts: Date.now() })
  room.lastVolumeBroadcast = 123
  for (const p of room.players.values()) p.isReady = true

  resetRoom(room)

  assert.equal(room.status, 'waiting')
  assert.equal(room.script, null)
  assert.deepEqual(room.scores, [])
  assert.equal(room.bgm, null)
  assert.deepEqual(room.recordingRoster, [])
  assert.equal(room.returned.size, 0)
  assert.equal(room.volumes.size, 0)
  assert.equal(room.lastVolumeBroadcast, 0)
  assert.equal(room.genre, 'comedy') // 保持
  assert.ok([...room.players.values()].every(p => !p.isReady))
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL（`recordingRoster`/`returned`/`resetRoom`/`allReturned` 未定義）

- [ ] **Step 3: Room 型・createRoom・removePlayer を変更**

`Room` interface（`lastVolumeBroadcast: number` の後）に追加：

```typescript
  recordingRoster: string[]
  returned: Set<string>
```

`createRoom` の room リテラル（`lastVolumeBroadcast: 0,` の後）に追加：

```typescript
    recordingRoster: [],
    returned: new Set(),
```

`removePlayer` に `room.returned.delete(socketId)` を追加（`room.volumes.delete(socketId)` の隣）：

```typescript
export function removePlayer(room: Room, socketId: string): Player | undefined {
  const player = room.players.get(socketId)
  if (player) room.players.delete(socketId)
  room.volumes.delete(socketId)
  room.returned.delete(socketId)
  return player
}
```

- [ ] **Step 4: resetRoom・allReturned を追加**

`roomStore.ts` の末尾付近（`_clearAllRooms` の前）に追加：

```typescript
export function resetRoom(room: Room): void {
  room.status = 'waiting'
  room.script = null
  room.scores = []
  room.bgm = null
  room.recordingRoster = []
  room.volumes.clear()
  room.returned.clear()
  room.lastVolumeBroadcast = 0
  for (const p of room.players.values()) p.isReady = false
  // genre は保持（同じ部屋で再戦）
}

export function allReturned(room: Room): boolean {
  return room.players.size > 0 && [...room.players.keys()].every(id => room.returned.has(id))
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: PASS（既存＋追加4件）

- [ ] **Step 6: コミット**

```bash
git add server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "feat: roomStore に recordingRoster/returned・resetRoom/allReturned"
```

---

### Task 4: ハンドラ（stop_recording / return_to_lobby / disconnect 拡張）

**Files:**
- Modify: `server/src/handlers.ts`
- Test: `server/src/handlers.evaluation.test.ts`（新規）
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `generateStubScores`（Task 2）、`resetRoom`/`allReturned`/`Room.recordingRoster`/`returned`（Task 3）、既存 `findRoomBySocket`/`toSnapshot`/`touch`/`removePlayer`/`deleteRoom`。
- Produces: `stop_recording`/`return_to_lobby` の受信処理と `recording_stopped`/`evaluation_complete`/`player_returned`/`room_reset` 配信。

- [ ] **Step 1: 統合テストを書く（RED）**

`server/src/handlers.evaluation.test.ts` を新規作成：

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once } from './testUtils'
import { _clearAllRooms } from './roomStore'
import type { PlayerScore } from '@shared/types'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// status='recording' まで進めた host/guest を返す
async function makeRecordingRoom() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  host.emit('start_game')
  await once(guest, 'script_ready')
  await once(host, 'script_ready')
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  host.emit('start_recording')
  await once(guest, 'recording_started')
  await once(host, 'recording_started')
  return { host, guest, roomCode }
}

test('host の stop_recording は recording_stopped と evaluation_complete を全員へ', async () => {
  const { host, guest } = await makeRecordingRoom()
  const guestStopped = once(guest, 'recording_stopped')
  const hostStopped = once(host, 'recording_stopped')
  const guestEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(guest, 'evaluation_complete')
  host.emit('stop_recording')
  await Promise.all([guestStopped, hostStopped])
  const e = await guestEval
  assert.equal(e.scores.length, 2) // 在室2人
  assert.deepEqual(e.scores.map(s => s.playerName).sort(), ['たろう', 'はなこ'])
  assert.deepEqual(e.leftPlayers, [])
  host.disconnect(); guest.disconnect()
})

test('非ホストの stop_recording は無視', async () => {
  const { host, guest } = await makeRecordingRoom()
  let hostSaw = false
  host.on('recording_stopped', () => { hostSaw = true })
  guest.emit('stop_recording')
  await delay(250)
  assert.equal(hostSaw, false)
  host.disconnect(); guest.disconnect()
})

test('録音中に離脱したプレイヤーは leftPlayers に入りスコアから除外', async () => {
  const { host, guest } = await makeRecordingRoom()
  const hostLeft = once(host, 'player_left')
  guest.disconnect()
  await hostLeft // サーバーが removePlayer 済み
  const hostEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  const e = await hostEval
  assert.deepEqual(e.scores.map(s => s.playerName), ['たろう'])
  assert.deepEqual(e.leftPlayers, ['はなこ'])
  host.disconnect()
})

test('全員 return_to_lobby で room_reset・status=waiting', async () => {
  const { host, guest } = await makeRecordingRoom()
  host.emit('stop_recording')
  await once(guest, 'recording_stopped')
  await once(host, 'recording_stopped')
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  const guestReset = once<{ room: { status: string } }>(guest, 'room_reset')
  guest.emit('return_to_lobby')
  const r = await guestReset
  assert.equal(r.room.status, 'waiting')
  host.disconnect(); guest.disconnect()
})

test('一部だけ return_to_lobby では room_reset されない', async () => {
  const { host, guest } = await makeRecordingRoom()
  host.emit('stop_recording')
  await once(guest, 'recording_stopped')
  await once(host, 'recording_stopped')
  let reset = false
  guest.on('room_reset', () => { reset = true })
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  await delay(250)
  assert.equal(reset, false)
  host.disconnect(); guest.disconnect()
})

test('評価中に相手が離脱→残り全員復帰済みなら room_reset（デッドロック回避）', async () => {
  const { host, guest } = await makeRecordingRoom()
  host.emit('stop_recording')
  await once(guest, 'recording_stopped')
  await once(host, 'recording_stopped')
  host.emit('return_to_lobby')
  await once(host, 'player_returned')
  const hostReset = once(host, 'room_reset')
  guest.disconnect() // 復帰待ちの相手が抜ける → 残り(host)は復帰済み
  await hostReset
  host.disconnect()
})

test('room_reset 後は新規ゲストが join できる（既知バグ回帰）', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom()
  host.emit('stop_recording')
  await once(guest, 'recording_stopped')
  await once(host, 'recording_stopped')
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  const guestReset = once(guest, 'room_reset')
  guest.emit('return_to_lobby')
  await guestReset
  const g2 = connectClient(server.port)
  g2.emit('join_room', { roomCode, playerName: 'さぶろう' })
  await once(g2, 'room_joined') // status=waiting なので成功（進行中なら error になる）
  host.disconnect(); guest.disconnect(); g2.disconnect()
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/handlers.evaluation.test.ts`
Expected: FAIL（ハンドラ未実装）

- [ ] **Step 3: handlers.ts の import を追加**

`server/src/handlers.ts` の `./roomStore` import に `resetRoom, allReturned` を追加。新規行追加：`import { generateStubScores } from './ai/scoreStub'`。

- [ ] **Step 4: start_recording に roster スナップショットを追加**

既存 `start_recording` ハンドラの `room.status = 'recording'` の後に追加：

```typescript
    room.recordingRoster = [...room.players.values()].map(p => p.name)
```

- [ ] **Step 5: stop_recording / return_to_lobby ハンドラを追加**

`send_volume` ハンドラの後、`disconnect` の前に追加：

```typescript
  socket.on('stop_recording', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id || room.status !== 'recording') return
    const present = [...room.players.values()].map(p => p.name)
    const scores = generateStubScores(present)
    const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
    room.status = 'evaluating'
    room.scores = scores
    touch(room)
    io.to(room.code).emit('recording_stopped')
    io.to(room.code).emit('evaluation_complete', { scores, leftPlayers })
  })

  socket.on('return_to_lobby', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.status !== 'evaluating') return
    room.returned.add(socket.id)
    touch(room)
    const playerName = room.players.get(socket.id)?.name
    if (playerName) io.to(room.code).emit('player_returned', { playerName })
    if (allReturned(room)) {
      resetRoom(room)
      io.to(room.code).emit('room_reset', { room: toSnapshot(room) })
    }
  })
```

- [ ] **Step 6: disconnect にゲスト離脱時の room_reset 再判定を追加**

`disconnect` ハンドラのゲスト分岐（`else` ブロック）を次に変更：

```typescript
    } else {
      socket.to(room.code).emit('player_left', { playerName: player.name })
      if (room.players.size === 0) {
        deleteRoom(room.code)
      } else {
        touch(room)
        if (room.status === 'evaluating' && allReturned(room)) {
          resetRoom(room)
          io.to(room.code).emit('room_reset', { room: toSnapshot(room) })
        }
      }
    }
```

- [ ] **Step 7: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.evaluation.test.ts`
Expected: PASS（7件）

- [ ] **Step 8: package.json の test に追加 → 全テスト確認**

`server/package.json` の `"test"` スクリプト末尾に `src/handlers.evaluation.test.ts` を追加。
Run: `cd server && npm test`
Expected: PASS（既存＋Task2/3/4 追加分すべて）

- [ ] **Step 9: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.evaluation.test.ts server/package.json
git commit -m "feat: stop_recording/return_to_lobby/disconnect拡張（評価→結果→ロビー復帰）"
```

---

### Task 5: client の useGameSocket・GameContext 配線

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/useGameSocket.ts`

**Interfaces:**
- Consumes: S→C `recording_stopped`/`evaluation_complete`/`player_returned`/`room_reset`（Task 1/4）。
- Produces: `GameContext.leftPlayers: string[]`/`returnedPlayers: string[]`、`GameActions.stopRecording()`/`returnToLobby()`。Task 6 の画面が使う。

- [ ] **Step 1: GameContext と INITIAL_CTX に追加**

`client/src/App.tsx` の `GameContext` interface、`scores` 行の後に追加：

```typescript
  leftPlayers: string[]
  returnedPlayers: string[]
```

`INITIAL_CTX`、`scores: [],` の後に追加：

```typescript
  leftPlayers: [],
  returnedPlayers: [],
```

- [ ] **Step 2: （App.tsx の画面呼び出し変更は Task 6 で行う）**

Task 5 では `App.tsx` は `GameContext`/`INITIAL_CTX` 追加（Step 1）のみ、`useGameSocket` は Step 3 のみ変更する。**EvaluatingScreen/ResultScreen/RecordingScreen の呼び出し行は変更しない**（対応する画面 props は Task 6 で追加するため、ここで変えると tsc が割れる）。この Step は「変更しないことの確認」。

- [ ] **Step 3: useGameSocket にリスナ・アクションを追加**

`client/src/useGameSocket.ts`：

`GameActions` interface の `sendBgm` 行の後に追加：

```typescript
  stopRecording: () => void
  returnToLobby: () => void
```

`onBgmChanged` の後にリスナ関数を追加（`RoomSnapshot` は既に import 済み）：

```typescript
    function onRecordingStopped() {
      setScreen('evaluating')
    }
    function onEvaluationComplete({ scores, leftPlayers }: { scores: GameContext['scores']; leftPlayers: string[] }) {
      setCtx(prev => ({ ...prev, scores, leftPlayers }))
    }
    function onPlayerReturned({ playerName }: { playerName: string }) {
      setCtx(prev => ({ ...prev, returnedPlayers: [...new Set([...prev.returnedPlayers, playerName])] }))
    }
    function onRoomReset({ room }: { room: RoomSnapshot }) {
      setCtx(prev => ({
        ...prev,
        genre: room.genre,
        players: room.players,
        script: null,
        scores: [],
        readyMap: {},
        bgm: null,
        leftPlayers: [],
        returnedPlayers: [],
      }))
      setScreen('lobby')
    }
```

`socket.on('bgm_changed', onBgmChanged)` の後に登録を追加：

```typescript
    socket.on('recording_stopped', onRecordingStopped)
    socket.on('evaluation_complete', onEvaluationComplete)
    socket.on('player_returned', onPlayerReturned)
    socket.on('room_reset', onRoomReset)
```

`socket.off('bgm_changed', onBgmChanged)` の後に解除を追加：

```typescript
    socket.off('recording_stopped', onRecordingStopped)
    socket.off('evaluation_complete', onEvaluationComplete)
    socket.off('player_returned', onPlayerReturned)
    socket.off('room_reset', onRoomReset)
```

`return { ... }` のアクション群、`sendBgm` の後に追加：

```typescript
    stopRecording() {
      socket.emit('stop_recording')
    },
    returnToLobby() {
      socket.emit('return_to_lobby')
    },
```

- [ ] **Step 4: 型チェック**

Run: `cd client && npx tsc --noEmit`
Expected: PASS。Task 5 は画面呼び出しを変えないので単独で緑になる（新 ctx フィールド・新アクションは未使用だが型エラーにはならない）。App.tsx の画面呼び出し変更と画面 props 追加は Task 6 でまとめて緑化する。

- [ ] **Step 5: コミット**

```bash
git add client/src/App.tsx client/src/useGameSocket.ts
git commit -m "feat: client に評価→結果→ロビー復帰のリスナ・アクション・ctxを配線"
```

---

### Task 6: 画面の実接続化（Recording / Evaluating / Result）

**Files:**
- Modify: `client/src/screens/RecordingScreen.tsx`
- Modify: `client/src/screens/EvaluatingScreen.tsx`
- Modify: `client/src/screens/ResultScreen.tsx`

**Interfaces:**
- Consumes: `actions.stopRecording`/`actions.returnToLobby`（Task 5）、`ctx.scores`/`ctx.leftPlayers`/`ctx.returnedPlayers`/`ctx.players`/`ctx.playerName`。

- [ ] **Step 1: RecordingScreen を stop_recording 接続＋onNavigate 撤去**

`client/src/screens/RecordingScreen.tsx` は遷移が完全にサーバー駆動（`recording_stopped`）になるため、`onNavigate` を撤去する。

(a) import と Props から `onNavigate`/`NavigateFn` を削除：

```tsx
import type { GameContext } from '../App'
```
（`NavigateFn` を使っていた import 行から外す。）Props を `{ ctx, actions }` に、関数シグネチャを `export default function RecordingScreen({ ctx, actions }: Props) {` に。

(b) ホスト用「録音終了」ボタンの `onClick={() => onNavigate('evaluating')}` を変更：

```tsx
              onClick={() => actions.stopRecording()}
```

(c) ゲスト用ブロックの**デモボタン**（`（デモ）次の画面へ →` の `<button>`）を**削除**し、待機メッセージ枠だけ残す：

```tsx
          ) : (
            <div className="bg-white/70 rounded-2xl p-3 text-center border border-sky-100 mb-4">
              <p className="text-slate-500 text-sm">ホストが終了を押すまで演じ続けてください</p>
            </div>
          )}
```

(d) 録音タイマーの `MAX_SEC` 到達時のローカル遷移を撤去（5分自動終了はサーバー未実装＝非スコープ。ローカルだけ遷移すると同期が崩れるため）。該当 `useEffect` を次に変更：

```tsx
  useEffect(() => {
    if (phase !== 'recording') return
    if (elapsed >= MAX_SEC) return // 上限で停止。遷移はホストの録音終了（サーバー駆動）
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [phase, elapsed])
```

（これで `onNavigate` は RecordingScreen 内で未使用＝props から外して問題ない。遷移は host 含む全員が `recording_stopped` で行う。）

- [ ] **Step 2: EvaluatingScreen を受信ドリブンに**

`client/src/screens/EvaluatingScreen.tsx` を次のように変更。props に `ctx` を追加：

```tsx
import { useEffect, useState } from 'react'
import type { GameContext, NavigateFn } from '../App'

interface Props {
  ctx: GameContext
  onNavigate: NavigateFn
}
```

`export default function EvaluatingScreen({ ctx, onNavigate }: Props) {` に変更。`useEffect` を次に置換（ステップ進行と結果遷移を分離し、最終ステップでは `ctx.scores` 到着を待つ）：

```tsx
  useEffect(() => {
    if (step < STEPS.length - 1) {
      const t = setTimeout(() => setStep(s => s + 1), 1200)
      return () => clearTimeout(t)
    }
    // 最終ステップ：スコア到着後に結果へ（未着なら待機）
    if (ctx.scores.length === 0) return
    const t = setTimeout(() => onNavigate('result'), 1500)
    return () => clearTimeout(t)
  }, [step, ctx.scores, onNavigate])
```

- [ ] **Step 3: ResultScreen を ctx.scores＋グレーカード＋return に**

`client/src/screens/ResultScreen.tsx` を変更：

import と props（`onNavigate` は使わなくなるため撤去）：

```tsx
import type { GameContext } from '../App'
import type { GameActions } from '../useGameSocket'
import type { PlayerScore } from '../types'

interface Props {
  ctx: GameContext
  actions: GameActions
}
```

（`PlayerScore` は `total()` ヘルパーの引数型で使用。）`MOCK_SCORES` 定数を**削除**。`export default function ResultScreen({ ctx, actions }: Props) {` に変更し、先頭を：

```tsx
  const sorted = [...ctx.scores].sort((a, b) => total(b) - total(a))
  const returnedCount = ctx.returnedPlayers.length
  const totalCount = ctx.players.length
```

Winner banner は `sorted[0]?` でガード（空配列でも落ちないように）。例：

```tsx
      {sorted[0] && (
        <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-300 rounded-2xl p-4 mb-4 text-center shadow-sm">
          <p className="text-amber-600 text-xs font-bold tracking-wider mb-1">🥇 最優秀俳優賞</p>
          <p className="text-3xl font-bold text-slate-900">{sorted[0].playerName}</p>
          <p className="text-amber-600 text-sm mt-1">合計 {total(sorted[0])} 点</p>
        </div>
      )}
```

スコアカードのループは `sorted.map(...)`（従来の `sorted` が `MOCK_SCORES` 由来だったのを `ctx.scores` 由来に）。その**後ろ**にグレーの離脱カードを追加：

```tsx
        {ctx.leftPlayers.map(name => (
          <div key={`left-${name}`} className="rounded-2xl p-4 shadow-sm border bg-slate-100 border-slate-200 opacity-70">
            <div className="flex items-center gap-3">
              <span className="text-2xl grayscale">🚪</span>
              <div>
                <p className="font-bold text-slate-500">{name}</p>
                <p className="text-slate-400 text-xs">録音中に退出しました</p>
              </div>
            </div>
          </div>
        ))}
```

「ロビーへ戻る」ボタンを変更（`onNavigate('lobby', {...})` を廃止）：

```tsx
        <button
          onClick={() => actions.returnToLobby()}
          className="w-full py-3 bg-white hover:bg-sky-50 text-slate-700 font-bold rounded-2xl transition-colors shadow-sm border border-sky-200"
        >
          ロビーへ戻る
        </button>
        {returnedCount > 0 && (
          <p className="text-center text-slate-400 text-xs">
            {returnedCount}/{totalCount} 人がロビーへ戻りました…
          </p>
        )}
```

（実際の画面遷移は `room_reset` 受信時に全員同時。`Stars`/`total`/`MEDALS` の既存ヘルパーはそのまま利用。）

- [ ] **Step 4: App.tsx の画面呼び出しを更新（3画面まとめて）**

`client/src/App.tsx` の該当 3 行を、上で変更した各画面の新 props に合わせて更新：

```tsx
      {screen === 'recording'  && <RecordingScreen ctx={ctx} actions={actions} />}
      {screen === 'evaluating' && <EvaluatingScreen ctx={ctx} onNavigate={navigate} />}
      {screen === 'result'     && <ResultScreen ctx={ctx} actions={actions} />}
```

（RecordingScreen と ResultScreen は `onNavigate` を渡さない。EvaluatingScreen は `onNavigate` を維持し `ctx` を追加。）

- [ ] **Step 5: 型チェック・ビルド**

Run: `cd client && npx tsc --noEmit`
Expected: PASS

Run: `cd client && npx vite build`
Expected: 成功

- [ ] **Step 6: 手動 2 タブ確認（通しプレイ）**

サーバー・クライアント起動、2タブでホスト＋ゲスト。録音まで進め：
- ホスト「録音終了」→ **両タブ**が評価画面へ → 演出後に結果へ。
- 結果に `ctx.scores`（在室者分）が表示される。
- 片方が録音中に退出していれば、結果に**グレーの「退出」カード**が出る。
- 各自「ロビーへ戻る」→ 全員押すと**両タブがロビーへ**（room_reset）。
- ロビーで**新規タブが参加できる**（既知バグ解消）。

- [ ] **Step 7: コミット**

```bash
git add client/src/App.tsx client/src/screens/RecordingScreen.tsx client/src/screens/EvaluatingScreen.tsx client/src/screens/ResultScreen.tsx
git commit -m "feat: Evaluating/Result 実接続化・録音終了を stop_recording に接続"
```

---

## 完了条件

- サーバー全テスト green（`cd server && npm test`）：Task 2/3/4 追加分含む。既知バグ回帰テストが green。
- クライアント `tsc --noEmit` / `vite build` green。
- 2 タブ手動で 録音終了→評価→結果→ロビー復帰→再参加 の通しが成立。

## 非スコープ（この計画で触らない）

- 録音の 5 分自動終了タイマー（host 主導＋既存 idle クリーンアップで担保）。
- 実音声録音・アップロード、Whisper、Claude 採点、実台本生成（**Phase C**）。
- 引数なし emit ガード（既存共通パターン。全体 hardening として別途）。
- Phase A 繰り越し（`start_game` の genre/最小人数ガード、host 権限拒否の統合テスト網羅、正規名エコー）。
