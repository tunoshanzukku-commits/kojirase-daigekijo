# Phase B 着手メモ（準備→録音→評価スタブ→結果 のリアルタイム同期）

*作成日：2026-07-13 / 前提：Phase A 完了（main, HEAD ee894af）*

このメモは Phase B を**すぐ着手できる状態**にするための手順書。実装は「ブレインストーミング→設計書→計画→サブエージェント駆動」の Phase A と同じサイクルで進める。まず §7 の「要決定事項」を潰してから §6 の分解で計画を書く。

---

## 1. スコープ

Phase A で `top→lobby→casting` が実サーバー接続済み。Phase B は残りのゲーム進行 `casting→prepare→recording→evaluating→result→(lobby)` をリアルタイム同期する。**評価はスタブ**（実音声・Whisper・Claude 評価は Phase C）。

**Phase B に含む:**
- 準備：`set_ready`/`ready_updated`（allReady 判定）、`force_start`（ホスト・タイマー切れ後）
- 録音：`start_recording`/`recording_started`、`stop_recording`/`recording_stopped`、`send_reaction`/`reaction_received`、`send_bgm`/`bgm_changed`、`send_sfx`/`sfx_played`、`send_volume`/`volume_update`
- 評価（スタブ）：`recording_stopped` 後にサーバーが**スタブ `PlayerScore[]` を生成**→`evaluation_complete` を配信
- 結果→ロビー：`return_to_lobby`/`player_returned`、全員復帰で `room_reset`

**Phase C に繰り越し（Phase B では触らない）:**
- `submit_audio`（MediaRecorder 実音声）、Whisper 文字起こし、Claude 評価
- BGM/SFX の実音声再生、Claude 本番台本生成
- 声量メーターの Web Audio 実測（§7-D で B に入れるか判断）

---

## 2. 追加するイベント契約（`shared/events.ts`）

Phase A のマップに追記する。**フェーズごとに追記**し、Phase C 用は今は入れない。

```typescript
// ClientToServerEvents に追加
set_ready:       (p: { isReady: boolean }) => void
force_start:     () => void                          // host only, タイマー切れ後
start_recording: () => void                          // host only
stop_recording:  () => void                          // host only
send_reaction:   (p: { emoji: string }) => void
send_bgm:        (p: { bgmId: string | null }) => void
send_sfx:        (p: { sfxId: string }) => void
send_volume:     (p: { level: number }) => void      // 0.0〜1.0, 100msごと
return_to_lobby: () => void

// ServerToClientEvents に追加
ready_updated:      (p: { playerName: string; isReady: boolean; allReady: boolean }) => void
recording_started:  () => void
recording_stopped:  () => void
reaction_received:  (p: { emoji: string; playerName: string }) => void
bgm_changed:        (p: { bgmId: string | null; playerName: string }) => void
sfx_played:         (p: { sfxId: string; playerName: string }) => void
volume_update:      (p: { volumes: Record<string, number> }) => void  // playerName→level
evaluation_started: () => void
evaluation_complete:(p: { scores: PlayerScore[] }) => void
player_returned:    (p: { playerName: string }) => void
room_reset:         (p: { room: RoomSnapshot }) => void
```

`shared/constants.ts` に許可リストを追加：`EMOJIS`（👏😂🔥😍💪）、`BGM_IDS`（dramatic/creepy/comical/battle）、`SFX_IDS`（drumroll/dawn/fanfare/scream/laugh/chin）。※フロントの `RecordingScreen` の現行絵文字・BGM・SFX 定義と一致させる（実装時に現物を確認）。

---

## 3. サーバー変更（`server/src/`）

Phase A の `Room`/`Player` は既に `status: RoomStatus` と `Player.isReady` を持つ。追加で必要なもの：

- **roomStore**: `Room` に `recordingStartedAt?: number`（最大5分タイムアウト用）。ヘルパー追加：`setReady(room, socketId, isReady)`、`allReady(room): boolean`、`resetRoom(room)`（status='waiting', script=null, scores=[], 全員 isReady=false, recordingStartedAt=undefined）。
- **handlers**（`registerHandlers` に追記、全て host 権限チェックは Phase A の `findRoomBySocket + hostSocketId` パターンを踏襲）：
  - `set_ready`：自分の isReady 更新→`io.to(code).emit('ready_updated', {playerName, isReady, allReady})`
  - `force_start`：host のみ・準備タイマー切れ後のみ受理（タイマー基準は §7-B の決定に従う）→ 録音開始へ
  - `start_recording`：host のみ→status='recording'、`recordingStartedAt=Date.now()`、最大5分の自動終了タイマー設定→`io.to(code).emit('recording_started')`
  - `stop_recording`：host のみ（or 5分タイムアウト）→status='evaluating'→`recording_stopped`→**スタブ評価**：`generateStubScores(room)` を生成し `room.scores` に保存→`evaluation_complete {scores}`（`evaluation_started` を挟むかは §7-C）
  - `send_reaction`/`send_bgm`/`send_sfx`：許可リスト検証→`io.to(code).emit(...received/changed/played, {..., playerName})`
  - `send_volume`：level を 0..1 にクランプしてルームに保持→（スロットルして）`volume_update {volumes}` を配信。**高頻度なので配信間隔の設計に注意**（§7-D）
  - `return_to_lobby`：送信者を「復帰済み」にマーク→`player_returned {playerName}`→全員復帰で `resetRoom` して `room_reset {room}`
  - `disconnect` 拡張：録音中/評価中の切断は「そのプレイヤーはスコア null」で扱う（Phase A の player_left/room_dissolved は踏襲）
- **新規** `server/src/ai/scoreStub.ts`：`generateStubScores(playerNames): PlayerScore[]`（acting/emotion/kojirase を 1〜5 で機械生成、comment はスタブ文。Phase C で Whisper+Claude に差替、同シグネチャ維持）。TDD。

---

## 4. クライアント変更（`client/src/`）

`GameContext` と `useGameSocket` を拡張し、各画面のモックを実接続へ。

- **GameContext 追加**：`readyMap: Record<string, boolean>`（or players に isReady を反映）、`reactions`/`bgm`/`volumes` はエフェメラルなので画面ローカル or context。`scores` は Phase A で既にある（評価結果を格納）。
- **useGameSocket 追加リスナ**：`ready_updated`→readyMap 更新、`recording_started`→recording へ遷移、`recording_stopped`→evaluating へ、`evaluation_complete`→scores 反映＋result へ、`reaction_received`/`bgm_changed`/`sfx_played`/`volume_update`→該当画面へ反映、`player_returned`/`room_reset`→lobby リセット。アクション追加：`setReady/forceStart/startRecording/stopRecording/sendReaction/sendBgm/sendSfx/sendVolume/returnToLobby`。
- **PrepareScreen**：準備完了トグル→`set_ready`、全員の準備状況を `ready_updated` で表示、ホストの録音開始ボタンは `allReady` or タイマー切れで有効化→`start_recording`/`force_start`。マイク許可フローは既存（維持）。
- **RecordingScreen**：`recording_started` でカウントダウン開始、絵文字スタンプ→`send_reaction`＋`reaction_received` で全員分表示、BGM/SFX パネル→`send_bgm`/`send_sfx`＋`bgm_changed`/`sfx_played`、声量メーター→`send_volume`＋`volume_update`（§7-D）、ホスト「録音終了」→`stop_recording`。
- **EvaluatingScreen**：現状クライアント側の固定アニメ。Phase B では `evaluation_complete` 受信で result へ遷移（アニメは演出として残すが遷移は受信ドリブンに）。§7-C。
- **ResultScreen**：`ctx.scores`（スタブ）を表示、「ロビーへ戻る」→`return_to_lobby`。
- **LobbyScreen**：`room_reset` で fromResult 状態＋ジャンル等をリセット、`player_returned` で帰還状況バッジ（Phase A で残してある fromResult UI を実データ化）。
- **casting→prepare 遷移**：§7-A の決定に従う。

---

## 5. テスト方針（Phase A と同じ）

- サーバー：`node:test`＋硬化済み `testUtils`（once timeout / io.close / reconnection:false）で統合テスト。TDD。
  - set_ready→ready_updated（allReady 計算）、force_start のタイマーガード、start/stop_recording の status 遷移＋放送、reaction/bgm/sfx の許可リスト検証＋放送、return_to_lobby の全員復帰→room_reset、scoreStub、切断時のスコア null。
- クライアント：`tsc --noEmit`＋`vite build`。結合は live サーバーに 2〜3 クライアントの headless socket スクリプト（Phase A の `_e2e_verify.mjs` パターン）。DOM 目視は 2 タブ（Chrome 導入は admin 権限要）。

---

## 6. 提案する分解（各サブフェーズが独立して動作・レビュー可能）

Phase A 同様、大きすぎるので分割。**サブフェーズ単位で 設計書→計画→実装**。

- **B1 準備フェーズ**：set_ready/ready_updated/force_start ＋ casting→prepare→recording への遷移同期。RecordingScreen はまだモック演出のまま「録音中表示」だけ実遷移。
- **B2 録音中インタラクション**：reaction/bgm/sfx/volume の同期。RecordingScreen を実接続化。
- **B3 評価スタブ→結果→ロビー復帰**：stop_recording→evaluation_complete(スタブ scores)→result→return_to_lobby→room_reset。EvaluatingScreen/ResultScreen/LobbyScreen(fromResult) を実接続化。

各サブフェーズ完了で「2タブで通しプレイの一部が成立」する縦スライスになる。

---

## 7. 着手前に決めること（ブレインストーミングで潰す）

- **A. casting→prepare の遷移**：各クライアントが「台本を読む→」で個別に prepare へ入るか、ホスト操作で全員同時か。現行フロント（casting は個別ボタン）と仕様書§3⑤（ホスト起点）で食い違い。→ 個別入室でも準備状況は同期されるので個別で良いか要確認。
- **B. 準備タイマーの権威**：`SKIP_UNLOCK_SEC=30` のカウントをサーバー基準にするか各クライアント基準か。force_start をサーバーが受理する条件（タイマー切れ）をどう判定するか（recording へ入る前の prepare 開始時刻をサーバーが持つ必要）。
- **C. Evaluating の駆動**：クライアント固定アニメ（〜6秒）を残しつつ `evaluation_complete` 受信で遷移か、完全サーバー駆動か。スタブは即時生成できるので「最低アニメ時間＋受信」で自然に。
- **D. 声量メーターの扱い**：Web Audio 実測を B に入れるか。`send_volume` は 100ms×人数で高頻度。配信はサーバーが N ミリ秒ごとに集約ブロードキャスト推奨。実測が重ければ B ではモック維持し実測を C に回す選択も。
- **E. 切断時のスコア表示**：録音中に抜けたプレイヤーを結果でどう出すか（仕様書§6：グレーの退出カード）。B3 で実装するか。

---

## 8. Phase A レビュー由来の繰り越し（B のどこかで畳む）

- `start_game` にサーバー側の genre 妥当性・最小人数(≥2)ガードを追加（**B1 着手時に入れると安全**。Phase C の Claude 課金前に必須）。
- host 権限拒否（ゲストの set_genre/start_game/start_recording 等が無視される）と MAX_PLAYERS/status≠waiting の統合テストを追加。
- サーバーが `room_created`/`room_joined` で**正規化後の自分の名前**をエコーし、クライアントの自己判定を権威化（現状は client 側の trim 名に依存）。
- 生成中オーバーレイをゲストにも（Phase C の Claude 遅延で意味を持つ）。

---

## 9. キックオフ手順（この順で実行）

1. `superpowers:brainstorming` で §7 の A〜E を決める（このメモを入力に使う）。
2. サブフェーズ B1 の設計書を `docs/superpowers/specs/` に作成・コミット。
3. `superpowers:writing-plans` で B1 の実装計画（TDD・小コミット）を作成。
4. `superpowers:subagent-driven-development` で実装（実装は well-specified なら haiku、統合/判断は sonnet、最終レビューは opus）。
5. B1 完了→同サイクルで B2、B3。
6. ブランチ：`feature/backend-phaseB1-prepare` 等。各サブフェーズ完了で main へマージ（Phase A と同じ運用）。

**参照**：backend 仕様書 `doc/backend仕様書.md`（§4 イベント全定義・§5 AI フロー・§6 エラー）、frontend 仕様書 `doc/frontend仕様書.md`（§4-4準備/§4-5録音/§4-6評価/§4-7結果）、Phase A 設計/計画 `docs/superpowers/{specs,plans}/2026-07-04-backend-phaseA-lobby*`。
