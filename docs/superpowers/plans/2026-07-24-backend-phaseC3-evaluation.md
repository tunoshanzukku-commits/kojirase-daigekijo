# Phase C3 Whisper文字起こし＋Claude評価 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `finalizeEvaluation` のスタブ採点を、各プレイヤーの録音を Groq Whisper で文字起こしし Claude Haiku 4.5 が台本照合で採点する本実装に差し替える（失敗時は `evaluation_failed` でロビーへ）。

**Architecture:** `finalizeEvaluation` を非同期化し、入口で音声・ロスター・台本をスナップショット、`evaluationSeq`（世代トークン）で await 中の reset/delete による stale emit を封じ、finalize 自体は決して reject しない（全体 try/catch → 失敗は `evaluation_failed`）。AI パイプラインは `transcribe.ts`（プロバイダ隔離）→ `ai/scoreGen.ts`（Claude 採点）→ `ai/evaluate.ts`（オーケストレーション・並列文字起こし・鍵未設定はスタブ）の3モジュールに分離。

**Tech Stack:** TypeScript / Express 4 / Socket.IO 4 / `@anthropic-ai/sdk`（既存）/ Groq Whisper（`fetch`＋`FormData`＝Node20標準・依存追加なし）/ node:test + tsx / React 18 + Vite（クライアント）

## Global Constraints

- Socket イベント契約（`shared/events.ts`）への追加は `evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void` の**1つのみ**。`evaluation_complete` のペイロード `{ scores, leftPlayers }` は不変。
- 文字起こし: Groq、`BASE_URL='https://api.groq.com/openai/v1'`、`MODEL='whisper-large-v3-turbo'`、キー `GROQ_API_KEY`、`language=ja`、`response_format=json`。プロバイダ固有値は `transcribe.ts` 先頭に隔離する。
- 採点: Anthropic、`MODEL='claude-haiku-4-5'`、`output_config.format` の JSON Schema で `PlayerScore[]` の形に固定。**構造化出力は `minimum`/`maximum` 非対応**のため 1〜5 の範囲は `parseScores` の検証で担保する。
- **スタブ/オフライン**: `GROQ_API_KEY` か `ANTHROPIC_API_KEY` が未設定、または `script` が null なら `generateStubScores(performers)` を返す（ネットワーク無し）。判定は `ai/evaluate.ts` に一元化する。
- 文字起こしも採点も **1 リトライ**。**個別プレイヤーの文字起こし失敗は空文字に劣化**（全体を落とさない）。**採点（`generateScores`）の失敗は throw** → `evaluation_failed`。
- 採点対象 `performers = recordingRoster ∩ 現在の在室者`。`leftPlayers = recordingRoster \ 在室者`（不変）。
- `finalizeEvaluation` は **async かつ決して reject しない**（全体 try/catch）。よって全 5 呼び出し箇所は `void finalizeEvaluation(io, room)`。
- `io.to` で送信者を含む全員へ同時配信されるイベントを統合テストで待つときは、**必ず全リスナを登録してから emit**（逐次 await は Windows で送信者自身の分を 100% 取りこぼす）。
- サーバーにテストは `tsx --test`（typecheck スクリプトは無い）。クライアント検証は `npm run build`（`tsc && vite build`）と 2 タブ手動。テスト時は dotenv を読まないため `GROQ_API_KEY`/`ANTHROPIC_API_KEY` は未設定＝自動でスタブモード（注入テストは `__set...ForTest` で鍵に依存しない）。
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。作業ブランチ `feature/phase-c3-evaluation`（作成済み）。

## File Structure

| ファイル | 責務 |
|---|---|
| `shared/events.ts` (modify) | `evaluation_failed` イベントを追加 |
| `server/src/roomStore.ts` (modify) | `Room.evaluationSeq`（世代トークン）を追加・`resetRoom` で ++ |
| `server/src/ai/evaluate.ts` (create) | `evaluatePerformance` オーケストレーション＋差し替えフック。Task1 はスタブのみ、Task4 で実パイプライン |
| `server/src/handlers.ts` (modify) | `finalizeEvaluation` の非同期化・スナップショット・世代再確認・失敗経路・`void` 呼び出し・`join_room` の `collectingAudio` ガード |
| `server/src/transcribe.ts` (create) | Groq Whisper 文字起こし（プロバイダ隔離・mime→拡張子・1リトライ・フック） |
| `server/src/ai/scoreGen.ts` (create) | Claude Haiku 4.5 採点（`parseScores`・1リトライ・フック） |
| `server/src/index.ts` (modify) | スタブモードの起動時警告 |
| `client/src/useGameSocket.ts` (modify) | `evaluation_failed` リスナ |
| `.env.example` (modify) | `GROQ_API_KEY=` 追加 |
| `server/src/*.test.ts` (create/modify) | 各モジュールの単体・統合テスト |

---

### Task 1: finalizeEvaluation の非同期化 ＋ 失敗契約 ＋ evaluate スタブ足場

最重要タスク。AI をまだ入れず、`evaluatePerformance` はスタブを返す足場だけ用意し、**非同期化・世代トークン・失敗経路・呼び出し整理**を先に完成させて注入テストで固める。

**Files:**
- Create: `server/src/ai/evaluate.ts`
- Modify: `shared/events.ts`, `server/src/roomStore.ts`, `server/src/handlers.ts`
- Modify: `server/src/handlers.evaluation.test.ts`（新規統合テスト追加・既存1テスト書き換え）
- Modify: `server/src/uploadRoute.ts`（2 呼び出しを `void` 化）

**Interfaces:**
- Consumes: 既存 `generateStubScores`、`Room`、`getRoom`/`resetRoom`/`toSnapshot`/`touch`
- Produces:
  - `evaluatePerformance(script: ScriptData | null, performers: string[], audioByName: Map<string, { buffer: Buffer; mime: string }>): Promise<PlayerScore[]>`
  - `__setEvaluatorForTest(fn: Evaluator): void` / `__resetEvaluatorForTest(): void`（`Evaluator` は上記 `evaluatePerformance` と同じ型）
  - `Room.evaluationSeq: number`
  - `evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void`
  - `finalizeEvaluation(io, room): Promise<void>`（async・非 reject）

- [ ] **Step 1: Create the evaluate scaffold (stub only)**

`server/src/ai/evaluate.ts` を新規作成:

```ts
import type { ScriptData, PlayerScore } from '@shared/types'
import { generateStubScores } from './scoreStub'

export type Evaluator = (
  script: ScriptData | null,
  performers: string[],
  audioByName: Map<string, { buffer: Buffer; mime: string }>,
) => Promise<PlayerScore[]>

// Task 1 時点は常にスタブ。Task 4 で transcribe + scoreGen の実パイプラインに差し替える。
const defaultEvaluate: Evaluator = async (_script, performers, _audioByName) => {
  return generateStubScores(performers)
}

let impl: Evaluator = defaultEvaluate

export function evaluatePerformance(
  script: ScriptData | null,
  performers: string[],
  audioByName: Map<string, { buffer: Buffer; mime: string }>,
): Promise<PlayerScore[]> {
  return impl(script, performers, audioByName)
}

export function __setEvaluatorForTest(fn: Evaluator): void {
  impl = fn
}
export function __resetEvaluatorForTest(): void {
  impl = defaultEvaluate
}
```

- [ ] **Step 2: Add the evaluation_failed event**

`shared/events.ts` の `ServerToClientEvents` に追加（`script_failed` の隣）:

```ts
  evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void
```

`RoomSnapshot` は同ファイル冒頭で既に import 済み（追加 import 不要）。

- [ ] **Step 3: Add evaluationSeq to the room**

`server/src/roomStore.ts` の `Room` インターフェースに追加（`recordingTimer` の直後）:

```ts
  evaluationSeq: number
```

`createRoom` の初期化に追加（`recordingTimer: null,` の直後）:

```ts
    evaluationSeq: 0,
```

`resetRoom` の先頭（`room.status = 'waiting'` の前）に追加:

```ts
  room.evaluationSeq++ // 進行中の非同期評価を無効化（stale な evaluation_complete を防ぐ）
```

- [ ] **Step 4: Write the failing integration tests**

`server/src/handlers.evaluation.test.ts` に import を1行だけ追加する（`PlayerScore` と `__set/resetUploadTimeoutForTest` は既に import 済み。重複追加しないこと）:

```ts
import { __setEvaluatorForTest, __resetEvaluatorForTest } from './ai/evaluate'
```

`afterEach` に `__resetEvaluatorForTest()` を追加:

```ts
afterEach(async () => {
  __resetUploadTimeoutForTest()
  __resetEvaluatorForTest()
  await server.close()
})
```

既存テスト `'収集中に全員がロビーへ戻っても評価は破棄されない'` を**丸ごと次に置き換える**（非同期化により「全員が収集中に戻った＝結果を見る人がいない」ので評価は破棄してロビーへ、が正しい挙動になる）:

```ts
test('収集中に全員がロビーへ戻ったら評価は破棄してロビーへ戻す', async () => {
  __setUploadTimeoutForTest(5000) // タイムアウトでは終わらせない
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  // 収集中に全員がロビーへ戻る → 誰も結果を見ないので評価せずリセットのみ
  const hostReset = once<{ room: { status: string } }>(host, 'room_reset')
  const guestReturned = once(guest, 'player_returned')
  host.emit('return_to_lobby')
  await guestReturned
  let sawEval = false
  host.on('evaluation_complete', () => { sawEval = true })
  guest.emit('return_to_lobby')
  const r = await hostReset
  assert.equal(r.room.status, 'waiting')
  await delay(150)
  assert.equal(sawEval, false) // 評価は破棄され evaluation_complete は来ない
  host.disconnect(); guest.disconnect()
})
```

ファイル末尾に新規統合テスト4件を追記:

```ts
test('採点成功で evaluation_complete が全員へ届く（評価器を注入）', async () => {
  __setUploadTimeoutForTest(60) // アップロードせずタイムアウトで収集ゲートを閉じる
  __setEvaluatorForTest(async (_script, performers) =>
    performers.map(name => ({ playerName: name, acting: 4, emotion: 4, kojirase: 4, comment: `${name}講評` })),
  )
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const e = await hostEval // 60ms のタイムアウトで finalize→注入評価器→配信
  assert.equal(e.scores.length, 2)
  assert.deepEqual(e.scores.map(s => s.comment).sort(), ['たろう講評', 'はなこ講評'].sort())
  host.disconnect(); guest.disconnect()
})

test('採点失敗で evaluation_failed が届き room が waiting に戻る（throw を注入）', async () => {
  __setUploadTimeoutForTest(60) // タイムアウトで収集を閉じ finalize を走らせる
  __setEvaluatorForTest(async () => { throw new Error('boom') })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  const hostFailed = once<{ room: { status: string }; message: string }>(host, 'evaluation_failed')
  const guestFailed = once<{ room: { status: string } }>(guest, 'evaluation_failed')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const [hf] = await Promise.all([hostFailed, guestFailed])
  assert.equal(hf.room.status, 'waiting')
  assert.match(hf.message, /採点に失敗/)
  host.disconnect(); guest.disconnect()
})

test('evaluation_complete は重複配信されない', async () => {
  __setUploadTimeoutForTest(40)
  __setEvaluatorForTest(async (_s, performers) =>
    performers.map(name => ({ playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: 'x' })),
  )
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  let count = 0
  host.on('evaluation_complete', () => { count++ })
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await delay(200) // タイムアウト finalize が走る。collectingAudio ガードで emit は1回だけ
  assert.equal(count, 1)
  host.disconnect(); guest.disconnect()
})

test('評価の解決前に全員が戻ると stale な evaluation_complete は来ない（世代トークン）', async () => {
  __setUploadTimeoutForTest(40)
  // 200ms 遅れて解決する評価器。その間に全員 return_to_lobby → resetRoom で世代が進む
  __setEvaluatorForTest(async (_s, performers) => {
    await delay(200)
    return performers.map(name => ({ playerName: name, acting: 5, emotion: 5, kojirase: 5, comment: 'late' }))
  })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await delay(60) // タイムアウトで finalize 開始（評価器は 200ms 保留）
  let sawEval = false
  host.on('evaluation_complete', () => { sawEval = true })
  const hostReset = once(host, 'room_reset')
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  guest.emit('return_to_lobby')
  await hostReset // 全員復帰で resetRoom（世代 ++）
  await delay(250) // 保留していた評価器が解決するのを待つ
  assert.equal(sawEval, false) // 世代不一致で emit されない
  host.disconnect(); guest.disconnect()
})
```

**注:** 1 番目のテストは実際の収集ゲート閉じにHTTPアップロードを使わず、`host.emit('stop_recording')` 直後の**タイムアウト**で閉じる作りにする。上記のコードは冗長な二重 stop_recording を含むので、実装時は次に単純化すること — `__setUploadTimeoutForTest(60)` にして `stop_recording` 後にタイムアウトで finalize を走らせ `hostEval` を待つ。二重 `stop_recording` 行は削除する。

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/handlers.evaluation.test.ts`
Expected: FAIL — `__setEvaluatorForTest` が未実装（import エラー）、および新規テストが未実装挙動で失敗。

- [ ] **Step 6: Make finalizeEvaluation async with snapshot + epoch + failure path**

`server/src/handlers.ts` の import を修正。`generateStubScores` を削除し `evaluatePerformance` を追加:

```ts
import { evaluatePerformance } from './ai/evaluate'
```

（`import { generateStubScores } from './ai/scoreStub'` の行は削除する。finalize はもう直接呼ばない。）

`finalizeEvaluation` を丸ごと置き換え（async 化）:

```ts
// evaluation_complete を配信する唯一の関数。全員のアップロード到達・タイムアウト・
// 収集中の切断のいずれからも呼ばれる。async だが決して reject しない（全体 try/catch）。
// 入口でスナップショットを取り、evaluationSeq で await 中の reset/delete による stale emit を防ぐ。
export async function finalizeEvaluation(io: IO, room: Room): Promise<void> {
  if (!room.collectingAudio) return // 入口の冪等ガード（同期）
  room.collectingAudio = false
  if (room.uploadTimer) {
    clearTimeout(room.uploadTimer)
    room.uploadTimer = null
  }
  const myEval = ++room.evaluationSeq
  const code = room.code
  const present = [...room.players.values()].map(p => p.name)
  const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
  const performers = room.recordingRoster.filter(n => present.includes(n))
  const script = room.script
  const audioByName = new Map<string, { buffer: Buffer; mime: string }>()
  for (const [sid, a] of room.audio) {
    const name = room.players.get(sid)?.name
    if (name) audioByName.set(name, a)
  }
  try {
    const scores = await evaluatePerformance(script, performers, audioByName)
    if (getRoom(code) !== room || room.evaluationSeq !== myEval) return // 解散/リセット/再ゲームで無効化
    room.scores = scores
    touch(room)
    io.to(code).emit('evaluation_complete', { scores, leftPlayers })
  } catch (err) {
    console.error('[server] evaluation failed:', err)
    if (getRoom(code) !== room || room.evaluationSeq !== myEval) return
    resetRoom(room) // status→waiting・genre 保持・audio/scores クリア（evaluationSeq も ++）
    touch(room)
    io.to(code).emit('evaluation_failed', {
      room: toSnapshot(room),
      message: '採点に失敗しました。もう一度お試しください',
    })
  }
}
```

- [ ] **Step 7: Void the 5 call sites and drop finalize from the allReturned branches**

`server/src/handlers.ts`:

`beginAudioCollection` 内のタイムアウトコールバック（`finalizeEvaluation(io, room)`）を:

```ts
  const timer = setTimeout(() => {
    if (getRoom(code) !== room) return // 解散後の発火は無視
    void finalizeEvaluation(io, room)
  }, uploadTimeoutMs)
```

`beginAudioCollection` 末尾の即時 finalize を:

```ts
  if (room.uploadExpected.size === 0) void finalizeEvaluation(io, room)
```

`return_to_lobby` の allReturned 分岐から `if (room.collectingAudio) finalizeEvaluation(io, room)` の行を**削除**（残すと破棄される評価を非同期に開始してしまう。収集中に全員戻ったら評価せずリセットが正しい）:

```ts
    if (allReturned(room)) {
      resetRoom(room)
      io.to(room.code).emit('room_reset', { room: toSnapshot(room) })
    }
```

`disconnect` 分岐: 「収集中に待っている相手が抜けたら残りだけで確定」は `void` 化して残し、allReturned 分岐からは finalize を**削除**:

```ts
        touch(room)
        // 収集中に待っている相手が抜けたら、残りだけで確定させる（デッドロック回避）
        if (room.collectingAudio && room.uploadExpected.size === 0) {
          void finalizeEvaluation(io, room)
        }
        if (room.status === 'evaluating' && allReturned(room)) {
          resetRoom(room)
          io.to(room.code).emit('room_reset', { room: toSnapshot(room) })
        }
```

`server/src/uploadRoute.ts` の 2 箇所を `void` 化:

```ts
    if (room.uploadExpected.size === 0) void finalizeEvaluation(io, room)
```

（41 行目・62 行目の両方。`void` を付けるだけ。）

- [ ] **Step 8: Add the join_room collectingAudio guard**

`server/src/handlers.ts` の `join_room`、`room.generatingScript` ガードの直後に追加:

```ts
    if (room.collectingAudio) {
      socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
      return
    }
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/handlers.evaluation.test.ts`
Expected: PASS（新規4件＋書き換え1件を含め green）。

- [ ] **Step 10: Run the whole server suite for regressions**

Run: `cd server && npm test`
Expected: PASS（`fail 0`）。既存の evaluation/upload/recording テストがスタブ評価器で従来どおり `evaluation_complete` を受ける。

- [ ] **Step 11: Commit**

```bash
git add shared/events.ts server/src/roomStore.ts server/src/ai/evaluate.ts server/src/handlers.ts server/src/uploadRoute.ts server/src/handlers.evaluation.test.ts
git commit -m "$(cat <<'EOF'
feat: finalizeEvaluation を非同期化し失敗契約 evaluation_failed を追加

入口スナップショット＋evaluationSeq で await 中の reset/delete による
stale emit を封じ、finalize は決して reject しない（全体 try/catch→失敗は
evaluation_failed でロビーへ）。5呼び出しを void 化、収集中に全員戻ったら
評価は破棄してリセット。evaluatePerformance はまだスタブ足場。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: transcribe.ts（Groq Whisper 文字起こし）

**Files:**
- Create: `server/src/transcribe.ts`, `server/src/transcribe.test.ts`
- Modify: `.env.example`, `server/package.json`（test スクリプトに追加）

**Interfaces:**
- Consumes: なし（Node20 標準 `fetch`/`FormData`/`Blob`/`Response`）
- Produces:
  - `transcribe(audio: { buffer: Buffer; mime: string }): Promise<string>`
  - `extForMime(mime: string): string`
  - `__setTranscriberForTest(fn)` / `__resetTranscriberForTest()`

- [ ] **Step 1: Write the failing tests**

`server/src/transcribe.test.ts` を新規作成:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { transcribe, extForMime, __resetTranscriberForTest } from './transcribe'

afterEach(() => {
  __resetTranscriberForTest()
  delete process.env.GROQ_API_KEY
})

test('extForMime は codecs 付き mime と各種 mime を拡張子に変換', () => {
  assert.equal(extForMime('audio/webm;codecs=opus'), 'webm')
  assert.equal(extForMime('audio/webm'), 'webm')
  assert.equal(extForMime('audio/mp4'), 'mp4')
  assert.equal(extForMime('audio/ogg'), 'ogg')
  assert.equal(extForMime('audio/wav'), 'wav')
  assert.equal(extForMime('audio/mpeg'), 'mp3')
  assert.equal(extForMime('application/octet-stream'), 'webm') // 既定
})

test('transcribe は Groq 応答の text を返す（fetch をモック）', async () => {
  const orig = globalThis.fetch
  process.env.GROQ_API_KEY = 'test-key'
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 })) as typeof fetch
  try {
    const text = await transcribe({ buffer: Buffer.from([1, 2, 3]), mime: 'audio/webm' })
    assert.equal(text, 'こんにちは')
  } finally {
    globalThis.fetch = orig
  }
})

test('transcribe は 1 回リトライする（1回目失敗→2回目成功）', async () => {
  const orig = globalThis.fetch
  process.env.GROQ_API_KEY = 'test-key'
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 1) throw new Error('network')
    return new Response(JSON.stringify({ text: 'やあ' }), { status: 200 })
  }) as typeof fetch
  try {
    const text = await transcribe({ buffer: Buffer.from([1]), mime: 'audio/webm' })
    assert.equal(text, 'やあ')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = orig
  }
})

test('transcribe は 2 回失敗すると throw', async () => {
  const orig = globalThis.fetch
  process.env.GROQ_API_KEY = 'test-key'
  globalThis.fetch = (async () => new Response('err', { status: 500 })) as typeof fetch
  try {
    await assert.rejects(() => transcribe({ buffer: Buffer.from([1]), mime: 'audio/webm' }))
  } finally {
    globalThis.fetch = orig
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/transcribe.test.ts`
Expected: FAIL — `./transcribe` が存在せず import エラー。

- [ ] **Step 3: Implement transcribe.ts**

`server/src/transcribe.ts` を新規作成:

```ts
// Groq Whisper（OpenAI 互換）。プロバイダ固有値はこの3定数に隔離してある。
// OpenAI へ乗り換える場合は BASE_URL / MODEL / キー名を変えるだけで他モジュールに波及しない。
const BASE_URL = 'https://api.groq.com/openai/v1'
const MODEL = 'whisper-large-v3-turbo'

const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

// Whisper 系はファイル名の拡張子で入力形式を判定するため mime→拡張子が必須。
export function extForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase() // 'audio/webm;codecs=opus' → 'audio/webm'
  return MIME_EXT[base] ?? 'webm'
}

async function callGroq(audio: { buffer: Buffer; mime: string }): Promise<string> {
  const ext = extForMime(audio.mime)
  const form = new FormData()
  form.append('file', new Blob([audio.buffer], { type: audio.mime }), `audio.${ext}`)
  form.append('model', MODEL)
  form.append('language', 'ja')
  form.append('response_format', 'json')
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY ?? ''}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Groq transcription failed: ${res.status}`)
  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn() // 1回だけリトライ
  }
}

async function realTranscribe(audio: { buffer: Buffer; mime: string }): Promise<string> {
  return withRetry(() => callGroq(audio))
}

let impl = realTranscribe
export function transcribe(audio: { buffer: Buffer; mime: string }): Promise<string> {
  return impl(audio)
}
export function __setTranscriberForTest(
  fn: (audio: { buffer: Buffer; mime: string }) => Promise<string>,
): void {
  impl = fn
}
export function __resetTranscriberForTest(): void {
  impl = realTranscribe
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/transcribe.test.ts`
Expected: PASS（5 テスト green）。

- [ ] **Step 5: Add GROQ_API_KEY to .env.example and register the test file**

`.env.example` に追加（`ANTHROPIC_API_KEY=` の行の下）:

```
GROQ_API_KEY=
```

`server/package.json` の `test` スクリプト末尾に `src/transcribe.test.ts` を追加。

- [ ] **Step 6: Run the whole server suite**

Run: `cd server && npm test`
Expected: PASS（`fail 0`）。

- [ ] **Step 7: Commit**

```bash
git add server/src/transcribe.ts server/src/transcribe.test.ts .env.example server/package.json
git commit -m "$(cat <<'EOF'
feat: Groq Whisper 文字起こしモジュール transcribe.ts

プロバイダ固有値(BASE_URL/MODEL/キー名)を先頭に隔離し OpenAI 乗り換えを
容易に。mime→拡張子マップ・1リトライ・テストフックを備える。fetch/FormData
は Node20 標準で依存追加なし。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ai/scoreGen.ts（Claude Haiku 4.5 採点）

`scriptGen.ts` と同型で作る。

**Files:**
- Create: `server/src/ai/scoreGen.ts`, `server/src/ai/scoreGen.test.ts`
- Modify: `server/package.json`（test スクリプトに追加）

**Interfaces:**
- Consumes: `@anthropic-ai/sdk`（既存）、`ScriptData`/`PlayerScore`
- Produces:
  - `generateScores(script: ScriptData, transcripts: { playerName: string; text: string }[]): Promise<PlayerScore[]>`
  - `parseScores(text: string, expectedNames: string[]): PlayerScore[]`
  - `__setScoreGeneratorForTest(fn)` / `__resetScoreGeneratorForTest()`

- [ ] **Step 1: Write the failing tests**

`server/src/ai/scoreGen.test.ts` を新規作成:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseScores, __resetScoreGeneratorForTest } from './scoreGen'

afterEach(() => __resetScoreGeneratorForTest())

test('parseScores は正しい JSON を PlayerScore[] に変換', () => {
  const text = JSON.stringify({
    scores: [
      { playerName: 'A', acting: 5, emotion: 3, kojirase: 4, comment: 'よかった' },
      { playerName: 'B', acting: 1, emotion: 2, kojirase: 1, comment: '無音' },
    ],
  })
  const s = parseScores(text, ['A', 'B'])
  assert.equal(s.length, 2)
  assert.deepEqual(s.map(x => x.playerName), ['A', 'B']) // expectedNames の順
  assert.equal(s[0].acting, 5)
  assert.equal(s[1].comment, '無音')
})

test('parseScores は不正 JSON で throw', () => {
  assert.throws(() => parseScores('not json', ['A']))
})

test('parseScores は期待プレイヤーが欠けると throw', () => {
  const text = JSON.stringify({ scores: [{ playerName: 'A', acting: 3, emotion: 3, kojirase: 3, comment: 'c' }] })
  assert.throws(() => parseScores(text, ['A', 'B'])) // B が無い
})

test('parseScores はスコアが 1〜5 の整数でないと throw', () => {
  const text = JSON.stringify({ scores: [{ playerName: 'A', acting: 6, emotion: 3, kojirase: 3, comment: 'c' }] })
  assert.throws(() => parseScores(text, ['A'])) // 6 は範囲外
  const text2 = JSON.stringify({ scores: [{ playerName: 'A', acting: 2.5, emotion: 3, kojirase: 3, comment: 'c' }] })
  assert.throws(() => parseScores(text2, ['A'])) // 非整数
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/ai/scoreGen.test.ts`
Expected: FAIL — `./scoreGen` が存在せず import エラー。

- [ ] **Step 3: Implement scoreGen.ts**

`server/src/ai/scoreGen.ts` を新規作成:

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { ScriptData, PlayerScore } from '@shared/types'

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 2000

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          playerName: { type: 'string' },
          acting: { type: 'integer' },
          emotion: { type: 'integer' },
          kojirase: { type: 'integer' },
          comment: { type: 'string' },
        },
        required: ['playerName', 'acting', 'emotion', 'kojirase', 'comment'],
      },
    },
  },
  required: ['scores'],
}

const SYSTEM =
  'あなたは即興劇の審査員です。各プレイヤーの担当役・台詞（台本）と実際の発話（文字起こし）を照合し、' +
  '演技力・感情表現・こじらせ度を各 1〜5 の整数と短い日本語の講評コメントで採点します。' +
  '発話が空の場合は聞き取れなかった扱いで各項目を最低点(1)にし、その旨をコメントに書いてください。' +
  '出力は必ず与えられた JSON スキーマに厳密に従ってください。'

export function buildScorePrompt(
  script: ScriptData,
  transcripts: { playerName: string; text: string }[],
): string {
  const lines: string[] = []
  lines.push(`世界観：${script.worldSetting}`, '')
  for (const t of transcripts) {
    const role = script.roles.find(r => r.player === t.playerName)
    const scripted = script.entries
      .filter(e => e.player === t.playerName)
      .map(e => e.line)
      .join(' / ')
    lines.push(`▼ ${t.playerName}`)
    lines.push(`役：${role?.role ?? '不明'}（${role?.description ?? ''}）`)
    lines.push(`台本の台詞：${scripted || '（なし）'}`)
    lines.push(`実際の発話：${t.text || '（無音）'}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function parseScores(text: string, expectedNames: string[]): PlayerScore[] {
  const data = JSON.parse(text) as {
    scores?: Array<{ playerName?: string; acting?: unknown; emotion?: unknown; kojirase?: unknown; comment?: unknown }>
  }
  if (!Array.isArray(data.scores)) throw new Error('invalid scores shape')
  const byName = new Map(data.scores.map(s => [s.playerName, s]))
  const check = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) {
      throw new Error(`bad score for ${name}`)
    }
    return v
  }
  return expectedNames.map(name => {
    const s = byName.get(name)
    if (!s) throw new Error(`missing score for ${name}`)
    return {
      playerName: name,
      acting: check(s.acting, name),
      emotion: check(s.emotion, name),
      kojirase: check(s.kojirase, name),
      comment: String(s.comment ?? ''),
    }
  })
}

let anthropic: Anthropic | null = null
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic())
}

async function callClaude(
  script: ScriptData,
  transcripts: { playerName: string; text: string }[],
): Promise<PlayerScore[]> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildScorePrompt(script, transcripts) }],
    output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
  } as Parameters<Anthropic['messages']['create']>[0])
  const block = (res as { content: Array<{ type: string; text?: string }>; stop_reason?: string }).content.find(
    b => b.type === 'text',
  )
  if (!block?.text) {
    const stop = (res as { stop_reason?: string }).stop_reason ?? 'unknown'
    throw new Error(`Claude 応答に text ブロックがありません (stop_reason=${stop})`)
  }
  return parseScores(block.text, transcripts.map(t => t.playerName))
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn() // 1回だけリトライ
  }
}

async function realGenerateScores(
  script: ScriptData,
  transcripts: { playerName: string; text: string }[],
): Promise<PlayerScore[]> {
  return withRetry(() => callClaude(script, transcripts))
}

let impl = realGenerateScores
export function generateScores(
  script: ScriptData,
  transcripts: { playerName: string; text: string }[],
): Promise<PlayerScore[]> {
  return impl(script, transcripts)
}
export function __setScoreGeneratorForTest(
  fn: (script: ScriptData, transcripts: { playerName: string; text: string }[]) => Promise<PlayerScore[]>,
): void {
  impl = fn
}
export function __resetScoreGeneratorForTest(): void {
  impl = realGenerateScores
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/ai/scoreGen.test.ts`
Expected: PASS（4 テスト green）。

- [ ] **Step 5: Register the test file**

`server/package.json` の `test` スクリプト末尾に `src/ai/scoreGen.test.ts` を追加。

- [ ] **Step 6: Run the whole server suite**

Run: `cd server && npm test`
Expected: PASS（`fail 0`）。

- [ ] **Step 7: Commit**

```bash
git add server/src/ai/scoreGen.ts server/src/ai/scoreGen.test.ts server/package.json
git commit -m "$(cat <<'EOF'
feat: Claude Haiku 4.5 採点モジュール scoreGen.ts

台本の担当役・台詞と実際の発話を照合し 演技/感情/こじらせ を 1〜5 と
講評コメントで採点。JSON Schema 固定・parseScores で人数欠落と範囲外を
弾く・1リトライ。scriptGen と同型（テストフック付き）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: evaluate.ts に実パイプラインを配線

`evaluatePerformance` の既定実装を、transcribe（並列・個別失敗は空文字）＋ generateScores（鍵未設定はスタブ）に差し替える。

**Files:**
- Modify: `server/src/ai/evaluate.ts`
- Create: `server/src/ai/evaluate.test.ts`
- Modify: `server/src/index.ts`（スタブモード警告）, `server/package.json`

**Interfaces:**
- Consumes: Task 2 `transcribe`/`__setTranscriberForTest`、Task 3 `generateScores`/`__setScoreGeneratorForTest`、既存 `generateStubScores`
- Produces: 変更なし（`evaluatePerformance` の内部実装のみ差し替え）

- [ ] **Step 1: Write the failing tests**

`server/src/ai/evaluate.test.ts` を新規作成:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePerformance } from './evaluate'
import { __setTranscriberForTest, __resetTranscriberForTest } from '../transcribe'
import { __setScoreGeneratorForTest, __resetScoreGeneratorForTest } from './scoreGen'
import type { ScriptData } from '@shared/types'

const SCRIPT: ScriptData = {
  worldSetting: 'ある町',
  roles: [
    { player: 'A', role: '主役', description: 'x' },
    { player: 'B', role: '脇役', description: 'y' },
  ],
  entries: [
    { player: 'A', character: '主役', action: '', line: 'せりふA' },
    { player: 'B', character: '脇役', action: '', line: 'せりふB' },
  ],
}

afterEach(() => {
  __resetTranscriberForTest()
  __resetScoreGeneratorForTest()
  delete process.env.GROQ_API_KEY
  delete process.env.ANTHROPIC_API_KEY
})

test('鍵未設定ならスタブスコアを返す（ネットワーク無し）', async () => {
  const scores = await evaluatePerformance(SCRIPT, ['A', 'B'], new Map())
  assert.equal(scores.length, 2)
  assert.deepEqual(scores.map(s => s.playerName).sort(), ['A', 'B'])
})

test('個別 transcribe 失敗は空文字に劣化して全員採点が返る', async () => {
  process.env.GROQ_API_KEY = 'k'
  process.env.ANTHROPIC_API_KEY = 'k'
  __setTranscriberForTest(async () => { throw new Error('boom') }) // 常に失敗
  __setScoreGeneratorForTest(async (_script, transcripts) =>
    transcripts.map(t => ({
      playerName: t.playerName, acting: 3, emotion: 3, kojirase: 3, comment: t.text || '（無音）',
    })),
  )
  const audio = new Map([['A', { buffer: Buffer.from([1]), mime: 'audio/webm' }]])
  const scores = await evaluatePerformance(SCRIPT, ['A', 'B'], audio)
  assert.equal(scores.length, 2)
  assert.ok(scores.every(s => s.comment === '（無音）')) // A(失敗)も B(音声なし)も空文字
})

test('音声のある performer は文字起こし結果が採点に渡る', async () => {
  process.env.GROQ_API_KEY = 'k'
  process.env.ANTHROPIC_API_KEY = 'k'
  __setTranscriberForTest(async () => 'しゃべった')
  let received: { playerName: string; text: string }[] = []
  __setScoreGeneratorForTest(async (_script, transcripts) => {
    received = transcripts
    return transcripts.map(t => ({ playerName: t.playerName, acting: 4, emotion: 4, kojirase: 4, comment: 'ok' }))
  })
  const audio = new Map([['A', { buffer: Buffer.from([1]), mime: 'audio/webm' }]])
  await evaluatePerformance(SCRIPT, ['A'], audio)
  assert.deepEqual(received, [{ playerName: 'A', text: 'しゃべった' }])
})

test('generateScores が throw したら evaluatePerformance も throw', async () => {
  process.env.GROQ_API_KEY = 'k'
  process.env.ANTHROPIC_API_KEY = 'k'
  __setTranscriberForTest(async () => 'x')
  __setScoreGeneratorForTest(async () => { throw new Error('claude down') })
  const audio = new Map([['A', { buffer: Buffer.from([1]), mime: 'audio/webm' }]])
  await assert.rejects(() => evaluatePerformance(SCRIPT, ['A'], audio))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx tsx --test src/ai/evaluate.test.ts`
Expected: FAIL — 現状 `evaluatePerformance` は常にスタブなので、transcribe/scoreGen 注入を使うテスト（2〜4番目）が期待どおりに動かず失敗（例: コメントが '（無音）' でなくスタブ文言）。

- [ ] **Step 3: Wire the real pipeline**

`server/src/ai/evaluate.ts` を書き換え（`defaultEvaluate` を実パイプラインに）:

```ts
import type { ScriptData, PlayerScore } from '@shared/types'
import { generateStubScores } from './scoreStub'
import { transcribe } from '../transcribe'
import { generateScores } from './scoreGen'

export type Evaluator = (
  script: ScriptData | null,
  performers: string[],
  audioByName: Map<string, { buffer: Buffer; mime: string }>,
) => Promise<PlayerScore[]>

// 鍵未設定 or 台本なしはスタブ（ネットワーク無し）。実行時は各 performer を並列で
// 文字起こしし、個別失敗は空文字に劣化（全体は落とさない）。採点(generateScores)の
// 失敗はそのまま throw され、呼び出し側(finalizeEvaluation)で evaluation_failed になる。
const realEvaluate: Evaluator = async (script, performers, audioByName) => {
  if (!process.env.GROQ_API_KEY || !process.env.ANTHROPIC_API_KEY || !script) {
    return generateStubScores(performers)
  }
  const transcripts = await Promise.all(
    performers.map(async name => {
      const audio = audioByName.get(name)
      if (!audio) return { playerName: name, text: '' }
      try {
        const text = await transcribe(audio)
        return { playerName: name, text }
      } catch (err) {
        console.error(`[server] transcription failed for ${name}:`, err)
        return { playerName: name, text: '' } // 個別失敗は空文字に劣化
      }
    }),
  )
  return generateScores(script, transcripts)
}

let impl: Evaluator = realEvaluate

export function evaluatePerformance(
  script: ScriptData | null,
  performers: string[],
  audioByName: Map<string, { buffer: Buffer; mime: string }>,
): Promise<PlayerScore[]> {
  return impl(script, performers, audioByName)
}

export function __setEvaluatorForTest(fn: Evaluator): void {
  impl = fn
}
export function __resetEvaluatorForTest(): void {
  impl = realEvaluate
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx tsx --test src/ai/evaluate.test.ts`
Expected: PASS（4 テスト green）。

- [ ] **Step 5: Add the stub-mode startup warning**

`server/src/index.ts` の既存 `ANTHROPIC_API_KEY` 警告の下に追加:

```ts
if (!process.env.GROQ_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  console.warn('[server] GROQ_API_KEY / ANTHROPIC_API_KEY 未設定：AI評価はスタブモードで動作します')
}
```

- [ ] **Step 6: Register the test file and run the whole suite**

`server/package.json` の `test` スクリプト末尾に `src/ai/evaluate.test.ts` を追加。

Run: `cd server && npm test`
Expected: PASS（`fail 0`）。Task 1 の handlers 統合テストは（鍵未設定なので）`realEvaluate` がスタブに落ち、従来どおり `evaluation_complete` を受ける。

- [ ] **Step 7: Commit**

```bash
git add server/src/ai/evaluate.ts server/src/ai/evaluate.test.ts server/src/index.ts server/package.json
git commit -m "$(cat <<'EOF'
feat: evaluate に Whisper+Claude 実パイプラインを配線

performer を並列で文字起こし（個別失敗は空文字に劣化）→ Claude 採点。
鍵未設定/台本なしはスタブに落とす。採点失敗は throw して finalize 側の
evaluation_failed へ。起動時にスタブモード警告。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: クライアントの evaluation_failed 配線

**Files:**
- Modify: `client/src/useGameSocket.ts`

**Interfaces:**
- Consumes: Task 1 の `evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void`
- Produces: なし

**Note:** クライアントにテストは無い。検証は `npm run build`。

- [ ] **Step 1: Add the evaluation_failed listener**

`client/src/useGameSocket.ts` に、`onRoomReset` を参考にしたハンドラを追加する。`onRoomReset` 関数の直後に定義:

```ts
    function onEvaluationFailed({ room, message }: { room: RoomSnapshot; message: string }) {
      setCtx(prev => ({
        ...prev,
        genre: room.genre,
        players: room.players,
        script: null,
        scores: [],
        readyMap: {},
        bgm: null,
        leftPlayers: [],
        returnedPlayers: [],
      }))
      pushToast(message, 'error')
      setScreen('lobby')
    }
```

登録（`socket.on('room_reset', onRoomReset)` の直後）:

```ts
    socket.on('evaluation_failed', onEvaluationFailed)
```

解除（`socket.off('room_reset', onRoomReset)` の直後）:

```ts
    socket.off('evaluation_failed', onEvaluationFailed)
```

`RoomSnapshot` 型が未 import なら、既存の型 import 行に追加する（`import type { RoomSnapshot, PlayerSnapshot, ScriptData } from './types'` の形）。

- [ ] **Step 2: Verify the client builds**

Run: `cd client && npm run build`
Expected: PASS — `tsc` 型エラーなし、`vite build` 完了。

- [ ] **Step 3: Commit**

```bash
git add client/src/useGameSocket.ts
git commit -m "$(cat <<'EOF'
feat: クライアントで evaluation_failed を配線

採点失敗時に room スナップショットで ctx をリセットし、トースト表示して
ロビーへ戻す（onRoomReset と同型）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 全体検証と 2 タブ手動確認

**Files:** 変更なし（検証のみ）

**Interfaces:**
- Consumes: Task 1〜5 のすべて

- [ ] **Step 1: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — `fail 0`。新規（transcribe/scoreGen/evaluate/finalize 統合）を含む全テスト green。

- [ ] **Step 2: Run the client build**

Run: `cd client && npm run build`
Expected: PASS — 型エラーなし、`vite build` 完了。

- [ ] **Step 3: Start both servers with real keys**

`.env`（リポジトリ直下）に `GROQ_API_KEY` と `ANTHROPIC_API_KEY` が入っていることを確認し、バックグラウンド起動:

```bash
cd server && npm run dev
```

```bash
cd client && npm run dev
```

Expected: server ログに **`GROQ_API_KEY / ANTHROPIC_API_KEY 未設定：AI評価はスタブモード` が出ない**（＝実キー認識）。`[server] listening on 3001`。

- [ ] **Step 4: 2 タブ手動確認チェックリスト**

ブラウザ 2 タブ（`http://localhost:5173`）で実施:

1. ルーム作成→参加→ジャンル→開始→配役→両方準備完了→録音開始→両タブでマイク許可。
2. **各自が自分の台詞を実際に声に出して演じる**（数秒ずつ）。ホストが録音終了。
3. 「AI採点中...」→ しばらく（実文字起こし＋採点で数十秒）→ **結果画面にスコアが出る**。
4. **講評コメントが実際の発話内容を反映している**こと（スタブ固定文でない）。演技・感情・こじらせが 1〜5 で出る。
5. サーバーログに文字起こし・採点のエラーが出ていないこと。
6. **マイク拒否のケース**: 片方をブロックして録音→終了。そのプレイヤーは**低評価＋「聞き取れなかった」旨のコメント**、もう片方は通常採点。
7. **失敗のケース（任意）**: `.env` の `GROQ_API_KEY` を一時的に無効な値にして再起動→録音→終了すると、**トースト「採点に失敗しました」＋ロビーへ戻る**（ホストが再開できる）。確認後キーを戻す。

- [ ] **Step 5: Stop the background servers**

手動確認後、起動中プロセスを停止する。

- [ ] **Step 6: Commit (only if fixes were needed)**

手動確認で不具合が出た場合のみ修正・コミット。

---

## 完了後

全タスク green かつ手動確認 OK なら、opus の whole-branch レビュー（`superpowers:requesting-code-review`）→ `superpowers:finishing-a-development-branch` で main へローカルマージ（fast-forward → マージ後 `npm test` 再実行 → `git branch -d feature/phase-c3-evaluation`）。
