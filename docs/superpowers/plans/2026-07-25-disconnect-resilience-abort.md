# 切断レジリエンス①「中断してロビーへ戻る」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ホストが配役/準備/録音の途中で「中断してロビーへ戻る」を押すと、全員がロビーに戻って再スタートできるようにする。

**Architecture:** サーバーが真実源。新イベント `abort_game`（C→S・ホストのみ）→ サーバーが既存の `resetRoom` で状態を待機へ戻し `game_aborted`（S→C・room snapshot 同梱）を全員へ配信 → 各クライアントが ctx をロビー形にリセット・録音/マイクを解放・トースト表示・ロビー画面へ遷移。ホスト移譲・本人再接続・自動復旧は本プランの非スコープ。

**Tech Stack:** TypeScript / Node20 / Socket.IO（server, tsx `--test`）/ React18 + Vite（client, `tsc && vite build`）/ 共有型は `shared/` を `@shared/*` エイリアスで両側から import。

## Global Constraints

- 設計書: [docs/superpowers/specs/2026-07-25-backend-disconnect-resilience-abort-design.md](../specs/2026-07-25-backend-disconnect-resilience-abort-design.md)。
- サーバーのステータスは `waiting / casting / recording / evaluating` の4つ。**`preparing` は存在しない**（配役画面も準備画面もサーバー上は `casting`）。中断の対象ステータスは `casting` と `recording` のみ。
- ホストのみ発火（`room.hostSocketId === socket.id`）。対象外は黙って無視（既存ハンドラの流儀＝emit しない）。
- **サーバーの `npm test` はファイルを明示列挙する**（自動探索しない）。新規テストファイルは `server/package.json` の `test` スクリプトに必ず追加する。
- 中断理由の文言はクライアント固定文字列（サーバーはメッセージを送らない）。
- クライアントはテストフレームワーク無し＝検証は `npm run build`（`tsc && vite build`）clean ＋ 目視。既存の `reconnection: false` は変更しない。
- コミットの `Co-Authored-By` は `Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: サーバー `abort_game` ハンドラ（＋共有イベント契約）

**Files:**
- Modify: `shared/events.ts`（`abort_game` を `ClientToServerEvents` に、`game_aborted` を `ServerToClientEvents` に追加）
- Modify: `server/src/handlers.ts`（`return_to_lobby` ハンドラの直後に `abort_game` ハンドラを追加）
- Modify: `server/package.json`（`test` スクリプトに `src/handlers.abort.test.ts` を追加）
- Test: `server/src/handlers.abort.test.ts`（新規）

**Interfaces:**
- Consumes: 既存の `findRoomBySocket`, `resetRoom`, `toSnapshot`, `touch`（すべて `handlers.ts` で import 済み）、テストハーネス `startTestServer / connectClient / once / expectNoEvent / makeRecordingRoom`（`testUtils.ts`）、`__setRecordingLimitForTest / __resetRecordingLimitForTest`（`handlers.ts`）。
- Produces:
  - C→S `abort_game: () => void`
  - S→C `game_aborted: (payload: { room: RoomSnapshot }) => void`（`room` は `toSnapshot(room)`＝status `'waiting'`・genre 保持・script `null`・scores `[]`）

- [ ] **Step 1: 共有イベントを追加**

`shared/events.ts` の `ClientToServerEvents` 内、`return_to_lobby` 行の直後に追加:

```ts
  return_to_lobby: () => void
  abort_game: () => void
```

同ファイルの `ServerToClientEvents` 内、`room_reset` 行の直後に追加:

```ts
  room_reset: (payload: { room: RoomSnapshot }) => void
  game_aborted: (payload: { room: RoomSnapshot }) => void
```

（`RoomSnapshot` は同ファイル冒頭で import 済み。）

- [ ] **Step 2: 失敗するテストを書く**

`server/src/handlers.abort.test.ts` を新規作成:

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom } from './testUtils'
import { _clearAllRooms, getRoom } from './roomStore'
import { __setRecordingLimitForTest, __resetRecordingLimitForTest } from './handlers'
import type { RoomSnapshot } from '@shared/types'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  server = await startTestServer()
})
afterEach(async () => {
  __resetRecordingLimitForTest()
  await server.close()
})

// status='casting'（配役/準備）まで進めた host(たろう)/guest(はなこ) を返す。
async function makeCastingRoom(port: number) {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  // io.to で送信者含む全員へ同時配信されるため、先に両方 listen してから emit する
  const scriptReadyGuest = once(guest, 'script_ready')
  const scriptReadyHost = once(host, 'script_ready')
  host.emit('start_game')
  await scriptReadyGuest
  await scriptReadyHost
  return { host, guest, roomCode }
}

// status='waiting' の host/guest（対象外ステータス検証用）
async function makeWaitingRoom(port: number) {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest, roomCode }
}

test('casting 中にホストが abort_game → 全員に game_aborted・room は waiting へ・genre 保持', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  const abortedGuest = once<{ room: RoomSnapshot }>(guest, 'game_aborted')
  const abortedHost = once<{ room: RoomSnapshot }>(host, 'game_aborted')
  host.emit('abort_game')
  const g = await abortedGuest
  const h = await abortedHost
  assert.equal(g.room.status, 'waiting')
  assert.equal(g.room.genre, 'comedy') // genre 保持
  assert.equal(g.room.script, null)
  assert.equal(h.room.status, 'waiting')
  const room = getRoom(roomCode)!
  assert.equal(room.status, 'waiting')
  assert.equal(room.script, null)
  host.disconnect(); guest.disconnect()
})

test('recording 中にホストが abort_game → game_aborted 配信・評価に進まない', async () => {
  __setRecordingLimitForTest(10_000) // 上限で勝手に終わらないよう十分長く（makeRecordingRoom より前に設定）
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const abortedGuest = once(guest, 'game_aborted')
  host.emit('abort_game')
  await abortedGuest
  const room = getRoom(roomCode)!
  assert.equal(room.status, 'waiting')
  // 中断後は録音終了フローが動かない
  await expectNoEvent(guest, 'recording_stopped', 400)
  host.disconnect(); guest.disconnect()
})

test('非ホストの abort_game は無視される', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  guest.emit('abort_game')
  await expectNoEvent(host, 'game_aborted', 300)
  const room = getRoom(roomCode)!
  assert.equal(room.status, 'casting') // 変わらない
  host.disconnect(); guest.disconnect()
})

test('waiting 中の abort_game は無視される（対象外ステータス）', async () => {
  const { host, guest } = await makeWaitingRoom(server.port)
  host.emit('abort_game')
  await expectNoEvent(guest, 'game_aborted', 300)
  host.disconnect(); guest.disconnect()
})

test('evaluating 中の abort_game は無視される（対象外ステータス）', async () => {
  __setRecordingLimitForTest(10_000)
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await stoppedGuest // status→evaluating, collectingAudio=true
  host.emit('abort_game')
  await expectNoEvent(guest, 'game_aborted', 300)
  const room = getRoom(roomCode)!
  assert.equal(room.status, 'evaluating')
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 3: テストスクリプトに新ファイルを追加**

`server/package.json` の `test` スクリプト末尾（`src/ai/evaluate.test.ts` の後）に ` src/handlers.abort.test.ts` を追記する。例:

```
"test": "tsx --test ... src/ai/evaluate.test.ts src/handlers.abort.test.ts"
```

- [ ] **Step 4: テストを実行して失敗を確認**

Run: `cd server && npm test`
Expected: 新規5テストが FAIL（`abort_game` ハンドラ未実装のため `game_aborted` が届かず `once` がタイムアウト、非ホスト/対象外テストは `expectNoEvent` が通るが positive テストが落ちる）。

- [ ] **Step 5: ハンドラを実装**

`server/src/handlers.ts` の `return_to_lobby` ハンドラ（`socket.on('return_to_lobby', ...)` ブロック）の直後、`socket.on('disconnect', ...)` の直前に追加:

```ts
  socket.on('abort_game', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id) return
    if (room.status !== 'casting' && room.status !== 'recording') return // 対象外は無視
    resetRoom(room) // status→waiting・script/audio/scores/timers クリア・genre 保持・evaluationSeq++
    touch(room)
    io.to(room.code).emit('game_aborted', { room: toSnapshot(room) })
  })
```

- [ ] **Step 6: テストを実行して通過を確認（＋全スイート）**

Run: `cd server && npm test`
Expected: 新規5テストが PASS。既存テストも全て PASS（総数が5件増える）。

- [ ] **Step 7: コミット**

```bash
git add shared/events.ts server/src/handlers.ts server/src/handlers.abort.test.ts server/package.json
git commit -m "feat: abort_game でホストがゲームを中断しロビーへ戻せるように（サーバー）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: クライアント socket 配線（abortGame アクション＋game_aborted ハンドラ）

**Files:**
- Modify: `client/src/useGameSocket.ts`（`GameActions` に `abortGame` 追加・`onGameAborted` ハンドラ追加・register/unregister・action 実装）

**Interfaces:**
- Consumes: Task 1 の S→C `game_aborted: { room: RoomSnapshot }` / C→S `abort_game`。既存 import 済みの `cancelRecording`（`./recorder`）・`socket`・`RoomSnapshot`（`./types`）。
- Produces: `GameActions.abortGame: () => void`（Task 4 の各画面が呼ぶ）。

- [ ] **Step 1: GameActions に abortGame を追加**

`client/src/useGameSocket.ts` の `export interface GameActions` 内、`returnToLobby` 行の直後に追加:

```ts
  returnToLobby: () => void
  abortGame: () => void
  leaveRoom: () => void
```

- [ ] **Step 2: onGameAborted ハンドラを追加**

`useEffect` 内、`onRoomReset` 関数の直後（`onEvaluationFailed` の前あたり）に追加:

```ts
    function onGameAborted({ room }: { room: RoomSnapshot }) {
      cancelRecording() // 録音中でも安全にマイク/レコーダーを解放（未録音時も無害）
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
      pushToast('ゲームを中断してロビーに戻りました', 'info')
      setScreen('lobby')
    }
```

- [ ] **Step 3: リスナ登録/解除を追加**

`socket.on('room_reset', onRoomReset)` の直後に登録を追加:

```ts
    socket.on('room_reset', onRoomReset)
    socket.on('game_aborted', onGameAborted)
```

クリーンアップの `socket.off('room_reset', onRoomReset)` の直後に解除を追加:

```ts
      socket.off('room_reset', onRoomReset)
      socket.off('game_aborted', onGameAborted)
```

- [ ] **Step 4: abortGame アクションを実装**

返り値オブジェクトの `returnToLobby(){...}` の直後に追加:

```ts
    abortGame() {
      socket.emit('abort_game')
    },
```

- [ ] **Step 5: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` が成功（型エラー無し）。

- [ ] **Step 6: コミット**

```bash
git add client/src/useGameSocket.ts
git commit -m "feat: クライアントで game_aborted を受けてロビーへ戻す＋abortGame アクション

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 共通確認ダイアログ ConfirmDialog

**Files:**
- Create: `client/src/components/ConfirmDialog.tsx`（新規・再利用可能な確認モーダル）

**Interfaces:**
- Produces: `ConfirmDialog`（default export）。props: `{ open: boolean; title: string; message: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void }`。`open` が false のとき `null` を返す。Task 4 の3画面が使う。

- [ ] **Step 1: コンポーネントを作成**

`client/src/components/ConfirmDialog.tsx`:

```tsx
interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}

// App の解散ダイアログと同じ見た目の軽量モーダル。破壊的操作の確認に使う。
// z-[70] で解散ダイアログ(z-[60])より前面。
export default function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, onConfirm, onCancel,
}: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 shadow-lg border border-sky-100 text-center max-w-xs w-full">
        <p className="font-bold text-slate-900 mb-2">{title}</p>
        <p className="text-slate-500 text-sm mb-5">{message}</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-3 bg-red-500 hover:bg-red-400 text-white font-bold rounded-xl transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: ビルドで型検証**

Run: `cd client && npm run build`
Expected: 成功（未使用でも型エラー無し。`noUnusedLocals` は export 済みコンポーネントには影響しない）。

- [ ] **Step 3: コミット**

```bash
git add client/src/components/ConfirmDialog.tsx
git commit -m "feat: 共通の確認ダイアログ ConfirmDialog を追加

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 3画面に中断ボタン＋確認を配線（＋App の CastingScreen 配線）

**Files:**
- Modify: `client/src/App.tsx`（`CastingScreen` に `actions` を渡す）
- Modify: `client/src/screens/CastingScreen.tsx`（props に `actions` 追加・中断ボタン＋ConfirmDialog）
- Modify: `client/src/screens/PrepareScreen.tsx`（中断ボタン＋ConfirmDialog）
- Modify: `client/src/screens/RecordingScreen.tsx`（中断ボタン＋ConfirmDialog）

**Interfaces:**
- Consumes: Task 2 の `GameActions.abortGame`、Task 3 の `ConfirmDialog`。

- [ ] **Step 1: App から CastingScreen へ actions を渡す**

`client/src/App.tsx` の該当行を変更:

```tsx
      {screen === 'casting'    && <CastingScreen ctx={ctx} actions={actions} onNavigate={navigate} />}
```

- [ ] **Step 2: CastingScreen に中断ボタンを追加**

`client/src/screens/CastingScreen.tsx` を変更。冒頭 import を追加:

```tsx
import { useState } from 'react'
import type { GameContext, NavigateFn } from '../App'
import type { GameActions } from '../useGameSocket'
import ConfirmDialog from '../components/ConfirmDialog'
import { FULL_SCRIPT, MOCK_ROLES, MOCK_WORLD, getMockPlayer } from '../mockScript'
import { genreLabel } from '../genres'
```

`Props` に `actions` を追加:

```tsx
interface Props {
  ctx: GameContext
  actions: GameActions
  onNavigate: NavigateFn
}

export default function CastingScreen({ ctx, actions, onNavigate }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false)
```

「台本を読む →」ボタン（`onClick={() => onNavigate('prepare')}` のボタン）の直後、最後の閉じ `</div>` の直前に追加:

```tsx
      {ctx.isHost && (
        <button
          onClick={() => setConfirmOpen(true)}
          className="w-full mt-3 py-2.5 text-slate-400 hover:text-red-500 text-sm font-medium transition-colors"
        >
          ⚠️ 中断してロビーへ戻る
        </button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="ゲームを中断しますか？"
        message="台本と録音は破棄され、全員ロビーに戻ります。"
        confirmLabel="中断する"
        cancelLabel="やめる"
        onConfirm={() => { setConfirmOpen(false); actions.abortGame() }}
        onCancel={() => setConfirmOpen(false)}
      />
```

- [ ] **Step 3: PrepareScreen に中断ボタンを追加**

`client/src/screens/PrepareScreen.tsx` の import に追加:

```tsx
import ConfirmDialog from '../components/ConfirmDialog'
```

コンポーネント先頭のステート宣言群（`const [elapsed, setElapsed] = useState(0)` の並び）に追加:

```tsx
  const [confirmOpen, setConfirmOpen] = useState(false)
```

ホストの録音開始ブロック（`{ctx.isHost && ( ... )}` の閉じ）の直後、最後の閉じ `</div>` の直前に追加:

```tsx
      {ctx.isHost && (
        <button
          onClick={() => setConfirmOpen(true)}
          className="w-full mt-3 py-2.5 text-slate-400 hover:text-red-500 text-sm font-medium transition-colors"
        >
          ⚠️ 中断してロビーへ戻る
        </button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="ゲームを中断しますか？"
        message="台本と録音は破棄され、全員ロビーに戻ります。"
        confirmLabel="中断する"
        cancelLabel="やめる"
        onConfirm={() => { setConfirmOpen(false); actions.abortGame() }}
        onCancel={() => setConfirmOpen(false)}
      />
```

- [ ] **Step 4: RecordingScreen に中断ボタンを追加**

`client/src/screens/RecordingScreen.tsx` の import に追加:

```tsx
import ConfirmDialog from '../components/ConfirmDialog'
```

コンポーネント先頭のステート宣言群に追加:

```tsx
  const [confirmOpen, setConfirmOpen] = useState(false)
```

録音フェーズのホスト用「録音終了」ボタン（`onClick={() => actions.stopRecording()}`）のブロックがある `{ctx.isHost ? ( ... ) : ( ... )}` の直後（`</div>` で `phase === 'recording'` ブロックを閉じる前）に、ホスト向け中断ボタンを追加:

```tsx
          {ctx.isHost && (
            <button
              onClick={() => setConfirmOpen(true)}
              className="w-full py-2.5 text-slate-400 hover:text-red-500 text-sm font-medium transition-colors mb-4"
            >
              ⚠️ 中断してロビーへ戻る
            </button>
          )}
```

そして ConfirmDialog は phase に依存せず表示できるよう、最後の `<style>{...}</style>` の直前（ルートの `</div>` の中）に追加:

```tsx
      <ConfirmDialog
        open={confirmOpen}
        title="ゲームを中断しますか？"
        message="台本と録音は破棄され、全員ロビーに戻ります。"
        confirmLabel="中断する"
        cancelLabel="やめる"
        onConfirm={() => { setConfirmOpen(false); actions.abortGame() }}
        onCancel={() => setConfirmOpen(false)}
      />
```

- [ ] **Step 5: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` が成功（型エラー無し）。

- [ ] **Step 6: コミット**

```bash
git add client/src/App.tsx client/src/screens/CastingScreen.tsx client/src/screens/PrepareScreen.tsx client/src/screens/RecordingScreen.tsx
git commit -m "feat: 配役/準備/録音画面にホストの中断ボタンを追加

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 実機/2タブ目視確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: dev サーバー起動**

server（`cd server && npm run dev`）と client（`cd client && npm run dev`）を起動。ブラウザ2タブ（localhost:5173）でホスト＋ゲストを作る。

- [ ] **Step 2: 配役画面での中断**

ジャンル選択→開始→配役画面で、ホスト側「⚠️ 中断してロビーへ戻る」→確認「中断する」。
Expected: 両タブがロビーへ戻る／非ホスト側にトースト「ゲームを中断してロビーに戻りました」／genre と参加者が保持され、ホストが再度開始できる。

- [ ] **Step 3: 準備画面での中断**

再度開始→配役→「台本を読む」→準備画面で中断。
Expected: Step 2 と同じ挙動。

- [ ] **Step 4: 録音画面での中断（マイク解放）**

再度開始→録音開始→録音画面で中断。
Expected: 両タブがロビーへ戻る／録音インジケータ（ブラウザのマイク使用中表示）が消える＝マイク解放／非ホストにトースト。

- [ ] **Step 5: 非ホストにボタンが無いこと**

ゲスト側の配役/準備/録音画面に中断ボタンが表示されないことを確認。

---

## 完了条件

- サーバー全テスト（既存＋新規5件）が PASS。
- `client` の `npm run build` が clean。
- 2タブ目視で配役/準備/録音のいずれからもホストが中断でき、全員がロビーへ戻って再スタートできる。マイクが解放される。
