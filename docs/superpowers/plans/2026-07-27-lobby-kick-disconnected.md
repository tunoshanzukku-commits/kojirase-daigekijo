# ロビーで切断中プレイヤーをキック Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ホストがロビー画面にいる間だけ、事故切断で「復帰待ち…」になっているプレイヤーを猶予満了を待たずに手動でルームから外せるようにする。

**Architecture:** 新イベント `kick_player { playerName }`（C→S）を1本足し、退出処理は B5 で切り出した既存の `removeNonHostAndNotify(io, room, socketId)` をそのまま再利用する（＝猶予満了で起きる自動退出を、ホストが今すぐ起こすだけ）。S→C の新イベントは無く、既存の `player_left` がそのまま流れる。クライアントはロビーの該当行にボタンを出し、共通 `ConfirmDialog` で確認してから emit する。

**Tech Stack:** TypeScript / Node20（server: `tsx --test`、型チェックは別途 `tsc --noEmit`）/ React18 + Vite（client: `tsc && vite build`）/ Socket.IO / 共有型は `shared/`（`@shared/*`、`client/src/types.ts` は `export * from '@shared/types'`）。

## Global Constraints

- 設計書: [docs/superpowers/specs/2026-07-27-lobby-kick-disconnected-design.md](../specs/2026-07-27-lobby-kick-disconnected-design.md)。
- **キックできるのはホストのみ**（`room.hostSocketId !== socket.id` は無視）。
- **キックできるのは切断中（`disconnectedAt != null`）の非ホストのみ**。接続中・ホスト・存在しない名前は無視。
- **キックできる status は `waiting` と `evaluating` の2つだけ**（＝ロビー画面が出ている状態）。`casting`/`recording` は無視。
- **条件を満たさない要求は黙って無視する**（既存の C→S ハンドラの慣習。エラーを返さない）。
- **S→C の新規イベントを増やさない**。退出の通知は既存の `player_left` を使う。
- **クライアントは楽観的更新をしない**。一覧からの削除は `player_left` 受信で行う。
- **server は tsx が型チェックしないため、`npx tsc --noEmit`（server）を検証ゲートにする**。client は `npm run build`（tsc && vite build）clean。
- コミットの `Co-Authored-By` は `Claude Opus 5 <noreply@anthropic.com>`。

---

### Task 1: サーバー — `kick_player` 契約とハンドラ

**Files:**
- Modify: `shared/events.ts`（`ClientToServerEvents` に `kick_player`）
- Modify: `server/src/handlers.ts`（`leave_room` ハンドラの直後に `kick_player` ハンドラ）
- Modify: `server/src/testUtils.ts`（`makeRoom` / `makeCastingRoom` を共用ヘルパーとして追加）
- Modify: `server/src/handlers.reconnect.test.ts`（ローカルの `makeRoom` / `makeCastingRoom` を削除して testUtils から import）
- Create: `server/src/handlers.kick.test.ts`
- Modify: `server/package.json`（`test` スクリプトに新テストファイルを追加）

**Interfaces:**
- Consumes（既存・B5 で実装済み）:
  - `removeNonHostAndNotify(io: IO, room: Room, socketId: string): void` — `handlers.ts` の module スコープ関数。`removePlayer` → `io.to(room.code).emit('player_left', { playerName })` → 部屋が空なら `deleteRoom` → `touch` → 収集中で `uploadExpected` が空なら `finalizeEvaluation` → `status==='evaluating'` かつ `allReturned` なら `resetRoom`＋`room_reset` までを行う唯一の非ホスト退出経路。`removePlayer` が猶予タイマーも解除する。
  - `Player.disconnectedAt: number | null`（`roomStore.ts`）、`findRoomBySocket`、`getRoom`。
  - テストフック `__setGraceForTest(ms)` / `__resetGraceForTest()`、`__setUploadTimeoutForTest(ms)` / `__resetUploadTimeoutForTest()`、`__setRecordingLimitForTest(ms)` / `__resetRecordingLimitForTest()`（すべて `handlers.ts` から export 済み）。
  - テストハーネス `startTestServer` / `connectClient` / `once` / `expectNoEvent` / `makeRecordingRoom`（`testUtils.ts`）。
- Produces:
  - C→S `kick_player: (payload: { playerName: string }) => void`

- [ ] **Step 1: テストヘルパーを testUtils へ抽出する**

`server/src/testUtils.ts` の `makeRecordingRoom` の**直前**に追加する（`makeRecordingRoom` と同じ「複数の統合テストで共用する」方針。現状 `handlers.reconnect.test.ts` にローカル定義されているものを移動する）:

```ts
// waiting のホスト(たろう)＋ゲスト(はなこ) と両者の再接続トークンを返す。
// 複数の統合テストで共用する（重複コピーを増やさない）。
export async function makeRoom(port: number): Promise<{
  host: Socket; guest: Socket; roomCode: string; hostToken: string; guestToken: string
}> {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const hc = await once<{ roomCode: string; token: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode: hc.roomCode, playerName: 'はなこ' })
  const gj = await once<{ token: string }>(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest, roomCode: hc.roomCode, hostToken: hc.token, guestToken: gj.token }
}

// status='casting'（配役/準備フェーズ）まで進めた部屋
export async function makeCastingRoom(port: number): Promise<{
  host: Socket; guest: Socket; roomCode: string; hostToken: string; guestToken: string
}> {
  const r = await makeRoom(port)
  r.host.emit('set_genre', { genre: 'comedy' })
  await once(r.guest, 'genre_changed')
  // script_ready は io.to で送信者含む全員へ同時配信されるため、先に両方 listen してから emit
  const readyGuest = once(r.guest, 'script_ready')
  const readyHost = once(r.host, 'script_ready')
  r.host.emit('start_game')
  await readyGuest
  await readyHost
  return r
}
```

`server/src/handlers.reconnect.test.ts` から**ローカル定義の `makeRoom` と `makeCastingRoom`（コメント含む約25行）を削除**し、import 文を差し替える:

```ts
import {
  startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom,
  makeRoom, makeCastingRoom,
} from './testUtils'
```

Run: `cd server && npx tsx --test src/handlers.reconnect.test.ts`
Expected: 移動前と同じく全 PASS（14テスト）。ここが崩れたら先に直してから次へ進む。

- [ ] **Step 2: 失敗するテストを書く（`server/src/handlers.kick.test.ts` を新規作成）**

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  startTestServer, connectClient, once, expectNoEvent,
  makeRoom, makeCastingRoom, makeRecordingRoom,
} from './testUtils'
import { _clearAllRooms, getRoom } from './roomStore'
import {
  __setGraceForTest, __resetGraceForTest,
  __setUploadTimeoutForTest, __resetUploadTimeoutForTest,
  __setRecordingLimitForTest, __resetRecordingLimitForTest,
} from './handlers'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  __setGraceForTest(10_000) // 猶予満了ではなくキックで消えたことを確かめるため長めに取る
  server = await startTestServer()
})
afterEach(async () => {
  __resetGraceForTest()
  __resetUploadTimeoutForTest()
  __resetRecordingLimitForTest()
  await server.close()
})

// はなこ が切断中（猶予スロット保持＝「復帰待ち…」）の waiting ルーム
async function makeRoomWithGhost(port: number) {
  const r = await makeRoom(port)
  const dc = once(r.host, 'player_disconnected')
  r.guest.disconnect()
  await dc
  return r
}

test('ホストは切断中プレイヤーをキックできる', async () => {
  const { host, roomCode } = await makeRoomWithGhost(server.port)
  const left = once<{ playerName: string }>(host, 'player_left')
  host.emit('kick_player', { playerName: 'はなこ' })
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(getRoom(roomCode)?.players.size, 1)
  host.disconnect()
})

test('接続中プレイヤーはキックできない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  host.emit('kick_player', { playerName: 'はなこ' })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(getRoom(roomCode)?.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('存在しない名前の kick_player は無視される', async () => {
  const { host, roomCode } = await makeRoomWithGhost(server.port)
  host.emit('kick_player', { playerName: 'いないひと' })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(getRoom(roomCode)?.players.size, 2)
  host.disconnect()
})

test('非ホストの kick_player は無視される', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const g2 = connectClient(server.port)
  g2.emit('join_room', { roomCode, playerName: 'さぶろう' })
  await once(g2, 'room_joined')
  await once(host, 'player_joined') // makeRoom で1回目は消化済み＝これは さぶろう の分
  const dc = once(host, 'player_disconnected')
  g2.disconnect() // さぶろう を「復帰待ち」にする
  await dc
  guest.emit('kick_player', { playerName: 'さぶろう' }) // ゲストが要求 → 無視されるべき
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(getRoom(roomCode)?.players.size, 3)
  host.disconnect(); guest.disconnect()
})

test('casting 中の kick_player は無視される', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  host.emit('kick_player', { playerName: 'はなこ' })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(getRoom(roomCode)?.players.size, 2)
  host.disconnect()
})

test('recording 中の kick_player は無視される', async () => {
  __setRecordingLimitForTest(10_000)
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  host.emit('kick_player', { playerName: 'はなこ' })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(getRoom(roomCode)?.players.size, 2)
  host.disconnect()
})

test('結果待ち(evaluating)でもキックできる', async () => {
  __setUploadTimeoutForTest(80) // 誰もアップロードしないので即 finalize させる
  __setRecordingLimitForTest(10_000)
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const evalHost = once(host, 'evaluation_complete')
  host.emit('stop_recording')
  await evalHost // status='evaluating'（結果待ち）
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const left = once<{ playerName: string }>(host, 'player_left')
  host.emit('kick_player', { playerName: 'はなこ' })
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(getRoom(roomCode)?.players.size, 1)
  host.disconnect()
})

test('キック後に猶予が満了しても player_left は二度飛ばない', async () => {
  __setGraceForTest(800)
  const { host } = await makeRoomWithGhost(server.port)
  const left = once(host, 'player_left')
  host.emit('kick_player', { playerName: 'はなこ' })
  await left
  await expectNoEvent(host, 'player_left', 1200) // 猶予満了(800ms)を跨いで再送が無いこと
  host.disconnect()
})

test('キックされたプレイヤーは token で戻れない', async () => {
  const { host, guestToken } = await makeRoomWithGhost(server.port)
  const left = once(host, 'player_left')
  host.emit('kick_player', { playerName: 'はなこ' })
  await left
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  await once(g2, 'rejoin_failed')
  host.disconnect(); g2.disconnect()
})
```

- [ ] **Step 3: テストスクリプトに新ファイルを登録**

`server/package.json` の `scripts.test` の末尾（`src/handlers.reconnect.test.ts` の後ろ）に半角スペース区切りで追記する:

```
 src/handlers.kick.test.ts
```

- [ ] **Step 4: テストを実行して失敗を確認**

Run: `cd server && npx tsx --test src/handlers.kick.test.ts`
Expected: FAIL。`kick_player` ハンドラが無いため、キック成功系（「ホストは切断中プレイヤーをキックできる」「結果待ち(evaluating)でもキックできる」「キック後に猶予が満了しても…」「キックされたプレイヤーは token で戻れない」）が `timeout waiting for "player_left"` で落ちる。無視系のテストは「何も起きない」ことを見ているのでこの時点では PASS してよい。

- [ ] **Step 5: イベント契約を追加**

`shared/events.ts` の `ClientToServerEvents`、`leave_room` の直後に追加:

```ts
  leave_room: () => void // 意図的な退出（猶予なしで即削除。事故切断とは区別する）
  kick_player: (payload: { playerName: string }) => void
```

- [ ] **Step 6: `kick_player` ハンドラを実装**

`server/src/handlers.ts`、`socket.on('leave_room', ...)` ハンドラの閉じ括弧の直後に追加:

```ts
  // ロビーで「もう戻ってこない人」をホストが今すぐ外す。
  // 猶予満了と同じ経路（removeNonHostAndNotify）を通すので、退出時のガードは共通。
  socket.on('kick_player', ({ playerName }) => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id) return
    // ロビー画面が出ている間だけ（waiting=待機／evaluating=前ゲームの結果待ち）
    if (room.status !== 'waiting' && room.status !== 'evaluating') return
    const target = [...room.players.values()].find(p => p.name === playerName)
    if (!target || target.isHost) return
    // 接続中は対象外。復帰済みならホストの画面が古いだけなので黙って無視する。
    if (target.disconnectedAt == null) return
    removeNonHostAndNotify(io, room, target.socketId)
  })
```

- [ ] **Step 7: テストと型チェックを実行**

Run: `cd server && npx tsx --test src/handlers.kick.test.ts`
Expected: 9テスト全 PASS。

Run: `cd server && npm test`
Expected: 既存を含め全 PASS（B5 完了時点は 153 pass ＋ 本タスクの 9 = 162）。

Run: `cd server && npx tsc --noEmit`
Expected: 型エラー無し。

- [ ] **Step 8: コミット**

```bash
git add shared/events.ts server/src/handlers.ts server/src/handlers.kick.test.ts \
  server/src/testUtils.ts server/src/handlers.reconnect.test.ts server/package.json
git commit -m "feat: ロビーで切断中プレイヤーをキック（kick_player・サーバー）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: クライアント — ロビーの「退出させる」ボタン

**Files:**
- Modify: `client/src/useGameSocket.ts`（`GameActions` に `kickPlayer` を追加＋実装）
- Modify: `client/src/screens/LobbyScreen.tsx`（ボタン＋`ConfirmDialog`）

**Interfaces:**
- Consumes: Task 1 の C→S `kick_player: (payload: { playerName: string }) => void`。既存の S→C `player_left`（受信処理は `onPlayerLeft` が実装済み＝追加のリスナ不要）。`PlayerSnapshot.connected: boolean`（B5 で追加済み）。共通コンポーネント `ConfirmDialog`（`client/src/components/ConfirmDialog.tsx`、props: `open` / `title` / `message` / `confirmLabel` / `cancelLabel` / `onConfirm` / `onCancel`）。
- Produces: `GameActions.kickPlayer(playerName: string): void`

- [ ] **Step 1: `kickPlayer` アクションを追加**

`client/src/useGameSocket.ts` の `GameActions` インターフェース、`abortGame` の直後に追加:

```ts
  abortGame: () => void
  kickPlayer: (playerName: string) => void
  leaveRoom: () => void
```

同ファイルの返り値オブジェクト、`abortGame() { ... },` の直後に追加:

```ts
    kickPlayer(playerName) {
      // 一覧からの削除は player_left 受信で行う（楽観的更新にしない＝
      // サーバーが条件を満たさず弾いた場合に表示がズレない）
      socket.emit('kick_player', { playerName })
    },
```

- [ ] **Step 2: ロビーにキックボタンと確認ダイアログを追加**

`client/src/screens/LobbyScreen.tsx`:

冒頭の import に追加（`import { GENRES, genreLabel } from '../genres'` の下）:

```ts
import ConfirmDialog from '../components/ConfirmDialog'
```

`const [hostOnlyNudge, setHostOnlyNudge] = useState(false)` の下に state を追加:

```ts
  const [kickTarget, setKickTarget] = useState<string | null>(null) // キック確認中のプレイヤー名
```

参加者一覧の行（`{ctx.players.map((p, i) => (` の中）、既存の「📶 復帰待ち…」バッジの直後に追加:

```tsx
              {p.connected === false && (
                <span className="text-xs text-amber-600 font-bold">📶 復帰待ち…</span>
              )}
              {ctx.isHost && p.connected === false && (
                <button
                  onClick={() => setKickTarget(p.name)}
                  className="ml-auto text-xs px-2 py-1 border border-red-200 text-red-500 hover:bg-red-50 rounded-lg font-bold transition-colors"
                >
                  退出させる
                </button>
              )}
```

コンポーネント最後の閉じ `</div>`（`return (` に対応するルート要素の閉じタグ）の直前に確認ダイアログを追加:

```tsx
      <ConfirmDialog
        open={kickTarget !== null}
        title={`${kickTarget} を退出させますか？`}
        message="復帰待ちを取り消します。この人は戻れなくなります。"
        confirmLabel="退出させる"
        cancelLabel="キャンセル"
        onConfirm={() => {
          if (kickTarget) actions.kickPlayer(kickTarget)
          setKickTarget(null)
        }}
        onCancel={() => setKickTarget(null)}
      />
```

- [ ] **Step 3: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` clean。

- [ ] **Step 4: コミット**

```bash
git add client/src/useGameSocket.ts client/src/screens/LobbyScreen.tsx
git commit -m "feat: ロビーで切断中プレイヤーを「退出させる」ボタン（確認ダイアログ付き）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 2タブ目視確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: dev 起動**

server（`npm --prefix server run dev`）＋ client（`npm --prefix client run dev`）を background で起動し、2タブでホスト（たろう）＋ゲスト（はなこ）のルームを作る。

- [ ] **Step 2: ロビーでキック**

ゲストタブを DevTools → Network → **Offline** にする。→ ホストのロビーで「📶 復帰待ち…」と「退出させる」ボタンが出る。押す → 確認ダイアログ「はなこ を退出させますか？」→「退出させる」→ 一覧から消えてトースト「はなこ が退出しました」。

- [ ] **Step 3: キックされた側は戻れない**

ゲストタブを Online に戻す。→ 自動再接続 → `rejoin_failed` →「ルームに戻れませんでした」でトップ画面へ。

- [ ] **Step 4: 接続中はボタンが出ない**

新しくゲストを参加させ、接続中の行に「退出させる」が出ないこと、ゲスト側の画面にはホストを含め誰にもボタンが出ないことを確認。

- [ ] **Step 5: 進行中は出ない**

ゲームを開始（配役画面）し、ゲストをオフラインにする。→ 配役画面には「復帰待ち…」バッジは出るがキックボタンは無い（ロビー画面にしか無い）。

---

## 完了条件

- サーバー全テスト PASS（B5 完了時点 153 ＋ 本プラン 9 = 162）＋ `server` の `npx tsc --noEmit` clean。
- `client` の `npm run build` clean。
- 2タブ目視: ロビーで切断中の人だけキックでき、キック後は本人が戻れない。接続中・進行中・非ホストにはボタンが出ない。
