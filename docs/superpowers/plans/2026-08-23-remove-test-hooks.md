# テスト専用フックの除去（依存注入への移行） 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本番モジュールから export されているテスト専用フック25個を、モジュールのファクトリ化によって完全に削除する。

**Architecture:** 状態を持つモジュールを `createX(deps)` 形式のファクトリに変え、状態をサーバーインスタンスに閉じ込める。`buildServer` が全依存を組み立て、テストは `startTestServer(options)` から差し替える。ユーザーに見える挙動は一切変えない。

**Tech Stack:** TypeScript (tsx で直接実行・ビルド出力なし)、Express、Socket.io、node:test

**Spec:** `docs/superpowers/specs/2026-08-23-remove-test-hooks-design.md`

## Global Constraints

- **これはリファクタリングであり、新規テストは書かない。** 既存の281テストが安全網。各タスクの合格条件は「テスト件数の一致」であって「緑」ではない
- **関数の中身は一字も変えない。** 変えてよいのはインデントと呼び出し名だけ
- **server 281 / client 10** — 全タスクでこの件数が一致すること
- **`client/` は無改造。** 触ったら差し戻し
- 機能追加・挙動変更は一切しない
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- 作業ブランチは `feature/remove-test-hooks`（main で直接作業しない）

---

## 前提：作業開始前に1回だけ

- [ ] **ブランチを切り、ベースラインを記録する**

```bash
git checkout -b feature/remove-test-hooks
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"   # tests 281 / pass 281 / fail 0
cd ../client && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" # tests 10 / pass 10 / fail 0
```

この数字を全タスクで照合する。

---

### Task 1: roomStore をファクトリ化する

**Files:**
- Modify: `server/src/roomStore.ts`
- Modify: `server/src/handlers.ts`（呼び出し置換のみ）
- Modify: `server/src/uploadRoute.ts`（`findRoomBySocket` の呼び出し）
- Modify: `server/src/index.ts`（`cleanupRooms`）
- Modify: `server/src/server.ts`（store を生成して配る）
- Modify: `server/tests/testUtils.ts`
- Modify: 各 `server/tests/*.test.ts`（`_clearAllRooms` の除去）

**Interfaces:**

- Consumes: なし（最初のタスク）
- Produces:

```ts
// server/src/roomStore.ts
export interface RoomStore {
  exists(code: string): boolean
  get(code: string): Room | undefined
  create(hostSocketId: string, name: string): Room
  findBySocket(socketId: string): Room | undefined
  delete(code: string): void
  findByToken(token: string): { room: Room; player: Player } | undefined
  cleanup(now: number, maxIdleMs: number): string[]
}
export function createRoomStore(): RoomStore
```

**⚠️ 18関数のうちインスタンス化するのは上の7つだけ。** 残り10（`addPlayer` `hasPlayerName` `removePlayer` `reattachPlayer` `touch` `setReady` `allReady` `toSnapshot` `resetRoom` `allReturned`）は `Room` を引数に取る純粋関数で Map に触らないため、**module export のまま変えない**。ここを一緒に動かすと差分が無意味に膨らむ。

- [ ] **Step 1: Map に触る7関数を `createRoomStore` の中へ移す**

`server/src/roomStore.ts:44` の `const rooms = new Map<string, Room>()` をファクトリの内側へ移し、7関数をその中で定義して返す。**関数の本体は一字も変えない**（`rooms` への参照はクロージャで解決される）。`_clearAllRooms`（262-268行）は**削除**する。

```ts
export function createRoomStore(): RoomStore {
  const rooms = new Map<string, Room>()

  function exists(code: string): boolean {
    return rooms.has(code)          // ← 旧 roomExists の本体そのまま
  }
  // get / create / findBySocket / delete / findByToken / cleanup も同様

  return { exists, get, create, findBySocket, delete: deleteRoom_, findByToken, cleanup }
}
```

- [ ] **Step 2: `server.ts` で store を生成し、返り値に含める**

```ts
export function buildServer(options: { distDir?: string; rooms?: RoomStore } = {}) {
  const rooms = options.rooms ?? createRoomStore()
  // ... registerHandlers / registerUploadRoute に rooms を渡す
  return { httpServer, io, app, rooms }
}
```

- [ ] **Step 3: 呼び出し側を置換する**

| 旧 | 新 |
|---|---|
| `roomExists(code)` | `rooms.exists(code)` |
| `getRoom(code)` | `rooms.get(code)` |
| `createRoom(sid, name)` | `rooms.create(sid, name)` |
| `findRoomBySocket(sid)` | `rooms.findBySocket(sid)` |
| `deleteRoom(code)` | `rooms.delete(code)` |
| `findPlayerByToken(t)` | `rooms.findByToken(t)` |
| `cleanupRooms(now, ms)` | `rooms.cleanup(now, ms)` |

`handlers.ts` は `registerHandlers(io, socket)` → `registerHandlers(io, socket, rooms)` とし、内部関数にも `rooms` を渡す。`index.ts` は `buildServer()` の返り値から `rooms` を受け取る。

- [ ] **Step 4: テスト側から `_clearAllRooms` を除去する**

`beforeEach` の `_clearAllRooms()` を削除する。`startTestServer()` が毎回新しい store を作るので状態は空になる。`testUtils.ts` の `startTestServer` は `buildServer()` の返り値の `rooms` も返す（テストが直接 store を覗く箇所があるため）。

- [ ] **Step 5: 件数一致を確認する**

```bash
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npx tsc --noEmit
```
Expected: **tests 281 / pass 281 / fail 0**、tsc は無出力

- [ ] **Step 6: 差分がレビュー可能か確認する**

```bash
git diff -w -- server/src/handlers.ts | grep "^[+-]" | grep -v "^[+-][+-]" | head -60
```
Expected: `rooms.` への置換と引数追加以外の意味のある差分が無いこと。**ロジック行が1行でも変わっていたら差し戻す。**

- [ ] **Step 7: コミット**

```bash
git add -A
git commit -m "refactor: roomStore をファクトリ化して _clearAllRooms を消す

Map に触る7関数だけを createRoomStore() の中へ移した。Room を引数に取る
残り10関数は Map に触らない純粋関数なので module export のまま残す。

サーバーインスタンスごとに store が独立するので、テストの beforeEach で
_clearAllRooms() を呼ぶ必要がなくなった。

server 281/281・tsc clean。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: quota をファクトリ化する

> **⚠️ 実行中の裁定 R4 で範囲を狭めた。** 当初は `prompts` と `scriptLibrary` も含めていたが、
> それらの消費者（`scriptGen` `scoreGen` `handlers`）は Task 3 が所有する層にあり、
> 1つの層を2タスクに割ると両側が中途半端な引数渡しを抱える。**`prompts` と
> `scriptLibrary` は Task 3 に移した。このタスクでは触らない。**

**Files:**
- Modify: `server/src/quota.ts`
- Modify: `server/src/roomStore.ts`（`toSnapshot` に `quota` を渡す）
- Modify: `server/src/handlers.ts`（`quota` を一時的な引数で受ける）
- Modify: `server/src/server.ts` `server/tests/testUtils.ts`
- Modify: `server/tests/quota.test.ts` `server/tests/handlers.guard.test.ts`（動的 import あり）

**Interfaces:**

- Consumes: `RoomStore` / `createRoomStore()`（Task 1）
- Produces:

```ts
// server/src/quota.ts
export interface Quota {
  tryConsumeGame(now: Date): boolean
  getState(now: Date): { date: string; used: number; limit: number }
  isAiAvailable(now: Date): boolean
}
export function createQuota(): Quota
// jstDateString(now: Date): string は純粋関数なので module export のまま

// server/src/roomStore.ts — 裁定 R6 で署名変更を許可
export function toSnapshot(room: Room, quota: Quota): RoomSnapshot
```

**⚠️ 裁定 R6**：Task 1 が「10個の純粋関数」と呼んだのは *store に対する* 純粋性と本体不変のことで、署名の凍結ではない。`toSnapshot` はもともと `isAiAvailable()` 経由でモジュール状態に依存しており、真に純粋ではなかった。

以下は **Task 3 へ移動**（このタスクでは実装しない・参考用）。

```ts
// server/src/ai/prompts.ts
export interface Prompts {
  scriptSystem(): string
  scriptUserTemplate(): string
  scriptUserSoloTemplate(): string
  scoreSystem(): string
  scoreSystemSolo(): string
  scoreUserHeader(): string
  scoreUserPlayer(): string
  genreFlavor(genreId: string): string
  counts: { prompts: number; genres: number }
}
export function createPrompts(dir?: string): Prompts   // 欠損・空ファイルは従来どおり throw
// renderTemplate / promptsDir / REQUIRED_FILES は純粋なので module export のまま

// server/src/ai/scriptLibrary.ts
export interface ScriptLibrary {
  generate(genre: string, playerNames: string[]): ScriptData
  count: number
}
export function createScriptLibrary(plays: Play[]): ScriptLibrary
// parsePlay / loadPlays / selectPlay / toScriptData / playsDir は純粋なので module export のまま
```

**⚠️ `createScriptLibrary` は `dir` ではなく `Play[]` を受け取る。** こうすると `__setPlaysForTest` の代替が「テストが自前の `Play[]` を渡す」だけで済み、テスト用のファイル入出力が不要になる。本番は `createScriptLibrary(loadPlays(playsDir()))` と書く。

- [ ] **Step 1: 3モジュールをファクトリ化する**

各モジュールの `let cache` / `let plays` / カウンタ変数をファクトリの内側へ移す。**関数の本体は一字も変えない。** `__resetPromptsForTest` `__setPlaysForTest` `__resetPlaysForTest` `__resetQuotaForTest` を削除する。

- [ ] **Step 2: `server.ts` で生成し、`index.ts` の起動ログを追随させる**

```ts
const prompts = options.prompts ?? createPrompts()
const plays = options.plays ?? createScriptLibrary(loadPlays(playsDir()))
const quota = options.quota ?? createQuota()
```

`index.ts` の `initPrompts()` 呼び出しと起動ログは `buildServer()` の返り値から取る形に変える（`prompts.counts` を使う）。

- [ ] **Step 3: テスト側を移行する**

- `prompts.test.ts`：`initPrompts(dir)` → `createPrompts(dir)`。`__resetPromptsForTest()` は不要（毎回新インスタンス）
- `scriptLibrary.test.ts`：`__setPlaysForTest(plays)` → `createScriptLibrary(plays)`
- `quota.test.ts`：`__resetQuotaForTest()` → `createQuota()`

- [ ] **Step 4: 件数一致を確認する**

```bash
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npx tsc --noEmit
```
Expected: **tests 281 / pass 281 / fail 0**

- [ ] **Step 5: コミット**

```bash
git add -A
git commit -m "refactor: quota/prompts/scriptLibrary をファクトリ化する

モジュールレベルのキャッシュとカウンタをインスタンスに閉じ込め、
__resetPromptsForTest / __setPlaysForTest / __resetPlaysForTest /
__resetQuotaForTest の4つを消した。

createScriptLibrary は dir ではなく Play[] を受け取る形にした。テストが
自前の台本配列を渡せるので、テスト用のファイル入出力が要らなくなる。

server 281/281・tsc clean。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: AI 層をまとめてファクトリ化する（prompts / scriptLibrary / アダプタ / feedback）

> **⚠️ 裁定 R4 により `prompts` と `scriptLibrary` が Task 2 からこのタスクへ移った。**
> 削除するフックは **3 + 10 = 13個**（`__resetPromptsForTest` `__setPlaysForTest`
> `__resetPlaysForTest` ＋ アダプタ10個）。**このタスクだけ他より大きい。**

**Files:**
- Modify: `server/src/ai/prompts.ts` `server/src/ai/scriptLibrary.ts`
- Modify: `server/src/ai/scriptGen.ts` `server/src/ai/scoreGen.ts` `server/src/ai/evaluate.ts` `server/src/transcribe.ts` `server/src/feedback.ts`
- Create: `server/src/ai/index.ts`（`createAi` の置き場）
- Modify: `server/src/server.ts` `server/src/index.ts`（起動ログのプロンプト数）
- Modify: `server/src/handlers.ts`（`generateLibraryScript` を一時的な引数で受ける）
- Modify: `server/tests/ai/*.test.ts` `server/tests/transcribe.test.ts` `server/tests/feedback*.test.ts` `server/tests/testUtils.ts`

**Interfaces:**

- Consumes: `Prompts` / `ScriptLibrary`（Task 2）
- Produces:

```ts
// server/src/ai/index.ts
export interface Ai {
  generateScript(genre: string, playerNames: string[]): Promise<ScriptData>
  generateScores(script: ScriptData, transcripts: { playerName: string; text: string }[]): Promise<PlayerScore[]>
  transcribe(audio: { buffer: Buffer; mime: string }): Promise<string>
  evaluate(script: ScriptData | null, performers: string[], audioByName: Map<string, { buffer: Buffer; mime: string }>): Promise<PlayerScore[]>
}
export function createAi(deps: {
  prompts: Prompts
  plays: ScriptLibrary
  overrides?: Partial<Ai>
}): Ai
```

**⚠️ `overrides` は `Partial<Ai>` にする。** テストは `evaluate` だけ差し替えたいことが多く（`handlers.evaluation.test.ts` など）、全部を渡させると記述が膨らむ。`createAi` は未指定のものだけ本番実装を組み立てる。

```ts
// server/src/feedback.ts
export type FeedbackSender = (text: string, meta: FeedbackMeta) => Promise<void>
export function createFeedbackSender(): FeedbackSender   // 従来の realSend
// validateFeedback / buildDiscordPayload は純粋なので module export のまま
```

- [ ] **Step 1: 5モジュールから `let impl` と setter を消す**

各モジュールは「本番実装を返す関数」だけを export する形にする。

```ts
// 例: server/src/ai/scoreGen.ts
export function createScoreGenerator(prompts: Prompts) {
  return function generateScores(script, transcripts) { /* 旧 realGenerateScores の本体そのまま */ }
}
```

削除するのは10個：`__setScriptGeneratorForTest` `__resetScriptGeneratorForTest` `__setScoreGeneratorForTest` `__resetScoreGeneratorForTest` `__setTranscriberForTest` `__resetTranscriberForTest` `__setEvaluatorForTest` `__resetEvaluatorForTest` `__setFeedbackSenderForTest` `__resetFeedbackSenderForTest`。

- [ ] **Step 2: `createAi` を書く**

`evaluate` は `transcribe` と `generateScores` に依存するので、`createAi` の中で解決する（`overrides` があればそれを優先）。

- [ ] **Step 3: テスト側を移行する**

`__setEvaluatorForTest(fake)` → `startTestServer({ ai: { evaluate: fake } })`。純粋関数のテスト（`parseScores` `parseScript` `validateFeedback` `buildDiscordPayload` `selectScoreSystem` `extForMime` 等）は**無改造**で通るはず。

- [ ] **Step 4: 件数一致を確認する**

```bash
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npx tsc --noEmit
```
Expected: **tests 281 / pass 281 / fail 0**

- [ ] **Step 5: コミット**

```bash
git add -A
git commit -m "refactor: AIアダプタとfeedbackの差し替え口をcreateAiに集約する

scriptGen/scoreGen/transcribe/evaluate/feedback のモジュールレベルの
let impl と setter を消し、10個のフックを削除した。差し替えは
createAi({ overrides }) と buildServer のオプションから行う。

overrides を Partial<Ai> にしたのは、テストが evaluate だけ差し替えたい
ケースが多いため。

server 281/281・tsc clean。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: handlers をファクトリ化する（最大の山）

**Files:**
- Modify: `server/src/handlers.ts`（533行・全面）
- Modify: `server/src/server.ts`
- Modify: `server/tests/handlers.*.test.ts`（8本）`server/tests/testUtils.ts`

**Interfaces:**

- Consumes: `RoomStore`（Task 1）、`Quota`（Task 2）、`Ai`（Task 3）
- Produces:

```ts
// server/src/handlers.ts
export interface Limits {
  roomCreateMax: number         // 既定 DEFAULT_ROOM_CREATE_MAX
  roomCreateWindowMs: number    // 既定 ROOM_CREATE_WINDOW_MS
  uploadTimeoutMs: number       // 既定 DEFAULT_UPLOAD_TIMEOUT_MS
  recordingLimitMs: number      // 既定 DEFAULT_RECORDING_LIMIT_MS
  graceMs: number               // 既定 DEFAULT_GRACE_MS
  uploadRateWindowMs: number    // 既定 UPLOAD_WINDOW_MS（Task 5 で使う）
  uploadRateMax: number         // 既定 UPLOAD_MAX
  feedbackRateWindowMs: number  // 既定 FEEDBACK_WINDOW_MS
  feedbackRateMax: number       // 既定 FEEDBACK_MAX
}
```

**⚠️ `Limits` はルートのレート制限値も含む**（設計書の「`Limits` の内容」節に合わせる）。`handlers` は自分に関係する5つしか読まないが、型を1つに保つことでサーバー全体の調整値が1箇所に集まる。

```ts
export interface Handlers {
  registerHandlers(io: IO, socket: Sock): void
  finalizeEvaluation(io: IO, room: Room): Promise<void>
  beginAudioCollection(io: IO, room: Room): void
}
export function createHandlers(deps: {
  rooms: RoomStore
  quota: Quota
  ai: Ai
  limits?: Partial<Limits>
}): Handlers
```

- [ ] **Step 1: 533行を `createHandlers` で包む**

`let roomCreateMax` `let uploadTimeoutMs` `let recordingLimitMs` `let graceMs` と `roomCreateLimiter` をファクトリの内側へ移す。**8個のフックを削除**する。**内部関数の本体は一字も変えない**（インデントだけ変わる）。

- [ ] **Step 2: 繊細な3箇所を個別に目視する**

これは設計書のリスク節で名指しした、過去に実際バグを出した箇所である。**移行前後で等価であることを1つずつ確認する。**

1. **猶予タイマーが `clearRoomTimers` に入っていないこと**（入ると `resetRoom` 経由で消え、切断中プレイヤーが永久ゴースト化して `start_game` の人数に混じる）
2. **`finalizeEvaluation` の入口の同期的な冪等ガード（`if (!room.collectingAudio) return`）と `evaluationSeq` の比較**（await 中の reset/delete による stale emit を防いでいる）
3. **`reattachPlayer` 後のアップロード済み音声の再マップ**（落とすと収集中リロードで無音採点になる）

```bash
git diff -w -- server/src/handlers.ts | grep "^[+-]" | grep -v "^[+-][+-]"
```
Expected: `rooms.` `quota.` `ai.` `limits.` への置換以外に意味のある差分が無いこと。

- [ ] **Step 3: テスト側を移行する**

`__setUploadTimeoutForTest(5000)` → `startTestServer({ limits: { uploadTimeoutMs: 5000 } })`。`__setGraceForTest` `__setRecordingLimitForTest` `__setRoomCreateLimitForTest` も同様。`__resetRateLimitForTest` は不要（インスタンスが新しい）。

**⚠️ `testUtils.ts` の `DAILY_GAME_LIMIT ??= '100000'` はそのまま残す。** これは `config.ts` の環境変数であり本改修のスコープ外。

- [ ] **Step 4: 件数一致を確認する**

```bash
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npx tsc --noEmit
```
Expected: **tests 281 / pass 281 / fail 0**

- [ ] **Step 5: コミット**

```bash
git add -A
git commit -m "refactor: handlers をファクトリ化して上限のフック8個を消す

roomCreateMax/uploadTimeoutMs/recordingLimitMs/graceMs とレート制限器を
createHandlers の内側へ移した。上限は limits オプションで注入する。

関数の本体は一字も変えていない（git diff -w で確認済み）。過去にバグを
出した3箇所——猶予タイマーが clearRoomTimers に入っていないこと、
finalizeEvaluation の冪等ガードと evaluationSeq、reattachPlayer 後の
音声再マップ——は個別に目視して等価を確認した。

server 281/281・tsc clean。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: uploadRoute / feedbackRoute をファクトリ化する

**Files:**
- Modify: `server/src/uploadRoute.ts` `server/src/feedbackRoute.ts`
- Modify: `server/src/server.ts`
- Modify: `server/tests/handlers.upload.test.ts` `server/tests/feedbackRoute.test.ts` `server/tests/testUtils.ts`

**Interfaces:**

- Consumes: `RoomStore`（Task 1）、`FeedbackSender`（Task 3）、`Handlers`（Task 4）
- Produces:

```ts
export function createUploadRoute(deps: {
  rooms: RoomStore
  finalizeEvaluation: Handlers['finalizeEvaluation']
  limits: Limits           // uploadRateWindowMs / uploadRateMax を読む
}): (app: Express, io: IO) => void

export function createFeedbackRoute(deps: {
  sendFeedback: FeedbackSender
  limits: Limits           // feedbackRateWindowMs / feedbackRateMax を読む
}): (app: Express) => void
```

**⚠️ ここで循環依存が消える。** 現在 `uploadRoute.ts` は `handlers.ts` から `finalizeEvaluation` を import しているが、`buildServer` が handlers を先に作って渡す形になるため相互参照がなくなる。

- [ ] **Step 1: 2モジュールをファクトリ化し、フック2個を消す**

`__resetUploadRateLimitForTest` `__resetFeedbackRateLimitForTest` を削除。レート制限器はファクトリの内側で作る。

- [ ] **Step 2: テスト側を移行する**

`__resetFeedbackRateLimitForTest()` の呼び出しを削除し、レート制限のテストは `startTestServer()` が毎回新インスタンスを作ることに依存する形にする。

**⚠️ `feedbackRoute.test.ts` の「同一IPからの連投を429で弾く」は、1つのサーバーインスタンス内で4回叩くテストなので、そのまま通るはず。** 逆に `beforeEach` でリセットしていたことに依存していたテストがあれば、サーバーを作り直す形に変える。

- [ ] **Step 3: 件数一致を確認する**

```bash
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npx tsc --noEmit
```
Expected: **tests 281 / pass 281 / fail 0**

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "refactor: uploadRoute/feedbackRoute をファクトリ化する

レート制限器をファクトリの内側へ移し、__resetUploadRateLimitForTest と
__resetFeedbackRateLimitForTest を消した。

副産物として uploadRoute → handlers の import が消えた。buildServer が
handlers を先に作って finalizeEvaluation を渡すため、モジュール間の
相互参照がなくなっている。

server 281/281・tsc clean。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 最終配線と完了確認

**Files:**
- Modify: `server/src/server.ts` `server/src/index.ts` `server/tests/testUtils.ts`

**Interfaces:**

- Consumes: 全タスクの成果物
- Produces:

```ts
export function buildServer(options?: {
  distDir?: string
  rooms?: RoomStore
  quota?: Quota
  prompts?: Prompts
  plays?: ScriptLibrary
  ai?: Partial<Ai>
  sendFeedback?: FeedbackSender
  limits?: Partial<Limits>
}): { httpServer: Server; io: IO; app: Express; rooms: RoomStore }
```

**本番の呼び出し `buildServer()` は引数なしのまま変わらない。**

- [ ] **Step 1: `buildServer` を整理する**

組み立て順を1箇所にまとめる：`rooms` → `prompts` / `plays` / `quota` → `ai` → `handlers` → routes。

- [ ] **Step 2: `startTestServer` のオプションを `buildServer` に素通しする**

```ts
export async function startTestServer(options: Parameters<typeof buildServer>[0] = {}) {
  const { httpServer, io, rooms } = buildServer(options)
  // ... 既存の listen / close 処理はそのまま
}
```

- [ ] **Step 3: フックが0件になったことを確認する（本改修の完了条件）**

```bash
grep -rn "export function __\|export function _clear" server/src
```
Expected: **出力なし（0件）**

- [ ] **Step 4: 全体検証**

```bash
cd server && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"   # 281/281/0
npx tsc --noEmit                                              # 無出力
cd ../client && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)" # 10/10/0
npx tsc --noEmit && npm run build                             # clean
git diff main --stat -- client/                               # 出力なし（client 無改造）
```

- [ ] **Step 5: 実際に起動して疎通を確認する**

```bash
cd server && npm start &
sleep 3 && curl -s http://localhost:3001/health
```
Expected: `{"ok":true}`。確認後プロセスを止める。

**⚠️ 自動テストは `buildServer` を直接呼ぶので、`index.ts` の配線ミスを捕まえられない。** ここだけは実際に起動して見ること。

- [ ] **Step 6: コミット**

```bash
git add -A
git commit -m "refactor: buildServer に依存の組み立てを集約し、テスト専用フックを全廃する

buildServer が rooms→prompts/plays/quota→ai→handlers→routes の順で
組み立て、startTestServer はそのオプションを素通しするだけになった。

grep で本番の __*ForTest / _clear* が0件になったことを確認済み。
本番の呼び出し buildServer() は引数なしのまま変わっていない。

server 281/281・client 10/10・tsc clean・build clean・/health 疎通OK。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 完了条件

| # | 条件 | 確認方法 |
|---|------|----------|
| 1 | テスト専用フックが0件 | `grep -rn "export function __\|export function _clear" server/src` が無出力 |
| 2 | テスト件数が一致 | server 281/281・client 10/10 |
| 3 | 型が通る | `npx tsc --noEmit` が server / client とも無出力 |
| 4 | client 無改造 | `git diff main --stat -- client/` が無出力 |
| 5 | 本番が起動する | `npm start` → `/health` が `{"ok":true}` |
| 6 | 差分がレビュー可能 | 各コミットの `git diff -w` に呼び出し置換以外の意味ある差分が無い |

## 想定される落とし穴

- **動的 import の書き換え漏れ**：`tests/` 移動のとき `await import('./x')` を見落として3件が静かに落ちた。`grep -rn "import('" server/tests` で確認すること
- **テストが減っても緑に見える**：件数を毎回照合すること。「pass 278 / fail 0」は成功ではない
- **`index.ts` の配線ミス**：自動テストは `buildServer` を直接呼ぶので捕まらない。Task 6 Step 5 の起動確認が唯一の網
- **`testUtils.ts` の `DAILY_GAME_LIMIT ??= '100000'`**：`config.ts` の環境変数でありスコープ外。消さないこと
