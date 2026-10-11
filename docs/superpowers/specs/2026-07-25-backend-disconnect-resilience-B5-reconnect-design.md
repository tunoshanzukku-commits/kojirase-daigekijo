# 設計書：切断レジリエンスB5「本人再接続」（非ホストのトークン再接続）

- 日付: 2026-07-25
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/disconnect-resilience-b5-reconnect`
- 関連: [全体仕様書](../../../doc/仕様書.md) / [切断レジリエンス①（中断してロビー）](2026-07-25-backend-disconnect-resilience-abort-design.md)

## 1. 背景とスコープ

「戻れない」課題の残り。切断レジリエンス①でホストの手動「中断してロビーへ」は入ったが、**落ちた本人が進行中の部屋へ再接続できない**（`join_room` は `status∈{waiting,evaluating}` のみ許可＝casting/recording を拒否）、かつクライアントは `socket.ts` が **`reconnection:false`**（自動再接続すると新 socket.id で孤児化するのを避けるため意図的にオフ）で本人同定が `socket.id`。

本スライス（B5）は**非ホストのトークン再接続**を実装する。落ちた本人がスマホの一瞬切れ/リロードから、進行中の同じ部屋・同じ画面へ自動で戻れるようにする。

### 決定事項（ブレインストーミングで確定）

- **同定＝セッショントークン＋自動再接続**: 参加時にサーバーが不透明トークンを発行→クライアントが localStorage 保存→`reconnection:true` にし、再接続時に `rejoin(token)` を自動送信してサーバーが旧スロットに再紐付け。（名前ベースの手動再入室は不採用＝同名衝突・リロードに弱い。）
- **対象＝非ホストのみ**。ホスト切断は従来どおり即 `room_dissolved`＋部屋削除（ホスト移譲=B6は別スライス）。
- **猶予スロット**: 非ホストの事故切断でも即削除せず**約60秒**スロット保持。ゲームは止めない。他プレイヤーには「復帰待ち」表示。猶予内に戻れば現在の画面へ復帰、猶予切れで従来どおり退出（`player_left`）。
- **意図的な退出と事故切断を区別**: 「退出」ボタン（`socket.disconnect()`）＝disconnect reason `io client disconnect` は即削除（猶予なし）。ネットワーク断（`transport close`/`ping timeout` 等）は猶予開始。
- **録音中の復帰＝「録音はされないが役は演じられる」**: 録音画面をフル復元（台本＋リアクション/SFX/BGM＋声量メーター）し演技は続けられるが、本人の MediaRecorder は起動しない＝音声アップロードなし。「⚠️ 接続が切れたため録音されません（演技はそのままOK）」を明示。採点は発話空＝最低点、既存 fail-open で全員分結果は出る。

### 実装アプローチ（案A採用・確定）

**socketId キーは維持し、再接続時にプレイヤーを付け替え（re-key）**。`room.players` は現状の socketId キーのまま。Player に `token` と `disconnectedAt` を追加。切断→即削除せず猶予、再接続で旧socketId→新socketId に付け替え。`allReady`/`allReturned`/`uploadExpected` は「切断中(disconnectedAt≠null)」を除外。既存ハンドラへの影響を最小化する（安定 playerId への全面刷新＝案Bは全ハンドラ/テスト波及が大きくリスク高のため不採用）。

## 2. アーキテクチャ方針

- **サーバーが真実源**。トークンで本人同定、再接続は必ず `rejoin(token)` ハンドラを通す。クライアントが勝手に状態を作らない（サーバーが `rejoined` で snapshot を返し復元）。
- **ホストは対象外**: disconnect ハンドラでホストは従来どおり `room_dissolved`＋削除。猶予は非ホストのみ。
- **クライアントは `reconnection:true`＋リロード復帰**（アプリ起動時に localStorage のトークンがあれば猶予内なら `rejoin` を試行）。
- 既存の finalize/generationトークン/収集ゲート/中断（abort_game）を壊さない。

## 3. データ契約（`shared/events.ts` ＋ payload）

### 3.1 追加イベント

```ts
// client → server
rejoin: (payload: { token: string }) => void
leave_room: () => void   // 「退出」ボタンの意図的離脱（即削除・猶予なし）
// server → client
rejoined: (payload: { room: RoomSnapshot; status: RoomStatus; selfName: string }) => void
rejoin_failed: (payload: { message: string }) => void
player_disconnected: (payload: { playerName: string }) => void
player_reconnected: (payload: { playerName: string }) => void
```

### 3.2 既存 payload の拡張

- `room_created` / `room_joined` の payload に **`token: string`** を追加（クライアントが localStorage 保存）。
- `RoomSnapshot`（`toSnapshot`）の各 player に **`connected: boolean`**（= `disconnectedAt == null`）を追加し、クライアントが「復帰待ち」バッジを出せるようにする。

## 4. サーバー実装

### 4.1 データモデル（`roomStore.ts`）

`Player` に追加:

```ts
export interface Player {
  socketId: string
  name: string
  isHost: boolean
  isReady: boolean
  token: string            // 再接続クレデンシャル（不透明・ランダム）
  disconnectedAt: number | null  // 事故切断中は now、在室は null
}
```

- `createRoom`/`addPlayer` で `token`（ランダム）を発行、`disconnectedAt: null`。
- room に猶予タイマー保持: `Room` に `graceTimers: Map<string /*socketId*/, ReturnType<typeof setTimeout>>` を追加（または player 単位で保持）。`clearRoomTimers`/`resetRoom`/`deleteRoom` で確実にクリア。
- token→player 検索: `findPlayerByToken(token): { room: Room; player: Player } | undefined`（全 room 走査 or token→roomCode index）。
- 付け替え: `reattachPlayer(room, player, newSocketId)` = `room.players.delete(oldSocketId)`→`player.socketId=newSocketId`→`room.players.set(newSocketId, player)`→`player.disconnectedAt=null`。旧socketIdの transient マップ（`volumes`/`returned`/`audio`/`uploadExpected`）は付け替え時に旧キーを掃除（録音中復帰は音声なし前提のため再マップ不要）。
- 除外ヘルパー更新: `allReady`/`allReturned` は「`disconnectedAt==null` のプレイヤーのみ」で判定。`toSnapshot` は `connected` を含める。

### 4.2 トークン発行

`create_room`/`join_room` 成功時、`room_created`/`room_joined` の payload に `player.token` を含めて返す。

### 4.3 意図的な退出と事故切断の区別（`leave_room` 方式）

disconnect reason 文字列は環境依存で脆いので、**意図的な退出は明示イベント `leave_room` で表す**（reason 文字列には依存しない）:

- **`leave_room` ハンドラ**（意図的離脱）: 従来の非ホスト退出処理をそのまま実行＝`removePlayer` + `player_left` + 既存ガード（size0でdelete / 収集中 finalize / allReturned で room_reset）+ token破棄。**猶予なし**。ホストの `leave_room` は従来の解散と同じく `room_dissolved`+deleteRoom（現状ホストは退出ボタン押下で全員トップの挙動を踏襲）。
- **`disconnect` ハンドラ**（`leave_room` を経ずに接続が切れた＝事故切断）:

```
disconnect:
  room = findRoomBySocket(socket.id); if !room return
  player = room.players.get(socket.id); if !player return
  if player.isHost:                       // ホストは従来どおり
    socket.to(code).emit('room_dissolved'); deleteRoom(code); return
  // 非ホストの事故切断 → 猶予（leave_room を経た退出は既に player 不在＝ここに来ない）
  player.disconnectedAt = Date.now()
  socket.to(room.code).emit('player_disconnected', { playerName: player.name })
  touch(room)
  // 収集中に「切断中を除外した uploadExpected が空」になったら finalize（デッドロック回避・既存踏襲）
  grace timer(60s) → 満了時: getRoom 健在＆まだ disconnectedAt≠null なら
       removePlayer + player_left（従来フロー：size0でdelete / 収集 / allReturned）+ token破棄
```

- クライアントの `leaveRoom()` アクションは、`socket.disconnect()` の前に **`leave_room` を emit** する（サーバーが即削除するので、その後の disconnect は player 不在で no-op）。これで「退出ボタン＝即削除・猶予なし」「ネットワーク断＝猶予」が確実に分岐する。

### 4.4 再接続ハンドラ（`handlers.ts` `rejoin`）

```
rejoin({ token }):
  found = findPlayerByToken(token)
  if !found: socket.emit('rejoin_failed', {message:'ルームに戻れませんでした'}); return
  { room, player } = found
  reattachPlayer(room, player, socket.id)  // grace timer もクリア
  socket.join(room.code)
  socket.emit('rejoined', { room: toSnapshot(room), status: room.status, selfName: player.name })
  socket.to(room.code).emit('player_reconnected', { playerName: player.name })
```

### 4.5 除外ロジック

- **`allReady`（準備→録音開始の可否）**: 切断中を除外して全員 ready 判定（切断者で止めない）。
- **`allReturned`（評価→ロビーの room_reset）**: 切断中を除外。
- **`uploadExpected`（録音→収集ゲート）**: `beginAudioCollection` で `uploadExpected = 接続中プレイヤーの socketId 集合`（切断中を除外）。切断中に録音終了→切断者は最初から expected に入らない＝収集は止まらない。猶予内に録音中へ復帰しても本人は録音していない（音声なし）ため expected に足さない。

## 5. クライアント実装

### 5.1 socket と再接続（`socket.ts`）

`reconnection:true`（`reconnectionAttempts` と `reconnectionDelay` を設定）。

### 5.2 トークン保持・リロード復帰（`useGameSocket.ts` / `App.tsx`）

- `room_created`/`room_joined` 受信で `localStorage['reconnectToken']` に token を保存。退出/`room_dissolved`/`room_reset`/`rejoin_failed` で破棄。
- socket `connect` イベント: 初回接続でなく**再接続**のとき、token があれば `rejoin(token)` を emit。
- アプリ起動時（App mount）: localStorage に token があれば socket.connect＋`rejoin(token)` を試行（**リロード復帰**）。失敗（`rejoin_failed`）ならトークン破棄しトップ。

### 5.3 状態復元（`rejoined` ハンドラ）

`status`（と snapshot.scores の有無）から画面を復元し ctx を snapshot で再構築:

| 条件 | 復元画面 |
|---|---|
| status = waiting | lobby |
| status = casting | casting（準備画面は casting 内のクライアント遷移なので casting へ戻し、ユーザーが「台本を読む」で prepare へ再遷移） |
| status = recording | recording（§5.6 のバナー付き・recorder 非起動） |
| status = evaluating かつ scores 空 | evaluating |
| status = evaluating かつ scores 非空（結果閲覧中） | result |

（各自が個別にロビーへ戻る仕様のため、結果閲覧中もサーバー status は `evaluating` のまま。scores の有無で evaluating/result を判別する。）

### 5.4 自分が切断中のUI

- socket `disconnect`（事故断）: `cancelRecording()`（既存）＋「接続が切れました。再接続中…」オーバーレイ（解散ダイアログ風の軽量モーダル）を表示。`rejoined` で解除。`reconnect_failed`/試行尽き/`rejoin_failed` でトップへ（「ルームに戻れませんでした」）。

### 5.5 他プレイヤーのUI

- `player_disconnected`: 参加者一覧の該当プレイヤーに「復帰待ち…」バッジ（`RoomSnapshot.players[].connected` を参照）＋トースト。
- `player_reconnected`: バッジ解除＋トースト「◯◯ が復帰しました」。

### 5.6 録音中の復帰（`RecordingScreen.tsx`）

`rejoined` かつ status=recording で復帰した本人は、**録音画面をフル表示（台本・リアクション/SFX/BGM・声量メーター）で演技は可能**だが、**MediaRecorder は起動しない**（`startUploadRecorder` を呼ばない）。画面上部に「⚠️ 接続が切れたため、この録音は記録されません（演技はそのまま続けてOK）」バナー。

## 6. テスト戦略

- **サーバー（統合テスト・testUtils ハーネス）**:
  1. 非ホストの**事故切断**で `player_disconnected` 配信・即 `player_left` しない（猶予保持）。
  2. 猶予内に `rejoin(token)` で付け替え成功・`rejoined`（正しい status）配信・`player_reconnected` 配信・room の players 数が保たれる。
  3. 猶予満了（未復帰）で `player_left`・token破棄。
  4. **退出ボタン相当（意図的切断）**は即 `player_left`（猶予なし）。
  5. 無効トークンで `rejoin_failed`。
  6. casting/recording/evaluating それぞれで rejoin→正しい status で復元。
  7. 除外ロジック: 切断中プレイヤーがいても `allReady`/`allReturned` が成立、録音終了→収集が切断者を待たず finalize（uploadExpected 除外）。
- **クライアント（テストフレームワーク無し）**: `npm run build`（tsc && vite build）clean ＋ 2タブ目視（タブのオフライン化/リロードで復帰・復帰待ち表示・録音中バナー・退出は復帰しない）。

## 7. 非スコープ / 繰り越し

- **ホスト再接続/ホスト移譲（B6）**: 本スライスはホスト切断＝即解散のまま。
- **人数割れ自動復旧（B7）**: 対象外。
- **録音の残り再開（切断中の音声を部分的に録る）**: 対象外（画面復帰＝演技可、記録なし）。
- socket.io の意図的切断 reason 判定が環境依存な場合の明示 `leave_room` 併用は実装時に確定。

## 8. 変更ファイル一覧（見込み）

- `shared/events.ts` — `rejoin`/`leave_room`（C→S）・`rejoined`/`rejoin_failed`/`player_disconnected`/`player_reconnected`（S→C）追加、`room_created`/`room_joined` に token、`RoomSnapshot.players[].connected`。
- `shared/types.ts` — `PlayerSnapshot.connected`（＋必要なら型）。
- `server/src/roomStore.ts` — `Player.token`/`disconnectedAt`、`graceTimers`、`findPlayerByToken`/`reattachPlayer`、`allReady`/`allReturned`/`toSnapshot` 更新。
- `server/src/handlers.ts` — `create_room`/`join_room` で token 返却、`disconnect` の猶予分岐、`rejoin` ハンドラ、`beginAudioCollection` の uploadExpected 除外。
- `server/src/*.test.ts` — §6 の統合テスト（新規 `handlers.reconnect.test.ts` 想定）。
- `client/src/socket.ts` — `reconnection:true`。
- `client/src/useGameSocket.ts` / `client/src/App.tsx` — token 保持・connect/reconnect と起動時 rejoin・`rejoined`/`rejoin_failed`/`player_disconnected`/`player_reconnected` ハンドラ・切断オーバーレイ・復帰待ちバッジ。
- `client/src/screens/RecordingScreen.tsx` — 録音中復帰バナー＋recorder 非起動。
- `client/src/screens/LobbyScreen.tsx` / `CastingScreen.tsx` / `PrepareScreen.tsx` — 「復帰待ち」バッジ表示（参加者一覧）。
