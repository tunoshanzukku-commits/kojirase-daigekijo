# Phase B2 録音中インタラクション同期 設計書

*作成日：2026-07-15 / 前提：Phase B1 完了（main にマージ済み, HEAD 7e2fffe）*

## 目的

録音画面（`RecordingScreen`）の**モック演出を実サーバー接続へ**置き換え、録音中のインタラクション（リアクション絵文字・BGM・SFX・声量）を全プレイヤー間でリアルタイム同期する。実音声の録音・アップロード（MediaRecorder / Whisper / Claude 評価）は Phase C に据え置き、B2 は**状態・演出の同期と声量の実測のみ**を扱う。

B2 完了で「2タブで録音フェーズのインタラクションが成立する」縦スライスが完成する。

## スコープ

**含む:**
- `send_reaction` / `reaction_received`：絵文字スタンプを全員に浮遊表示
- `send_bgm` / `bgm_changed`：BGM 選択をルーム共有状態として同期
- `send_sfx` / `sfx_played`：効果音トリガーを全員に配信
- `send_volume` / `volume_update`：各自のマイク声量を Web Audio で実測 → サーバーが**合算（sum-clamp）**した「ルーム声量」を全員へ同期
- `RecordingScreen` の実接続化（モック撤去、`ctx.script`/`ctx.playerName` 方式へ移行）

**含まない（Phase C 繰り越し）:**
- MediaRecorder による実音声の録音・アップロード（`submit_audio`）、Whisper 文字起こし、Claude 評価
- BGM/SFX の**実音声再生**（B2 は選択状態・トリガーの同期と視覚フィードバックのみ）

**B3 で扱う（B2 では触らない）:**
- `stop_recording` / 評価スタブ / `evaluation_complete` / 結果 / `return_to_lobby` / `room_reset`
- 録音中に離脱したプレイヤーの結果表示（スコア null）

## 決定事項（ブレインストーミングで確定）

- **声量メーターは前倒しで実測**（§7-D の実マイク計測）。ただし UI は現状の 12 本イコライザを**作り替えず**、それを**全員の声量を合算した「ルーム声量」1 本**の表示として使う。複数人が同時に話すほどメーターが上がる。
- **合算方式は sum-clamp**（各プレイヤーの level を合計し 0〜1 にクランプ）。max ではない。
- **リアクション・SFX・BGM は全員が操作可能**（現行UI通り／パーティ性重視）。ホスト限定は `start/stop_recording` のみ（B1/B3）。

## イベント契約（`shared/events.ts` 追記）

```typescript
// ClientToServerEvents に追加
send_reaction: (payload: { emoji: string }) => void
send_bgm:      (payload: { bgmId: string | null }) => void
send_sfx:      (payload: { sfxId: string }) => void
send_volume:   (payload: { level: number }) => void   // 0.0〜1.0, 100msごと

// ServerToClientEvents に追加
reaction_received: (payload: { emoji: string; playerName: string }) => void
bgm_changed:       (payload: { bgmId: string | null; playerName: string }) => void
sfx_played:        (payload: { sfxId: string; playerName: string }) => void
volume_update:     (payload: { level: number }) => void   // 合算ルーム声量 0.0〜1.0
```

## 定数（`shared/constants.ts` 追記）

**現行フロント（`RecordingScreen`）の定義に一致させる**（キックオフメモの推測IDは使わない）。

```typescript
export const EMOJIS = ['👏', '😂', '🔥', '😍', '💪'] as const
export const BGM_IDS = ['dramatic', 'horror', 'comedy', 'battle'] as const
export const SFX_IDS = ['drum', 'boom', 'fanfare', 'scream', 'laugh', 'bell'] as const
```

`validation.ts` に許可判定を追加：`isValidEmoji(v)`, `isValidBgmId(v)`（null 許可）, `isValidSfxId(v)`。サーバーは許可リスト外を**黙って無視**（`error` は投げない。高頻度・非致命のため）。

## サーバー設計（`server/src/`）

### roomStore（`Room` 拡張）

```typescript
// Room に追加
bgm: string | null                                  // 現在のルームBGM。初期 null
volumes: Map<string, { level: number; ts: number }> // socketId → 最新声量。初期 空Map
lastVolumeBroadcast: number                          // 直近の volume_update 配信時刻(ms)。初期 0
```

- `createRoom` で `bgm: null`, `volumes: new Map()`, `lastVolumeBroadcast: 0` を初期化。
- `removePlayer` で `room.volumes.delete(socketId)` も行う（離脱者の声量を除去）。
- （B3 の `resetRoom` で `bgm=null`, `volumes.clear()`, `lastVolumeBroadcast=0` に戻す。B2 では未実装で可）。

### 声量ロジック（新規 `server/src/volume.ts`・純粋関数・TDD）

```typescript
export function clamp01(n: number): number
// NaN/非有限は 0、0未満は 0、1超は 1

export function combineFreshVolumes(
  entries: Iterable<{ level: number; ts: number }>,
  now: number,
  windowMs = 500,
): number
// ts が now-windowMs 以降のエントリのみ対象。各 level を clamp01 して合計し、1 にクランプ。
```

- 単体テスト観点：空→0、単一→その値、複数→合計、合計>1→1、古いエントリ（ts が窓外）は除外、負値/NaN→0 扱い。

### handlers（`registerHandlers` に追記）

全ハンドラ共通：`const room = findRoomBySocket(socket.id); if (!room || room.status !== 'recording') return`（録音中のみ受理）。送信者名は `room.players.get(socket.id)?.name`。

- **`send_reaction`**：`isValidEmoji(emoji)` でなければ無視 →
  `socket.to(room.code).emit('reaction_received', { emoji, playerName })`（送信者以外へ。送信者はクライアント側で楽観的表示）。
- **`send_sfx`**：`isValidSfxId(sfxId)` でなければ無視 →
  `socket.to(room.code).emit('sfx_played', { sfxId, playerName })`。
- **`send_bgm`**：`isValidBgmId(bgmId)`（null 可）でなければ無視 → `room.bgm = bgmId`; `touch(room)` →
  `io.to(room.code).emit('bgm_changed', { bgmId, playerName })`（**全員**。共有状態のため送信者も含めて権威化）。
- **`send_volume`**：`recordVolume`（`room.volumes.set(socket.id, { level: clamp01(level), ts: now })`）→
  `if (now - room.lastVolumeBroadcast >= VOLUME_BROADCAST_MS)`（=200ms）なら
  `const combined = combineFreshVolumes(room.volumes.values(), now)`; `room.lastVolumeBroadcast = now`;
  `io.to(room.code).emit('volume_update', { level: combined })`。**専用タイマーは持たない**（タイムスタンプ・スロットル）。

`VOLUME_BROADCAST_MS = 200` は handlers（またはサーバー定数）に定義。

### 配信先の整理

| イベント | 配信 | 理由 |
|---|---|---|
| reaction_received | `socket.to`（送信者以外） | 送信者は楽観的にローカル表示。二重表示回避・即時性 |
| sfx_played | `socket.to`（送信者以外） | 同上 |
| bgm_changed | `io.to`（全員） | 共有状態。最後に押した人が勝つ。全員を権威的に一致 |
| volume_update | `io.to`（全員） | ルーム声量は全員共通の 1 本 |

## クライアント設計（`client/src/`）

### useGameSocket

**追加リスナ:**
- `reaction_received` → 浮遊リアクションを画面に追加（送信者名は将来用に保持可、B2では絵文字のみ表示で可）
- `bgm_changed` → 共有BGM状態を更新（`ctx.bgm` or 画面ローカル）
- `sfx_played` → SFX フラッシュ演出を発火
- `volume_update` → ルーム声量 `level` を反映（イコライザ駆動）

エフェメラル/高頻度なデータ（reactions/sfx/volume）は `GameContext` に溜めず、`RecordingScreen` がマウント中に購読する形が望ましい。実装方式は計画で確定（案：`useGameSocket` にコールバック登録口を設ける or 共有BGMのみ `ctx.bgm`、他は画面ローカルに橋渡し）。**BGM は再入室・再描画で状態が要るため `ctx.bgm` に保持**、reaction/sfx/volume は画面ローカルで可。

**追加アクション:** `sendReaction(emoji)`, `sendBgm(bgmId)`, `sendSfx(sfxId)`, `sendVolume(level)` → 各 `socket.emit`。

### RecordingScreen（実接続化）

- **偽の「他人が勝手にリアクション」タイマーを削除**（現 [88-101 行]）。リアクションは自分の送信（楽観的表示）＋ `reaction_received`（他人分）で構成。
- **BGM**：`currentBgm` を `ctx.bgm`（`bgm_changed` 駆動）に置換。ボタン押下で `sendBgm(id or null)`。
- **SFX**：ボタン押下で `sendSfx(id)`＋自分のフラッシュを楽観的表示。`sfx_played` で他人のトリガーもフラッシュ。
- **リアクション**：ボタン押下で `sendReaction(emoji)`＋楽観的に浮遊表示。`reaction_received` で他人分を浮遊表示。
- **声量メーター（実測）**：録音開始時に `navigator.mediaDevices.getUserMedia({ audio: true })` を再取得（許可済みのため再プロンプトなし）→ `AudioContext` + `AnalyserNode`。約100msごとに RMS/振幅から `level`(0〜1) を算出し `sendVolume(level)`。イコライザ（12本）は **`volume_update` の合算 `level`** で駆動（自分ローカルの値ではなくルーム声量）。録音画面アンマウント/終了時に track 停止・`AudioContext.close()`。
- **台本表示**：`FULL_SCRIPT`/`getMockPlayer` 依存を B1 と同様に `ctx.script?.entries ?? FULL_SCRIPT` と `ctx.script ? ctx.playerName : getMockPlayer(...)` へ移行。
- 現状のカウントダウン→recording のローカル演出、`stop_recording`（「録音終了」ボタンの実接続）は **B3** で扱う。B2 では「録音終了」ボタンの遷移は現状のまま（ローカル `onNavigate('evaluating')`）に留める。

## テスト方針（Phase A/B1 と同じ）

- **サーバー統合テスト**（`node:test` + 硬化済み `testUtils`）：ルームを `recording` 状態にする helper を用意（create→join→set_genre→start_game→set_ready×2→start_recording）。
  - `send_reaction`：許可絵文字は他プレイヤーに `reaction_received{emoji, playerName}`、送信者自身には**届かない**（`socket.to`）、不正絵文字は無視。
  - `send_sfx`：同様（`sfx_played`）。
  - `send_bgm`：`bgm_changed{bgmId, playerName}` が**送信者含む全員**へ、`room.bgm` 更新、null で解除、不正IDは無視。
  - `send_volume`：`volume_update{level}` が配信される、合算・クランプが効く、スロットル（200ms未満の連続送信で追加配信が出ない）。
  - `status !== 'recording'` では 4 イベントとも無視される。
- **声量純粋関数**（`volume.ts`）：単体テスト（合計・クランプ・古値除外・異常値）。
- **クライアント**：`tsc --noEmit` + `vite build`。live 2〜3 クライアント headless E2E（reaction/bgm/sfx/volume の配信確認）。Web Audio 実測は headless 検証が難しいため**声量計測部分は2タブ目視**、同期ロジックはサーバー側単体・統合でカバー。

## タスク分解（B2 = 1 サブフェーズ = 1 計画）

各タスク TDD・小コミット。

1. `shared/events.ts` に 4+4 イベント、`shared/constants.ts` に `EMOJIS`/`BGM_IDS`/`SFX_IDS`、`validation.ts` に許可判定＋テスト。
2. `server/src/volume.ts`（`clamp01`/`combineFreshVolumes`）＋単体テスト。
3. `roomStore`：`Room` に `bgm`/`volumes`/`lastVolumeBroadcast`、`createRoom` 初期化、`removePlayer` で `volumes.delete`＋テスト。
4. `handlers`：`send_reaction`/`send_bgm`/`send_sfx`/`send_volume` の 4 ハンドラ＋統合テスト（recording 状態 helper 含む）。
5. クライアント：`useGameSocket` の 4 リスナ＋4 アクション、`GameContext.bgm` 追加。
6. `RecordingScreen` 実接続化（モック撤去・Web Audio 声量計測・BGM/SFX/リアクション/声量の実接続・`ctx.script` 移行）。

## 繰り越し・非スコープ

- 録音終了（`stop_recording`）と評価→結果→ロビーは **B3**。
- BGM/SFX の実音声再生・実台本・Whisper・Claude 評価は **Phase C**。
- Phase A レビュー由来の繰り越し（`start_game` の genre/最小人数ガード、host 権限拒否の統合テスト、正規名エコー）は B2 では扱わず、B3 or hardening パスへ継続。
