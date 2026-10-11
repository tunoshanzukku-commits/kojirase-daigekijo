# Phase A（サーバー雛形＋ロビー実接続）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2つ以上のブラウザで、ルーム作成→参加→ロビー同期→ジャンル同期→ホスト開始→全員が配役画面へ同時遷移、までを実サーバー（Express+Socket.io）で成立させる。

**Architecture:** リポジトリ直下 `shared/` に client/server 共有の型・定数・Socket.ioイベント型を置き、両方から `@shared/*` エイリアスで直接import（ビルド不要）。`server/` は TypeScript を `tsx` で実行。ルームはインメモリ `Map`。台本生成は Phase A ではスタブ（参加者名から機械生成、Phase C で Claude に差替）。フロントは `socket.ts`（型付きシングルトン）＋ `useGameSocket` フックで App に配線し、Top/Lobby/Casting のモックを実接続へ置換。

**Tech Stack:** TypeScript, React 18 + Vite（既存 client）, Node.js + Express + Socket.io（新規 server）, socket.io-client, node:test + tsx（サーバーテスト）。

## Global Constraints

- 共有型・定数の単一の真実源は `shared/`。client の `types.ts` / `genres.ts` は `@shared/*` の再エクスポートにして既存importを壊さない。
- Socket.io イベント名は仕様書準拠：`create_room` `join_room` `set_genre` `start_game`（C→S）／`room_created` `room_joined` `player_joined` `genre_changed` `script_ready` `player_left` `room_dissolved` `error`（S→C）。
- 入力検証（サーバー側が確定）：playerName は trim＋制御文字除去後 1〜10文字・同室重複不可／roomCode は `I`/`O` 除外 A〜Z の4文字／genre は定義済み8種のみ／join は `status==='waiting'` のみ／満員は10人。
- ルームコードのアルファベット：`ABCDEFGHJKLMNPQRSTUVWXYZ`（A〜Z から I, O を除いた24文字）。`ROOM_CODE_LEN=4` `MAX_PLAYERS=10` `NAME_MAX=10`。
- 開発ポート：server=3001 / Vite=5173。client 接続先は `import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001'`。
- Phase A スコープ外：AI本番（Claude/Whisper）、音声録音・提出、準備/録音/結果の同期、声量・BGM/SFX、SNSシェア、Railwayデプロイ。これらのイベント型・処理は本計画では追加しない。
- サーバーテストは追加の重い依存を入れず `node:test`＋`tsx`。各テストは `npx tsx --test <ファイル>` で個別実行できること。

---

## ファイル構成

**新規（shared/）**
- `shared/types.ts` — `ScriptEntry` `RoleInfo` `ScriptData` `PlayerScore` `RoomStatus` `PlayerSnapshot` `RoomSnapshot`
- `shared/constants.ts` — `Genre` `GENRES` `GENRE_IDS` `genreLabel` `NAME_MAX` `ROOM_CODE_LEN` `MAX_PLAYERS` `ROOM_CODE_ALPHABET`
- `shared/events.ts` — `ClientToServerEvents` `ServerToClientEvents`

**新規（server/）**
- `server/package.json` / `server/tsconfig.json`
- `server/src/server.ts` — `buildServer()`（express+socket.io組立、connectionでregisterHandlers）
- `server/src/index.ts` — 起動エントリ（listen＋cleanupタイマー）
- `server/src/roomCode.ts` — コード生成
- `server/src/validation.ts` — 入力検証
- `server/src/roomStore.ts` — `Room`/`Player` 内部型・インメモリMap・CRUD・cleanup
- `server/src/handlers.ts` — Socket.ioイベント配線
- `server/src/ai/scriptStub.ts` — スタブ台本生成
- `server/src/testUtils.ts` — テスト用サーバー起動/クライアント接続ヘルパー
- テスト：`roomCode.test.ts` `validation.test.ts` `roomStore.test.ts` `ai/scriptStub.test.ts` `handlers.connection.test.ts` `handlers.game.test.ts` `handlers.disconnect.test.ts`

**変更（client/）**
- `client/src/types.ts` / `client/src/genres.ts` — 再エクスポート化
- `client/tsconfig.json` / `client/vite.config.ts` — `@shared` エイリアス
- `client/package.json` — `socket.io-client` 追加
- `client/src/vite-env.d.ts` — 新規（vite/client 型参照）
- `client/src/socket.ts` — 新規（型付きシングルトン）
- `client/src/useGameSocket.ts` — 新規（socket配線フック）
- `client/src/App.tsx` — フック統合・`players` 追加・Toast/解散モーダル
- `client/src/screens/TopScreen.tsx` — create/join emit・エラー表示
- `client/src/screens/LobbyScreen.tsx` — 実players・set_genre・start_game
- `client/src/screens/CastingScreen.tsx` — `ctx.script` を優先表示

---

## Task 1: shared/ 基盤と client 再エクスポート・エイリアス

**Files:**
- Create: `shared/types.ts`, `shared/constants.ts`, `shared/events.ts`
- Modify: `client/src/types.ts`, `client/src/genres.ts`, `client/tsconfig.json`, `client/vite.config.ts`

**Interfaces:**
- Produces: `@shared/types`（`ScriptData` `PlayerScore` `ScriptEntry` `RoleInfo` `RoomStatus` `PlayerSnapshot` `RoomSnapshot`）、`@shared/constants`（`GENRES` `GENRE_IDS` `genreLabel` `NAME_MAX` `ROOM_CODE_LEN` `MAX_PLAYERS` `ROOM_CODE_ALPHABET`）、`@shared/events`（`ClientToServerEvents` `ServerToClientEvents`）。

- [ ] **Step 1: `shared/types.ts` を作成**

```typescript
export interface ScriptEntry {
  player: string
  character: string
  action?: string
  line: string
}

export interface RoleInfo {
  player: string
  role: string
  description: string
}

export interface ScriptData {
  worldSetting: string
  roles: RoleInfo[]
  entries: ScriptEntry[]
}

export interface PlayerScore {
  playerName: string
  acting: number
  emotion: number
  kojirase: number
  comment: string
}

export type RoomStatus =
  | 'waiting'
  | 'casting'
  | 'preparing'
  | 'recording'
  | 'evaluating'
  | 'result'

export interface PlayerSnapshot {
  name: string
  isHost: boolean
  isReady: boolean
}

export interface RoomSnapshot {
  code: string
  status: RoomStatus
  genre: string
  players: PlayerSnapshot[]
  script: ScriptData | null
  scores: PlayerScore[]
}
```

- [ ] **Step 2: `shared/constants.ts` を作成**

```typescript
export interface Genre {
  id: string
  label: string
  emoji: string
}

export const GENRES: Genre[] = [
  { id: 'romance', label: '恋愛ドラマ',   emoji: '💕' },
  { id: 'horror',  label: 'ホラー',       emoji: '👻' },
  { id: 'comedy',  label: 'コメディ',     emoji: '😂' },
  { id: 'jidai',   label: '時代劇',       emoji: '⚔️' },
  { id: 'sf',      label: 'SF・未来',     emoji: '🚀' },
  { id: 'mystery', label: 'ミステリー',   emoji: '🔍' },
  { id: 'emotion', label: '感動・涙活',   emoji: '😢' },
  { id: 'chaos',   label: 'カオスモード', emoji: '🌀' },
]

export const GENRE_IDS: string[] = GENRES.map(g => g.id)

export function genreLabel(id: string): string {
  return GENRES.find(g => g.id === id)?.label ?? ''
}

export const NAME_MAX = 10
export const ROOM_CODE_LEN = 4
export const MAX_PLAYERS = 10
// A〜Z から紛らわしい I, O を除いた24文字
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
```

- [ ] **Step 3: `shared/events.ts` を作成**

```typescript
import type { RoomSnapshot, PlayerSnapshot, ScriptData } from './types'

export interface ClientToServerEvents {
  create_room: (payload: { playerName: string }) => void
  join_room: (payload: { roomCode: string; playerName: string }) => void
  set_genre: (payload: { genre: string }) => void
  start_game: () => void
}

export interface ServerToClientEvents {
  room_created: (payload: { roomCode: string; room: RoomSnapshot }) => void
  room_joined: (payload: { room: RoomSnapshot }) => void
  player_joined: (payload: { player: PlayerSnapshot }) => void
  genre_changed: (payload: { genre: string }) => void
  script_ready: (payload: { script: ScriptData }) => void
  player_left: (payload: { playerName: string }) => void
  room_dissolved: () => void
  error: (payload: { message: string }) => void
}
```

- [ ] **Step 4: `client/src/types.ts` を再エクスポートに置換**

```typescript
export * from '@shared/types'
```

- [ ] **Step 5: `client/src/genres.ts` を再エクスポートに置換**

```typescript
export * from '@shared/constants'
```

- [ ] **Step 6: `client/tsconfig.json` の compilerOptions に baseUrl/paths を追加**

`"jsx": "react-jsx",` の直後に以下を挿入する（`compilerOptions` 内）：

```json
    "baseUrl": ".",
    "paths": { "@shared/*": ["../shared/*"] },
```

- [ ] **Step 7: `client/vite.config.ts` に @shared エイリアスを追加**

ファイル全体を以下に置換：

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
})
```

- [ ] **Step 8: client の型チェックが通ることを確認**

Run: `cd client && npx tsc --noEmit`
Expected: エラー無しで終了（exit code 0）。`@shared/*` が解決され、既存の import が壊れていないこと。

- [ ] **Step 9: Commit**

```bash
git add shared client/src/types.ts client/src/genres.ts client/tsconfig.json client/vite.config.ts
git commit -m "feat: shared/ に共有型・定数・Socket.ioイベント型を追加し client を再エクスポート化"
```

---

## Task 2: server/ 雛形と @shared 解決のスモークテスト

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/server.ts`, `server/src/handlers.ts`, `server/src/index.ts`

**Interfaces:**
- Produces: `buildServer()`（`{ app, httpServer, io }` を返す）、`registerHandlers(io, socket)`（この時点では空）。

- [ ] **Step 1: `server/package.json` を作成**

```json
{
  "name": "ai-shibai-server",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "tsx --test src/roomCode.test.ts src/validation.test.ts src/roomStore.test.ts src/ai/scriptStub.test.ts src/handlers.connection.test.ts src/handlers.game.test.ts src/handlers.disconnect.test.ts"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.0",
    "socket.io": "^4.7.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0",
    "socket.io-client": "^4.7.0",
    "tsx": "^4.7.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: `server/tsconfig.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["../shared/*"] },
    "noEmit": true
  },
  "include": ["src", "../shared"]
}
```

- [ ] **Step 3: `server/src/handlers.ts` をスタブで作成**

```typescript
import type { Server, Socket } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>

export function registerHandlers(_io: IO, _socket: Sock): void {
  // Task 7〜9 で実装
}
```

- [ ] **Step 4: `server/src/server.ts` を作成**

```typescript
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import cors from 'cors'
import { registerHandlers } from './handlers'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'

export function buildServer() {
  const app = express()
  app.use(cors())
  app.get('/health', (_req, res) => res.json({ ok: true }))

  const httpServer = createServer(app)
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  })

  io.on('connection', socket => registerHandlers(io, socket))

  return { app, httpServer, io }
}
```

- [ ] **Step 5: `server/src/index.ts` を作成（@shared 解決のスモーク込み）**

```typescript
import { buildServer } from './server'
import { GENRES } from '@shared/constants'

const { httpServer } = buildServer()
const PORT = Number(process.env.PORT) || 3001

httpServer.listen(PORT, () => {
  console.log(`[server] listening on ${PORT} / genres loaded: ${GENRES.length}`)
})
```

- [ ] **Step 6: 依存をインストール**

Run: `cd server && npm install`
Expected: 正常完了。

- [ ] **Step 7: 起動して @shared 解決とブートを確認**

Run: `cd server && npm start`
Expected: 標準出力に `[server] listening on 3001 / genres loaded: 8`。別ターミナルで `curl http://localhost:3001/health` → `{"ok":true}`。確認後 Ctrl+C で停止。

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "feat: server 雛形（Express+Socket.io）と @shared 解決を追加"
```

---

## Task 3: roomCode 生成（TDD）

**Files:**
- Create: `server/src/roomCode.ts`, `server/src/roomCode.test.ts`

**Interfaces:**
- Produces: `generateRoomCode(): string`、`generateUniqueRoomCode(exists: (code: string) => boolean): string`。

- [ ] **Step 1: 失敗するテストを書く（`server/src/roomCode.test.ts`）**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRoomCode, generateUniqueRoomCode } from './roomCode'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '@shared/constants'

test('generateRoomCode は許可文字のみで ROOM_CODE_LEN 文字', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode()
    assert.equal(code.length, ROOM_CODE_LEN)
    for (const ch of code) {
      assert.ok(ROOM_CODE_ALPHABET.includes(ch), `想定外の文字: ${ch}`)
    }
  }
})

test('generateRoomCode は I と O を含まない', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode()
    assert.ok(!code.includes('I'))
    assert.ok(!code.includes('O'))
  }
})

test('generateUniqueRoomCode は既存コードを避けて再生成する', () => {
  const taken = new Set<string>()
  const first = generateUniqueRoomCode(c => taken.has(c))
  taken.add(first)
  const second = generateUniqueRoomCode(c => taken.has(c))
  assert.notEqual(first, second)
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/roomCode.test.ts`
Expected: FAIL（`./roomCode` が存在しない／export未定義）。

- [ ] **Step 3: `server/src/roomCode.ts` を実装**

```typescript
import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '@shared/constants'

export function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]
  }
  return code
}

export function generateUniqueRoomCode(exists: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = generateRoomCode()
    if (!exists(code)) return code
  }
  throw new Error('ルームコードの生成に失敗しました')
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/roomCode.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/src/roomCode.ts server/src/roomCode.test.ts
git commit -m "feat: ルームコード生成（I/O除外・衝突回避）"
```

---

## Task 4: 入力検証（TDD）

**Files:**
- Create: `server/src/validation.ts`, `server/src/validation.test.ts`

**Interfaces:**
- Produces: `sanitizeName(raw: string): string`、`isValidName(name: string): boolean`、`normalizeRoomCode(raw: string): string`、`isValidRoomCode(code: string): boolean`、`isValidGenre(genre: string): boolean`。

- [ ] **Step 1: 失敗するテストを書く（`server/src/validation.test.ts`）**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeName, isValidName, normalizeRoomCode, isValidRoomCode, isValidGenre,
} from './validation'

test('sanitizeName は前後空白除去と制御文字除去を行う', () => {
  assert.equal(sanitizeName('  たろう  '), 'たろう')
  const dirty = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(10) + 'c'
  assert.equal(sanitizeName(dirty), 'abc')
})

test('isValidName は 1〜10 文字を許可', () => {
  assert.equal(isValidName(''), false)
  assert.equal(isValidName('a'), true)
  assert.equal(isValidName('あ'.repeat(10)), true)
  assert.equal(isValidName('あ'.repeat(11)), false)
})

test('normalizeRoomCode は大文字化・不正文字除去・4文字上限', () => {
  assert.equal(normalizeRoomCode('ab-cd'), 'ABCD')
  assert.equal(normalizeRoomCode('abcde'), 'ABCD')
  assert.equal(normalizeRoomCode('a1o9i!'), 'A') // 数字/記号除去・I,O除外
})

test('isValidRoomCode は許可文字4文字のみ true', () => {
  assert.equal(isValidRoomCode('ABCD'), true)
  assert.equal(isValidRoomCode('ABC'), false)
  assert.equal(isValidRoomCode('ABIO'), false)
})

test('isValidGenre は定義済みジャンルのみ true', () => {
  assert.equal(isValidGenre('romance'), true)
  assert.equal(isValidGenre('chaos'), true)
  assert.equal(isValidGenre('unknown'), false)
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/validation.test.ts`
Expected: FAIL（`./validation` 未定義）。

- [ ] **Step 3: `server/src/validation.ts` を実装**

```typescript
import { NAME_MAX, GENRE_IDS, ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '@shared/constants'

const ALLOWED = new Set(ROOM_CODE_ALPHABET.split(''))

function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f
}

export function sanitizeName(raw: string): string {
  let out = ''
  for (const ch of raw) {
    if (!isControlChar(ch.codePointAt(0) ?? 0)) out += ch
  }
  return out.trim()
}

export function isValidName(name: string): boolean {
  return name.length >= 1 && name.length <= NAME_MAX
}

export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter(c => ALLOWED.has(c))
    .join('')
    .slice(0, ROOM_CODE_LEN)
}

export function isValidRoomCode(code: string): boolean {
  return code.length === ROOM_CODE_LEN && code.split('').every(c => ALLOWED.has(c))
}

export function isValidGenre(genre: string): boolean {
  return GENRE_IDS.includes(genre)
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/validation.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/src/validation.ts server/src/validation.test.ts
git commit -m "feat: 入力検証（name/roomCode/genre）"
```

---

## Task 5: roomStore（TDD）

**Files:**
- Create: `server/src/roomStore.ts`, `server/src/roomStore.test.ts`

**Interfaces:**
- Consumes: `generateUniqueRoomCode`（roomCode.ts）、`RoomStatus` `RoomSnapshot`（@shared/types）。
- Produces: 内部型 `Player { socketId; name; isHost; isReady }`、`Room { code; status; genre; script; scores; players: Map<string, Player>; hostSocketId; createdAt; lastActivityAt }`。関数：`createRoom(hostSocketId, name): Room`、`getRoom(code): Room | undefined`、`roomExists(code): boolean`、`addPlayer(room, socketId, name, isHost): Player`、`hasPlayerName(room, name): boolean`、`findRoomBySocket(socketId): Room | undefined`、`removePlayer(room, socketId): Player | undefined`、`deleteRoom(code): void`、`toSnapshot(room): RoomSnapshot`、`touch(room): void`、`cleanupRooms(now, maxIdleMs): string[]`、`_clearAllRooms(): void`。

- [ ] **Step 1: 失敗するテストを書く（`server/src/roomStore.test.ts`）**

```typescript
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRoom, roomExists, addPlayer, hasPlayerName, toSnapshot,
  findRoomBySocket, removePlayer, cleanupRooms, _clearAllRooms,
} from './roomStore'

beforeEach(() => _clearAllRooms())

test('createRoom はホストを先頭プレイヤーにした waiting ルームを登録', () => {
  const room = createRoom('sock-host', 'たろう')
  assert.equal(room.status, 'waiting')
  assert.equal(room.hostSocketId, 'sock-host')
  assert.ok(roomExists(room.code))
  const snap = toSnapshot(room)
  assert.equal(snap.players.length, 1)
  assert.deepEqual(snap.players[0], { name: 'たろう', isHost: true, isReady: false })
})

test('addPlayer / hasPlayerName でゲストを追跡', () => {
  const room = createRoom('sock-host', 'たろう')
  addPlayer(room, 'sock-g1', 'はなこ', false)
  assert.equal(hasPlayerName(room, 'はなこ'), true)
  assert.equal(hasPlayerName(room, 'けんじ'), false)
  assert.equal(toSnapshot(room).players.length, 2)
})

test('removePlayer は socketId で削除し findRoomBySocket は部屋を特定', () => {
  const room = createRoom('sock-host', 'たろう')
  addPlayer(room, 'sock-g1', 'はなこ', false)
  assert.equal(findRoomBySocket('sock-g1')?.code, room.code)
  const removed = removePlayer(room, 'sock-g1')
  assert.equal(removed?.name, 'はなこ')
  assert.equal(findRoomBySocket('sock-g1'), undefined)
})

test('cleanupRooms は空ルーム・アイドルルームを削除', () => {
  const empty = createRoom('sock-a', 'A')
  removePlayer(empty, 'sock-a')
  const idle = createRoom('sock-b', 'B')
  idle.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000
  const fresh = createRoom('sock-c', 'C')
  const deleted = cleanupRooms(Date.now(), 60 * 60 * 1000)
  assert.ok(deleted.includes(empty.code))
  assert.ok(deleted.includes(idle.code))
  assert.ok(!deleted.includes(fresh.code))
  assert.ok(roomExists(fresh.code))
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL（`./roomStore` 未定義）。

- [ ] **Step 3: `server/src/roomStore.ts` を実装**

```typescript
import type { RoomStatus, RoomSnapshot, ScriptData, PlayerScore } from '@shared/types'
import { generateUniqueRoomCode } from './roomCode'

export interface Player {
  socketId: string
  name: string
  isHost: boolean
  isReady: boolean
}

export interface Room {
  code: string
  status: RoomStatus
  genre: string
  script: ScriptData | null
  scores: PlayerScore[]
  players: Map<string, Player>
  hostSocketId: string
  createdAt: number
  lastActivityAt: number
}

const rooms = new Map<string, Room>()

export function roomExists(code: string): boolean {
  return rooms.has(code)
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code)
}

export function addPlayer(room: Room, socketId: string, name: string, isHost: boolean): Player {
  const player: Player = { socketId, name, isHost, isReady: false }
  room.players.set(socketId, player)
  return player
}

export function createRoom(hostSocketId: string, name: string): Room {
  const code = generateUniqueRoomCode(roomExists)
  const now = Date.now()
  const room: Room = {
    code,
    status: 'waiting',
    genre: '',
    script: null,
    scores: [],
    players: new Map(),
    hostSocketId,
    createdAt: now,
    lastActivityAt: now,
  }
  addPlayer(room, hostSocketId, name, true)
  rooms.set(code, room)
  return room
}

export function hasPlayerName(room: Room, name: string): boolean {
  for (const p of room.players.values()) {
    if (p.name === name) return true
  }
  return false
}

export function findRoomBySocket(socketId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room
  }
  return undefined
}

export function removePlayer(room: Room, socketId: string): Player | undefined {
  const player = room.players.get(socketId)
  if (player) room.players.delete(socketId)
  return player
}

export function deleteRoom(code: string): void {
  rooms.delete(code)
}

export function touch(room: Room): void {
  room.lastActivityAt = Date.now()
}

export function toSnapshot(room: Room): RoomSnapshot {
  return {
    code: room.code,
    status: room.status,
    genre: room.genre,
    players: [...room.players.values()].map(p => ({
      name: p.name,
      isHost: p.isHost,
      isReady: p.isReady,
    })),
    script: room.script,
    scores: room.scores,
  }
}

export function cleanupRooms(now: number, maxIdleMs: number): string[] {
  const deleted: string[] = []
  for (const [code, room] of rooms) {
    if (room.players.size === 0 || now - room.lastActivityAt > maxIdleMs) {
      rooms.delete(code)
      deleted.push(code)
    }
  }
  return deleted
}

export function _clearAllRooms(): void {
  rooms.clear()
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "feat: インメモリ roomStore（CRUD・snapshot・cleanup）"
```

---

## Task 6: スタブ台本生成（TDD）

**Files:**
- Create: `server/src/ai/scriptStub.ts`, `server/src/ai/scriptStub.test.ts`

**Interfaces:**
- Consumes: `ScriptData` `RoleInfo` `ScriptEntry`（@shared/types）、`genreLabel`（@shared/constants）。
- Produces: `generateStubScript(genre: string, playerNames: string[]): ScriptData`。

- [ ] **Step 1: 失敗するテストを書く（`server/src/ai/scriptStub.test.ts`）**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateStubScript } from './scriptStub'

test('generateStubScript は全プレイヤー分の役とセリフを生成', () => {
  const names = ['たろう', 'はなこ', 'けんじ']
  const script = generateStubScript('jidai', names)
  assert.equal(script.roles.length, 3)
  assert.deepEqual(script.roles.map(r => r.player), names)
  assert.ok(script.entries.length >= names.length)
  for (const entry of script.entries) {
    assert.ok(names.includes(entry.player), `未知のプレイヤー: ${entry.player}`)
  }
  assert.ok(script.worldSetting.length > 0)
})

test('generateStubScript は未知ジャンルでも生成できる', () => {
  const script = generateStubScript('', ['A'])
  assert.ok(script.worldSetting.length > 0)
  assert.equal(script.roles.length, 1)
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/ai/scriptStub.test.ts`
Expected: FAIL（`./scriptStub` 未定義）。

- [ ] **Step 3: `server/src/ai/scriptStub.ts` を実装**

```typescript
import type { ScriptData, RoleInfo, ScriptEntry } from '@shared/types'
import { genreLabel } from '@shared/constants'

export function generateStubScript(genre: string, playerNames: string[]): ScriptData {
  const label = genreLabel(genre) || '即興劇'

  const roles: RoleInfo[] = playerNames.map((name, i) => ({
    player: name,
    role: `${label}の登場人物${i + 1}`,
    description: `${name} が演じる、${label}の世界の登場人物です。（スタブ）`,
  }))

  const entries: ScriptEntry[] = playerNames.map((name, i) => ({
    player: name,
    character: `${label}の登場人物${i + 1}`,
    action: i === 0 ? '幕が上がる' : undefined,
    line: `わたしは${name}。ここは${label}の世界だ。（スタブのセリフ）`,
  }))

  return {
    worldSetting: `これは「${label}」ジャンルのスタブ台本です。本番では Claude API が生成します。`,
    roles,
    entries,
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/ai/scriptStub.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/scriptStub.ts server/src/ai/scriptStub.test.ts
git commit -m "feat: スタブ台本生成（参加者名から機械生成）"
```

---

## Task 7: handlers — create_room / join_room（統合テスト）

**Files:**
- Create: `server/src/testUtils.ts`, `server/src/handlers.connection.test.ts`
- Modify: `server/src/handlers.ts`

**Interfaces:**
- Consumes: `buildServer`（server.ts）、roomStore/validation/scriptStub の各関数、`MAX_PLAYERS` `NAME_MAX`（@shared/constants）。
- Produces: `startTestServer()`、`connectClient(port)`、`once(socket, event)`（testUtils）。`registerHandlers` に `create_room` `join_room` を実装。

- [ ] **Step 1: `server/src/testUtils.ts` を作成**

```typescript
import type { AddressInfo } from 'node:net'
import { io as ClientIO, type Socket } from 'socket.io-client'
import { buildServer } from './server'

export async function startTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const { httpServer } = buildServer()
  await new Promise<void>(resolve => httpServer.listen(0, resolve))
  const port = (httpServer.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>(resolve => httpServer.close(() => resolve())),
  }
}

export function connectClient(port: number): Socket {
  return ClientIO(`http://localhost:${port}`, { forceNew: true, transports: ['websocket'] })
}

export function once<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise<T>(resolve => socket.once(event, (payload: T) => resolve(payload)))
}
```

- [ ] **Step 2: 失敗するテストを書く（`server/src/handlers.connection.test.ts`）**

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once } from './testUtils'
import { _clearAllRooms } from './roomStore'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

test('create_room は room_created とスナップショットを返す', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode, room } = await once<{ roomCode: string; room: { players: any[] } }>(host, 'room_created')
  assert.equal(roomCode.length, 4)
  assert.equal(room.players.length, 1)
  assert.equal(room.players[0].name, 'たろう')
  assert.equal(room.players[0].isHost, true)
  host.disconnect()
})

test('create_room は空の名前を error で拒否', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: '   ' })
  const err = await once<{ message: string }>(host, 'error')
  assert.match(err.message, /名前/)
  host.disconnect()
})

test('join_room はゲストを追加しホストへ player_joined 通知', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')

  const guest = connectClient(server.port)
  const joined = once<{ room: { players: any[] } }>(guest, 'room_joined')
  const notified = once<{ player: { name: string } }>(host, 'player_joined')
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })

  const { room } = await joined
  const { player } = await notified
  assert.equal(room.players.length, 2)
  assert.equal(player.name, 'はなこ')
  host.disconnect(); guest.disconnect()
})

test('join_room は未知コードを error で拒否', async () => {
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode: 'ZZZZ', playerName: 'はなこ' })
  const err = await once<{ message: string }>(guest, 'error')
  assert.match(err.message, /見つかりません/)
  guest.disconnect()
})

test('join_room は重複名を error で拒否', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'たろう' })
  const err = await once<{ message: string }>(guest, 'error')
  assert.match(err.message, /使われています/)
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/handlers.connection.test.ts`
Expected: FAIL（ハンドラ未実装のため `room_created` 等が返らずタイムアウト/未定義）。

- [ ] **Step 4: `server/src/handlers.ts` に create_room / join_room を実装（ファイル全体を置換）**

```typescript
import type { Server, Socket } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { NAME_MAX, MAX_PLAYERS } from '@shared/constants'
import {
  sanitizeName, isValidName, normalizeRoomCode, isValidRoomCode,
} from './validation'
import {
  createRoom, getRoom, addPlayer, hasPlayerName, toSnapshot, touch,
} from './roomStore'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>

export function registerHandlers(_io: IO, socket: Sock): void {
  socket.on('create_room', ({ playerName }) => {
    const name = sanitizeName(playerName ?? '')
    if (!isValidName(name)) {
      socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
      return
    }
    const room = createRoom(socket.id, name)
    socket.join(room.code)
    socket.emit('room_created', { roomCode: room.code, room: toSnapshot(room) })
  })

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = normalizeRoomCode(roomCode ?? '')
    if (!isValidRoomCode(code)) {
      socket.emit('error', { message: 'ルームが見つかりません' })
      return
    }
    const room = getRoom(code)
    if (!room) {
      socket.emit('error', { message: 'ルームが見つかりません' })
      return
    }
    if (room.status !== 'waiting') {
      socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
      return
    }
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('error', { message: '満員です' })
      return
    }
    const name = sanitizeName(playerName ?? '')
    if (!isValidName(name)) {
      socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
      return
    }
    if (hasPlayerName(room, name)) {
      socket.emit('error', { message: 'その名前は使われています' })
      return
    }
    const player = addPlayer(room, socket.id, name, false)
    touch(room)
    socket.join(room.code)
    socket.emit('room_joined', { room: toSnapshot(room) })
    socket.to(room.code).emit('player_joined', {
      player: { name: player.name, isHost: player.isHost, isReady: player.isReady },
    })
  })
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.connection.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 6: Commit**

```bash
git add server/src/testUtils.ts server/src/handlers.ts server/src/handlers.connection.test.ts
git commit -m "feat: create_room / join_room ハンドラと統合テスト基盤"
```

---

## Task 8: handlers — set_genre / start_game（統合テスト）

**Files:**
- Create: `server/src/handlers.game.test.ts`
- Modify: `server/src/handlers.ts`

**Interfaces:**
- Consumes: `findRoomBySocket`（roomStore）、`isValidGenre`（validation）、`generateStubScript`（scriptStub）、`io`（ブロードキャスト用）。
- Produces: `registerHandlers` に `set_genre` `start_game` を追加。

- [ ] **Step 1: 失敗するテストを書く（`server/src/handlers.game.test.ts`）**

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once } from './testUtils'
import { _clearAllRooms } from './roomStore'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

async function createRoomWithHost() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  return { host, roomCode }
}

test('set_genre（ホスト）は全員へ genre_changed をブロードキャスト', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')

  const guestGenre = once<{ genre: string }>(guest, 'genre_changed')
  host.emit('set_genre', { genre: 'horror' })
  const { genre } = await guestGenre
  assert.equal(genre, 'horror')
  host.disconnect(); guest.disconnect()
})

test('set_genre は無効ジャンルを error で拒否しブロードキャストしない', async () => {
  const { host } = await createRoomWithHost()
  host.emit('set_genre', { genre: 'not-a-genre' })
  const err = await once<{ message: string }>(host, 'error')
  assert.match(err.message, /ジャンル/)
  host.disconnect()
})

test('start_game は全プレイヤー分の台本で script_ready をブロードキャスト', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'jidai' })
  await once(guest, 'genre_changed')

  const guestScript = once<{ script: { roles: { player: string }[] } }>(guest, 'script_ready')
  host.emit('start_game')
  const { script } = await guestScript
  assert.equal(script.roles.length, 2)
  const players = script.roles.map(r => r.player).sort()
  assert.deepEqual(players, ['たろう', 'はなこ'].sort())
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/handlers.game.test.ts`
Expected: FAIL（`set_genre`/`start_game` 未実装）。

- [ ] **Step 3: `server/src/handlers.ts` に set_genre / start_game を追加（ファイル全体を置換）**

```typescript
import type { Server, Socket } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { NAME_MAX, MAX_PLAYERS } from '@shared/constants'
import {
  sanitizeName, isValidName, normalizeRoomCode, isValidRoomCode, isValidGenre,
} from './validation'
import {
  createRoom, getRoom, addPlayer, hasPlayerName, toSnapshot, touch, findRoomBySocket,
} from './roomStore'
import { generateStubScript } from './ai/scriptStub'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>

export function registerHandlers(io: IO, socket: Sock): void {
  socket.on('create_room', ({ playerName }) => {
    const name = sanitizeName(playerName ?? '')
    if (!isValidName(name)) {
      socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
      return
    }
    const room = createRoom(socket.id, name)
    socket.join(room.code)
    socket.emit('room_created', { roomCode: room.code, room: toSnapshot(room) })
  })

  socket.on('join_room', ({ roomCode, playerName }) => {
    const code = normalizeRoomCode(roomCode ?? '')
    if (!isValidRoomCode(code)) {
      socket.emit('error', { message: 'ルームが見つかりません' })
      return
    }
    const room = getRoom(code)
    if (!room) {
      socket.emit('error', { message: 'ルームが見つかりません' })
      return
    }
    if (room.status !== 'waiting') {
      socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
      return
    }
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('error', { message: '満員です' })
      return
    }
    const name = sanitizeName(playerName ?? '')
    if (!isValidName(name)) {
      socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
      return
    }
    if (hasPlayerName(room, name)) {
      socket.emit('error', { message: 'その名前は使われています' })
      return
    }
    const player = addPlayer(room, socket.id, name, false)
    touch(room)
    socket.join(room.code)
    socket.emit('room_joined', { room: toSnapshot(room) })
    socket.to(room.code).emit('player_joined', {
      player: { name: player.name, isHost: player.isHost, isReady: player.isReady },
    })
  })

  socket.on('set_genre', ({ genre }) => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id) return
    if (!isValidGenre(genre)) {
      socket.emit('error', { message: '無効なジャンルです' })
      return
    }
    room.genre = genre
    touch(room)
    io.to(room.code).emit('genre_changed', { genre })
  })

  socket.on('start_game', () => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.hostSocketId !== socket.id) return
    const names = [...room.players.values()].map(p => p.name)
    try {
      const script = generateStubScript(room.genre, names)
      room.script = script
      room.status = 'casting'
      touch(room)
      io.to(room.code).emit('script_ready', { script })
    } catch {
      socket.emit('error', { message: '台本の生成に失敗しました' })
    }
  })
}
```

- [ ] **Step 4: 全サーバーテストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.game.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add server/src/handlers.ts server/src/handlers.game.test.ts
git commit -m "feat: set_genre / start_game ハンドラ（ジャンル同期・スタブ台本配信）"
```

---

## Task 9: handlers — disconnect と cleanup タイマー

**Files:**
- Create: `server/src/handlers.disconnect.test.ts`
- Modify: `server/src/handlers.ts`, `server/src/index.ts`

**Interfaces:**
- Consumes: `removePlayer` `deleteRoom` `findRoomBySocket` `cleanupRooms`（roomStore）。
- Produces: `registerHandlers` に `disconnect` を追加。index.ts に cleanup 定期実行を追加。

- [ ] **Step 1: 失敗するテストを書く（`server/src/handlers.disconnect.test.ts`）**

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once } from './testUtils'
import { _clearAllRooms, roomExists } from './roomStore'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  _clearAllRooms()
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

test('ゲスト切断はホストへ player_left を通知', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(host, 'player_joined')

  const left = once<{ playerName: string }>(host, 'player_left')
  guest.disconnect()
  const { playerName } = await left
  assert.equal(playerName, 'はなこ')
  host.disconnect()
})

test('ホスト切断はゲストへ room_dissolved を通知しルーム削除', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')

  const dissolved = once(guest, 'room_dissolved')
  host.disconnect()
  await dissolved
  assert.equal(roomExists(roomCode), false)
  guest.disconnect()
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/handlers.disconnect.test.ts`
Expected: FAIL（`disconnect` 未実装のため通知が来ずタイムアウト）。

- [ ] **Step 3: `server/src/handlers.ts` の import と末尾に disconnect を追加**

`roomStore` からの import 行を以下に置換（`removePlayer` `deleteRoom` を追加）：

```typescript
import {
  createRoom, getRoom, addPlayer, hasPlayerName, toSnapshot, touch, findRoomBySocket,
  removePlayer, deleteRoom,
} from './roomStore'
```

`start_game` ハンドラの閉じ `})` の後、`registerHandlers` 関数の閉じ `}` の前に、以下を追加：

```typescript
  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id)
    if (!room) return
    const player = removePlayer(room, socket.id)
    if (!player) return
    if (player.isHost) {
      socket.to(room.code).emit('room_dissolved')
      deleteRoom(room.code)
    } else {
      socket.to(room.code).emit('player_left', { playerName: player.name })
      if (room.players.size === 0) {
        deleteRoom(room.code)
      } else {
        touch(room)
      }
    }
  })
```

- [ ] **Step 4: `server/src/index.ts` に cleanup 定期実行を追加（ファイル全体を置換）**

```typescript
import { buildServer } from './server'
import { cleanupRooms } from './roomStore'
import { GENRES } from '@shared/constants'

const { httpServer } = buildServer()
const PORT = Number(process.env.PORT) || 3001
const ONE_HOUR = 60 * 60 * 1000
const CLEANUP_INTERVAL = 5 * 60 * 1000

setInterval(() => {
  const deleted = cleanupRooms(Date.now(), ONE_HOUR)
  if (deleted.length > 0) console.log(`[server] cleaned up rooms: ${deleted.join(', ')}`)
}, CLEANUP_INTERVAL)

httpServer.listen(PORT, () => {
  console.log(`[server] listening on ${PORT} / genres loaded: ${GENRES.length}`)
})
```

- [ ] **Step 5: 切断テストと全テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.disconnect.test.ts`
Expected: PASS（2 tests）。

Run: `cd server && npm test`
Expected: 全ファイル PASS（roomCode 3 / validation 5 / roomStore 4 / scriptStub 2 / connection 5 / game 3 / disconnect 2）。

- [ ] **Step 6: Commit**

```bash
git add server/src/handlers.ts server/src/index.ts server/src/handlers.disconnect.test.ts
git commit -m "feat: 切断処理（ホスト解散/ゲスト退出）と cleanup 定期実行"
```

---

## Task 10: client socket・useGameSocket・App 統合

**Files:**
- Create: `client/src/socket.ts`, `client/src/useGameSocket.ts`, `client/src/vite-env.d.ts`
- Modify: `client/src/App.tsx`, `client/package.json`

**Interfaces:**
- Consumes: `@shared/events`、`@shared/types`、`components/Toast`（`ToastStack` default, `ToastMessage`）。
- Produces: `socket`（型付きシングルトン）、`useGameSocket(params): GameActions`、`GameActions { createRoom; joinRoom; setGenre; startGame; leaveRoom }`。`GameContext` に `players: PlayerSnapshot[]` を追加。

- [ ] **Step 1: `client/package.json` に socket.io-client を追加**

`"dependencies"` を以下に置換：

```json
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "socket.io-client": "^4.7.0"
  },
```

- [ ] **Step 2: 依存をインストール**

Run: `cd client && npm install`
Expected: 正常完了。

- [ ] **Step 3: `client/src/vite-env.d.ts` を作成**

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 4: `client/src/socket.ts` を作成**

```typescript
import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'

const URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://localhost:3001'

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(URL, {
  autoConnect: false,
})
```

- [ ] **Step 5: `client/src/useGameSocket.ts` を作成**

```typescript
import { useEffect } from 'react'
import { socket } from './socket'
import type { Screen, GameContext } from './App'
import type { RoomSnapshot, PlayerSnapshot, ScriptData } from './types'

interface Params {
  setCtx: React.Dispatch<React.SetStateAction<GameContext>>
  setScreen: (s: Screen) => void
  setError: (msg: string) => void
  pushToast: (text: string, tone?: 'error' | 'info') => void
  setDissolved: (v: boolean) => void
}

export interface GameActions {
  createRoom: (playerName: string) => void
  joinRoom: (roomCode: string, playerName: string) => void
  setGenre: (genre: string) => void
  startGame: () => void
  leaveRoom: () => void
}

export function useGameSocket({ setCtx, setScreen, setError, pushToast, setDissolved }: Params): GameActions {
  useEffect(() => {
    function onRoomCreated({ roomCode, room }: { roomCode: string; room: RoomSnapshot }) {
      setError('')
      setCtx(prev => ({
        ...prev, roomCode, isHost: true,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores,
      }))
      setScreen('lobby')
    }
    function onRoomJoined({ room }: { room: RoomSnapshot }) {
      setError('')
      setCtx(prev => ({
        ...prev, roomCode: room.code, isHost: false,
        genre: room.genre, players: room.players, script: room.script, scores: room.scores,
      }))
      setScreen('lobby')
    }
    function onPlayerJoined({ player }: { player: PlayerSnapshot }) {
      setCtx(prev => ({ ...prev, players: [...prev.players, player] }))
    }
    function onPlayerLeft({ playerName }: { playerName: string }) {
      setCtx(prev => ({ ...prev, players: prev.players.filter(p => p.name !== playerName) }))
      pushToast(`${playerName} が退出しました`, 'info')
    }
    function onGenreChanged({ genre }: { genre: string }) {
      setCtx(prev => ({ ...prev, genre }))
    }
    function onScriptReady({ script }: { script: ScriptData }) {
      setCtx(prev => ({ ...prev, script }))
      setScreen('casting')
    }
    function onDissolved() {
      setDissolved(true)
    }
    function onError({ message }: { message: string }) {
      setError(message)
    }

    socket.on('room_created', onRoomCreated)
    socket.on('room_joined', onRoomJoined)
    socket.on('player_joined', onPlayerJoined)
    socket.on('player_left', onPlayerLeft)
    socket.on('genre_changed', onGenreChanged)
    socket.on('script_ready', onScriptReady)
    socket.on('room_dissolved', onDissolved)
    socket.on('error', onError)

    return () => {
      socket.off('room_created', onRoomCreated)
      socket.off('room_joined', onRoomJoined)
      socket.off('player_joined', onPlayerJoined)
      socket.off('player_left', onPlayerLeft)
      socket.off('genre_changed', onGenreChanged)
      socket.off('script_ready', onScriptReady)
      socket.off('room_dissolved', onDissolved)
      socket.off('error', onError)
    }
  }, [setCtx, setScreen, setError, pushToast, setDissolved])

  return {
    createRoom(playerName) {
      if (!socket.connected) socket.connect()
      socket.emit('create_room', { playerName })
    },
    joinRoom(roomCode, playerName) {
      if (!socket.connected) socket.connect()
      socket.emit('join_room', { roomCode, playerName })
    },
    setGenre(genre) {
      socket.emit('set_genre', { genre })
    },
    startGame() {
      socket.emit('start_game')
    },
    leaveRoom() {
      socket.disconnect()
    },
  }
}
```

- [ ] **Step 6: `client/src/App.tsx` を置換**

```typescript
import { useState, useCallback } from 'react'
import TopScreen from './screens/TopScreen'
import LobbyScreen from './screens/LobbyScreen'
import CastingScreen from './screens/CastingScreen'
import PrepareScreen from './screens/PrepareScreen'
import RecordingScreen from './screens/RecordingScreen'
import EvaluatingScreen from './screens/EvaluatingScreen'
import ResultScreen from './screens/ResultScreen'
import ToastStack, { type ToastMessage } from './components/Toast'
import { GENRE_BG, DEFAULT_BG } from './genreStyles'
import { useGameSocket } from './useGameSocket'
import { socket } from './socket'
import type { ScriptData, PlayerScore, PlayerSnapshot } from './types'

export type Screen =
  | 'top'
  | 'lobby'
  | 'casting'
  | 'prepare'
  | 'recording'
  | 'evaluating'
  | 'result'

export interface GameContext {
  playerName: string
  isHost: boolean
  roomCode: string
  genre: string
  fromResult?: boolean
  players: PlayerSnapshot[]
  script: ScriptData | null
  scores: PlayerScore[]
}

export type NavigateFn = (screen: Screen, updates?: Partial<GameContext>) => void

const INITIAL_CTX: GameContext = {
  playerName: '',
  isHost: false,
  roomCode: '',
  genre: '',
  players: [],
  script: null,
  scores: [],
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('top')
  const [ctx, setCtx] = useState<GameContext>(INITIAL_CTX)
  const [error, setError] = useState('')
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [dissolved, setDissolved] = useState(false)

  const pushToast = useCallback((text: string, tone: 'error' | 'info' = 'info') => {
    setToasts(prev => [...prev, { id: Date.now() + Math.random(), text, tone }])
  }, [])
  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const actions = useGameSocket({ setCtx, setScreen, setError, pushToast, setDissolved })

  const navigate: NavigateFn = (nextScreen, updates) => {
    if (updates) setCtx(prev => ({ ...prev, ...updates }))
    setScreen(nextScreen)
  }

  const resetToTop = () => {
    if (socket.connected) socket.disconnect()
    setCtx(INITIAL_CTX)
    setError('')
    setDissolved(false)
    setScreen('top')
  }

  const bg = ctx.genre ? (GENRE_BG[ctx.genre] ?? DEFAULT_BG) : DEFAULT_BG

  return (
    <div className={`min-h-screen ${bg} text-slate-900 transition-colors duration-700`}>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {dissolved && (
        <div className="fixed inset-0 z-[60] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 shadow-lg border border-sky-100 text-center max-w-xs w-full">
            <div className="text-4xl mb-3">🚪</div>
            <p className="font-bold text-slate-900 mb-4">ホストが退出したためルームが解散されました</p>
            <button
              onClick={resetToTop}
              className="w-full py-3 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-xl transition-colors"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {screen === 'top'        && <TopScreen actions={actions} error={error} onClearError={() => setError('')} />}
      {screen === 'lobby'      && <LobbyScreen ctx={ctx} actions={actions} onNavigate={navigate} onLeave={resetToTop} />}
      {screen === 'casting'    && <CastingScreen ctx={ctx} onNavigate={navigate} />}
      {screen === 'prepare'    && <PrepareScreen ctx={ctx} onNavigate={navigate} />}
      {screen === 'recording'  && <RecordingScreen ctx={ctx} onNavigate={navigate} />}
      {screen === 'evaluating' && <EvaluatingScreen onNavigate={navigate} />}
      {screen === 'result'     && <ResultScreen ctx={ctx} onNavigate={navigate} />}
    </div>
  )
}
```

- [ ] **Step 7: 型チェック（この時点で Top/Lobby のprops不一致エラーが出る想定）**

Run: `cd client && npx tsc --noEmit`
Expected: `TopScreen`/`LobbyScreen` の props 不一致エラーのみ（Task 11・12 で解消）。`socket.ts` `useGameSocket.ts` `App.tsx` `@shared` 解決自体のエラーが無いことを確認する。

- [ ] **Step 8: Commit**

```bash
git add client/package.json client/src/socket.ts client/src/useGameSocket.ts client/src/vite-env.d.ts client/src/App.tsx
git commit -m "feat: client に socket シングルトンと useGameSocket 配線・App統合"
```

---

## Task 11: TopScreen を実接続化

**Files:**
- Modify: `client/src/screens/TopScreen.tsx`

**Interfaces:**
- Consumes: `GameActions`（useGameSocket）。
- Produces: props `{ actions: GameActions; error: string; onClearError: () => void }`。

- [ ] **Step 1: `client/src/screens/TopScreen.tsx` を置換**

```typescript
import { useState } from 'react'
import type { GameActions } from '../useGameSocket'

interface Props {
  actions: GameActions
  error: string
  onClearError: () => void
}

type Mode = 'select' | 'create' | 'join'

export default function TopScreen({ actions, error, onClearError }: Props) {
  const [mode, setMode] = useState<Mode>('select')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  const switchMode = (m: Mode) => {
    onClearError()
    setMode(m)
  }

  const handleCreate = () => {
    if (!name.trim()) return
    actions.createRoom(name.trim())
  }

  const handleJoin = () => {
    if (!name.trim() || code.length !== 4) return
    actions.joinRoom(code, name.trim())
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <div className="text-7xl mb-4">🎭</div>
          <h1 className="text-4xl font-bold mb-2 text-slate-900">AI×芝居</h1>
          <p className="text-sky-600 text-sm">みんなで即興演劇を楽しもう！</p>
        </div>

        {mode === 'select' && (
          <div className="space-y-3">
            <button
              onClick={() => switchMode('create')}
              className="w-full py-4 bg-purple-600 hover:bg-purple-500 text-white font-bold text-lg rounded-2xl transition-colors shadow-sm"
            >
              ルームを作る（ホスト）
            </button>
            <button
              onClick={() => switchMode('join')}
              className="w-full py-4 bg-white hover:bg-sky-50 text-slate-700 font-bold text-lg rounded-2xl transition-colors shadow-sm border border-sky-200"
            >
              ルームに参加する
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="bg-white/80 backdrop-blur rounded-2xl p-6 space-y-4 shadow-sm border border-sky-100">
            <h2 className="font-bold text-xl text-slate-900">ルームを作る</h2>
            <input
              type="text"
              placeholder="あなたの名前（10文字まで）"
              maxLength={10}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              className="w-full p-3 bg-sky-50 text-slate-900 rounded-xl outline-none focus:ring-2 focus:ring-purple-400 placeholder-slate-400 border border-sky-200"
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim()}
              className="w-full py-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold rounded-xl transition-colors"
            >
              作成する
            </button>
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={() => switchMode('select')} className="w-full text-slate-400 text-sm py-1">
              ← 戻る
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="bg-white/80 backdrop-blur rounded-2xl p-6 space-y-4 shadow-sm border border-sky-100">
            <h2 className="font-bold text-xl text-slate-900">ルームに参加する</h2>
            <input
              type="text"
              placeholder="あなたの名前（10文字まで）"
              maxLength={10}
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full p-3 bg-sky-50 text-slate-900 rounded-xl outline-none focus:ring-2 focus:ring-purple-400 placeholder-slate-400 border border-sky-200"
            />
            <input
              type="text"
              placeholder="ABCD"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              className="w-full p-3 bg-sky-50 text-slate-900 rounded-xl outline-none focus:ring-2 focus:ring-purple-400 placeholder-slate-400 border border-sky-200 tracking-[0.4em] text-center text-2xl font-bold"
            />
            <button
              onClick={handleJoin}
              disabled={!name.trim() || code.length !== 4}
              className="w-full py-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold rounded-xl transition-colors"
            >
              参加する
            </button>
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button onClick={() => switchMode('select')} className="w-full text-slate-400 text-sm py-1">
              ← 戻る
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 型チェック（Top のエラーが解消されること）**

Run: `cd client && npx tsc --noEmit`
Expected: `TopScreen` 関連エラーが消え、残るのは `LobbyScreen` のprops不一致のみ。

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/TopScreen.tsx
git commit -m "feat: TopScreen を create_room/join_room 実接続化・エラー表示"
```

---

## Task 12: LobbyScreen を実接続化

**Files:**
- Modify: `client/src/screens/LobbyScreen.tsx`

**Interfaces:**
- Consumes: `GameContext`（`players` 追加済み）、`GameActions`、`NavigateFn`。
- Produces: props `{ ctx: GameContext; actions: GameActions; onNavigate: NavigateFn; onLeave: () => void }`。

- [ ] **Step 1: `client/src/screens/LobbyScreen.tsx` を置換**

```typescript
import { useState } from 'react'
import type { GameContext, NavigateFn } from '../App'
import type { GameActions } from '../useGameSocket'
import { GENRES, genreLabel } from '../genres'

interface Props {
  ctx: GameContext
  actions: GameActions
  onNavigate: NavigateFn
  onLeave: () => void
}

export default function LobbyScreen({ ctx, actions, onLeave }: Props) {
  const [confirmDisband, setConfirmDisband] = useState(false)
  const [generating, setGenerating] = useState(false)

  const startGame = () => {
    if (!ctx.genre) return
    setGenerating(true)
    actions.startGame() // script_ready 受信で App が casting へ遷移
  }

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto">
      {/* 台本生成中オーバーレイ */}
      {generating && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white/95 rounded-2xl p-8 shadow-lg border border-sky-100 text-center max-w-xs w-full">
            <div className="text-5xl mb-4">✍️🤖</div>
            <p className="font-bold text-lg text-slate-900 mb-1">AIが台本を執筆中...</p>
            <p className="text-slate-500 text-sm mb-6">ジャンル：{genreLabel(ctx.genre)}</p>
            <div className="w-8 h-8 mx-auto border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
          </div>
        </div>
      )}

      {/* Room code */}
      <div className="text-center py-6">
        <p className="text-slate-500 text-sm mb-1">ルームコード</p>
        <p className="text-5xl font-bold tracking-[0.3em] text-slate-900">{ctx.roomCode}</p>
        <p className="text-slate-400 text-xs mt-2">このコードを友達に共有しよう</p>
      </div>

      {/* Players */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 shadow-sm border border-sky-100">
        <p className="font-bold mb-3 text-slate-600 text-sm">参加者 {ctx.players.length} / 10</p>
        <div className="space-y-2">
          {ctx.players.map((p, i) => (
            <div key={i} className="flex items-center gap-3 py-1">
              <div className="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0">
                {p.name[0]}
              </div>
              <span className="text-slate-800">{p.name}</span>
              {p.isHost && (
                <span className="text-xs bg-amber-400 text-white px-2 py-0.5 rounded-full font-bold">ホスト</span>
              )}
              {p.name === ctx.playerName && (
                <span className="text-xs text-slate-400">（あなた）</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Genre */}
      {ctx.isHost ? (
        <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 shadow-sm border border-sky-100">
          <p className="font-bold mb-3 text-slate-600 text-sm">ジャンルを選ぶ</p>
          <div className="grid grid-cols-2 gap-2">
            {GENRES.map(g => (
              <button
                key={g.id}
                onClick={() => actions.setGenre(g.id)}
                className={`p-3 rounded-xl text-left transition-colors ${
                  ctx.genre === g.id
                    ? 'bg-purple-600 text-white'
                    : 'bg-sky-50 hover:bg-sky-100 text-slate-700 border border-sky-200'
                }`}
              >
                <div className="text-xl mb-1">{g.emoji}</div>
                <div className="text-sm font-medium">{g.label}</div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 text-center py-10 shadow-sm border border-sky-100">
          <div className="text-2xl mb-2">⏳</div>
          <p className="text-slate-500 text-sm">
            {ctx.genre ? `ジャンル：${genreLabel(ctx.genre)}` : 'ホストがジャンルを選択中...'}
          </p>
        </div>
      )}

      {ctx.isHost ? (
        <div className="space-y-3">
          <button
            onClick={startGame}
            disabled={!ctx.genre || generating}
            className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold text-lg rounded-2xl transition-colors shadow-sm"
          >
            ゲームを開始する
          </button>

          {!confirmDisband ? (
            <button
              onClick={() => setConfirmDisband(true)}
              className="w-full py-3 text-red-400 hover:text-red-600 text-sm font-medium transition-colors"
            >
              ルームを解散する
            </button>
          ) : (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
              <p className="text-red-600 text-sm font-bold text-center mb-3">
                本当に解散しますか？<br />
                <span className="font-normal text-xs">参加中の全員がロビーから退出されます</span>
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDisband(false)}
                  className="flex-1 py-2 bg-white border border-slate-200 text-slate-600 font-bold rounded-xl text-sm transition-colors hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={onLeave}
                  className="flex-1 py-2 bg-red-500 hover:bg-red-400 text-white font-bold rounded-xl text-sm transition-colors"
                >
                  解散する
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-center text-slate-400 text-sm py-4">
            ホストがゲームを開始するまで待機中...
          </div>

          {!confirmDisband ? (
            <button
              onClick={() => setConfirmDisband(true)}
              className="w-full py-3 text-slate-400 hover:text-slate-600 text-sm font-medium transition-colors"
            >
              退出する
            </button>
          ) : (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
              <p className="text-red-600 text-sm font-bold text-center mb-3">
                本当に退出しますか？
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDisband(false)}
                  className="flex-1 py-2 bg-white border border-slate-200 text-slate-600 font-bold rounded-xl text-sm transition-colors hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={onLeave}
                  className="flex-1 py-2 bg-red-500 hover:bg-red-400 text-white font-bold rounded-xl text-sm transition-colors"
                >
                  退出する
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 型チェックが全て通ることを確認**

Run: `cd client && npx tsc --noEmit`
Expected: エラー無し（exit code 0）。

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/LobbyScreen.tsx
git commit -m "feat: LobbyScreen を実players・set_genre・start_game に接続"
```

---

## Task 13: CastingScreen を ctx.script 優先表示・2タブ結合検証

**Files:**
- Modify: `client/src/screens/CastingScreen.tsx`

**Interfaces:**
- Consumes: `GameContext`（`script` に実データ or null）。`script` があれば実データ、無ければ従来モックにフォールバック。

- [ ] **Step 1: `client/src/screens/CastingScreen.tsx` を置換**

```typescript
import type { GameContext, NavigateFn } from '../App'
import { FULL_SCRIPT, MOCK_ROLES, MOCK_WORLD, getMockPlayer } from '../mockScript'
import { genreLabel } from '../genres'

interface Props {
  ctx: GameContext
  onNavigate: NavigateFn
}

export default function CastingScreen({ ctx, onNavigate }: Props) {
  const script = ctx.script
  const world = script?.worldSetting ?? MOCK_WORLD
  const roles = script?.roles ?? MOCK_ROLES
  const entries = script?.entries ?? FULL_SCRIPT
  const myPlayer = script ? ctx.playerName : getMockPlayer(ctx.isHost, ctx.playerName)

  const myRole = roles.find(r => r.player === myPlayer)
  const otherRoles = roles.filter(r => r.player !== myPlayer)
  const myEntries = entries.filter(e => e.player === myPlayer)

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto pb-10">
      <div className="text-center py-6">
        <div className="text-5xl mb-3">🎭</div>
        <h1 className="text-2xl font-bold text-slate-900">配役発表！</h1>
        <p className="text-slate-500 text-sm mt-1">
          ジャンル：{genreLabel(ctx.genre) || '時代劇'}
        </p>
      </div>

      {/* World setting */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 shadow-sm border border-sky-100">
        <p className="text-amber-600 text-xs font-bold tracking-wider mb-2">世界観</p>
        <p className="text-slate-700 text-sm leading-relaxed">{world}</p>
      </div>

      {/* My role */}
      <div className="bg-purple-50 border border-purple-300 rounded-2xl p-5 mb-4">
        <div className="text-center mb-4">
          <p className="text-purple-600 text-xs font-bold tracking-wider mb-1">{ctx.playerName} の役</p>
          <h2 className="text-2xl font-bold text-slate-900">{myRole?.role}</h2>
        </div>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">{myRole?.description}</p>
        <p className="text-amber-600 text-xs font-bold mb-2">あなたのセリフ</p>
        <div className="space-y-2">
          {myEntries.map((entry, i) => (
            <div key={i} className="bg-white rounded-xl p-3 border border-purple-100">
              {entry.action && (
                <p className="text-amber-600 text-xs italic mb-1">🎭 {entry.action}</p>
              )}
              <p className="text-slate-800 text-sm leading-relaxed">「{entry.line}」</p>
            </div>
          ))}
        </div>
      </div>

      {/* Other players */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-6 shadow-sm border border-sky-100">
        <p className="font-bold mb-3 text-slate-600 text-sm">他のプレイヤーの役</p>
        <div className="space-y-2">
          {otherRoles.map((r, i) => (
            <div key={i} className="flex items-center gap-3 py-1">
              <div className="w-7 h-7 bg-slate-300 rounded-full flex items-center justify-center text-xs font-bold text-slate-700 flex-shrink-0">
                {r.player[0]}
              </div>
              <span className="text-slate-600 text-sm">{r.player}</span>
              <span className="text-slate-300 text-sm">／</span>
              <span className="text-slate-700 text-sm">{r.role}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={() => onNavigate('prepare')}
        className="w-full py-4 bg-purple-600 hover:bg-purple-500 text-white font-bold text-lg rounded-2xl transition-colors shadow-sm"
      >
        台本を読む →
      </button>
    </div>
  )
}
```

- [ ] **Step 2: 型チェックが通ることを確認**

Run: `cd client && npx tsc --noEmit`
Expected: エラー無し。

- [ ] **Step 3: 2タブ結合検証**

2つのターミナルでそれぞれ `cd server && npm run dev` と `cd client && npm run dev` を起動。ブラウザで `http://localhost:5173` を2タブ開き、以下を確認：

1. タブA：ルームを作る→名前「たろう」→作成。コード表示・自分がホスト・一覧に「たろう（あなた）ホスト」。
2. タブB：ルームに参加する→名前「はなこ」＋タブAのコード→参加。両タブの一覧に2人。
3. タブA：ジャンル「時代劇」をタップ→両タブの背景が時代劇グラデーションに同期、タブAで選択ハイライト。
4. タブB（ゲスト）で「ジャンル：時代劇」表示。
5. タブA：ゲームを開始→両タブに生成中オーバーレイ→両タブが配役画面へ。各自の名前の役・スタブ台本が表示される。
6. タブA（ホスト）を閉じる→タブBに「ホストが退出した…」モーダル→OKでトップ。
7. 別途やり直し、タブB（ゲスト）を閉じる→タブAに「はなこ が退出しました」トースト・一覧から消える。
8. エラー系：存在しないコードで参加→「ルームが見つかりません」がフォーム下に赤表示。

Expected: すべて期待どおり。ズレがあれば該当タスクへ戻って修正。

- [ ] **Step 4: Commit**

```bash
git add client/src/screens/CastingScreen.tsx
git commit -m "feat: CastingScreen を ctx.script 優先表示（スタブ台本反映）"
```

---

## Self-Review 結果

- **Spec coverage:** 設計書§2〜§10を各タスクで網羅（shared構成=Task1／server雛形=Task2／roomCode=Task3／validation=Task4／roomStore=Task5／scriptStub=Task6／イベント契約=Task7-9／切断=Task9／フロント統合=Task10-13／テスト方針=各TDD＋Task13手動）。
- **Placeholder scan:** プレースホルダ無し。全コード・テスト・コマンドを明記。
- **Type consistency:** `RoomSnapshot`/`PlayerSnapshot`/`ScriptData` は shared 定義に統一。`GameActions`（createRoom/joinRoom/setGenre/startGame/leaveRoom）は useGameSocket 定義と Top/Lobby 消費で一致。roomStore の関数名は Task5 定義と handlers 消費で一致。
- **スコープ:** 単一の実装計画に収まる（Phase B/C は対象外を明記）。
