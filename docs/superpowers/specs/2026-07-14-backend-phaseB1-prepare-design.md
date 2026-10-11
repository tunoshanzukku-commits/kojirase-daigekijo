# Phase B1 設計書：準備フェーズのリアルタイム同期

*作成日：2026-07-14 / 前提：Phase A 完了（main）、Phase B 全体メモ `docs/superpowers/phase-b-kickoff.md`*

---

## 1. 目的とスコープ

Phase A で `top→lobby→casting` が実サーバー接続済み。B1 はゲーム進行の次の一歩として**準備フェーズ（prepare）をリアルタイム同期**し、そこから録音フェーズへの遷移までを成立させる。

**B1 のゴール（垂直スライス）:**

2つ以上のブラウザで、
1. 各プレイヤーが配役画面(casting)の「台本を読む →」で**各自のタイミングで**準備画面(prepare)へ入る
2. prepare で**実台本（`ctx.script`）と実参加者の準備状況**が表示される
3. 「準備完了」トグルが `set_ready` → `ready_updated` で全員にリアルタイム同期する（`allReady` 付き）
4. ホストの「録音開始」ボタンが **全員完了 or 30秒経過**（ホストのクライアント側タイマー）で有効化され、押すと `start_recording` → サーバーが `recording_started` を全員に配信
5. 全員が録音画面(recording)へ入り、カウントダウンが始まる

### スコープ外（後続サブフェーズ）

- **B2**: 録音中インタラクション同期（reaction / bgm / sfx / volume）。RecordingScreen 内部の実接続化。
- **B3**: 録音終了（`stop_recording`）→ 評価スタブ（`evaluation_complete`）→ 結果 → `return_to_lobby`/`room_reset`。録音の5分自動終了タイマー。
- **Phase C**: 実音声（MediaRecorder / `submit_audio`）、Whisper、Claude 評価・本番台本、BGM/SFX 実再生。
- Phase A レビュー由来の繰り越し（`start_game` のサーバー側 genre/最小人数ガード、権限拒否テスト、正規名エコー等）は B1 には**含めない**（focus 維持。別途 §8 参照）。

---

## 2. 決定事項（ブレインストーミング結果）

- **A. casting→prepare 遷移**：**各自で個別に進む**。新イベントは追加しない。まだ casting にいる（prepare 未入室）プレイヤーは `isReady=false` 扱いで、入室後に完了できる。準備状況は画面に関わらずサーバーが `Player.isReady` で保持・同期する。
- **B. 準備タイマー / 録音開始**：**単一 `start_recording` ＋ クライアント側タイマー**。`force_start` は追加しない（`force_start` と `start_recording` はサーバー側で同一動作＝ `recording_started` 配信のため統合）。ホストの「録音開始」ボタンは `(allReady || 30秒経過)` で有効化（クライアント判定）。サーバーは host からの `start_recording` を受理するだけで、準備タイマー状態は持たない。30秒ゲートは UX でありセキュリティ要件ではない。

---

## 3. イベント契約の追加（`shared/events.ts`）

Phase A のマップに追記する（B2/B3/C 用は今は入れない）。

```typescript
// ClientToServerEvents に追加
set_ready:       (payload: { isReady: boolean }) => void
start_recording: () => void   // host only

// ServerToClientEvents に追加
ready_updated:     (payload: { playerName: string; isReady: boolean; allReady: boolean }) => void
recording_started: () => void
```

---

## 4. サーバー変更（`server/src/`）

`Player.isReady` と `Room.status: RoomStatus` は Phase A で既存。B1 で追加するのは helper と handler のみ。

### roomStore.ts に追加

```typescript
// 指定 socket のプレイヤーの isReady を更新（存在しなければ何もしない）
export function setReady(room: Room, socketId: string, isReady: boolean): Player | undefined

// ルーム内の全プレイヤーが準備完了か（プレイヤー0人なら false）
export function allReady(room: Room): boolean
```

- `allReady`: `room.players.size > 0 && [...players.values()].every(p => p.isReady)`。
- 参加は `status==='waiting'` のみ（Phase A）なので、prepare 中に人数は増えない。

### handlers.ts に追加（`registerHandlers` 内）

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
  if (!room || room.hostSocketId !== socket.id) return  // host only
  room.status = 'recording'
  touch(room)
  io.to(room.code).emit('recording_started')
})
```

- `set_ready` は誰でも（自分の状態のみ更新）。`start_recording` はホストのみ（非ホストは無視）。
- 5分自動終了タイマー・`recordingStartedAt` は B3（stop 側）で追加する。B1 では status を 'recording' にして配信するだけ。

---

## 5. クライアント変更（`client/src/`）

### GameContext（App.tsx）

- `readyMap: Record<string, boolean>` を追加（`INITIAL_CTX` で `{}`）。プレイヤー名→準備状態。
- `allReady` は保持せず、消費側で `ctx.players.every(p => readyMap[p.name] === true)` として導出（prepare 中は参加者集合が固定なのでサーバーの `allReady` と一致）。

### useGameSocket.ts

- リスナ追加：
  - `ready_updated {playerName, isReady, allReady}` → `setCtx(prev => ({ ...prev, readyMap: { ...prev.readyMap, [playerName]: isReady } }))`
  - `recording_started` → `setScreen('recording')`
- アクション追加：`setReady(isReady: boolean)` → `socket.emit('set_ready', { isReady })`、`startRecording()` → `socket.emit('start_recording')`。
- `GameActions` インターフェースに上記2つを追加。

### PrepareScreen.tsx（実接続化）

- 台本：`ctx.script?.entries ?? FULL_SCRIPT`、自分＝`ctx.script ? ctx.playerName : getMockPlayer(...)`（CastingScreen と同方式）。
- 参加者と準備状況：`ctx.players`＋`ctx`の readyMap（`OTHERS` モック削除）。各行 `readyMap[p.name] === true` で「✓ 準備完了 / 読み中...」。
- 自分の準備トグル：表示は `readyMap[ctx.playerName] === true`（サーバー駆動）、クリックで `actions.setReady(!current)`。ローカル `isReady` state は廃止。マイク未許可時は無効（既存の `micStatus !== 'granted'` を維持）。
- ホスト録音ボタン：`allReady`（導出）または既存のローカル30秒 `elapsed` タイマー切れで有効化。クリックで `actions.startRecording()`（`onNavigate('recording')` 廃止）。円形タイマー UI・文言は現状維持。
- ゲストのデモ用「次の画面へ」ボタン削除（実フローは `recording_started` 受信で遷移）。
- props を `{ ctx, actions: GameActions }` に変更する。現行 PrepareScreen は `onNavigate` を「録音開始」と「デモ進行」の2箇所でしか使っておらず、両方 `recording_started` フローに置換されるため `onNavigate` は不要になる → props から削除し、App 側の `<PrepareScreen>` からも `onNavigate` を渡さない（LobbyScreen の onNavigate 削除と同方式）。

### RecordingScreen.tsx

- B1 では**変更しない**。`recording_started` により App が遷移させるだけ。内部のリアクション/BGM/声量、および「録音終了」は B2/B3 まで従来モックのまま（ゲストのデモボタンも残置）。

### App.tsx

- `INITIAL_CTX` に `readyMap: {}` を追加、`GameContext` 型に `readyMap` を追加。
- `<PrepareScreen ctx={ctx} actions={actions} />` に変更（`onNavigate` は渡さない）。

---

## 6. エラー / エッジ

- prepare 中に参加者は増えない（join は waiting のみ）。切断時は Phase A の `player_left`/`room_dissolved` が発火。切断者が抜けると残りメンバーで `allReady` が再計算される（次の `ready_updated` 配信時に反映。※切断時に自動で再配信はしない＝B1 では許容。厳密な即時再計算は B3 の切断整理で扱う）。
- `set_ready` はマイク許可前でもサーバー的には受理可能だが、UI 側でマイク未許可時はトグル無効（準備完了の前提条件）。

---

## 7. テスト方針

### サーバー統合（`node:test`＋硬化済み testUtils、TDD）

`server/src/handlers.prepare.test.ts`（新規）:
- 2プレイヤーで、片方 `set_ready(true)` → 両者に `ready_updated`（`allReady=false`）。
- 両者 `set_ready(true)` → `allReady=true`。
- `set_ready(false)` で取り消し → `allReady=false`。
- ホストが `start_recording` → 全員に `recording_started`（status='recording'）。
- 非ホストの `start_recording` は無視（`recording_started` が来ない＝タイムアウトで検証）。

roomStore の `setReady`/`allReady` は上記統合テストで実質カバー（必要なら単体も追加）。

### クライアント

`tsc --noEmit` / `vite build` クリーン。live サーバーへの headless 2クライアント E2E を拡張：両者 `set_ready(true)` → `allReady` → host `start_recording` → 両者 `recording_started`。

---

## 8. 実装順序（writing-plans で詳細化）

1. `shared/events.ts` に4イベント追加。
2. roomStore に `setReady`/`allReady`（TDD）。
3. handlers に `set_ready`（TDD 統合）。
4. handlers に `start_recording`（TDD 統合）。
5. client：GameContext に readyMap ／ useGameSocket にリスナ＋アクション。
6. client：PrepareScreen 実接続化（App から actions 配線）。
7. E2E 拡張・2タブ確認。

---

## 9. Phase A 繰り越し（B1 では対象外・別途）

`start_game` のサーバー側 genre 妥当性・最小人数(≥2)ガード、host 権限拒否/MAX_PLAYERS/status≠waiting の統合テスト追加、`room_created`/`room_joined` での正規名エコー。これらは B の別サブフェーズか専用の hardening パスで対応する。
