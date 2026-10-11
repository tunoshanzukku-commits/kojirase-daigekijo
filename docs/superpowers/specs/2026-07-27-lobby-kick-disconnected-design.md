# 設計書：ロビーで切断中プレイヤーをキック

- 日付: 2026-07-27
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/disconnect-resilience-b5-reconnect`（B5 の続き）
- 関連: [B5 本人再接続](2026-07-25-backend-disconnect-resilience-B5-reconnect-design.md) / [切断レジリエンス①（中断してロビー）](2026-07-25-backend-disconnect-resilience-abort-design.md)

## 1. 背景とスコープ

B5 で非ホストの事故切断は**60秒の猶予スロット**で保持されるようになった。戻ってくる人を守る仕組みだが、裏返すと「もう戻ってこないと分かっている人」も最大60秒は参加者一覧に「📶 復帰待ち…」として居座る。その間その人は `MAX_PLAYERS` の枠・名前・次ゲームの配役対象を占有し続ける。

本スライスは、**ホストがロビーで、切断中のプレイヤーだけを手動でルームから外せる**ようにする。猶予満了を待たずに部屋を掃除できる状態にするのが目的。

### 決定事項（ブレインストーミングで確定）

- **キックできるのはホストのみ**（ジャンル選択・開始・中断・解散と同じ権限モデル）。
- **キックできるのは切断中（`disconnectedAt != null`）のプレイヤーのみ**。接続中の人を追い出す機能ではない。
- **キックできる状態はロビー画面が出ている間ぜんぶ**＝`status ∈ {waiting, evaluating}`。`evaluating` は「前ゲームの結果待ちで自分だけ先にロビーへ戻った」状態を含むため。`casting`/`recording` は不可。
- **確認 UI は既存の共通 `ConfirmDialog`**（中断・解散と同じ見た目）。行内の小さいボタンの誤タップで、待てば戻る人を消してしまうのを防ぐ。
- **キックされた本人への専用通知は作らない**。本人は切断中でイベントを受け取れず、復帰しようとすると既存の `rejoin_failed`（「ルームに戻れませんでした」）でトップに戻る＝猶予満了と同じ挙動。専用メッセージにするにはキック済みトークンの墓標を部屋に持たせる必要があり、得られるものに対して状態が増えすぎる。

### 実装アプローチ（採用案）

**`kick_player` を新設し、退出処理は既存の `removeNonHostAndNotify` を再利用する。**

キックは「猶予満了で自動的に起きる退出を、ホストが今すぐ起こす」だけである。B5 で切り出した `removeNonHostAndNotify(io, room, socketId)` が、`player_left` 配信・部屋が空なら `deleteRoom`・収集中なら `finalizeEvaluation`・`allReturned` なら `room_reset`・猶予タイマー解除をまとめて行う唯一の退出経路なので、新しい退出経路を足さずに済む。

**却下した案:**

- **接続中も含めてキックできる汎用 `remove_player`**: 本人への通知イベントとクライアント側の「追い出されました」画面が必要になり、要望（切断中のみ）を超える。
- **クライアント側で一覧から隠すだけ**: サーバーが真実源なので、ゴーストは `MAX_PLAYERS`・名前の重複判定・次ゲームの配役対象を占有し続ける。何も解決しない。

## 2. データ契約（`shared/events.ts`）

```ts
// client → server
kick_player: (payload: { playerName: string }) => void
```

- **S→C の新規イベントはなし**。既存の `player_left { playerName }` がそのまま配信され、受信側は現行ハンドラで一覧から消えてトースト「◯◯ が退出しました」が出る。
- socketId はクライアントに露出していないため、他イベント（`ready_updated`・`player_returned` 等）と同じく **`playerName` で対象を指定する**。ルーム内で名前は一意（`hasPlayerName` が重複参加を拒否する）なので同定できる。

## 3. サーバー実装（`handlers.ts`）

```
kick_player({ playerName }):
  room = findRoomBySocket(socket.id);           if !room return
  if room.hostSocketId !== socket.id            return   // ホストのみ
  if room.status !== 'waiting' && !== 'evaluating' return // ロビー相当のみ
  target = [...room.players.values()].find(p => p.name === playerName)
  if !target || target.isHost                   return   // 自分/ホストは対象外
  if target.disconnectedAt == null              return   // 接続中はキックしない
  removeNonHostAndNotify(io, room, target.socketId)
```

- **条件を満たさない場合は黙って無視する**（既存の C→S ハンドラの慣習。不正操作にエラーを返さない）。
- **競合はサーバーが解決する**: ホストの画面が古く、本人が復帰した直後にキックが届いた場合は `disconnectedAt == null` で弾かれる。ホスト側の一覧は `player_reconnected` で「復帰しました」に更新される。
- **二重退出は起きない**: `removeNonHostAndNotify` → `removePlayer` が猶予タイマーを `clearTimeout` + `delete` するため、キック後に猶予満了コールバックが `player_left` を再送しない。
- **`room.players.size === 0` の分岐には到達しない**（ホストが必ず残っている）が、共通関数のガードとして残す。

## 4. クライアント実装

### 4.1 アクション（`useGameSocket.ts`）

`GameActions` に `kickPlayer: (playerName: string) => void` を追加し、`socket.emit('kick_player', { playerName })` を送るだけ。受信側の処理は既存の `onPlayerLeft` がそのまま担う（追加のリスナ不要）。

### 4.2 ロビー画面（`LobbyScreen.tsx`）

- `ctx.isHost && p.connected === false` の行にだけ、「復帰待ち…」バッジの隣に小さな赤系ボタン **「退出させる」** を表示する。ホスト自身の行と接続中の行には出さない。
- タップで共通 `ConfirmDialog` を開く（対象名を state に保持）:
  - title: `◯◯ を退出させますか？`
  - message: `復帰待ちを取り消します。この人は戻れなくなります。`
  - confirmLabel: `退出させる` / cancelLabel: `キャンセル`
- 確定で `actions.kickPlayer(name)`。一覧からの削除は `player_left` 受信で行う（楽観的更新はしない＝サーバーが弾いた場合に表示がズレない）。

## 5. テスト戦略

**サーバー（新規 `server/src/handlers.kick.test.ts`、`server/package.json` の `test` に追加）:**

1. ホストは切断中プレイヤーをキックでき、`player_left` が配信され `players.size` が減る。
2. **接続中**プレイヤーへの `kick_player` は無視される（`player_left` が飛ばない）。
3. **非ホスト**からの `kick_player` は無視される。
4. `status='casting'` / `'recording'` では無視される。
5. `status='evaluating'`（結果待ち）ではキックできる。
6. キック後に猶予が満了しても `player_left` は二度飛ばない。
7. キックされたプレイヤーの token での `rejoin` は `rejoin_failed`。

**クライアント（テストフレームワーク無し）:** `npm run build`（tsc && vite build）clean ＋ 2タブ目視（ゲストをオフライン化 → ホストのロビーで「退出させる」→ 一覧から消える・戻しても復帰できない）。

## 6. 非スコープ / 繰り越し

- **`start_game` の配役が切断中プレイヤーを含む問題**: ゴーストに役が割り当たり、そのセリフを誰も演じない台本ができる。本スライスのキックがあれば開始前に手で掃除できるが、掃除せず開始した場合は残る。「配役対象を接続中のみにする」修正は採点対象（`recordingRoster`・`performers`）の決め方にも波及するため別スライスとする。
- 接続中プレイヤーのキック（迷惑行為対策）は対象外。
- ホスト移譲（B6）・人数割れ自動復旧（B7）は引き続き対象外。

## 7. 変更ファイル一覧（見込み）

- `shared/events.ts` — `kick_player`（C→S）追加。
- `server/src/handlers.ts` — `kick_player` ハンドラ（既存 `removeNonHostAndNotify` を再利用）。
- `server/src/handlers.kick.test.ts` — 新規（§5 の7ケース）。
- `server/package.json` — `test` スクリプトに新テストファイルを追加。
- `client/src/useGameSocket.ts` — `kickPlayer` アクション追加。
- `client/src/screens/LobbyScreen.tsx` — 「退出させる」ボタン＋`ConfirmDialog`。
