# Phase B3 評価スタブ→結果→ロビー復帰 設計書

*作成日：2026-07-15 / 前提：Phase B2 完了（main にマージ済み, HEAD ff96cd4）*

## 目的

録音終了から先のゲーム進行——**評価（スタブ）→結果→ロビー復帰**——を実サーバー接続で同期する。`EvaluatingScreen`/`ResultScreen`/`LobbyScreen` のモックを実接続化し、Phase B（準備→録音→結果の同期）を完成させる。実評価（Whisper 文字起こし・Claude 採点）は Phase C 据え置きで、B3 は**スタブスコア**を扱う。

B3 完了で「2タブで最初から最後まで通しプレイ→ロビーに戻って再戦」までが成立する。加えて既知バグ（結果後にルームが `waiting` へ戻らず新規参加できない）を `room_reset` で解消する。

## スコープ

**含む:**
- `stop_recording`（host）→ `recording_stopped` ＋ `evaluation_complete{scores, leftPlayers}`
- スタブ評価：`server/src/ai/scoreStub.ts` が在室プレイヤーの `PlayerScore[]` を生成
- 録音中/評価中に離脱したプレイヤーを結果で**グレーの「退出」カード**表示（§7-E の決定）
- `return_to_lobby` → `player_returned` → 全員復帰で `room_reset{room}`
- `EvaluatingScreen`/`ResultScreen`/`LobbyScreen` の実接続化
- **既知バグ解消**：`room_reset` が `status='waiting'` に戻し、再戦・新規参加を可能にする

**含まない（Phase C 据え置き）:**
- 実音声録音・アップロード（`submit_audio`）、Whisper 文字起こし、Claude 採点、実台本生成
- 録音の 5 分自動終了タイマー（host 主導＋既存 idle クリーンアップで十分。§8 参照）

## 決定事項（ブレインストーミングで確定）

- **離脱者は結果でグレーの「退出」カード表示**（§7-E）。録音開始時の在室名簿をスナップショットし、`stop_recording` 時点の在室者との差分で離脱者を算出。
- **`recording_stopped` と `evaluation_complete` を分離**。スタブは即時だが、Phase C の実評価は数秒かかる。画面遷移（即時）とスコア到着（遅延しうる）を分離し C で流用可能にする。
- **`resetRoom` は genre を保持**（同じ部屋で再戦しやすい）。players・host も保持し、ゲーム進行状態のみクリア。
- 評価画面は**演出完了 AND スコア到着**で結果へ遷移（受信ドリブン）。

## イベント契約（`shared/events.ts` 追記）

```typescript
// ClientToServerEvents に追加
stop_recording: () => void                     // host のみ・status==='recording'
return_to_lobby: () => void                    // 全員・status==='evaluating'

// ServerToClientEvents に追加
recording_stopped: () => void
evaluation_complete: (payload: { scores: PlayerScore[]; leftPlayers: string[] }) => void
player_returned: (payload: { playerName: string }) => void
room_reset: (payload: { room: RoomSnapshot }) => void
```

`PlayerScore`（既存 `shared/types.ts`）: `{ playerName, acting, emotion, kojirase, comment }`。`RoomSnapshot`（既存）をそのまま `room_reset` で送る。

## フロー

```
host: 録音終了ボタン
   └─ stop_recording ──▶ サーバー
         present = 在室プレイヤー名
         scores = generateStubScores(present)
         leftPlayers = recordingRoster \ present   （録音開始時にいたが今いない）
         room.status = 'evaluating'; room.scores = scores
         io.to: recording_stopped()               ← 全員 evaluating 画面へ
         io.to: evaluation_complete({scores, leftPlayers})
   ↓
各クライアント: EvaluatingScreen（5ステップ演出）
         演出完了 AND ctx.scores 到着 → ResultScreen
   ↓
各クライアント: 「ロビーへ戻る」
   └─ return_to_lobby ──▶ サーバー
         room.returned.add(socket.id)
         io.to: player_returned({playerName})       ← 帰還状況を全員に
         在室者全員が returned なら:
             resetRoom(room)                        ← status='waiting' 等
             io.to: room_reset({room})              ← 全員ロビーへ・新規参加可能
```

## サーバー設計（`server/src/`）

### roomStore（`Room` 拡張）

```typescript
// Room に追加
recordingRoster: string[]   // 録音開始時の在室名簿。初期 []
returned: Set<string>       // 復帰済み socketId。初期 空Set
```

- `createRoom` で `recordingRoster: []`, `returned: new Set()` を初期化。
- `removePlayer` で `room.returned.delete(socketId)` も行う（既存の `volumes.delete` に加えて）。
- **`resetRoom(room)`** 新規ヘルパー：
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
    // genre は保持
  }
  ```
- **`allReturned(room): boolean`** 新規ヘルパー：`room.players.size > 0 && [...room.players.keys()].every(id => room.returned.has(id))`。

### スタブ評価（新規 `server/src/ai/scoreStub.ts`・TDD）

```typescript
export function generateStubScores(playerNames: string[]): PlayerScore[]
```

- 各プレイヤーに `acting`/`emotion`/`kojirase` を **1〜5** で生成。名前から安定的に導出（同名なら同結果＝テスト決定的）し、3項目が一様にならないよう項目ごとにオフセットを変える。
- `comment` はスタブ文（例：`「${name}」の演技をAIが講評しました。（スタブ）`）。
- Phase C で Whisper+Claude に差替、同シグネチャ維持。
- 単体テスト観点：入力名ごとに1件、各スコアが 1〜5、comment 非空、同名で決定的、空入力→空配列。

### handlers（`registerHandlers` に追記）

- **`start_recording` 拡張**（既存）：`room.status='recording'` の後に `room.recordingRoster = [...room.players.values()].map(p => p.name)` を追加。
- **`stop_recording`**（新規）：`const room = findRoomBySocket(socket.id); if (!room || room.hostSocketId !== socket.id || room.status !== 'recording') return`。
  - `present = [...room.players.values()].map(p => p.name)`
  - `const scores = generateStubScores(present)`
  - `const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))`
  - `room.status = 'evaluating'; room.scores = scores; touch(room)`
  - `io.to(room.code).emit('recording_stopped')`
  - `io.to(room.code).emit('evaluation_complete', { scores, leftPlayers })`
- **`return_to_lobby`**（新規）：`const room = findRoomBySocket(socket.id); if (!room || room.status !== 'evaluating') return`。
  - `room.returned.add(socket.id)`; `touch(room)`
  - `const playerName = room.players.get(socket.id)?.name; if (playerName) io.to(room.code).emit('player_returned', { playerName })`
  - `if (allReturned(room)) { resetRoom(room); io.to(room.code).emit('room_reset', { room: toSnapshot(room) }) }`
- **`disconnect` 拡張**：ゲスト離脱の分岐で、`player_left` 配信後、`room.status === 'evaluating' && room.players.size > 0 && allReturned(room)` なら `resetRoom(room)` ＋ `io.to(room.code).emit('room_reset', { room: toSnapshot(room) })`（復帰待ちの相手が抜けてもデッドロックしない）。host 離脱は既存どおり `room_dissolved`＋`deleteRoom`。

## クライアント設計（`client/src/`）

### GameContext（`App.tsx`）

```typescript
// 追加
leftPlayers: string[]        // 結果のグレーカード用。初期 []
returnedPlayers: string[]    // 帰還状況表示用。初期 []
```

`room_reset` 時にこれらと `scores`/`readyMap`/`bgm` をクリア。

### useGameSocket

- **追加リスナ:**
  - `recording_stopped` → `setScreen('evaluating')`
  - `evaluation_complete` → `setCtx(prev => ({ ...prev, scores, leftPlayers }))`
  - `player_returned` → `setCtx(prev => ({ ...prev, returnedPlayers: [...new Set([...prev.returnedPlayers, playerName])] }))`
  - `room_reset` → `setCtx` をロビー状態へ（`genre` は snapshot 値を採用、`players` を snapshot に、`scores=[]`/`leftPlayers=[]`/`returnedPlayers=[]`/`readyMap={}`/`bgm=null`）→ `setScreen('lobby')`
- **追加アクション:** `stopRecording()` → `socket.emit('stop_recording')`、`returnToLobby()` → `socket.emit('return_to_lobby')`。

### 画面

- **RecordingScreen:** 「録音終了」ボタンを `actions.stopRecording()` に接続（現状のローカル `onNavigate('evaluating')` を置換）。ゲストのデモ遷移ボタンは撤去。遷移は `recording_stopped` 受信でサーバー駆動（host 自身も受信）。
- **EvaluatingScreen:** props に `ctx` を追加。5ステップ演出は残し、**演出が最終ステップまで完了 AND `ctx.scores.length > 0`** で `onNavigate('result')`。スコア未到着なら最終ステップで待機。
- **ResultScreen:** `MOCK_SCORES` を `ctx.scores` に置換（合計降順ソート・上位メダル）。`ctx.leftPlayers` を**グレーの「退出」カード**（ランキング外・スコアなし・「退出しました」表記）で末尾に表示。「ロビーへ戻る」→ `actions.returnToLobby()`（ローカル navigate は廃止）。押下後は待機表示＋「◯/◯ がロビーへ」（`ctx.returnedPlayers` と `ctx.players` から算出）。実際の遷移は `room_reset` 受信で全員同時。
- **LobbyScreen:** 変更ほぼ不要。`room_reset` で全員が自然にロビーへ戻る（休眠 `fromResult` フラグは使わず room_reset 駆動に統一）。`ResultScreen` からの `onNavigate('lobby', {fromResult:true})` は撤去。

## テスト方針（Phase A/B1/B2 と同じ）

- **サーバー統合テスト**（`node:test`＋硬化済み `testUtils`。B2 の「recording 状態まで進める helper」を流用/拡張）：
  - `stop_recording`：host のみ受理（非ホストは無視）、`recording_stopped`＋`evaluation_complete{scores}` を全員へ、`scores` が在室者数と一致。
  - 離脱者算出：録音開始後にゲストが離脱→`stop_recording`→`leftPlayers` に離脱者名、`scores` は在室者のみ。
  - `return_to_lobby`：全員復帰で `room_reset`＋`status='waiting'`（snapshot で確認）、一部復帰では reset されない。
  - evaluating 中の離脱で残り全員復帰済みなら `room_reset`（デッドロック回避）。
  - `resetRoom` 後に新規ゲストが `join_room` できる（**既知バグ回帰テスト**）。
  - `scoreStub` 単体（決定性・範囲・空入力）。
- **クライアント**：`tsc --noEmit`＋`vite build`。live 2〜3 クライアント headless E2E（stop→evaluation_complete→return→room_reset の通し）。

## タスク分解（B3 = 1 サブフェーズ = 1 計画）

各タスク TDD・小コミット。

1. `shared/events.ts` に 2+4 イベント追加。
2. `server/src/ai/scoreStub.ts`（`generateStubScores`）＋単体テスト。
3. `roomStore`：`recordingRoster`/`returned` 追加・`createRoom` 初期化・`removePlayer` 掃除・`resetRoom`/`allReturned` ヘルパー＋テスト。
4. `handlers`：`start_recording` 拡張（roster 記録）、`stop_recording`/`return_to_lobby`/`disconnect` 拡張＋統合テスト（既知バグ回帰含む）。
5. クライアント：`useGameSocket` の 4 リスナ＋2 アクション、`GameContext.leftPlayers`/`returnedPlayers`、`App.tsx` の画面配線（Evaluating に ctx 追加）。
6. 画面実接続化：RecordingScreen（stop 接続）、EvaluatingScreen（受信ドリブン遷移）、ResultScreen（ctx.scores＋グレーカード＋return）、LobbyScreen（room_reset 経路の後始末）。

## 繰り越し・非スコープ

- 録音の 5 分自動終了タイマーは見送り（host 主導＋既存 `cleanupRooms` の idle 削除で担保）。必要なら後日 hardening。
- 実音声録音・アップロード、Whisper、Claude 採点、実台本生成は **Phase C**。
- Phase A 繰り越し（`start_game` の genre/最小人数ガード、host 権限拒否の統合テスト網羅、正規名エコー）は B3 では扱わず hardening パスへ継続。
- 引数なし emit ガード（既存コードベース共通パターン）は全体 hardening として別途。
