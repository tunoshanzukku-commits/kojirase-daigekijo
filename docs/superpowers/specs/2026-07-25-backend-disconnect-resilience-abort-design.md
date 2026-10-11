# 設計書：切断レジリエンス①「中断してロビーへ戻る」（ホスト操作の安全網）

- 日付: 2026-07-25
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/disconnect-resilience-abort`
- 関連: [全体仕様書](../../../doc/仕様書.md) / [Phase D SNSシェア設計](2026-07-25-frontend-phaseD-sns-share-design.md)

## 1. 背景とスコープ

Phase A〜D でコアループが実キーで一気通貫に動くようになったが、**進行中（配役/準備/録音）にプレイヤーが抜けたときにゲームが「戻れない」状態**になる課題が残っている。「戻れない」は実は3つの別問題を含む:

- **A. 抜けた本人が戻れない** — 切断＝`socket.id` 消滅で確定退出。`join_room` は `waiting`/`evaluating` 以外を拒否するため、進行中の再入室ができない。真の再接続には本人同定（トークン/名前）＋猶予スロット＋状態復元が必要で重い。
- **B. ホストが落ちると全滅** — どの段階でもホスト切断で `room_dissolved`＋部屋削除。全員がトップ画面へ放り出される。
- **C. 残った人が詰む** — 誰かが抜けても配役/準備/録音から抜け出す中断導線が無い。やり直したくてもロビーへ戻れない。

**本スライスのスコープは C のみ**＝ホスト操作の「中断してロビーへ戻る」導線を追加すること。A（本人再接続）と B（ホスト移譲）は後日の別スライスに繰り越す（§7）。ユーザー確認により、ホスト切断は**現状維持＝解散**、残り人数割れ時の**自動復旧は入れない**（純粋に手動ボタンのみ）と決定済み。

### 現状把握（実装で確認済みの事実）

- サーバーのステータスは `waiting / casting / recording / evaluating` の4つ。**`preparing` ステータスは存在しない**。配役画面も準備画面も、サーバー上は `status: 'casting'`（casting→prepare はクライアント内遷移のみ）。`start_recording` で `recording` に移る。
- 準備中に**非ホストが抜けても実は詰まない**: ホストは30秒スキップタイマー（`SKIP_UNLOCK_SEC`）で録音開始でき、`allReady` は残ったプレイヤーだけで再計算される。真に詰むのはホスト切断時（B・本スライス対象外）と、「やり直したいのに戻る導線が無い」場合（C・本スライス対象）。
- 進行中はホスト切断＝解散なので、**ホストは配役/準備/録音の間は必ず在室している**。したがって中断ボタンはホスト専用で十分（権限判定は `hostSocketId` 一致のみ）。
- クライアント socket は `reconnection: false`（[socket.ts](../../../client/src/socket.ts)）。本スライスはこの前提を一切変更しない。

## 2. 決定事項（ブレインストーミングで確定）

- **中断はホスト操作の手動ボタン1つのみ**。ホスト移譲・自動復旧・本人再接続は非スコープ。
- **専用イベント方式**を採用（既存 `room_reset` の再利用ではなく）。理由: 録音中に「押していない非ホスト」が突然ロビーへ飛ぶため、**中断理由をトーストで説明**でき、`room_reset`（＝全員が結果画面から復帰）と意味が混ざらないため。
- **対象ステータスは `casting` と `recording` のみ**。`evaluating` は既存の `return_to_lobby` があるので対象外。`generatingScript` 中（台本生成中・status は `waiting` のまま）はボタン非表示。

## 3. アーキテクチャ方針

- **サーバーが真実源**。中断は必ずサーバーの `abort_game` ハンドラを通し、`resetRoom(room)` で状態を確定させてから `game_aborted` を配信する。クライアントが勝手に画面だけ戻すことはしない。
- **既存資産の再利用**: `resetRoom`（status→waiting・script/scores/audio クリア・timers クリア・`evaluationSeq++`・genre 保持・ready フラグ全解除）と `toSnapshot` をそのまま使う。ctx の復元形は既存 `onRoomReset` と同一。
- **冪等・防御的**: ホスト以外／対象外ステータスは黙って無視（既存ハンドラの流儀）。2回押されても2回目は status が `waiting` のため弾かれる。

## 4. イベント/データ契約（`shared/events.ts`）

追加は2つだけ。

```ts
// ClientToServerEvents
abort_game: () => void
// ServerToClientEvents
game_aborted: (payload: { room: RoomSnapshot }) => void
```

- `game_aborted.room` は `toSnapshot(room)`（status='waiting'・genre 保持・players 現在値・script は null・scores は空）。クライアントはこれで ctx を復元する（`room_reset` と同じ形）。
- 中断理由テキストはサーバーから送らず、クライアント側で固定文言をトースト表示する（文言のローカライズをクライアントへ集約）。

## 5. サーバー実装（`server/src/handlers.ts`）

```ts
socket.on('abort_game', () => {
  const room = findRoomBySocket(socket.id)
  if (!room || room.hostSocketId !== socket.id) return
  if (room.status !== 'casting' && room.status !== 'recording') return // 対象外は無視
  resetRoom(room)          // status→waiting・script/audio/scores/timers クリア・genre 保持・evaluationSeq++
  touch(room)
  io.to(room.code).emit('game_aborted', { room: toSnapshot(room) })
})
```

- `resetRoom` が `clearRoomTimers`（recordingTimer/uploadTimer）を行うため、**録音自動終了タイマーは確実に停止**する。`evaluationSeq++` により、万一 in-flight の評価があっても stale な `evaluation_complete`/`evaluation_failed` は既存ガード（`room.evaluationSeq !== myEval`）で無効化される。
- レース: 録音自動終了（`beginAudioCollection`）が先に走って status が `evaluating` へ移った直後の abort は、status ガードで無視される。その場合ホストは結果画面の既存 `return_to_lobby` でロビーへ戻れる（許容）。

## 6. クライアント実装

### 6.1 `useGameSocket.ts`

- **アクション追加** `GameActions.abortGame`:
  ```ts
  abortGame() { socket.emit('abort_game') }
  ```
- **ハンドラ追加** `onGameAborted({ room })`（登録/解除も対で追加）:
  - `cancelRecording()` — 録音中でも安全にマイク/レコーダーを解放（未録音時も無害）。
  - ctx を `onRoomReset` と同一の形にリセット（`genre`/`players` は snapshot 由来、`script=null`, `scores=[]`, `readyMap={}`, `bgm=null`, `leftPlayers=[]`, `returnedPlayers=[]`）。
  - `pushToast('ゲームを中断してロビーに戻りました', 'info')`。
  - `setScreen('lobby')`。

### 6.2 中断ボタン（ホストのみ表示）

- 対象画面: `CastingScreen`（配役）・`PrepareScreen`（準備）・`RecordingScreen`（録音）。
- ラベル「⚠️ 中断してロビーへ戻る」。控えめな配置（画面下部・セカンダリ配色）で誤操作しにくくする。
- **確認ダイアログ**（破壊的操作＝台本・録音を破棄するため必須）: App の解散ダイアログと同じ軽量モーダルの見た目で、「ゲームを中断してロビーに戻りますか？　台本と録音は破棄されます」→［中断する／やめる］。
  - **共通コンポーネント `client/src/components/ConfirmDialog.tsx` を新設**して3画面で共用する（各画面へのベタ書きを避ける）。props 例: `{ open, title, message, confirmLabel, cancelLabel, onConfirm, onCancel }`。確認押下で `actions.abortGame()` を呼ぶ。
- `CastingScreen` は現状 `actions` を受け取っていない（`onNavigate` のみ）。props に `actions` を追加し、[App.tsx](../../../client/src/App.tsx) の配線も更新する。`PrepareScreen`/`RecordingScreen` は既に `actions` を受け取っている。

## 7. 非スコープ / 繰り越し

- **A. 本人再接続**（切断した本人が進行中の部屋・画面へ復帰）: 本人同定（セッショントークン or 名前）＋猶予スロット＋状態復元＋`reconnection` 設定変更が必要。別スライスで対応。
- **B. ホスト移譲**（ホスト切断でも部屋を存続）: 本スライスは現状維持＝解散。別スライスで対応。
- 残り人数がプレイ可能人数（2人）を割ったときの**自動ロビー復帰は入れない**（手動ボタンのみ）。
- `evaluating` からの復帰は既存 `return_to_lobby` のままで変更しない。

## 8. テスト戦略

- **サーバー（統合テスト・`server/src/testUtils.ts` ハーネス）**:
  1. ホストが `casting` 中に `abort_game` → 全クライアントに `game_aborted` が届き、room が `waiting` に戻る・**genre は保持**される。
  2. `recording` 中に `abort_game` → `game_aborted` 配信・録音タイマーが消え評価に進まない（`recording_stopped`/`evaluation_complete` が来ない）。
  3. **非ホスト**の `abort_game` は無視される（何も配信されない）。
  4. `waiting`/`evaluating` 中の `abort_game` は無視される（対象外ステータス）。
- **クライアント（テストフレームワーク無しの方針どおり）**: `npm run build`（`tsc && vite build`）が clean であること ＋ 2タブ目視（ホストで中断→両タブがロビーへ戻る・非ホストにトースト・録音中ならマイク解放・genre と参加者が保持されて再スタート可能）。

## 9. 変更ファイル一覧（見込み）

- `shared/events.ts` — `abort_game`（C→S）・`game_aborted`（S→C）を追加。
- `server/src/handlers.ts` — `abort_game` ハンドラ追加。
- `server/src/handlers.abort.test.ts` — 新規（既存の handlers.*.test.ts が関心ごとに分割されている慣習に合わせる）。§8 の4ケース。
- `client/src/useGameSocket.ts` — `abortGame` アクション＋`onGameAborted` ハンドラ（登録/解除）追加。
- `client/src/components/ConfirmDialog.tsx` — 新規（共通確認モーダル）。
- `client/src/screens/CastingScreen.tsx` — props に `actions` 追加・中断ボタン＋確認。
- `client/src/screens/PrepareScreen.tsx` — 中断ボタン＋確認。
- `client/src/screens/RecordingScreen.tsx` — 中断ボタン＋確認。
- `client/src/App.tsx` — `CastingScreen` へ `actions` を配線。
