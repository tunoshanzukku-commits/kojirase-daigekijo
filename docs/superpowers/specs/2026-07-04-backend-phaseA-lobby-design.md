# Phase A 設計書：サーバー雛形＋ロビー実接続

*作成日：2026-07-04*

---

## 1. 目的とスコープ

フロントエンドは7画面すべてモックデータで完成しているが、バックエンドは未実装（仕様書のみ）。本フェーズ（Phase A）では、リアルタイム多人数プレイの**土台**を作る。

**Phase A のゴール（垂直スライス）:**

2つ以上のブラウザで、
1. ホストがルームを作成しコードを受け取る
2. ゲストがコードで参加し、全員の一覧がリアルタイム同期する
3. ホストがジャンルを選ぶと全員の背景・選択がリアルタイム同期する
4. ホストが「ゲーム開始」を押すと、スタブ台本が `script_ready` で全員に配信され、**全員が同時に配役画面へ遷移**する
5. 切断（ホスト/ゲスト）が最低限ハンドリングされる

台本生成はスタブ（参加者名から機械的に生成）。**AI本統合・準備/録音/結果の同期は Phase B / C に回す。**

### スコープ外（次フェーズ）

- 準備/録音/結果画面のリアルタイム同期（`set_ready` `start_recording` `stop_recording` `send_reaction` `send_bgm` `send_sfx` `send_volume` 等）
- AI本番（Claude 台本生成 / Whisper 文字起こし / Claude 評価）
- 音声録音・提出（MediaRecorder / `submit_audio`）
- 声量メーター・BGM/SFX の実再生
- SNSシェア、ハプニングイベント、iOS Safari 対応
- Railway 本番デプロイ・フロント/バック同居構成

---

## 2. 全体構成と型共有方針

client と server は Socket.io で同じデータをやり取りするため、型・定数の**単一の真実源**をリポジトリ直下 `shared/` に置き、両方から `@shared/*` エイリアスで直接 import する（素の `.ts`・ビルド不要）。

```
AiSibaiProject/
├─ shared/                 ← 新設（client / server 共有）
│   ├─ types.ts            ScriptData, PlayerScore, ScriptEntry, RoleInfo,
│   │                      RoomSnapshot, PlayerSnapshot, RoomStatus
│   ├─ events.ts           ClientToServerEvents / ServerToClientEvents（Socket.io 型マップ）
│   └─ constants.ts        GENRES(8), NAME_MAX=10, ROOM_CODE_LEN=4, MAX_PLAYERS=10
│
├─ client/                 ← 既存（socket.ts 追加・Top/Lobby/App を実接続化）
│   └─ src/
│       ├─ types.ts        → `export * from '@shared/types'`（後方互換の再エクスポート）
│       ├─ genres.ts       → GENRES を `@shared/constants` から再エクスポート
│       ├─ socket.ts       ← 新設：型付き io() シングルトン
│       └─ useGameSocket.ts← 新設：socket 配線フック（App が使用）
│
└─ server/                 ← 新設 TypeScript
    ├─ package.json        express, socket.io, cors, tsx(dev), typescript
    ├─ tsconfig.json       paths: @shared/* → ../shared/*
    └─ src/
        ├─ index.ts        Express + Socket.io 起動、CORS、handlers 登録、cleanup タイマー
        ├─ roomStore.ts    rooms: Map<code, Room> / create/join/leave/get / cleanup
        ├─ roomCode.ts     I・O 除外 A〜Z 4文字生成・衝突回避
        ├─ validation.ts   sanitizeName / isValidGenre / normalizeRoomCode
        ├─ handlers.ts     socket 接続ごとのイベント配線（create/join/set_genre/start_game/disconnect）
        └─ ai/scriptStub.ts 参加者名＋ジャンルからスタブ ScriptData を生成（後に Claude へ差替）
```

### 型共有の中身

| ファイル | 内容 | 共有理由 |
|---------|------|---------|
| `types.ts` | `ScriptData` `PlayerScore` `ScriptEntry` `RoleInfo` `RoomSnapshot` `PlayerSnapshot` `RoomStatus` | サーバーが生成・送信し、クライアントが受信・表示する。送受で同じ型である必要がある |
| `events.ts` | Socket.io のイベント名と引数の型マップ | イベント名 typo・引数不一致をコンパイル時に検出。片方の変更が即もう片方のエラーになる |
| `constants.ts` | `GENRES`(8種), `NAME_MAX`, `ROOM_CODE_LEN`, `MAX_PLAYERS` | フロントの入力制限とサーバーの検証で同じルールを使い、ズレを防ぐ |

`shared/types.ts` は現行 `client/src/types.ts` の内容を移設し、`RoomSnapshot` `PlayerSnapshot` `RoomStatus` を追加する。`shared/constants.ts` の `GENRES` は現行 `client/src/genres.ts` の定義を移設する。移設後、client 側の `types.ts` / `genres.ts` は再エクスポートにして既存 import を壊さない。

---

## 3. 開発ワークフロー

| 項目 | 内容 |
|------|------|
| サーバー起動 | `server/` で `npm run dev`（tsx watch）→ `http://localhost:3001` |
| クライアント起動 | 既存どおり `client/` で `npm run dev` → `http://localhost:5173` |
| 接続先 | client は `import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'` |
| CORS | server は dev で Vite origin（`http://localhost:5173`）を許可 |
| 多人数テスト | ブラウザを2タブ開き、片方で作成・もう片方で参加 |
| ルート | ルート直下に開発補助の `package.json`（任意）で `dev` を並列起動できるようにする（`concurrently`）。必須ではない |

---

## 4. サーバーのデータモデル（インメモリ）

```typescript
// server 内部型（PlayerSnapshot/RoomSnapshot は shared から）
interface Player {
  socketId: string
  name: string
  isHost: boolean
  isReady: boolean        // Phase A では常に false（準備は Phase B）
}

interface Room {
  code: string
  status: RoomStatus      // Phase A は 'waiting' → start_game で 'casting'
  genre: string           // 初期 ''（未選択）
  script: ScriptData | null
  scores: PlayerScore[]   // Phase A は []
  players: Map<string, Player>   // socketId → Player
  hostSocketId: string
  createdAt: number
  lastActivityAt: number
}

const rooms = new Map<string, Room>()   // code → Room
```

### ルームコード生成（roomCode.ts）

- 使用文字：`A〜Z` から紛らわしい `I` `O` を除いた24文字
- 4文字ランダム生成。既存コードと衝突したら再生成
- 生成上限リトライを設け、万一超過時はエラー

### クリーンアップ（roomStore.ts）

- 判定タイマー（例：5分間隔）で全ルームを走査
- 「最終操作から1時間経過」または「players が空」のルームを削除
- 各イベント処理時に `lastActivityAt = Date.now()` を更新

---

## 5. Socket.io イベント契約（Phase A サブセット）

`shared/events.ts` に型で定義する。Phase B / C のイベントはここでは定義せず、フェーズごとに追記する。

### ClientToServerEvents

| イベント | ペイロード | 権限 | 処理 |
|---------|-----------|------|------|
| `create_room` | `{ playerName: string }` | 誰でも | 名前検証 → ルーム作成（作成者=ホスト）→ 発行元へ `room_created` |
| `join_room` | `{ roomCode: string, playerName: string }` | 誰でも | コード正規化・存在確認・状態確認・満員確認・名前検証/重複確認 → 参加 → 発行元へ `room_joined`・他全員へ `player_joined` |
| `set_genre` | `{ genre: string }` | ホストのみ | ジャンル検証 → `room.genre` 更新 → 全員へ `genre_changed` |
| `start_game` | （なし） | ホストのみ | スタブ台本生成 → `room.status='casting'`, `room.script=script` → 全員へ `script_ready` |

### ServerToClientEvents

| イベント | ペイロード | 宛先 | 意味 |
|---------|-----------|------|------|
| `room_created` | `{ roomCode: string, room: RoomSnapshot }` | 発行元 | ルーム作成成功 |
| `room_joined` | `{ room: RoomSnapshot }` | 発行元 | 参加成功 |
| `player_joined` | `{ player: PlayerSnapshot }` | 他全員 | 新規参加者を通知 |
| `genre_changed` | `{ genre: string }` | 全員 | ジャンル同期 |
| `script_ready` | `{ script: ScriptData }` | 全員 | 台本配信・配役へ遷移 |
| `player_left` | `{ playerName: string }` | 残り全員 | ゲスト切断 |
| `room_dissolved` | （なし） | 残り全員 | ホスト切断でルーム解散 |
| `error` | `{ message: string }` | 発行元 | 検証・処理エラー |

### RoomSnapshot / PlayerSnapshot（shared/types.ts）

```typescript
type RoomStatus = 'waiting' | 'casting' | 'preparing' | 'recording' | 'evaluating' | 'result'

interface PlayerSnapshot {
  name: string
  isHost: boolean
  isReady: boolean
}

interface RoomSnapshot {
  code: string
  status: RoomStatus
  genre: string
  players: PlayerSnapshot[]
  script: ScriptData | null
  scores: PlayerScore[]
}
```

---

## 6. 入力検証（validation.ts、backend仕様書§3 準拠）

| 項目 | ルール | 違反時 |
|------|--------|--------|
| playerName | trim → 制御文字・改行除去 → 1〜10文字。同一ルーム内で重複不可 | `error`「名前は1〜10文字で入力してください」/ 重複時「その名前は使われています」 |
| roomCode | 大文字化・`I`/`O`除外の A〜Z 4文字のみ。不一致・未存在 | `error`「ルームが見つかりません」 |
| genre | `GENRES` の8 ID のみ | `error`「無効なジャンルです」（ホストへ）、`room.genre` は変更しない |
| join 状態 | `room.status === 'waiting'` 以外は不可 | `error`「ゲーム進行中のため参加できません」 |
| 満員 | `players.size >= MAX_PLAYERS(10)` | `error`「満員です」 |
| 権限 | `set_genre` / `start_game` はホスト socket のみ。非ホストは無視 | 無視（必要に応じ `error`） |

**プロンプトインジェクション対策**は AI 本統合（Phase C）で扱う。Phase A のスタブは名前を指示文として解釈しないため影響なし。

---

## 7. スタブ台本生成（ai/scriptStub.ts）

`generateStubScript(genre: string, playerNames: string[]): ScriptData`

- 参加している**実際のプレイヤー名**に対して役情報（`RoleInfo`）を割り当てる
- ジャンルに応じた簡単な世界観テキストと、各プレイヤー1〜2本の `ScriptEntry` を機械生成
- 配役画面が実データで意味を持つ最小限の内容（Casting はプレイヤー→役の対応が見えれば良い）
- Phase C で Claude API 呼び出しに差し替える（同じ関数シグネチャを維持）

---

## 8. フロントエンド統合

### 8-1. socket クライアント（client/src/socket.ts）

```typescript
import { io, Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'

const URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> =
  io(URL, { autoConnect: false })
```

### 8-2. socket 配線フック（client/src/useGameSocket.ts）

`App.tsx` から使用。`GameContext` に **`players: PlayerSnapshot[]`** を追加し、以下を配線：

- `room_created` / `room_joined` → ctx（roomCode, isHost, players, genre, status）更新 → `navigate('lobby')`
- `player_joined` → players に追加
- `player_left` → players から削除 ＋ Toast「〇〇が退出しました」
- `genre_changed` → ctx.genre 更新（背景プレビューも同期）
- `script_ready` → ctx.script 更新 → `navigate('casting')`
- `room_dissolved` → モーダル「ホストが退出したためルームが解散されました」→ OK でトップへリセット
- `error` → 画面に応じて Top インライン or 共通 Toast

### 8-3. 画面別の変更

| 画面 | 変更 |
|------|------|
| TopScreen | 作成/参加ボタンで `socket.connect()` ＋ `create_room`/`join_room` emit。成功で自動遷移（onNavigate 直呼びを廃止）。`error` はフォーム直下インライン赤文字 |
| LobbyScreen | 参加者一覧を `ctx.players` から描画。ホストのジャンルタップ → `set_genre` emit（楽観更新はせず `genre_changed` 受信で反映）。「ゲーム開始」→ `start_game` emit ＋ 既存の生成中オーバーレイ表示。`script_ready` 受信で配役へ。「（デモ）次の画面へ」ボタンは実フローに置換 |
| CastingScreen | `ctx.script` があればそれを表示（無ければ従来モック）。内部の作り込みは Phase B |
| App.tsx | `useGameSocket` を組み込み、`GameContext` に `players` を追加 |

Casting 以降のデモ用ボタン（prepare/recording 等）は Phase B まで残置。

---

## 9. エラーハンドリング

| ケース | サーバー | クライアント |
|--------|---------|------------|
| 検証エラー | `error {message}` を発行元へ | Top はインライン、進行中は共通 Toast |
| ホスト切断 | ルーム即解散・`room_dissolved` 全員・Map から削除 | モーダル → トップへ |
| ゲスト切断 | `player_left {playerName}` 全員・players から削除 | Toast ＋ 一覧更新 |
| 全員切断 | ルーム削除 | － |

---

## 10. テスト方針

### 自動（サーバー単体）

追加依存を増やさず `node:test` ＋ `tsx` で実行（`npm test`）。TDD で先にテストを書く。

- `roomCode`：生成が許可文字のみ・4文字・衝突時に再生成
- `roomStore`：create → get、join で players 追加、leave で削除、全員 leave で room 削除、cleanup が期限切れを削除
- `validation`：name の trim/制御文字除去/長さ境界、重複検出、genre の8種判定、roomCode 正規化

### 手動（結合）

2タブ手順書：
1. タブA：名前入力→作成→コード表示・自分がホスト・一覧に自分
2. タブB：同コードで参加→両タブの一覧に2人
3. タブA：ジャンル選択→両タブの背景・選択が同期
4. タブA：ゲーム開始→両タブに生成中オーバーレイ→両タブが配役画面へ・スタブ台本表示
5. タブA（ホスト）を閉じる→タブBにホスト退出モーダル→トップへ
6. （別途）タブBを閉じる→タブAに退出 Toast・一覧から消える

---

## 11. 実装順序（Plan で詳細化）

1. `shared/`（types / events / constants）作成、client の types.ts / genres.ts を再エクスポート化
2. `server/` 雛形（package.json, tsconfig, index.ts で起動確認）
3. `roomCode` / `validation`（テスト先行）
4. `roomStore`（テスト先行）＋ cleanup
5. `handlers`：create_room → join_room → set_genre → start_game → disconnect
6. `ai/scriptStub`
7. client：socket.ts / useGameSocket / GameContext に players 追加
8. client 画面配線：Top → Lobby → Casting（script 反映）／切断UI
9. 2タブ手動検証・調整
