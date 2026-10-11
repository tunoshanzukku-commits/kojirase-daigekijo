# Phase C1（Claude台本生成）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `start_game` の同期スタブ台本生成を、Claude Haiku 4.5 による非同期生成に差し替える（生成中オーバーレイのサーバー駆動化・課金前ガード・失敗時1リトライ含む）。

**Architecture:** サーバーの `start_game` を async 化し、`script_generating`→（生成）→`script_ready`/`script_failed` の3イベントで駆動する。生成本体は `ai/scriptGen.ts` に隔離し、`ANTHROPIC_API_KEY` 未設定時はスタブへフォールバック（＝テストとオフライン開発が network 無しで決定的に走る）。クライアントは生成中フラグを ctx 経由でオーバーレイに反映。

**Tech Stack:** TypeScript / Node（tsx）/ Socket.IO / `@anthropic-ai/sdk` / dotenv / React（Vite）

## Global Constraints

- サーバーは TypeScript・`tsx` 実行。共有型/イベントはリポジトリ直下 `shared/` に `@shared/*` で両側から import。
- モデルは `claude-haiku-4-5` 固定。非ストリーミング・`max_tokens` は 4000。`thinking` 設定は付けない（Haiku 4.5 非対応）。
- 失敗時はサーバー内で **1 回だけリトライ**（＝最大 2 試行）。本番でスタブ台本は出さない。
- 課金前ガード: `start_game` は genre 必須・プレイヤー **2人以上**を要求。
- テストは node:test（`tsx --test`）。`io.to` 配信を待つ時は **両リスナ登録後に emit**（Windows の逐次 await 取りこぼし回避）。TDD 厳守（RED を実際に確認してから実装）。
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 設計書: [docs/superpowers/specs/2026-07-18-backend-phaseC1-script-design.md](../specs/2026-07-18-backend-phaseC1-script-design.md)

---

## ファイル構成

- `shared/events.ts` — `script_generating` / `script_failed` を S→C に追加（Task 1）
- `server/src/roomStore.ts` — `Room.generatingScript` フラグ（Task 1）
- `server/src/ai/scriptGen.ts` — 新規。実生成＋スタブフォールバック＋リトライ＋テスト用フック（Task 2）
- `server/src/index.ts` — `dotenv/config`・起動時ログ（Task 2）
- `.env.example` — 新規（Task 2）
- `server/package.json` — 依存追加・test スクリプト更新（Task 2）
- `server/src/handlers.ts` — `start_game` async 化＋ガード（Task 3）、`join_room` ガード（Task 4）
- `server/src/testUtils.ts` — `expectNoEvent` ヘルパ追加（Task 3）
- `client/src/App.tsx` / `useGameSocket.ts` / `screens/LobbyScreen.tsx` — 生成中フラグ配線（Task 5）

---

### Task 1: 共有イベント契約と roomStore フラグ

**Files:**
- Modify: `shared/events.ts`
- Modify: `server/src/roomStore.ts`（`Room` interface、`createRoom`、`resetRoom`）
- Test: `server/src/roomStore.test.ts`

**Interfaces:**
- Produces: `ServerToClientEvents.script_generating: () => void`、`ServerToClientEvents.script_failed: (p: { message: string }) => void`、`Room.generatingScript: boolean`

- [ ] **Step 1: 失敗するテストを追記**

`server/src/roomStore.test.ts` の末尾に追加:

```ts
test('createRoom は generatingScript=false で初期化', () => {
  const room = createRoom('sock-h', 'ホスト')
  assert.equal(room.generatingScript, false)
})

test('resetRoom は generatingScript を false に戻す', () => {
  const room = createRoom('sock-h', 'ホスト')
  room.generatingScript = true
  resetRoom(room)
  assert.equal(room.generatingScript, false)
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL（`generatingScript` が `Room` に無く tsx 実行時 undefined→ assert 不一致、または型エラー）

- [ ] **Step 3: roomStore に実装**

`server/src/roomStore.ts` の `Room` interface に追加（`returned: Set<string>` の下）:

```ts
  returned: Set<string>
  generatingScript: boolean
```

`createRoom` の room リテラル内、`returned: new Set(),` の下に追加:

```ts
    returned: new Set(),
    generatingScript: false,
```

`resetRoom` 内、`room.returned.clear()` の下に追加:

```ts
  room.returned.clear()
  room.generatingScript = false
```

- [ ] **Step 4: shared にイベント追加**

`shared/events.ts` の `ServerToClientEvents` 内、`room_reset` の下に追加:

```ts
  room_reset: (payload: { room: RoomSnapshot }) => void
  script_generating: () => void
  script_failed: (payload: { message: string }) => void
```

- [ ] **Step 5: テスト成功を確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: PASS（全テスト green）

- [ ] **Step 6: コミット**

```bash
git add shared/events.ts server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "$(printf 'feat: roomStore に generatingScript・S→C に script_generating/failed を追加\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: AI 生成モジュール（scriptGen）＋依存・設定

**Files:**
- Create: `server/src/ai/scriptGen.ts`
- Modify: `server/src/index.ts`
- Modify: `server/package.json`
- Create: `.env.example`（リポジトリ直下）
- Test: `server/src/ai/scriptGen.test.ts`

**Interfaces:**
- Consumes: `generateStubScript(genre, playerNames): ScriptData`（`./scriptStub`）、`ScriptData`（`@shared/types`）
- Produces:
  - `generateScript(genre: string, playerNames: string[]): Promise<ScriptData>`
  - `parseScript(text: string, playerNames: string[]): ScriptData`（不正JSON・role欠落で throw）
  - `__setScriptGeneratorForTest(fn: (genre: string, playerNames: string[]) => Promise<ScriptData>): void`
  - `__resetScriptGeneratorForTest(): void`

- [ ] **Step 1: 依存をインストール**

Run: `cd server && npm install @anthropic-ai/sdk dotenv`
Expected: `server/package.json` の dependencies に両方が入る。

- [ ] **Step 2: 失敗するテストを作成**

Create `server/src/ai/scriptGen.test.ts`:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateScript, parseScript, __resetScriptGeneratorForTest } from './scriptGen'

afterEach(() => __resetScriptGeneratorForTest())

test('API キー未設定なら全員分の role を持つスタブ台本を返す', async () => {
  delete process.env.ANTHROPIC_API_KEY
  const script = await generateScript('comedy', ['たろう', 'はなこ'])
  assert.equal(script.roles.length, 2)
  assert.deepEqual(script.roles.map(r => r.player).sort(), ['たろう', 'はなこ'].sort())
  assert.equal(typeof script.worldSetting, 'string')
  assert.ok(script.entries.length > 0)
})

test('parseScript は正しい JSON を ScriptData に変換', () => {
  const text = JSON.stringify({
    worldSetting: 'ある町',
    roles: [{ player: 'A', role: '主役', description: '説明' }],
    entries: [{ player: 'A', character: '主役', action: '', line: 'セリフ' }],
  })
  const s = parseScript(text, ['A'])
  assert.equal(s.worldSetting, 'ある町')
  assert.equal(s.entries[0].action, undefined) // '' は undefined に正規化
  assert.equal(s.entries[0].line, 'セリフ')
})

test('parseScript は不正 JSON で throw', () => {
  assert.throws(() => parseScript('not json', ['A']))
})

test('parseScript は role に居ないプレイヤーがいると throw', () => {
  const text = JSON.stringify({
    worldSetting: 'x',
    roles: [{ player: 'A', role: 'r', description: 'd' }],
    entries: [{ player: 'A', character: 'r', action: '', line: 'l' }],
  })
  assert.throws(() => parseScript(text, ['A', 'B'])) // B が居ない
})
```

- [ ] **Step 3: 失敗を確認**

Run: `cd server && npx tsx --test src/ai/scriptGen.test.ts`
Expected: FAIL（`./scriptGen` が存在しない）

- [ ] **Step 4: scriptGen を実装**

Create `server/src/ai/scriptGen.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import type { ScriptData } from '@shared/types'
import { genreLabel } from '@shared/constants'
import { generateStubScript } from './scriptStub'

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 4000

const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    worldSetting: { type: 'string' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          player: { type: 'string' },
          role: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['player', 'role', 'description'],
      },
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          player: { type: 'string' },
          character: { type: 'string' },
          action: { type: 'string' },
          line: { type: 'string' },
        },
        required: ['player', 'character', 'action', 'line'],
      },
    },
  },
  required: ['worldSetting', 'roles', 'entries'],
}

const SYSTEM =
  'あなたは即興劇の台本作家です。指定ジャンルとプレイヤー名から、日本語の短い即興劇台本を作ります。' +
  '各プレイヤーにちょうど1役を割り当て、全員に見せ場を作り、こじらせ・大げさな演技が映える展開にしてください。' +
  '出力は必ず与えられた JSON スキーマに厳密に従ってください。'

export function buildUserPrompt(genre: string, playerNames: string[]): string {
  const label = genreLabel(genre) || '即興劇'
  return (
    `ジャンル：${label}\n` +
    `プレイヤー：${playerNames.join('、')}\n\n` +
    `制約：\n` +
    `- roles はプレイヤー全員ぶん（${playerNames.length}役）、player 名は上記と完全一致。\n` +
    `- entries は各プレイヤーに台詞が回る短い一幕（8〜16行程度）。\n` +
    `- worldSetting は1〜2文で世界観を説明。\n` +
    `- action はト書き（無ければ空文字）。`
  )
}

export function parseScript(text: string, playerNames: string[]): ScriptData {
  const data = JSON.parse(text) as {
    worldSetting?: unknown
    roles?: Array<{ player?: string; role?: string; description?: string }>
    entries?: Array<{ player?: string; character?: string; action?: string; line?: string }>
  }
  if (
    typeof data.worldSetting !== 'string' ||
    !Array.isArray(data.roles) ||
    !Array.isArray(data.entries) ||
    data.entries.length === 0
  ) {
    throw new Error('invalid script shape')
  }
  const roleNames = new Set(data.roles.map(r => r.player))
  for (const n of playerNames) {
    if (!roleNames.has(n)) throw new Error(`missing role for ${n}`)
  }
  return {
    worldSetting: data.worldSetting,
    roles: data.roles.map(r => ({
      player: String(r.player),
      role: String(r.role ?? ''),
      description: String(r.description ?? ''),
    })),
    entries: data.entries.map(e => ({
      player: String(e.player),
      character: String(e.character ?? ''),
      action: e.action ? String(e.action) : undefined,
      line: String(e.line ?? ''),
    })),
  }
}

let anthropic: Anthropic | null = null
function getClient(): Anthropic {
  return (anthropic ??= new Anthropic())
}

async function callClaude(genre: string, playerNames: string[]): Promise<ScriptData> {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: 'user', content: buildUserPrompt(genre, playerNames) }],
    output_config: { format: { type: 'json_schema', schema: SCRIPT_SCHEMA } },
  } as Parameters<Anthropic['messages']['create']>[0])
  const block = (res as { content: Array<{ type: string; text?: string }> }).content.find(
    b => b.type === 'text',
  )
  const text = block?.text ?? ''
  return parseScript(text, playerNames)
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    return await fn() // 1回だけリトライ
  }
}

async function realGenerateScript(genre: string, playerNames: string[]): Promise<ScriptData> {
  if (!process.env.ANTHROPIC_API_KEY) return generateStubScript(genre, playerNames)
  return withRetry(() => callClaude(genre, playerNames))
}

let impl = realGenerateScript
export function generateScript(genre: string, playerNames: string[]): Promise<ScriptData> {
  return impl(genre, playerNames)
}
export function __setScriptGeneratorForTest(
  fn: (genre: string, playerNames: string[]) => Promise<ScriptData>,
): void {
  impl = fn
}
export function __resetScriptGeneratorForTest(): void {
  impl = realGenerateScript
}
```

- [ ] **Step 5: テスト成功を確認**

Run: `cd server && npx tsx --test src/ai/scriptGen.test.ts`
Expected: PASS（4件 green）

- [ ] **Step 6: index.ts に dotenv と起動時ログを追加**

`server/src/index.ts` の先頭行に追加（既存 import の一番上）:

```ts
import 'dotenv/config'
```

`httpServer.listen(...)` の直前に追加:

```ts
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[server] ANTHROPIC_API_KEY 未設定：台本生成はスタブモードで動作します')
}
```

- [ ] **Step 7: `.env.example` を作成**

Create `.env.example`（リポジトリ直下）:

```
# サーバー用。server/ の .env に実キーを置く（.env は gitignore 済み）
ANTHROPIC_API_KEY=
```

- [ ] **Step 8: package.json の test スクリプトに追加**

`server/package.json` の `test` スクリプト末尾（`src/handlers.evaluation.test.ts` の後）に ` src/ai/scriptGen.test.ts` を追記。

- [ ] **Step 9: サーバー全テストが green か確認**

Run: `cd server && npm test`
Expected: PASS（既存＋新規すべて green。既存の start_game 系は2人＋genreで通過し無影響）

- [ ] **Step 10: コミット**

```bash
git add server/src/ai/scriptGen.ts server/src/ai/scriptGen.test.ts server/src/index.ts server/package.json server/package-lock.json .env.example
git commit -m "$(printf 'feat: Claude台本生成モジュール scriptGen を追加（キー無しはスタブ）\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `start_game` の async 化・ガード・生成中/失敗フロー

**Files:**
- Modify: `server/src/handlers.ts`（`start_game` ハンドラ、import 行）
- Modify: `server/src/testUtils.ts`（`expectNoEvent` 追加）
- Test: `server/src/handlers.game.test.ts`

**Interfaces:**
- Consumes: `generateScript`・`__setScriptGeneratorForTest`・`__resetScriptGeneratorForTest`（Task 2）、`Room.generatingScript`（Task 1）、`script_generating`/`script_failed`/`script_ready`（Task 1）、`getRoom`（既存 roomStore）
- Produces: `expectNoEvent(socket, event, ms?): Promise<void>`（testUtils）

- [ ] **Step 1: testUtils に負アサーション用ヘルパを追加**

`server/src/testUtils.ts` の末尾に追加:

```ts
// `ms` 内に `event` が来なければ解決、来たら reject（「起きないこと」の検証用）。
export function expectNoEvent(socket: Socket, event: string, ms = 250): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handler = () => {
      clearTimeout(timer)
      socket.off(event, handler)
      reject(new Error(`unexpected "${event}"`))
    }
    const timer = setTimeout(() => {
      socket.off(event, handler)
      resolve()
    }, ms)
    socket.once(event, handler)
  })
}
```

- [ ] **Step 2: 失敗するテストを追記**

`server/src/handlers.game.test.ts` の import と afterEach を更新し、テストを追記する。

import 行を差し替え:

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent } from './testUtils'
import { _clearAllRooms } from './roomStore'
import { __setScriptGeneratorForTest, __resetScriptGeneratorForTest } from './ai/scriptGen'
```

既存の `afterEach` を次に差し替え（フックのリセットを追加）:

```ts
afterEach(async () => {
  __resetScriptGeneratorForTest()
  await server.close()
})
```

ファイル末尾に追記:

```ts
test('start_game は script_generating→script_ready の順に配信する', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  const gen = once(guest, 'script_generating')
  const ready = once<{ script: { roles: unknown[] } }>(guest, 'script_ready')
  host.emit('start_game')
  await gen
  const { script } = await ready
  assert.equal(script.roles.length, 2)
  host.disconnect(); guest.disconnect()
})

test('start_game は genre 未設定なら error でガードし生成を始めない', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')

  const noGen = expectNoEvent(host, 'script_generating')
  host.emit('start_game')
  const err = await once<{ message: string }>(host, 'error')
  assert.match(err.message, /ジャンル/)
  await noGen
  host.disconnect(); guest.disconnect()
})

test('start_game は1人だと error でガードする', async () => {
  const { host } = await createRoomWithHost()
  host.emit('set_genre', { genre: 'comedy' })
  await once(host, 'genre_changed')

  const noGen = expectNoEvent(host, 'script_generating')
  host.emit('start_game')
  const err = await once<{ message: string }>(host, 'error')
  assert.match(err.message, /2人/)
  await noGen
  host.disconnect()
})

test('生成失敗時は script_failed を配信し、その後の再開始が成功する', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  __setScriptGeneratorForTest(() => Promise.reject(new Error('boom')))
  const failed = once<{ message: string }>(guest, 'script_failed')
  host.emit('start_game')
  const f = await failed
  assert.match(f.message, /失敗/)

  // generatingScript がクリアされ status も waiting のままなら再開始できる
  __resetScriptGeneratorForTest()
  const ready = once(guest, 'script_ready')
  host.emit('start_game')
  await ready
  host.disconnect(); guest.disconnect()
})

test('生成中の二重 start_game は無視される', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  __setScriptGeneratorForTest(() => new Promise<never>(() => {})) // 解決しない＝生成中を保持
  const firstGen = once(host, 'script_generating')
  host.emit('start_game')
  await firstGen

  const noSecond = expectNoEvent(host, 'script_generating') // 2回目は出ない
  host.emit('start_game')
  await noSecond
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 3: 失敗を確認**

Run: `cd server && npx tsx --test src/handlers.game.test.ts`
Expected: FAIL（`script_generating` が未実装、ガード未実装）

- [ ] **Step 4: handlers.ts の import を更新**

`server/src/handlers.ts` の import を変更する。`getRoom` は既存 import に含まれているので、AI 生成の import 行を差し替える。

`import { generateStubScript } from './ai/scriptStub'` を削除し、代わりに:

```ts
import { generateScript } from './ai/scriptGen'
```

（`getRoom` が roomStore の import に無ければ追加する。現状の import には既に `getRoom` が含まれている。）

- [ ] **Step 5: `start_game` を async 実装に差し替え**

`server/src/handlers.ts` の `socket.on('start_game', () => { ... })` ブロック全体を次に置き換える:

```ts
  socket.on('start_game', async () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id || room.status !== 'waiting') return
    if (room.generatingScript) return
    if (!isValidGenre(room.genre)) {
      socket.emit('error', { message: 'ジャンルを選んでください' })
      return
    }
    if (room.players.size < 2) {
      socket.emit('error', { message: '2人以上で開始できます' })
      return
    }
    const code = room.code
    const names = [...room.players.values()].map(p => p.name)
    room.generatingScript = true
    touch(room)
    io.to(code).emit('script_generating')
    try {
      const script = await generateScript(room.genre, names)
      if (getRoom(code) !== room) return // 生成中にホスト切断→解散したケース
      room.generatingScript = false
      room.script = script
      room.status = 'casting'
      touch(room)
      io.to(code).emit('script_ready', { script })
    } catch {
      if (getRoom(code) !== room) return
      room.generatingScript = false
      io.to(code).emit('script_failed', {
        message: '台本の生成に失敗しました。もう一度お試しください',
      })
    }
  })
```

- [ ] **Step 6: テスト成功を確認**

Run: `cd server && npx tsx --test src/handlers.game.test.ts`
Expected: PASS（既存2件＋新規5件すべて green）

- [ ] **Step 7: サーバー全テストが green か確認**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 8: コミット**

```bash
git add server/src/handlers.ts server/src/testUtils.ts server/src/handlers.game.test.ts
git commit -m "$(printf 'feat: start_game を非同期化し script_generating/failed とガードを実装\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: 生成中は `join_room` を拒否

**Files:**
- Modify: `server/src/handlers.ts`（`join_room` ハンドラ）
- Test: `server/src/handlers.game.test.ts`

**Interfaces:**
- Consumes: `Room.generatingScript`（Task 1）、`__setScriptGeneratorForTest`（Task 2）、`expectNoEvent` は不要

- [ ] **Step 1: 失敗するテストを追記**

`server/src/handlers.game.test.ts` の末尾に追加:

```ts
test('生成中の join_room は error で拒否する', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  __setScriptGeneratorForTest(() => new Promise<never>(() => {})) // 生成中を保持
  const gen = once(host, 'script_generating')
  host.emit('start_game')
  await gen

  const late = connectClient(server.port)
  late.emit('join_room', { roomCode, playerName: 'さぶろう' })
  const err = await once<{ message: string }>(late, 'error')
  assert.match(err.message, /参加できません/)
  host.disconnect(); guest.disconnect(); late.disconnect()
})
```

- [ ] **Step 2: 失敗を確認**

Run: `cd server && npx tsx --test src/handlers.game.test.ts`
Expected: FAIL（生成中でも join が通り `room_joined` が来て `error` が来ない→timeout）

- [ ] **Step 3: `join_room` にガードを追加**

`server/src/handlers.ts` の `join_room` ハンドラ内、既存の status 判定ブロック（`if (room.status !== 'waiting' && room.status !== 'evaluating') { ... }`）の**直後**に追加:

```ts
    if (room.generatingScript) {
      socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
      return
    }
```

- [ ] **Step 4: テスト成功を確認**

Run: `cd server && npx tsx --test src/handlers.game.test.ts`
Expected: PASS

- [ ] **Step 5: サーバー全テストが green か確認**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.game.test.ts
git commit -m "$(printf 'feat: 台本生成中は join_room を拒否する\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: クライアント配線（生成中オーバーレイのサーバー駆動化）

**Files:**
- Modify: `client/src/App.tsx`（`GameContext`、`INITIAL_CTX`）
- Modify: `client/src/useGameSocket.ts`（3リスナ）
- Modify: `client/src/screens/LobbyScreen.tsx`（オーバーレイ・ガード）

**Interfaces:**
- Consumes: `script_generating`/`script_failed`/`script_ready`（Task 1）
- Produces: `GameContext.generating: boolean`

- [ ] **Step 1: GameContext に generating を追加**

`client/src/App.tsx` の `GameContext` interface に追加（`returnedPlayers: string[]` の下）:

```ts
  returnedPlayers: string[]
  generating: boolean
```

`INITIAL_CTX` に追加（`returnedPlayers: [],` の下）:

```ts
  returnedPlayers: [],
  generating: false,
```

- [ ] **Step 2: useGameSocket にリスナを追加/更新**

`client/src/useGameSocket.ts` の `onScriptReady` を差し替え（`generating: false` を追加）:

```ts
    function onScriptReady({ script }: { script: ScriptData }) {
      setCtx(prev => ({ ...prev, script, generating: false }))
      setScreen('casting')
    }
```

同ファイル内、`onScriptReady` の近くに2つ追加:

```ts
    function onScriptGenerating() {
      setCtx(prev => ({ ...prev, generating: true }))
    }
    function onScriptFailed({ message }: { message: string }) {
      setCtx(prev => ({ ...prev, generating: false }))
      pushToast(message, 'error')
    }
```

`socket.on('script_ready', onScriptReady)` の下に登録を追加:

```ts
    socket.on('script_ready', onScriptReady)
    socket.on('script_generating', onScriptGenerating)
    socket.on('script_failed', onScriptFailed)
```

`socket.off('script_ready', onScriptReady)` の下に解除を追加:

```ts
      socket.off('script_ready', onScriptReady)
      socket.off('script_generating', onScriptGenerating)
      socket.off('script_failed', onScriptFailed)
```

- [ ] **Step 3: LobbyScreen をサーバー駆動に**

`client/src/screens/LobbyScreen.tsx`:

ローカル state 行を削除:

```ts
  const [generating, setGenerating] = useState(false)
```

`startGame` を差し替え（楽観セット撤去・人数ガード追加）:

```ts
  const startGame = () => {
    if (!ctx.genre || waitingForReturns || ctx.players.length < 2) return
    actions.startGame() // script_generating/ready/failed で App が制御
  }
```

オーバーレイの表示条件を `generating` → `ctx.generating` に変更:

```tsx
      {ctx.generating && (
```

開始ボタンの `disabled` を差し替え、ラベルに人数ヒントを追加:

```tsx
          <button
            onClick={startGame}
            disabled={!ctx.genre || ctx.generating || waitingForReturns || ctx.players.length < 2}
            className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold text-lg rounded-2xl transition-colors shadow-sm"
          >
            {waitingForReturns
              ? '全員のロビー復帰を待っています…'
              : ctx.players.length < 2
              ? '2人以上で開始できます'
              : 'ゲームを開始する'}
          </button>
```

`useState` が他で未使用になる場合は import から外す（`confirmDisband`/`hostOnlyNudge` で使っているため残す）。

- [ ] **Step 4: 型チェック＆ビルドが通るか確認**

Run: `cd client && npm run build`
Expected: PASS（`tsc` 型エラーなし・`vite build` 成功）

- [ ] **Step 5: コミット**

```bash
git add client/src/App.tsx client/src/useGameSocket.ts client/src/screens/LobbyScreen.tsx
git commit -m "$(printf 'feat: 生成中オーバーレイをサーバー駆動化し人数ガードを追加\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: 全体検証

**Files:** なし（検証のみ）

- [ ] **Step 1: サーバー全テスト**

Run: `cd server && npm test`
Expected: PASS（全件 green）

- [ ] **Step 2: クライアント型チェック＆ビルド**

Run: `cd client && npm run build`
Expected: PASS

- [ ] **Step 3: 2タブ目視確認（ユーザー環境）**

server(3001)/client(5173) を起動し、2タブで:
- ホスト＋ゲストで参加 → ジャンル選択 → 開始。**両タブに「AIが台本を執筆中…」オーバーレイ**が出て、その後 casting へ遷移すること。
- ホスト1人で開始ボタンが「2人以上で開始できます」で無効なこと。
- （キー未設定なら）スタブ台本で遷移すること／`.env` にキーを置くと実台本になること。
- 失敗を模擬する場合は一時的に無効キーを設定 → 両タブでオーバーレイが閉じ、ホストにエラートーストが出てロビーに留まること。

---

## Self-Review（記入済み）

- **spec カバレッジ**: イベント契約(§3)→Task1 / roomStore(§4.1)→Task1 / start_game(§4.2)→Task3 / join_room(§4.3)→Task4 / エッジ(§4.4 ホスト切断再確認)→Task3 Step5 / scriptGen(§5)→Task2 / クライアント(§6)→Task5 / テスト(§7)→各Task＋Task6。全項目に対応タスクあり。
- **プレースホルダ**: なし（全コードブロックに実体）。
- **型整合**: `generateScript`/`parseScript`/`__setScriptGeneratorForTest`/`__resetScriptGeneratorForTest`/`generatingScript`/`expectNoEvent`/`GameContext.generating` は定義タスクと利用タスクで名称一致。
- **既存テスト非回帰**: 既存の start_game 系はすべて2人＋genreで通過（genre/人数ガードに抵触しない）。prepare テストは start_game を呼ばない。
