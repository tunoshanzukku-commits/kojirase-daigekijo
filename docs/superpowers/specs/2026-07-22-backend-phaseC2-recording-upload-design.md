# Phase C2 設計書：録音アップロード基盤（MediaRecorder → サーバー）

- 日付: 2026-07-22
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/phase-c2-recording-upload`
- 関連: [Phase C1 設計](2026-07-18-backend-phaseC1-script-design.md) / [Phase B3 設計](2026-07-15-backend-phaseB3-evaluation-design.md)

## 1. 背景とスコープ

Phase C は「AI 本統合」で、スタブ 3 点を実接続化する（C1 台本 → C2 録音アップロード → C3 Whisper+Claude 評価）。

- **C1（完了）**: Claude 台本生成。非同期基盤・生成中オーバーレイ・課金前ガードを整えた。
- **C2（本設計）**: 各プレイヤーが自分のマイクを **MediaRecorder で録音**し、ホストの録音終了を合図に **HTTP POST でサーバーへアップロード**。サーバーは在室者全員分（またはタイムアウト）を集めてから評価へ進む。**AI は入れず、評価は引き続きスタブスコア**。「音声がサーバーに届くこと」だけを検証する。
- **C3**: 集めた音声 Buffer を Whisper で文字起こし ＋ Claude で評価（`ai/scoreStub.ts` を差し替え）。C2 の音声収集が前提。

C2 のゴールは、**C3 が「収集済みの音声 Buffer」に対して `generateStubScores` を差し替えるだけ**で済む足場を作ること。

### 決定事項（ブレインストーミングで確定）

- **転送方式**: **HTTP multipart POST**。Express に `/upload` エンドポイントを追加し、録音終了後に Blob を `fetch` + `FormData` で送る。Socket.io（制御プレーン）にバイナリを載せず分離でき、Whisper にそのまま渡せる完結ファイルが得られる。
- **収集ゲート**: サーバー側に**「在室者全員分の音声が揃う（またはタイムアウト）まで待ってから評価」ゲートを作る**。難所を C2 で潰し、C3 をクリーンな差し替えにする。
- **保持方法**: **インメモリ Buffer**（`Room` に `audio: Map<socketId, {buffer, mime}>`）。既存の in-memory Map アーキテクチャに整合。`resetRoom`/`deleteRoom`/idle cleanup で自然に消える。パーティゲーム規模（5 分 × 数人 ≈ 数十 MB/room）で十分。

## 2. 現状の把握（実装前の事実）

- [handlers.ts](../../../server/src/handlers.ts) の `stop_recording`（host・`status==='recording'`）は同期で `status='evaluating'` にし、**即座に** `recording_stopped` ＋ `evaluation_complete{scores, leftPlayers}` を配信する。`scores` は `generateStubScores(present)`、`leftPlayers` は `recordingRoster \ present`。
- [RecordingScreen.tsx](../../../client/src/screens/RecordingScreen.tsx) は `phase==='recording'` で `getUserMedia` し、AnalyserNode で声量 RMS を実測して 100ms ごとに `send_volume` を送る。**MediaRecorder による音声保存は存在しない**（ストリームは声量分析にしか使っていない）。
- [EvaluatingScreen.tsx](../../../client/src/screens/EvaluatingScreen.tsx) は既に **`ctx.scores.length === 0` の間は結果へ遷移せず待機**する構造で、演出ステップは「音声を受信中...」→「文字起こし処理中（Whisper API）...」を表示する。**アップロード＋収集の遅延はこの待機演出に自然に吸収される**（新しいオーバーレイは不要）。
- [useGameSocket.ts](../../../client/src/useGameSocket.ts) の `onRecordingStopped` は `setScreen('evaluating')` するだけ。**画面遷移で RecordingScreen はアンマウントされる**ため、録音の確定＋送信は**画面コンポーネントの外（socket レイヤ）で持つ**必要がある。
- [server.ts](../../../server/src/server.ts) は Express + Socket.io。`cors()`（origin `*`）適用済み・`/health` のみ。マルチパート受信の仕組みは未導入。
- [socket.ts](../../../client/src/socket.ts) は `VITE_SERVER_URL ?? 'http://localhost:3001'` をサーバー URL に使う。アップロードの `fetch` 先も同じ値を使う。

## 3. 通信契約

### 3.1 Socket イベント（契約は不変）

`shared/events.ts` への**追加・変更はしない**。既存の `recording_stopped` / `evaluation_complete` のペイロードもそのまま。変わるのは**タイミングだけ**：

- 従来: `stop_recording` → `recording_stopped` ＋ `evaluation_complete` を即時・連続配信。
- C2: `stop_recording` → `recording_stopped` を即時配信（各クライアントがアップロード開始の合図）→ **サーバーが音声を収集** → 収集完了/タイムアウトで `evaluation_complete` を配信。

`recording_stopped` が「録音を確定してアップロードせよ」の合図を兼ねる（新イベント不要）。

### 3.2 HTTP エンドポイント（新規）

```
POST /upload   (multipart/form-data)
  fields:
    socketId: string        必須。アップロード主体の識別
    audio:    file (Blob)    録音本体（マイク許可時）
    skip:     "1"            マイク拒否/録音無し時のマーカー（audio 無しで送る）
  → 200 { ok: true }         受理（格納 or skip 記録）
  → 4xx { ok: false }        収集中でない/非メンバー/不正（クライアントは無視でよい）
```

- サーバーは `findRoomBySocket(socketId)` で部屋を解決する（**クライアントは roomCode を送らない**）。
- 検証: `room` が存在し `room.collectingAudio === true` かつ `room.uploadExpected.has(socketId)`。外れは 4xx で黙って弾く。
- `audio` があれば `room.audio.set(socketId, { buffer, mime })` して `[server] audio received: <name> <bytes> <mime>` をログ。`skip` は記録のみ（Buffer なし）。
- どちらの場合も `uploadExpected.delete(socketId)`。空になったら `finalizeEvaluation(room)`。

## 4. サーバー側フロー

### 4.1 `roomStore` の変更

`Room` に収集ゲート用フィールドを追加する。

```ts
interface Room {
  // ...既存
  audio: Map<string, { buffer: Buffer; mime: string }>  // socketId → 録音
  collectingAudio: boolean                                // 収集ウィンドウ中フラグ
  uploadExpected: Set<string>                             // 到達待ちの socketId
  uploadTimer: ReturnType<typeof setTimeout> | null       // タイムアウトハンドル
}
```

- `createRoom`: `audio: new Map()`, `collectingAudio: false`, `uploadExpected: new Set()`, `uploadTimer: null` で初期化。
- `resetRoom`: 上記をクリア（`audio.clear()`、`collectingAudio=false`、`uploadExpected.clear()`、`uploadTimer` を `clearTimeout` して null）。再戦で持ち越さない。
- `removePlayer`: 既存の `volumes`/`returned` 削除に加え、`audio.delete(socketId)` と `uploadExpected.delete(socketId)` も行う。
- `deleteRoom`: 対象 room の `uploadTimer` を `clearTimeout`（ダングリングタイマー防止）。※`deleteRoom(code)` は現在 code 引数のみ。room 取得のうえクリアする実装にする。

### 4.2 `stop_recording`（収集開始に変更）

ガード（host・`status==='recording'`）は既存どおり。通過後は**即評価せず、収集を開始する**：

```
status = 'evaluating'
present = 現在の在室 socketId 一覧
room.audio.clear()
room.collectingAudio = true
room.uploadExpected = new Set(present)
touch(room)
io.to(code).emit('recording_stopped')     // ← 各クライアントがアップロード開始
room.uploadTimer = setTimeout(() => {
  if (getRoom(code) !== room) return       // 解散後の発火を無視
  finalizeEvaluation(io, room)             // 未着があってもここで確定
}, UPLOAD_TIMEOUT_MS)
if (room.uploadExpected.size === 0) finalizeEvaluation(io, room)  // 念のため
```

**注**: `evaluation_complete` はここでは出さない。`recordingRoster` は `start_recording` 時のスナップショットのまま利用する。

### 4.3 `finalizeEvaluation(io, room)`（新規・冪等）

`POST /upload` で全員到達したとき、またはタイムアウトで 1 回だけ走る。

```
if (!room.collectingAudio) return          // 二重実行ガード
room.collectingAudio = false
if (room.uploadTimer) { clearTimeout(room.uploadTimer); room.uploadTimer = null }
const present = [...room.players.values()].map(p => p.name)
const scores = generateStubScores(present) // ★ C3 の差し替え点（room.audio を渡す形へ）
const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
room.scores = scores
touch(room)
io.to(room.code).emit('evaluation_complete', { scores, leftPlayers })
```

- `leftPlayers` は**finalize 時点**の在室者から算出（収集中に抜けた人も反映）。現行の「stop 時点」からのわずかな移動だが、より正確で仕様として妥当。
- C2 では `room.audio` は検証（格納・ログ）のみで採点には使わない。**C3 で `generateStubScores(present)` を `generateScores(present, room.audio)`（Whisper+Claude）に差し替える**のがこの関数唯一の改修点になるよう閉じておく。

### 4.4 エッジケース（既存パターンに準拠）

- **収集中に非ホストが切断**: `disconnect` → `removePlayer` で `uploadExpected` からも除去。除去後に `collectingAudio && uploadExpected.size === 0` なら `finalizeEvaluation`（デッドロック回避。`allReturned` と同型の「最後の 1 人が抜けたら確定」）。
- **収集中にホストが切断**: 既存 `disconnect` が `room_dissolved` ＋ `deleteRoom`。`deleteRoom` で `uploadTimer` を `clearTimeout`。万一タイマー/finalize が後から走っても `getRoom(code) !== room` ガードで no-op。
- **マイク拒否のプレイヤー**: クライアントは `skip` マーカーを POST し、サーバーは即 `uploadExpected` から外す（全員が拒否でもタイムアウトを待たず finalize）。
- **アップロード遅延・失敗**: `UPLOAD_TIMEOUT_MS` で finalize。届かなかった人は `room.audio` に無い（C3 で「音声なし」の扱い）。C2 では単にログに現れないだけ。
- **タイムアウト後に遅れて届いた upload**: `collectingAudio===false` なので 4xx で弾く（格納しない）。

### 4.5 タイムアウト定数（テスト用に上書き可）

```ts
let UPLOAD_TIMEOUT_MS = 15_000
export function __setUploadTimeoutForTest(ms: number): void { UPLOAD_TIMEOUT_MS = ms }
export function __resetUploadTimeoutForTest(): void { UPLOAD_TIMEOUT_MS = 15_000 }
```

`scriptGen` のテストフックと同型。テストは短縮値で「未着 → タイムアウト finalize」を高速に検証する。

## 5. サーバー実装詳細（`server.ts` / `handlers.ts`）

- **依存追加**: `multer`（＋ `@types/multer`）。`multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })`。25 MB は Whisper の入力上限に整合。`file.buffer`（memoryStorage）をそのまま `Room.audio` に格納。
- **ルート登録**: `buildServer()` 内で `app.post('/upload', upload.single('audio'), handler)`。`handler` は `io` と roomStore にアクセスするため、`buildServer` で `io` 生成後にクロージャで渡すか、`registerUploadRoute(app, io)` を `handlers.ts`（or 新規 `uploadRoute.ts`）に切り出す。既存の `registerHandlers` に合わせ **`server/src/uploadRoute.ts` に分離**して単一責務にする。
- **CORS**: 既存 `app.use(cors())` がクロスオリジン POST（5173→3001）を許可済み。追加設定不要。
- **`finalizeEvaluation` / タイムアウト定数**は `handlers.ts`（`stop_recording`・`disconnect` と同居）に置き、`uploadRoute.ts` から import して全員到達時に呼ぶ。

## 6. クライアント変更

### 6.1 新規 `client/src/recorder.ts`（モジュール単位のコントローラ）

画面アンマウントを跨いで録音を確定するため、MediaRecorder はモジュールスコープで保持する（`socket.ts` と同じくシングルトン）。

```ts
export function startUploadRecorder(): void
// getUserMedia({audio}) → MediaRecorder を作り start()。ondataavailable でチャンク配列に収集。
// 冪等（既に動作中なら何もしない）。getUserMedia 失敗（マイク拒否）は内部 state に記録し、
// stop 時に blob なし扱いにする。RecordingScreen の声量用ストリームとは別に取得する
// （二重 getUserMedia は Chrome で許容＝MVP 割り切り。将来ストリーム共有で最適化可）。

export async function stopAndUpload(socketId: string): Promise<void>
// MediaRecorder.stop() → onstop で最終 Blob を確定 → tracks を停止しストリーム解放。
// Blob があれば FormData{ socketId, audio: blob } を ${SERVER_URL}/upload へ POST。
// マイク拒否/録音無しなら FormData{ socketId, skip: '1' } を POST（サーバーの待機を解く）。
// 失敗は console にログするだけ（UI は壊さない。サーバー側タイムアウトで担保）。
```

- `SERVER_URL` は `socket.ts` と重複しないよう共有定数（例: `client/src/config.ts` に `export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'`）を作り、`socket.ts` と `recorder.ts` の両方から使う。

### 6.2 `useGameSocket.ts`

- `onRecordingStarted`: 既存の `setScreen('recording')` に加え `startUploadRecorder()` を呼ぶ（＝socket レイヤで録音開始。countdown 中の数秒の無音が先頭に入るが Whisper 的に無害）。
- `onRecordingStopped`: 既存の `setScreen('evaluating')` に加え `stopAndUpload(socket.id)` を呼ぶ（`socket.id` で識別。roomCode は不要）。

### 6.3 RecordingScreen（無改造）

既存の声量パイプライン（`getUserMedia` + Analyser + `send_volume`）はそのまま残す。録音は `recorder.ts` が別系統で担う。

## 7. テスト戦略（TDD・Windows / ブラウザなし）

先に失敗するテストを書き RED を確認してから実装する。DOM は自動化できない（Windows 制約：admin 権限が要り Chrome/Playwright が使えない）ため、**サーバー側の HTTP + socket 統合テスト**で音声到達と収集ゲートを担保する。

- **HTTP ハーネス**: `httpServer.listen(0)` でエフェメラルポートに立て、グローバル `fetch` に `FormData`（`Blob`/`Buffer`）を載せて `POST /upload`。`testUtils.ts` の socket ハーネスと併用し、1 テスト内で「socket で `stop_recording` → HTTP で `/upload` → socket で `evaluation_complete` を待つ」混在フローを組む。
- **ケース**:
  1. **収集中の受理・格納**: 収集ウィンドウ中の `POST /upload` が 200、`room.audio` にバイト列が入る。
  2. **収集中でない拒否**: `collectingAudio=false`（録音していない/finalize 後）の POST が 4xx、格納されない。
  3. **非メンバー拒否**: `uploadExpected` に無い socketId の POST が 4xx。
  4. **2 人ゲート**: 2 人で `stop_recording` 後、**片方だけ**アップロードした時点では `evaluation_complete` が来ない → 両方揃って初めて配信（スタブスコア・`io.to` 取りこぼし回避のため両リスナ登録後に進める）。
  5. **タイムアウト finalize**: `__setUploadTimeoutForTest` を短縮し、1 人未着でもタイムアウトで `evaluation_complete` が来る。
  6. **収集中 disconnect の非デッドロック**: 待っている相手が切断したら残りだけで finalize。
  7. **skip マーカー**: `skip` のみの POST で `uploadExpected` から外れ、全員 skip でも finalize する。
- **回帰**: 既存の `handlers.recording.test.ts` / `handlers.evaluation.test.ts` は「即 `evaluation_complete`」前提の箇所を「アップロード後 `evaluation_complete`」に更新する（`stop_recording` 直後に scores を期待しているアサーションがあれば収集完了まで待つ形へ）。
- **クライアント**: `tsc` ＋ `vite build` が clean。DOM 目視（2 タブでマイク許可 → サーバーログに `audio received: <name> <bytes> <mime>` が人数分 → 採点進行）はユーザーが実施。

## 8. 変更ファイル一覧（見込み）

- `server/src/roomStore.ts` — `Room` に `audio` / `collectingAudio` / `uploadExpected` / `uploadTimer`、`createRoom`/`resetRoom`/`removePlayer`/`deleteRoom` 更新
- `server/src/handlers.ts` — `stop_recording` を収集開始に、`finalizeEvaluation` 新規、`disconnect` の収集中デッドロック回避、タイムアウト定数＋テストフック
- `server/src/uploadRoute.ts` — 新規（`POST /upload` の multer ハンドラ・検証・格納・全員到達で finalize 呼び出し）
- `server/src/server.ts` — `registerUploadRoute(app, io)` の組み込み
- `server/package.json` — `multer` / `@types/multer` 追加・test スクリプトに新規テスト追加
- `client/src/config.ts` — 新規（`SERVER_URL` 共有）
- `client/src/socket.ts` — `SERVER_URL` を共有定数から参照
- `client/src/recorder.ts` — 新規（`startUploadRecorder` / `stopAndUpload`）
- `client/src/useGameSocket.ts` — `onRecordingStarted`/`onRecordingStopped` にフック
- 各種テストファイル（新規/追記）

## 9. 非スコープ / 繰り越し

- **Whisper 文字起こし・Claude 評価は C3**（`finalizeEvaluation` の `generateStubScores` を `room.audio` 消費に差し替える）。
- **アップロード認証トークンは未実装**（socketId を信頼する MVP。将来 `recording_started` でワンタイムトークンを配り upload に添える形へ＝繰り越し）。
- **声量用と録音用のストリーム統合**（現状 2 本 `getUserMedia`）は将来の最適化。
- **Safari(mp4/aac) 等コーデック分岐**は範囲外（Chrome の `audio/webm;codecs=opus` 前提。mime はそのまま格納し C3 へ渡す）。
- **アップロードのリトライ / レジューム**は無し（サーバー側タイムアウトで担保）。
- **5 分自動終了タイマー**は引き続き見送り（ホスト主導 stop ＋ idle クリーンアップ）。
