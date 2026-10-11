# Phase C2 録音アップロード基盤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 各プレイヤーの録音を MediaRecorder で取り、ホストの録音終了を合図に HTTP POST でサーバーへアップロードし、サーバーが在室者全員分（またはタイムアウト）を集めてから評価へ進む基盤を作る（AI なし・評価はスタブ継続）。

**Architecture:** `stop_recording` はもう即 `evaluation_complete` を出さない。収集ウィンドウ（`collectingAudio` / `uploadExpected` / `uploadTimer`）を開いて `recording_stopped` を配信し、各クライアントが `POST /upload` で音声を送る。全員到達またはタイムアウトで `finalizeEvaluation` が 1 回だけ走り `evaluation_complete` を配信する。音声は `Room.audio`（インメモリ Buffer）に保持し、C3 で `finalizeEvaluation` 内の `generateStubScores` を Whisper+Claude に差し替えるだけにする。

**Tech Stack:** TypeScript / Express 4 / Socket.IO 4 / multer（memoryStorage）/ node:test + tsx / React 18 + Vite（クライアント）

## Global Constraints

- Socket イベント契約（`shared/events.ts`）は**追加も変更もしない**。変わるのは `evaluation_complete` の発火タイミングのみ。
- サーバーは in-memory。音声は `Room.audio` に保持し `resetRoom` / `removePlayer` / `deleteRoom` / `_clearAllRooms` で必ずクリアする（タイマーも同様に `clearTimeout`）。
- アップロード上限は **25 MB**（`25 * 1024 * 1024`）＝Whisper の入力上限に整合。
- アップロードのタイムアウト既定値は **15000 ms**。テストからは `__setUploadTimeoutForTest(ms)` / `__resetUploadTimeoutForTest()` で上書きする（`scriptGen` のテストフックと同型）。
- `io.to` で送信者を含む全員へ同時配信されるイベントを統合テストで待つときは、**必ず両方のリスナを登録してから emit する**（逐次 await は Windows で host 側を 100% 取りこぼす）。
- クライアントにテストフレームワークは無い。クライアント側の検証は `npm run build`（`tsc && vite build`）と 2 タブ手動確認で行う。
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` を付ける。
- 作業ブランチは `feature/phase-c2-recording-upload`（作成済み）。

## File Structure

| ファイル | 責務 |
|---|---|
| `server/src/roomStore.ts` (modify) | `Room` に収集ゲート状態（`audio`/`collectingAudio`/`uploadExpected`/`uploadTimer`）を持たせ、生成・リセット・削除で確実にクリアする |
| `server/src/handlers.ts` (modify) | `stop_recording` を収集開始に変更、`finalizeEvaluation` を公開、タイムアウト定数とテストフック、`disconnect` のデッドロック回避 |
| `server/src/uploadRoute.ts` (create) | `POST /upload` のみ。multer で受信し検証→格納→全員到達なら `finalizeEvaluation` を呼ぶ |
| `server/src/server.ts` (modify) | `registerUploadRoute(app, io)` を組み込む |
| `server/src/handlers.upload.test.ts` (create) | 収集ゲートとアップロード endpoint の統合テスト |
| `server/src/roomStore.test.ts` (modify) | 収集ゲート状態の単体テスト追加 |
| `server/src/testUtils.ts` (modify) | `makeRecordingRoom(port)` を共有ヘルパーとして公開（3 テストファイルで共用） |
| `server/src/handlers.recording.test.ts` (modify) | ローカル `makeRecordingRoom` を撤去し testUtils から import |
| `server/src/handlers.evaluation.test.ts` (modify) | ローカル `makeRecordingRoom` を撤去し testUtils から import、「即 `evaluation_complete`」前提の回帰テストを短縮タイムアウトで通す |
| `client/src/config.ts` (create) | `SERVER_URL` の単一定義（socket と upload で共有） |
| `client/src/recorder.ts` (create) | MediaRecorder のモジュール単位ライフサイクルとアップロード送信 |
| `client/src/socket.ts` (modify) | `SERVER_URL` を `config.ts` から参照 |
| `client/src/useGameSocket.ts` (modify) | `onRecordingStarted` で録音開始 / `onRecordingStopped` で確定＋送信 |

---

### Task 1: roomStore に収集ゲート状態を追加

**Files:**
- Modify: `server/src/roomStore.ts`
- Test: `server/src/roomStore.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `Room.audio: Map<string, { buffer: Buffer; mime: string }>`（キーは socketId）
  - `Room.collectingAudio: boolean`
  - `Room.uploadExpected: Set<string>`（到達待ちの socketId）
  - `Room.uploadTimer: ReturnType<typeof setTimeout> | null`
  - `deleteRoom(code: string): void` は保留中の `uploadTimer` を `clearTimeout` してから削除する

- [ ] **Step 1: Write the failing tests**

`server/src/roomStore.test.ts` の import 行に `deleteRoom` を追加する（既存 import を書き換え）:

```ts
import {
  createRoom, roomExists, addPlayer, hasPlayerName, toSnapshot,
  findRoomBySocket, removePlayer, cleanupRooms, _clearAllRooms,
  setReady, allReady, resetRoom, allReturned, deleteRoom,
} from './roomStore'
```

ファイル末尾に以下 4 テストを追記:

```ts
test('createRoom は収集ゲートの初期値を設定する', () => {
  const room = createRoom('sock-host', 'たろう')
  assert.equal(room.collectingAudio, false)
  assert.equal(room.audio.size, 0)
  assert.equal(room.uploadExpected.size, 0)
  assert.equal(room.uploadTimer, null)
})

test('removePlayer は audio と uploadExpected からも取り除く', () => {
  const room = createRoom('h', 'たろう')
  addPlayer(room, 'g1', 'はなこ', false)
  room.audio.set('g1', { buffer: Buffer.from([1, 2, 3]), mime: 'audio/webm' })
  room.uploadExpected.add('g1')
  removePlayer(room, 'g1')
  assert.equal(room.audio.has('g1'), false)
  assert.equal(room.uploadExpected.has('g1'), false)
})

test('resetRoom は収集ゲートをクリアする', () => {
  const room = createRoom('h', 'たろう')
  room.collectingAudio = true
  room.audio.set('h', { buffer: Buffer.from([1]), mime: 'audio/webm' })
  room.uploadExpected.add('h')
  room.uploadTimer = setTimeout(() => {}, 10_000)
  resetRoom(room)
  assert.equal(room.collectingAudio, false)
  assert.equal(room.audio.size, 0)
  assert.equal(room.uploadExpected.size, 0)
  assert.equal(room.uploadTimer, null)
})

test('deleteRoom は保留中の uploadTimer をクリアする', async () => {
  const room = createRoom('h', 'たろう')
  let fired = false
  room.uploadTimer = setTimeout(() => { fired = true }, 20)
  deleteRoom(room.code)
  assert.equal(room.uploadTimer, null)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(fired, false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL — `room.collectingAudio` などが `undefined`（`assert.equal(undefined, false)` で AssertionError）。

- [ ] **Step 3: Implement**

`server/src/roomStore.ts` の `Room` インターフェースに 4 フィールドを追加:

```ts
export interface Room {
  code: string
  status: RoomStatus
  genre: string
  script: ScriptData | null
  scores: PlayerScore[]
  players: Map<string, Player>
  hostSocketId: string
  createdAt: number
  lastActivityAt: number
  bgm: string | null
  volumes: Map<string, { level: number; ts: number }>
  lastVolumeBroadcast: number
  recordingRoster: string[]
  returned: Set<string>
  generatingScript: boolean
  // 録音アップロードの収集ゲート（C2）
  audio: Map<string, { buffer: Buffer; mime: string }>
  collectingAudio: boolean
  uploadExpected: Set<string>
  uploadTimer: ReturnType<typeof setTimeout> | null
}
```

`createRoom` の room リテラルに初期値を追加（`generatingScript: false,` の直後）:

```ts
    generatingScript: false,
    audio: new Map(),
    collectingAudio: false,
    uploadExpected: new Set(),
    uploadTimer: null,
```

タイマー解除の共通ヘルパーを `deleteRoom` の手前に追加:

```ts
function clearUploadTimer(room: Room): void {
  if (room.uploadTimer) {
    clearTimeout(room.uploadTimer)
    room.uploadTimer = null
  }
}
```

`removePlayer` に 2 行追加:

```ts
export function removePlayer(room: Room, socketId: string): Player | undefined {
  const player = room.players.get(socketId)
  if (player) room.players.delete(socketId)
  room.volumes.delete(socketId)
  room.returned.delete(socketId)
  room.audio.delete(socketId)
  room.uploadExpected.delete(socketId)
  return player
}
```

`deleteRoom` をタイマー解除付きに置き換え:

```ts
export function deleteRoom(code: string): void {
  const room = rooms.get(code)
  if (room) clearUploadTimer(room)
  rooms.delete(code)
}
```

`resetRoom` に収集ゲートのクリアを追加（`room.generatingScript = false` の直後、`lastVolumeBroadcast` の前）:

```ts
  room.generatingScript = false
  room.audio.clear()
  room.collectingAudio = false
  room.uploadExpected.clear()
  clearUploadTimer(room)
  room.lastVolumeBroadcast = 0
```

`cleanupRooms` の削除ループでタイマーを解除:

```ts
export function cleanupRooms(now: number, maxIdleMs: number): string[] {
  const deleted: string[] = []
  for (const [code, room] of rooms) {
    if (room.players.size === 0 || now - room.lastActivityAt > maxIdleMs) {
      clearUploadTimer(room)
      rooms.delete(code)
      deleted.push(code)
    }
  }
  return deleted
}
```

`_clearAllRooms` でも解除（テスト間に 15 秒タイマーが残らないようにする）:

```ts
export function _clearAllRooms(): void {
  for (const room of rooms.values()) clearUploadTimer(room)
  rooms.clear()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: PASS（全テスト green、`fail 0`）。

- [ ] **Step 5: Commit**

```bash
git add server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "$(cat <<'EOF'
feat: roomStore に録音収集ゲートの状態を追加

audio/collectingAudio/uploadExpected/uploadTimer を Room に持たせ、
removePlayer・resetRoom・deleteRoom・cleanupRooms・_clearAllRooms で
確実にクリア（タイマーの取りこぼし防止）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: テストヘルパー共通化 ＋ stop_recording を収集開始に変え finalizeEvaluation を作る

まず `makeRecordingRoom` を testUtils に共通化し（Task 3 の新テストからも使うため）、続いて `stop_recording` が即 `evaluation_complete` を出すのをやめ収集ウィンドウを開く。この時点では**タイムアウトと切断だけが finalize のトリガ**（アップロード経由は Task 3）。

**Files:**
- Modify: `server/src/testUtils.ts`
- Modify: `server/src/handlers.recording.test.ts`
- Modify: `server/src/handlers.evaluation.test.ts`
- Modify: `server/src/handlers.ts`

**Interfaces:**
- Consumes: Task 1 の `Room.audio` / `Room.collectingAudio` / `Room.uploadExpected` / `Room.uploadTimer`
- Produces:
  - `makeRecordingRoom(port: number): Promise<{ host: Socket; guest: Socket; roomCode: string }>`（`testUtils.ts`）— たろう(host)/はなこ(guest) の 2 人で `status='recording'` まで進める
  - `finalizeEvaluation(io: Server<ClientToServerEvents, ServerToClientEvents>, room: Room): void` — 冪等。`evaluation_complete` を配信する唯一の関数
  - `__setUploadTimeoutForTest(ms: number): void` / `__resetUploadTimeoutForTest(): void`

**注:** `handlers.recording.test.ts:19` と `handlers.evaluation.test.ts:20` の 2 つの `makeRecordingRoom` は機能的に同一（同じ名前・ジャンル・手順・戻り値。差はコメントと変数名のみ）であることを確認済み。共有版に置き換えても挙動は変わらない。

- [ ] **Step 0a: Extract the shared test helper**

`server/src/testUtils.ts` の末尾に共有ヘルパーを追加する（`connectClient` / `once` は同一モジュール内の既存関数）:

```ts
// status='recording' まで進めた host(たろう)/guest(はなこ) を返す。
// 複数の統合テストで共用する（重複コピーを増やさない）。
export async function makeRecordingRoom(
  port: number,
): Promise<{ host: Socket; guest: Socket; roomCode: string }> {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  // script_ready/recording_started は io.to で送信者含む全員へ同時配信されるため、
  // 逐次 await だと host 側の受信が listener 登録前に届き取りこぼす競合が発生する
  // （Windows で実測・再現性100%）。「先に両方 listen してから emit」で回避する。
  const scriptReadyGuest = once(guest, 'script_ready')
  const scriptReadyHost = once(host, 'script_ready')
  host.emit('start_game')
  await scriptReadyGuest
  await scriptReadyHost
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  const recStartedGuest = once(guest, 'recording_started')
  const recStartedHost = once(host, 'recording_started')
  host.emit('start_recording')
  await recStartedGuest
  await recStartedHost
  return { host, guest, roomCode }
}
```

`server/src/handlers.recording.test.ts`: ローカルの `makeRecordingRoom`（18〜47 行目のコメント＋関数定義）を削除し、import 行を差し替え、呼び出しに `server.port` を渡す:

```ts
import { startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom } from './testUtils'
```

同ファイル内の `makeRecordingRoom()` 呼び出しをすべて `makeRecordingRoom(server.port)` に変更する。

`server/src/handlers.evaluation.test.ts`: ローカルの `makeRecordingRoom`（19〜48 行目のコメント＋関数定義）を削除し、import 行を差し替える:

```ts
import { startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom } from './testUtils'
```

同ファイル内の `makeRecordingRoom()` 呼び出しをすべて `makeRecordingRoom(server.port)` に変更する（`makeEvaluatingRoom` 内の呼び出しを含む）。

- [ ] **Step 0b: Verify the refactor is behavior-neutral**

Run: `cd server && npm test`
Expected: PASS — `fail 0`。テストの中身は変えていないので、リファクタ前と同じ件数が green のままであること。

- [ ] **Step 0c: Commit the refactor separately**

```bash
git add server/src/testUtils.ts server/src/handlers.recording.test.ts server/src/handlers.evaluation.test.ts
git commit -m "$(cat <<'EOF'
refactor: makeRecordingRoom を testUtils に共通化

同一実装が2テストファイルに重複していたため port 引数版を共有化。
C2 の新規アップロードテストからも使う。挙動は不変。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1: Write the failing tests**

`server/src/handlers.evaluation.test.ts` の import に テストフックを追加:

```ts
import { __setUploadTimeoutForTest, __resetUploadTimeoutForTest } from './handlers'
```

`beforeEach` / `afterEach` を差し替え（収集ゲート導入後も既存の回帰テストが素早く finalize するように短縮する）:

```ts
beforeEach(async () => {
  _clearAllRooms()
  __setUploadTimeoutForTest(50) // アップロードしないテストは即タイムアウトで確定させる
  server = await startTestServer()
})
afterEach(async () => {
  __resetUploadTimeoutForTest()
  await server.close()
})
```

同ファイル末尾に「ゲートが開いていること」の新規テストを追記:

```ts
test('stop_recording 直後は evaluation_complete を出さず収集を待つ', async () => {
  __setUploadTimeoutForTest(5000) // タイムアウトで確定させない
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  // 誰もアップロードしていないので評価は始まらない
  await expectNoEvent(host, 'evaluation_complete', 300)
  host.disconnect(); guest.disconnect()
})

```

`expectNoEvent` と `makeRecordingRoom` の import は Step 0a で追加済み（追加作業は不要）。

**重要（収集ゲートの意味論）**: `uploadExpected` は **stop_recording 時点の在室者全員（ホストを含む）**。ホストも演者であり、その音声は C3 の採点に必須。ホストを待ち対象から外してはいけない（外すと Task 3 の `POST /upload` が `uploadExpected.has(socketId)` で**ホスト自身のアップロードを 409 で弾き**、2 人ルームではゲストの到達だけで finalize が走ってしまう）。

**disconnect ガードのテストは Task 3 で行う**: 「収集中の切断で残りだけ finalize」は、**先に誰かがアップロードして待ち対象が減っている**状態でしか発生しない（アップロード手段が無い本タスクでは、ホストが必ず待ち対象に残るため `size===0` に到達しない）。本タスクではガードのコードのみ実装し、その振る舞いの検証は `POST /upload` が入る Task 3 の「収集中に相手が離脱したら残りだけで finalize」テストが担う。

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/handlers.evaluation.test.ts`
Expected: FAIL — `__setUploadTimeoutForTest` が `./handlers` に存在せず import エラー、かつ新規 2 テストが失敗（現状は stop_recording が即 `evaluation_complete` を出すため `unexpected "evaluation_complete"`）。

- [ ] **Step 3: Implement**

`server/src/handlers.ts` の import に `Room` 型を追加（既存の roomStore import の直後に 1 行）:

```ts
import type { Room } from './roomStore'
```

`const VOLUME_BROADCAST_MS = 200` の下にタイムアウト定数とテストフックを追加:

```ts
const DEFAULT_UPLOAD_TIMEOUT_MS = 15_000
let uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS

export function __setUploadTimeoutForTest(ms: number): void {
  uploadTimeoutMs = ms
}
export function __resetUploadTimeoutForTest(): void {
  uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS
}
```

同じ位置に `finalizeEvaluation` を追加（`registerHandlers` の外・モジュールトップレベル）:

```ts
// evaluation_complete を配信する唯一の関数。全員のアップロード到達・タイムアウト・
// 収集中の切断のいずれからも呼ばれるため冪等にしてある。
// ★ C3 ではここの generateStubScores を room.audio を消費する Whisper+Claude 版に差し替える。
export function finalizeEvaluation(io: IO, room: Room): void {
  if (!room.collectingAudio) return
  room.collectingAudio = false
  if (room.uploadTimer) {
    clearTimeout(room.uploadTimer)
    room.uploadTimer = null
  }
  const present = [...room.players.values()].map(p => p.name)
  const scores = generateStubScores(present)
  const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
  room.scores = scores
  touch(room)
  io.to(room.code).emit('evaluation_complete', { scores, leftPlayers })
}
```

`stop_recording` ハンドラを丸ごと置き換え:

```ts
  socket.on('stop_recording', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id || room.status !== 'recording') return
    const code = room.code
    room.status = 'evaluating'
    room.audio.clear()
    room.collectingAudio = true
    room.uploadExpected = new Set(room.players.keys())
    touch(room)
    // recording_stopped が「録音を確定してアップロードせよ」の合図を兼ねる
    io.to(code).emit('recording_stopped')
    const timer = setTimeout(() => {
      if (getRoom(code) !== room) return // 解散後の発火は無視
      finalizeEvaluation(io, room)
    }, uploadTimeoutMs)
    timer.unref() // 保留タイマーがテストのプロセス終了を妨げないように
    room.uploadTimer = timer
    if (room.uploadExpected.size === 0) finalizeEvaluation(io, room)
  })
```

`disconnect` ハンドラの非ホスト分岐に、収集中のデッドロック回避を追加（`touch(room)` の直後・`allReturned` チェックの前）:

```ts
      } else {
        touch(room)
        // 収集中に待っている相手が抜けたら、残りだけで確定させる（デッドロック回避）
        if (room.collectingAudio && room.uploadExpected.size === 0) {
          finalizeEvaluation(io, room)
        }
        if (room.status === 'evaluating' && allReturned(room)) {
          resetRoom(room)
          io.to(room.code).emit('room_reset', { room: toSnapshot(room) })
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/handlers.evaluation.test.ts`
Expected: PASS — 新規 2 テストを含め全 green。既存の「`host の stop_recording は recording_stopped と evaluation_complete を全員へ`」「`録音中に離脱したプレイヤーは leftPlayers に入りスコアから除外`」は 50ms のタイムアウト finalize 経由で通る。

- [ ] **Step 5: Run the whole server suite for regressions**

Run: `cd server && npm test`
Expected: PASS（全ファイル green、`fail 0`）。

- [ ] **Step 6: Commit**

```bash
git add server/src/handlers.ts server/src/handlers.evaluation.test.ts
git commit -m "$(cat <<'EOF'
feat: stop_recording を音声収集ゲートに変更し finalizeEvaluation を分離

即 evaluation_complete を出さず collectingAudio/uploadExpected を開いて
recording_stopped を配信。タイムアウト（既定15s・テスト上書き可）と
収集中の切断から冪等な finalizeEvaluation で確定する。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: POST /upload エンドポイント

音声の実受信。全員到達で即 `finalizeEvaluation` を呼び、タイムアウトを待たずに評価へ進める。

**Files:**
- Create: `server/src/uploadRoute.ts`
- Modify: `server/src/server.ts`
- Modify: `server/package.json`
- Test: `server/src/handlers.upload.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 の `finalizeEvaluation(io, room)`・`__setUploadTimeoutForTest(ms)`、Task 1 の `Room.audio` / `Room.collectingAudio` / `Room.uploadExpected`
- Produces:
  - `registerUploadRoute(app: Express, io: Server<ClientToServerEvents, ServerToClientEvents>): void`
  - HTTP `POST /upload`（multipart）: フィールド `socketId`（必須）、ファイル `audio`（任意）、フィールド `skip`（任意）。200 `{ok:true}` / 400 `{ok:false}`（socketId 欠落）/ 409 `{ok:false}`（収集中でない・非メンバー）

- [ ] **Step 1: Install multer**

```bash
cd server && npm install multer && npm install --save-dev @types/multer
```

- [ ] **Step 2: Write the failing tests**

`server/src/handlers.upload.test.ts` を新規作成:

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, expectNoEvent, makeRecordingRoom } from './testUtils'
import { _clearAllRooms, getRoom } from './roomStore'
import { __setUploadTimeoutForTest, __resetUploadTimeoutForTest } from './handlers'
import type { PlayerScore } from '@shared/types'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  __setUploadTimeoutForTest(5000) // 既定はタイムアウトで確定させない（ゲートを見るため）
  server = await startTestServer()
})
afterEach(async () => {
  __resetUploadTimeoutForTest()
  await server.close()
})

// webm の先頭バイト列を模した少量のダミー音声
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])

function uploadAudio(port: number, socketId: string, bytes: Uint8Array = AUDIO) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('audio', new Blob([bytes], { type: 'audio/webm' }), 'take.webm')
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

function uploadSkip(port: number, socketId: string) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('skip', '1')
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

// 収集ウィンドウを開いた（stop_recording 済みの）host/guest を返す
async function makeCollectingRoom() {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  return { host, guest, roomCode }
}

test('収集中の /upload は受理され Room.audio に格納される', async () => {
  const { host, guest, roomCode } = await makeCollectingRoom()
  const res = await uploadAudio(server.port, host.id)
  assert.equal(res.status, 200)
  const stored = getRoom(roomCode)!.audio.get(host.id)
  assert.ok(stored, 'host の音声が格納されていること')
  assert.equal(stored.buffer.length, AUDIO.length)
  assert.match(stored.mime, /audio\/webm/)
  host.disconnect(); guest.disconnect()
})

test('全員のアップロードが揃うまで evaluation_complete は出ない', async () => {
  const { host, guest } = await makeCollectingRoom()
  await uploadAudio(server.port, host.id)
  await expectNoEvent(host, 'evaluation_complete', 300) // 片方だけでは確定しない
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  await uploadAudio(server.port, guest.id)
  const e = await hostEval
  assert.equal(e.scores.length, 2)
  assert.deepEqual(e.scores.map(s => s.playerName).sort(), ['たろう', 'はなこ'])
  host.disconnect(); guest.disconnect()
})

test('収集中でない /upload は 409 で拒否される', async () => {
  const { host, guest } = await makeRecordingRoom(server.port) // まだ stop_recording していない
  const res = await uploadAudio(server.port, host.id)
  assert.equal(res.status, 409)
  host.disconnect(); guest.disconnect()
})

test('部屋に属さない socketId の /upload は 409', async () => {
  const { host, guest } = await makeCollectingRoom()
  const res = await uploadAudio(server.port, 'not-a-real-socket-id')
  assert.equal(res.status, 409)
  host.disconnect(); guest.disconnect()
})

test('socketId 欠落の /upload は 400', async () => {
  const { host, guest } = await makeCollectingRoom()
  const form = new FormData()
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  const res = await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  assert.equal(res.status, 400)
  host.disconnect(); guest.disconnect()
})

test('skip マーカーだけでも収集は進み finalize される', async () => {
  const { host, guest, roomCode } = await makeCollectingRoom()
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  await uploadSkip(server.port, host.id)
  await uploadSkip(server.port, guest.id)
  const e = await hostEval // 音声ゼロでもタイムアウトを待たず確定する
  assert.equal(e.scores.length, 2)
  assert.equal(getRoom(roomCode)!.audio.size, 0)
  host.disconnect(); guest.disconnect()
})

test('未着があってもタイムアウトで evaluation_complete が出る', async () => {
  __setUploadTimeoutForTest(80)
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await uploadAudio(server.port, host.id) // guest は送らない
  const e = await hostEval
  assert.equal(e.scores.length, 2)
  host.disconnect(); guest.disconnect()
})

test('収集中に相手が離脱したら残りだけで finalize（デッドロック回避）', async () => {
  const { host, guest } = await makeCollectingRoom()
  await uploadAudio(server.port, host.id) // host は到達済み → 残りの待ち対象は guest だけ
  const hostEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(host, 'evaluation_complete')
  guest.disconnect() // 最後の待ち対象が抜ける → 残りだけで確定しなければならない
  const e = await hostEval
  assert.deepEqual(e.scores.map(s => s.playerName), ['たろう'])
  assert.deepEqual(e.leftPlayers, ['はなこ'])
  host.disconnect()
})

test('finalize 後に遅れて届いた /upload は 409 で弾かれる', async () => {
  const { host, guest, roomCode } = await makeCollectingRoom()
  const hostEval = once(host, 'evaluation_complete')
  await uploadSkip(server.port, host.id)
  await uploadSkip(server.port, guest.id)
  await hostEval // 収集ウィンドウは閉じた
  const res = await uploadAudio(server.port, host.id)
  assert.equal(res.status, 409)
  assert.equal(getRoom(roomCode)!.audio.size, 0)
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/handlers.upload.test.ts`
Expected: FAIL — `/upload` が未実装のため 404 が返り、`assert.equal(res.status, 200)` などが AssertionError（`404 !== 200`）。

- [ ] **Step 4: Implement the upload route**

`server/src/uploadRoute.ts` を新規作成:

```ts
import type { Express, Request, Response } from 'express'
import multer from 'multer'
import type { Server } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { findRoomBySocket, touch } from './roomStore'
import { finalizeEvaluation } from './handlers'

type IO = Server<ClientToServerEvents, ServerToClientEvents>

// Whisper の入力上限に整合させる
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
})

// 録音済み音声の受け口。socketId から部屋を解決するのでクライアントは roomCode を送らない。
// マイク拒否のクライアントは音声なし＋skip=1 を送り、サーバーの待機を解く。
export function registerUploadRoute(app: Express, io: IO): void {
  app.post('/upload', upload.single('audio'), (req: Request, res: Response) => {
    const socketId = typeof req.body?.socketId === 'string' ? req.body.socketId : ''
    if (!socketId) {
      res.status(400).json({ ok: false })
      return
    }
    const room = findRoomBySocket(socketId)
    if (!room || !room.collectingAudio || !room.uploadExpected.has(socketId)) {
      res.status(409).json({ ok: false })
      return
    }
    const file = req.file
    if (file && file.buffer.length > 0) {
      room.audio.set(socketId, { buffer: file.buffer, mime: file.mimetype })
      const name = room.players.get(socketId)?.name ?? socketId
      console.log(`[server] audio received: ${name} ${file.buffer.length} bytes ${file.mimetype}`)
    }
    room.uploadExpected.delete(socketId)
    touch(room)
    res.json({ ok: true })
    if (room.uploadExpected.size === 0) finalizeEvaluation(io, room)
  })
}
```

`server/src/server.ts` にルートを組み込む（`io` 生成後に登録する）:

```ts
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import cors from 'cors'
import { registerHandlers } from './handlers'
import { registerUploadRoute } from './uploadRoute'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'

export function buildServer() {
  const app = express()
  app.use(cors())
  app.get('/health', (_req, res) => res.json({ ok: true }))

  const httpServer = createServer(app)
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  })

  registerUploadRoute(app, io)
  io.on('connection', socket => registerHandlers(io, socket))

  return { app, httpServer, io }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/handlers.upload.test.ts`
Expected: PASS（9 テスト green、`fail 0`）。

- [ ] **Step 6: Register the new test file in the test script**

`server/package.json` の `test` スクリプト末尾に `src/handlers.upload.test.ts` を追加:

```json
    "test": "tsx --test src/roomCode.test.ts src/validation.test.ts src/roomStore.test.ts src/ai/scriptStub.test.ts src/handlers.connection.test.ts src/handlers.game.test.ts src/handlers.disconnect.test.ts src/handlers.prepare.test.ts src/volume.test.ts src/handlers.recording.test.ts src/ai/scoreStub.test.ts src/handlers.evaluation.test.ts src/ai/scriptGen.test.ts src/handlers.upload.test.ts"
```

- [ ] **Step 7: Run the whole server suite**

Run: `cd server && npm test`
Expected: PASS（全ファイル green、`fail 0`）。

- [ ] **Step 8: Commit**

```bash
git add server/src/uploadRoute.ts server/src/server.ts server/src/handlers.upload.test.ts server/package.json server/package-lock.json
git commit -m "$(cat <<'EOF'
feat: POST /upload で録音音声を受信し収集ゲートを閉じる

multer(memoryStorage・25MB上限) で受信し socketId から部屋を解決。
収集中でない/非メンバーは409で拒否、全員到達でタイムアウトを待たず
finalizeEvaluation を呼ぶ。skip マーカーでマイク拒否時も待機を解く。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: クライアントの録音とアップロード配線

**Files:**
- Create: `client/src/config.ts`
- Create: `client/src/recorder.ts`
- Modify: `client/src/socket.ts`
- Modify: `client/src/useGameSocket.ts`

**Interfaces:**
- Consumes: Task 3 の `POST /upload`（`socketId` 必須・`audio` ファイル・`skip` フィールド）
- Produces:
  - `SERVER_URL: string`（`client/src/config.ts`）
  - `startUploadRecorder(): void` / `stopAndUpload(socketId: string): Promise<void>`（`client/src/recorder.ts`）

**Note:** クライアントにテストフレームワークは無い。このタスクの自動検証は `npm run build`（`tsc && vite build`）まで。振る舞いの確認は Task 5 の 2 タブ手動確認で行う。

- [ ] **Step 1: Create the shared server URL constant**

`client/src/config.ts` を新規作成:

```ts
// socket 接続と音声アップロードで同じサーバーを指すための単一定義
export const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://localhost:3001'
```

`client/src/socket.ts` を書き換えて共有定数を使う:

```ts
import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { SERVER_URL } from './config'

// reconnection:false — Phase A はインメモリ＋socket.id同一性のため、切断は確定扱いにする。
// 自動再接続すると新しいsocket.idで孤児化する（サーバーは既にplayer_left/room_dissolved済み）。
// トークンによる再入室は Phase B/C（設計書§6の切断時UI）で対応する。
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: false,
  reconnection: false,
})
```

- [ ] **Step 2: Create the recorder module**

`client/src/recorder.ts` を新規作成:

```ts
import { SERVER_URL } from './config'

// MediaRecorder は画面コンポーネントの外（モジュールスコープ）で持つ。
// recording_stopped で RecordingScreen はアンマウントされるため、
// 画面に持たせると停止前にストリームが切れて blob を取り逃す。
let mediaRecorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let starting = false
// stopAndUpload / 再開始で世代を進め、遅れて解決した getUserMedia を無効化する。
// これが無いと、許可応答が遅れた回のストリームが停止されないまま次の回に居座り、
// 次回の録音開始をブロックしたうえ前の回の音声を送ってしまう。
let generation = 0

// 録音開始。冪等（多重呼び出しは無視）。マイク拒否時は録音なしのまま進み、
// 停止時に skip マーカーを送ってサーバーの待機を解く。
export function startUploadRecorder(): void {
  if (mediaRecorder || starting) return
  const myGeneration = ++generation
  starting = true
  chunks = []
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then(s => {
      if (myGeneration !== generation) {
        // すでに停止済み/次の回が始まっている：受け取ったストリームは即解放する
        s.getTracks().forEach(t => t.stop())
        return
      }
      starting = false
      stream = s
      const rec = new MediaRecorder(s)
      rec.ondataavailable = e => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      rec.start()
      mediaRecorder = rec
    })
    .catch(() => {
      if (myGeneration === generation) starting = false // マイク不許可：blob なし扱い
    })
}

function stopAndGetBlob(): Promise<Blob | null> {
  const rec = mediaRecorder
  mediaRecorder = null
  if (!rec || rec.state === 'inactive') return Promise.resolve(null)
  return new Promise<Blob | null>(resolve => {
    rec.onstop = () => {
      const blob = chunks.length > 0 ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null
      chunks = []
      resolve(blob)
    }
    // error 時に停止しないと Promise が永久に未解決になりアップロード自体が飛ぶ。
    // null 解決して呼び出し側の skip 送信に倒す。
    rec.onerror = () => {
      chunks = []
      resolve(null)
    }
    rec.stop()
  })
}

function releaseStream(): void {
  stream?.getTracks().forEach(t => t.stop())
  stream = null
}

// 録音を確定してサーバーへ送る。失敗しても UI は壊さない
// （サーバー側の収集タイムアウトで評価は必ず進む）。
export async function stopAndUpload(socketId: string): Promise<void> {
  generation++ // 進行中の getUserMedia を無効化する
  starting = false
  let blob: Blob | null = null
  try {
    blob = await stopAndGetBlob()
  } catch {
    blob = null
  }
  releaseStream()

  const form = new FormData()
  form.append('socketId', socketId)
  if (blob) form.append('audio', blob, 'take.webm')
  else form.append('skip', '1')

  try {
    await fetch(`${SERVER_URL}/upload`, { method: 'POST', body: form })
  } catch (e) {
    console.warn('[recorder] アップロードに失敗しました', e)
  }
}
```

- [ ] **Step 3: Wire the recorder into the socket layer**

`client/src/useGameSocket.ts` の import に追加:

```ts
import { startUploadRecorder, stopAndUpload } from './recorder'
```

`onRecordingStarted` と `onRecordingStopped` を差し替え:

```ts
    function onRecordingStarted() {
      setScreen('recording')
      startUploadRecorder() // 画面ではなく socket レイヤで録音を開始・停止する
    }
```

```ts
    function onRecordingStopped() {
      setScreen('evaluating')
      void stopAndUpload(socket.id) // 画面遷移と並行して録音を確定→アップロード
    }
```

- [ ] **Step 4: Verify the client builds**

Run: `cd client && npm run build`
Expected: PASS — `tsc` の型エラーなし、`vite build` が `✓ built in ...` で完了。

- [ ] **Step 5: Commit**

```bash
git add client/src/config.ts client/src/recorder.ts client/src/socket.ts client/src/useGameSocket.ts
git commit -m "$(cat <<'EOF'
feat: クライアントで MediaRecorder 録音とアップロードを配線

画面アンマウントを跨いで blob を確定できるよう recorder.ts をモジュール
単位で持ち、recording_started で開始・recording_stopped で確定して
POST /upload。マイク拒否時は skip を送る。SERVER_URL は config.ts に集約。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 録音時間の上限タイマー（台本想定時間＋1分で自動終了）

現在 `MAX_SEC = 300` はクライアントの表示専用で、上限に達しても録音は止まらない（終了はホスト主導のみ）。これをサーバー権威の自動終了にする。**録音上限＝台本の想定時間（暫定 90 秒の固定値）＋ 1 分＝150 秒**。想定時間は将来台本から算出できるよう単一の定数に閉じ込める。

**Files:**
- Modify: `shared/constants.ts`
- Modify: `server/src/roomStore.ts`
- Modify: `server/src/handlers.ts`
- Modify: `server/src/handlers.recording.test.ts`
- Modify: `client/src/screens/RecordingScreen.tsx`

**Interfaces:**
- Consumes: Task 2 の `finalizeEvaluation` と収集ゲート一式
- Produces:
  - `SCRIPT_ESTIMATE_SEC = 90` / `RECORDING_BUFFER_SEC = 60` / `RECORDING_LIMIT_SEC = 150`（`shared/constants.ts`）
  - `beginAudioCollection(io: IO, room: Room): void` — 録音を終了し収集ウィンドウを開く。ホストの `stop_recording` と上限タイマーの**両方**から呼ばれる唯一の経路
  - `Room.recordingTimer: ReturnType<typeof setTimeout> | null`
  - `__setRecordingLimitForTest(ms: number)` / `__resetRecordingLimitForTest()`

- [ ] **Step 1: Add the shared constants**

`shared/constants.ts` の末尾に追加:

```ts
// 録音時間の上限（サーバーが自動終了させる）＝「台本の想定時間 ＋ 1分」。
// 想定時間はいまは固定値。将来ここを台本から算出する関数に差し替えられるよう
// 1箇所に閉じ込めてある（RECORDING_LIMIT_SEC 以外を直接参照しないこと）。
export const SCRIPT_ESTIMATE_SEC = 90
export const RECORDING_BUFFER_SEC = 60
export const RECORDING_LIMIT_SEC = SCRIPT_ESTIMATE_SEC + RECORDING_BUFFER_SEC // 150
```

- [ ] **Step 2: Write the failing tests**

`server/src/handlers.recording.test.ts` の import を 2 行差し替える（`getRoom` とテストフックを足す）:

```ts
import { _clearAllRooms, getRoom } from './roomStore'
import { __setRecordingLimitForTest, __resetRecordingLimitForTest } from './handlers'
```

既存の `afterEach` 本体の先頭に 1 行追加（テスト間で上限が漏れないように）:

```ts
  __resetRecordingLimitForTest()
```

ファイル末尾に 3 テストを追記:

```ts
test('録音時間の上限に達すると自動で recording_stopped が配信される', async () => {
  __setRecordingLimitForTest(200) // 上限を短縮（makeRecordingRoom より前に設定すること）
  const { host, guest } = await makeRecordingRoom(server.port)
  // ホストは stop_recording を送らない。上限タイマーだけで終了すること。
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  await Promise.all([stoppedGuest, stoppedHost])
  host.disconnect(); guest.disconnect()
})

test('ホストが上限前に停止したら上限タイマーは二重に発火しない', async () => {
  __setRecordingLimitForTest(300)
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedGuest, stoppedHost])
  // 上限(300ms)を跨いでも 2 回目の recording_stopped は来ない（タイマーは解除済み）
  await expectNoEvent(guest, 'recording_stopped', 500)
  host.disconnect(); guest.disconnect()
})

test('収集中に上限タイマーが満了しても収集はやり直されない', async () => {
  __setRecordingLimitForTest(300)
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedGuest, stoppedHost])
  const room = getRoom(roomCode)!
  assert.equal(room.collectingAudio, true)
  // 上限を跨いでも beginAudioCollection は status ガードで空振りし、
  // 収集ウィンドウが作り直されない（アップロードのタイムアウトは既定 15s のまま）
  await new Promise(r => setTimeout(r, 500))
  assert.equal(room.collectingAudio, true)
  assert.equal(room.status, 'evaluating')
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/handlers.recording.test.ts`
Expected: FAIL — `__setRecordingLimitForTest` が `./handlers` に存在せず import エラー（実装後、1 番目のテストは自動終了が無ければ `timeout waiting for "recording_stopped"` で落ちる）。

- [ ] **Step 4: Add the recordingTimer to roomStore**

`server/src/roomStore.ts` の `Room` に 1 フィールド追加（`uploadTimer` の直後）:

```ts
  recordingTimer: ReturnType<typeof setTimeout> | null
```

`createRoom` の初期化に追加（`uploadTimer: null,` の直後）:

```ts
    recordingTimer: null,
```

既存の `clearUploadTimer` を両方のタイマーを解除する版に置き換える（名前も実態に合わせる）:

```ts
function clearRoomTimers(room: Room): void {
  if (room.uploadTimer) {
    clearTimeout(room.uploadTimer)
    room.uploadTimer = null
  }
  if (room.recordingTimer) {
    clearTimeout(room.recordingTimer)
    room.recordingTimer = null
  }
}
```

`clearUploadTimer(room)` の呼び出し 4 箇所（`deleteRoom` / `resetRoom` / `cleanupRooms` / `_clearAllRooms`）をすべて `clearRoomTimers(room)` に置き換える。

- [ ] **Step 5: Extract beginAudioCollection and arm the limit timer**

`server/src/handlers.ts` の定数 import に `RECORDING_LIMIT_SEC` を追加:

```ts
import { NAME_MAX, MAX_PLAYERS, RECORDING_LIMIT_SEC } from '@shared/constants'
```

アップロードのタイムアウト定数群の隣に、録音上限とテストフックを追加:

```ts
const DEFAULT_RECORDING_LIMIT_MS = RECORDING_LIMIT_SEC * 1000
let recordingLimitMs = DEFAULT_RECORDING_LIMIT_MS

export function __setRecordingLimitForTest(ms: number): void {
  recordingLimitMs = ms
}
export function __resetRecordingLimitForTest(): void {
  recordingLimitMs = DEFAULT_RECORDING_LIMIT_MS
}
```

`finalizeEvaluation` の隣（モジュールトップレベル）に、録音終了の共通経路を追加:

```ts
// 録音を終了し音声収集ウィンドウを開く。ホストの stop_recording と
// 録音時間上限のタイマーの両方から呼ばれる唯一の経路。
export function beginAudioCollection(io: IO, room: Room): void {
  if (room.status !== 'recording') return // 二重終了・満了時の空振りを封じる
  const code = room.code
  if (room.recordingTimer) {
    clearTimeout(room.recordingTimer)
    room.recordingTimer = null
  }
  room.status = 'evaluating'
  room.audio.clear()
  room.collectingAudio = true
  room.uploadExpected = new Set(room.players.keys())
  touch(room)
  // recording_stopped が「録音を確定してアップロードせよ」の合図を兼ねる
  io.to(code).emit('recording_stopped')
  const timer = setTimeout(() => {
    if (getRoom(code) !== room) return // 解散後の発火は無視
    finalizeEvaluation(io, room)
  }, uploadTimeoutMs)
  timer.unref()
  room.uploadTimer = timer
  if (room.uploadExpected.size === 0) finalizeEvaluation(io, room)
}
```

`stop_recording` ハンドラをガードだけ残して委譲する形に置き換え:

```ts
  socket.on('stop_recording', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id || room.status !== 'recording') return
    beginAudioCollection(io, room)
  })
```

`start_recording` ハンドラに上限タイマーの武装を追加:

```ts
  socket.on('start_recording', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id) return
    if (room.status !== 'casting') return
    const code = room.code
    room.status = 'recording'
    room.recordingRoster = [...room.players.values()].map(p => p.name)
    touch(room)
    io.to(code).emit('recording_started')
    // 台本想定時間＋1分で自動終了（ホストが押し忘れても録音が終わる）
    const timer = setTimeout(() => {
      if (getRoom(code) !== room) return
      beginAudioCollection(io, room)
    }, recordingLimitMs)
    timer.unref()
    room.recordingTimer = timer
  })
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/handlers.recording.test.ts`
Expected: PASS（新規 3 件を含め green、`fail 0`）。

- [ ] **Step 7: Use the shared limit on the client**

`client/src/screens/RecordingScreen.tsx` のローカル定数 `const MAX_SEC = 300` を削除し、共有定数を使う。import を追加:

```ts
import { RECORDING_LIMIT_SEC } from '@shared/constants'
```

定数を差し替え:

```ts
const MAX_SEC = RECORDING_LIMIT_SEC
```

他の表示ロジック（経過時間・プログレスバー）は変更しない。上限に達すると実際にサーバーが `recording_stopped` を配信して画面が遷移する。

- [ ] **Step 8: Run the full server suite and the client build**

Run: `cd server && npm test`
Expected: PASS（`fail 0`）。

Run: `cd client && npm run build`
Expected: PASS（型エラーなし、`vite build` 完了）。

- [ ] **Step 9: Commit**

```bash
git add shared/constants.ts server/src/roomStore.ts server/src/handlers.ts server/src/handlers.recording.test.ts client/src/screens/RecordingScreen.tsx
git commit -m "$(cat <<'EOF'
feat: 録音時間の上限（台本想定時間＋1分）で自動終了する

サーバー権威のタイマーを start_recording で武装し、満了で
beginAudioCollection を呼んでホストの録音終了と同じ経路に合流させる。
上限は shared の RECORDING_LIMIT_SEC（暫定 90+60=150秒）に一元化し、
クライアントの表示上限も同じ値を参照する。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 全体検証と 2 タブ手動確認

**Files:**
- 変更なし（検証のみ。不具合が出た場合のみ該当ファイルを修正）

**Interfaces:**
- Consumes: Task 1〜4 のすべて
- Produces: なし（マージ判断の材料）

- [ ] **Step 1: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — `fail 0`。Task 3 で追加した 8 件を含む全テストが green。

- [ ] **Step 2: Run the client build**

Run: `cd client && npm run build`
Expected: PASS — 型エラーなし、`vite build` 完了。

- [ ] **Step 3: Start both servers for manual verification**

サーバーとクライアントを**バックグラウンドで**起動する:

```bash
cd server && npm run dev
```

```bash
cd client && npm run dev
```

Expected: server は `[server] listening on 3001 / genres loaded: 8`、client は `http://localhost:5173`。

- [ ] **Step 4: 2 タブ手動確認チェックリスト**

ブラウザ 2 タブ（`http://localhost:5173`）で実施し、各項目の結果を記録する:

1. タブ A でルーム作成 → タブ B で同じルームコードで参加 → ジャンル選択 → 開始 → 配役 → 両方で準備完了 → ホストが録音開始。
2. **録音開始時に両タブでマイク許可ダイアログが出る**（`recorder.ts` の `getUserMedia`）。両方「許可」する。
3. 数秒間しゃべる（声量メーターが動くこと＝既存機能が壊れていないこと）。
4. ホストが「録音終了」→ 両タブが「AI採点中...」画面へ。
5. **サーバーのログに人数分の `[server] audio received: <名前> <バイト数> bytes audio/webm...` が出る**（＝音声がサーバーに到達）。バイト数が 0 でないこと。
6. 両方到達した直後に結果画面へ進む（15 秒のタイムアウトを待たない）。
7. 結果画面のスコアが 2 人分出る（スタブスコア）。各自「ロビーに戻る」で復帰でき、全員戻ると再開始できる。
8. **マイク拒否のケース**: もう一度ゲームを開始し、片方のタブでマイクを「ブロック」する。ログにそのプレイヤーの `audio received` は出ないが、**タイムアウトを待たずに**採点が進むこと（skip マーカーが効いている）。
9. **録音時間の上限**: もう一度録音を開始し、**ホストは「録音終了」を押さずに放置**する。タイマー表示が 2:30（`RECORDING_LIMIT_SEC`＝150秒）に達した時点で、**両タブが自動的に採点画面へ遷移**すること。そのままアップロードも走り、ログに `audio received` が人数分出ること。
10. **上限前に停止した場合**: 通常どおりホストが途中で「録音終了」を押したあと、150 秒を跨いでも**二度目の遷移や再収集が起きない**こと（結果画面のまま）。

- [ ] **Step 5: Stop the background servers**

手動確認が終わったら起動中のプロセスを停止する。

- [ ] **Step 6: Commit (only if fixes were needed)**

手動確認で不具合が見つかった場合のみ修正し、コミットする:

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: 2タブ手動確認で見つかった録音アップロードの不具合を修正

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## 完了後

全タスク green かつ手動確認 OK なら、`superpowers:requesting-code-review` で opus の whole-branch レビューを受け、`superpowers:finishing-a-development-branch` で main へローカルマージする（fast-forward → マージ後に `npm test` 再実行 → `git branch -d feature/phase-c2-recording-upload`）。
