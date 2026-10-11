# Phase B2 録音中インタラクション同期 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 録音画面のモックを実サーバー接続に置き換え、reaction/bgm/sfx/声量を全プレイヤーで同期する（声量は Web Audio 実測→サーバー合算→ルーム声量として全員へ）。

**Architecture:** Phase A/B1 と同じ。`shared/` のイベント契約・定数を追記、`server/` にハンドラ＋純粋関数（声量合算）、`client/` は BGM のみ `ctx` 経由、reaction/sfx/volume は `RecordingScreen` がソケットを直接購読（高頻度データを App 再描画から隔離）。

**Tech Stack:** TypeScript（tsx）、Socket.io、React+Vite、`node:test`＋硬化済み `testUtils`、Web Audio API（AnalyserNode）。

## Global Constraints

- **声量合算は sum-clamp**：各プレイヤーの level(0〜1) を合計し 1 にクランプ。max ではない。
- **`VOLUME_BROADCAST_MS = 200`**（サーバー側スロットル間隔）。クライアントは声量を **100ms ごと**送信。
- **配信先**：`reaction_received`/`sfx_played` は `socket.to`（送信者以外）、`bgm_changed`/`volume_update` は `io.to`（全員・送信者含む）。
- **受理条件**：`send_reaction`/`send_bgm`/`send_sfx`/`send_volume` は `room.status === 'recording'` のときのみ受理。それ以外は無視。
- **権限**：reaction/sfx/bgm は全員操作可。ホスト限定は `start/stop_recording` のみ（B2 では追加しない）。
- **定数は現行フロントの ID に一致**：`EMOJIS = ['👏','😂','🔥','😍','💪']`、`BGM_IDS = ['dramatic','horror','comedy','battle']`、`SFX_IDS = ['drum','boom','fanfare','scream','laugh','bell']`。許可リスト外は**黙って無視**（`error` を投げない）。
- **B2 は計測のみ**：MediaRecorder による録音・アップロードはしない（Phase C）。BGM/SFX の実音声再生もしない（状態・演出の同期のみ）。
- クライアントは 2-space インデント・セミコロンなし。

## File Structure

- `shared/events.ts`（変更）：Client→Server 4イベント、Server→Client 4イベントを追加。
- `shared/constants.ts`（変更）：`EMOJIS`/`BGM_IDS`/`SFX_IDS` を追加。
- `server/src/validation.ts`（変更）：`isValidEmoji`/`isValidBgmId`/`isValidSfxId` を追加。
- `server/src/validation.test.ts`（変更）：上記のテスト追加。
- `server/src/volume.ts`（新規）：`clamp01`/`combineFreshVolumes`（純粋関数）。
- `server/src/volume.test.ts`（新規）：声量合算の単体テスト。
- `server/src/roomStore.ts`（変更）：`Room` に `bgm`/`volumes`/`lastVolumeBroadcast`、`createRoom` 初期化、`removePlayer` で `volumes` 掃除。
- `server/src/roomStore.test.ts`（変更）：上記のテスト追加。
- `server/src/handlers.ts`（変更）：`send_reaction`/`send_sfx`/`send_bgm`/`send_volume` ハンドラ追加。
- `server/src/handlers.recording.test.ts`（新規）：録音インタラクションの統合テスト。
- `server/package.json`（変更）：test スクリプトに新規テスト2本を追加。
- `client/src/App.tsx`（変更）：`GameContext.bgm` 追加、`RecordingScreen` に `actions` を渡す。
- `client/src/useGameSocket.ts`（変更）：`bgm_changed` リスナ、`sendBgm` アクション。
- `client/src/screens/RecordingScreen.tsx`（変更）：実接続化（モック撤去・Web Audio 声量・reaction/sfx/volume 直接購読・`ctx.script` 移行）。

---

### Task 1: shared イベント契約・定数・バリデータ

**Files:**
- Modify: `shared/events.ts`
- Modify: `shared/constants.ts`
- Modify: `server/src/validation.ts:1`（import 行）, 末尾に追加
- Test: `server/src/validation.test.ts`（末尾に追加）

**Interfaces:**
- Produces: `EMOJIS`, `BGM_IDS`, `SFX_IDS`（`@shared/constants`）。`isValidEmoji(v): v is string`, `isValidBgmId(v): v is string | null`, `isValidSfxId(v): v is string`（`./validation`）。Client→Server `send_reaction`/`send_bgm`/`send_sfx`/`send_volume`、Server→Client `reaction_received`/`bgm_changed`/`sfx_played`/`volume_update`。

- [ ] **Step 1: events.ts にイベント追加**

`shared/events.ts` の `ClientToServerEvents` の `start_recording` 行の後に追加：

```typescript
  send_reaction: (payload: { emoji: string }) => void
  send_bgm: (payload: { bgmId: string | null }) => void
  send_sfx: (payload: { sfxId: string }) => void
  send_volume: (payload: { level: number }) => void
```

`ServerToClientEvents` の `recording_started` 行の後に追加：

```typescript
  reaction_received: (payload: { emoji: string; playerName: string }) => void
  bgm_changed: (payload: { bgmId: string | null; playerName: string }) => void
  sfx_played: (payload: { sfxId: string; playerName: string }) => void
  volume_update: (payload: { level: number }) => void
```

- [ ] **Step 2: constants.ts に許可リスト追加**

`shared/constants.ts` の末尾に追加：

```typescript
// 録音中インタラクション（RecordingScreen の現行定義に一致させること）
export const EMOJIS = ['👏', '😂', '🔥', '😍', '💪'] as const
export const BGM_IDS = ['dramatic', 'horror', 'comedy', 'battle'] as const
export const SFX_IDS = ['drum', 'boom', 'fanfare', 'scream', 'laugh', 'bell'] as const
```

- [ ] **Step 3: バリデータのテストを書く（RED）**

`server/src/validation.test.ts` の末尾に追加。ファイル冒頭の import に `isValidEmoji, isValidBgmId, isValidSfxId` を追加すること。

```typescript
test('isValidEmoji は許可絵文字のみ true', () => {
  assert.equal(isValidEmoji('🔥'), true)
  assert.equal(isValidEmoji('💩'), false)
  assert.equal(isValidEmoji(''), false)
  assert.equal(isValidEmoji(123 as unknown as string), false)
})

test('isValidBgmId は許可ID と null を true、それ以外 false', () => {
  assert.equal(isValidBgmId('dramatic'), true)
  assert.equal(isValidBgmId(null), true)
  assert.equal(isValidBgmId('rock'), false)
  assert.equal(isValidBgmId(undefined as unknown as string), false)
})

test('isValidSfxId は許可IDのみ true', () => {
  assert.equal(isValidSfxId('drum'), true)
  assert.equal(isValidSfxId('explode'), false)
  assert.equal(isValidSfxId(null as unknown as string), false)
})
```

- [ ] **Step 4: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/validation.test.ts`
Expected: FAIL（`isValidEmoji` などが未定義）

- [ ] **Step 5: validation.ts にバリデータ実装**

`server/src/validation.ts:1` の import 行を次に変更：

```typescript
import { NAME_MAX, GENRE_IDS, ROOM_CODE_ALPHABET, ROOM_CODE_LEN, EMOJIS, BGM_IDS, SFX_IDS } from '@shared/constants'
```

ファイル末尾に追加：

```typescript
export function isValidEmoji(v: unknown): v is string {
  return typeof v === 'string' && (EMOJIS as readonly string[]).includes(v)
}

export function isValidBgmId(v: unknown): v is string | null {
  return v === null || (typeof v === 'string' && (BGM_IDS as readonly string[]).includes(v))
}

export function isValidSfxId(v: unknown): v is string {
  return typeof v === 'string' && (SFX_IDS as readonly string[]).includes(v)
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `cd server && npx tsx --test src/validation.test.ts`
Expected: PASS（既存＋追加3件）

- [ ] **Step 7: コミット**

```bash
git add shared/events.ts shared/constants.ts server/src/validation.ts server/src/validation.test.ts
git commit -m "feat: shared に録音インタラクションのイベント契約・定数・バリデータ"
```

---

### Task 2: 声量合算の純粋関数（volume.ts）

**Files:**
- Create: `server/src/volume.ts`
- Test: `server/src/volume.test.ts`
- Modify: `server/package.json`（test スクリプト）

**Interfaces:**
- Produces: `clamp01(n: number): number`、`combineFreshVolumes(entries: Iterable<{ level: number; ts: number }>, now: number, windowMs?: number): number`。Task 4 の `send_volume` ハンドラが `combineFreshVolumes` を使う。

- [ ] **Step 1: テストを書く（RED）**

`server/src/volume.test.ts` を新規作成：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp01, combineFreshVolumes } from './volume'

test('clamp01 は 0..1 に収め、非有限(NaN/Infinity)は 0', () => {
  assert.equal(clamp01(0.5), 0.5)
  assert.equal(clamp01(-1), 0)
  assert.equal(clamp01(2), 1)
  assert.equal(clamp01(NaN), 0)
  assert.equal(clamp01(Infinity), 0) // 非有限は 0（Number.isFinite で弾く）
})

test('combineFreshVolumes は新鮮なエントリの level を合計し 1 にクランプ', () => {
  const now = 1000
  assert.equal(combineFreshVolumes([], now), 0)
  assert.equal(combineFreshVolumes([{ level: 0.3, ts: 1000 }], now), 0.3)
  assert.equal(combineFreshVolumes([{ level: 0.4, ts: 1000 }, { level: 0.5, ts: 900 }], now), 0.9)
  assert.equal(combineFreshVolumes([{ level: 0.7, ts: 1000 }, { level: 0.8, ts: 1000 }], now), 1)
})

test('combineFreshVolumes は窓外(古い)エントリを除外', () => {
  const now = 2000
  // windowMs=500 → ts<1500 は除外
  assert.equal(combineFreshVolumes([{ level: 0.6, ts: 2000 }, { level: 0.9, ts: 1400 }], now), 0.6)
})

test('combineFreshVolumes は異常な level を 0 として扱う', () => {
  const now = 1000
  assert.equal(combineFreshVolumes([{ level: -5, ts: 1000 }, { level: NaN, ts: 1000 }, { level: 0.2, ts: 1000 }], now), 0.2)
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/volume.test.ts`
Expected: FAIL（`volume` モジュールが存在しない）

- [ ] **Step 3: volume.ts を実装**

`server/src/volume.ts` を新規作成：

```typescript
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

export function combineFreshVolumes(
  entries: Iterable<{ level: number; ts: number }>,
  now: number,
  windowMs = 500,
): number {
  let sum = 0
  for (const { level, ts } of entries) {
    if (now - ts > windowMs) continue
    sum += clamp01(level)
  }
  return sum > 1 ? 1 : sum
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/volume.test.ts`
Expected: PASS（4件）

- [ ] **Step 5: package.json の test に追加**

`server/package.json` の `"test"` スクリプト末尾（`src/handlers.prepare.test.ts` の後）に `src/volume.test.ts` を追加。

- [ ] **Step 6: コミット**

```bash
git add server/src/volume.ts server/src/volume.test.ts server/package.json
git commit -m "feat: 声量合算の純粋関数 clamp01 / combineFreshVolumes"
```

---

### Task 3: roomStore に BGM・声量状態

**Files:**
- Modify: `server/src/roomStore.ts`（`Room` 型, `createRoom`, `removePlayer`）
- Test: `server/src/roomStore.test.ts`（末尾に追加）

**Interfaces:**
- Consumes: なし。
- Produces: `Room.bgm: string | null`、`Room.volumes: Map<string, { level: number; ts: number }>`、`Room.lastVolumeBroadcast: number`。Task 4 のハンドラがこれらを読み書きする。

- [ ] **Step 1: テストを書く（RED）**

`server/src/roomStore.test.ts` の末尾に追加（既存の import に `removePlayer` があるか確認し、無ければ追加）：

```typescript
test('createRoom は bgm=null・volumes 空・lastVolumeBroadcast=0 で初期化', () => {
  const room = createRoom('sock-h', 'ホスト')
  assert.equal(room.bgm, null)
  assert.equal(room.volumes.size, 0)
  assert.equal(room.lastVolumeBroadcast, 0)
})

test('removePlayer は volumes からも該当 socketId を削除', () => {
  const room = createRoom('sock-h', 'ホスト')
  addPlayer(room, 'sock-g', 'ゲスト', false)
  room.volumes.set('sock-g', { level: 0.5, ts: Date.now() })
  removePlayer(room, 'sock-g')
  assert.equal(room.volumes.has('sock-g'), false)
})
```

（`createRoom`/`addPlayer`/`removePlayer` は既存 import。無い識別子があれば冒頭 import に足す。）

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL（`room.bgm` などが undefined／`volumes` が存在しない）

- [ ] **Step 3: Room 型にフィールド追加**

`server/src/roomStore.ts` の `Room` interface（`lastActivityAt: number` の後）に追加：

```typescript
  bgm: string | null
  volumes: Map<string, { level: number; ts: number }>
  lastVolumeBroadcast: number
```

- [ ] **Step 4: createRoom で初期化**

`createRoom` の `room` オブジェクトリテラル（`lastActivityAt: now,` の後）に追加：

```typescript
    bgm: null,
    volumes: new Map(),
    lastVolumeBroadcast: 0,
```

- [ ] **Step 5: removePlayer で volumes を掃除**

`removePlayer` を次に変更：

```typescript
export function removePlayer(room: Room, socketId: string): Player | undefined {
  const player = room.players.get(socketId)
  if (player) room.players.delete(socketId)
  room.volumes.delete(socketId)
  return player
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: PASS（既存＋追加2件）

- [ ] **Step 7: コミット**

```bash
git add server/src/roomStore.ts server/src/roomStore.test.ts
git commit -m "feat: roomStore に BGM・声量(volumes)・スロットル状態を追加"
```

---

### Task 4: 録音インタラクションのハンドラ

**Files:**
- Modify: `server/src/handlers.ts`（import 行, `start_recording` ハンドラの後・`disconnect` の前に追加）
- Test: `server/src/handlers.recording.test.ts`（新規）
- Modify: `server/package.json`（test スクリプト）

**Interfaces:**
- Consumes: `isValidEmoji`/`isValidBgmId`/`isValidSfxId`（Task 1）、`combineFreshVolumes`（Task 2）、`Room.bgm`/`volumes`/`lastVolumeBroadcast`（Task 3）、既存 `findRoomBySocket`/`touch`。
- Produces: `send_reaction`/`send_sfx`/`send_bgm`/`send_volume` の受信処理と `reaction_received`/`sfx_played`/`bgm_changed`/`volume_update` の配信。

- [ ] **Step 1: 統合テストを書く（RED）**

`server/src/handlers.recording.test.ts` を新規作成：

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

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// 録音中(status='recording')まで進めた host/guest を返す
async function makeRecordingRoom() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  host.emit('start_game')
  await once(guest, 'script_ready')
  await once(host, 'script_ready')
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  host.emit('start_recording')
  await once(guest, 'recording_started')
  await once(host, 'recording_started')
  return { host, guest, roomCode }
}

// 待機中(status='waiting')の host/guest を返す（status ガード検証用）
async function makeWaitingRoom() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest }
}

test('send_reaction は許可絵文字を送信者以外へ reaction_received で配信', async () => {
  const { host, guest } = await makeRecordingRoom()
  const guestSaw = once<{ emoji: string; playerName: string }>(guest, 'reaction_received')
  let hostSaw = false
  host.on('reaction_received', () => { hostSaw = true })
  host.emit('send_reaction', { emoji: '🔥' })
  const r = await guestSaw
  assert.equal(r.emoji, '🔥')
  assert.equal(r.playerName, 'たろう')
  await delay(150)
  assert.equal(hostSaw, false) // socket.to：送信者自身には届かない
  host.disconnect(); guest.disconnect()
})

test('send_reaction は不正絵文字を無視', async () => {
  const { host, guest } = await makeRecordingRoom()
  let guestSaw = false
  guest.on('reaction_received', () => { guestSaw = true })
  host.emit('send_reaction', { emoji: '💩' })
  await delay(200)
  assert.equal(guestSaw, false)
  host.disconnect(); guest.disconnect()
})

test('send_sfx は許可IDを送信者以外へ sfx_played で配信', async () => {
  const { host, guest } = await makeRecordingRoom()
  const guestSaw = once<{ sfxId: string; playerName: string }>(guest, 'sfx_played')
  host.emit('send_sfx', { sfxId: 'drum' })
  const s = await guestSaw
  assert.equal(s.sfxId, 'drum')
  assert.equal(s.playerName, 'たろう')
  host.disconnect(); guest.disconnect()
})

test('send_bgm は bgm_changed を送信者含む全員へ配信（null で解除）', async () => {
  const { host, guest } = await makeRecordingRoom()
  const guestSaw = once<{ bgmId: string | null; playerName: string }>(guest, 'bgm_changed')
  const hostSaw = once<{ bgmId: string | null }>(host, 'bgm_changed')
  host.emit('send_bgm', { bgmId: 'dramatic' })
  const g = await guestSaw
  const h = await hostSaw
  assert.equal(g.bgmId, 'dramatic')
  assert.equal(g.playerName, 'たろう')
  assert.equal(h.bgmId, 'dramatic') // io.to：送信者も受け取る
  // null で解除
  const guestSaw2 = once<{ bgmId: string | null }>(guest, 'bgm_changed')
  host.emit('send_bgm', { bgmId: null })
  const g2 = await guestSaw2
  assert.equal(g2.bgmId, null)
  host.disconnect(); guest.disconnect()
})

test('send_bgm は不正IDを無視', async () => {
  const { host, guest } = await makeRecordingRoom()
  let guestSaw = false
  guest.on('bgm_changed', () => { guestSaw = true })
  host.emit('send_bgm', { bgmId: 'rock' })
  await delay(200)
  assert.equal(guestSaw, false)
  host.disconnect(); guest.disconnect()
})

test('send_volume は volume_update を配信し、初回は自分の level を反映', async () => {
  const { host, guest } = await makeRecordingRoom()
  const guestSaw = once<{ level: number }>(guest, 'volume_update')
  host.emit('send_volume', { level: 0.5 })
  const v = await guestSaw
  assert.ok(Math.abs(v.level - 0.5) < 0.01, `level=${v.level}`)
  host.disconnect(); guest.disconnect()
})

test('send_volume は複数プレイヤーの声量を合算(sum-clamp)', async () => {
  const { host, guest } = await makeRecordingRoom()
  const first = once<{ level: number }>(guest, 'volume_update')
  host.emit('send_volume', { level: 0.5 })
  const f = await first
  assert.ok(Math.abs(f.level - 0.5) < 0.01)
  await delay(250) // スロットル解除＋host の値は 500ms 窓内に残る
  const second = once<{ level: number }>(guest, 'volume_update')
  guest.emit('send_volume', { level: 0.5 })
  const s = await second
  assert.ok(s.level > 0.99, `合算 level=${s.level}`) // 0.5+0.5=1.0 にクランプ
  host.disconnect(); guest.disconnect()
})

test('send_volume は 200ms 未満の連続送信をスロットル（1回だけ配信）', async () => {
  const { host, guest } = await makeRecordingRoom()
  let count = 0
  guest.on('volume_update', () => { count++ })
  host.emit('send_volume', { level: 0.3 })
  host.emit('send_volume', { level: 0.6 })
  host.emit('send_volume', { level: 0.9 })
  await delay(150)
  assert.equal(count, 1)
  host.disconnect(); guest.disconnect()
})

test('status が recording 以外では 4イベントとも無視', async () => {
  const { host, guest } = await makeWaitingRoom()
  let saw = false
  guest.on('reaction_received', () => { saw = true })
  guest.on('sfx_played', () => { saw = true })
  guest.on('bgm_changed', () => { saw = true })
  guest.on('volume_update', () => { saw = true })
  host.emit('send_reaction', { emoji: '🔥' })
  host.emit('send_sfx', { sfxId: 'drum' })
  host.emit('send_bgm', { bgmId: 'dramatic' })
  host.emit('send_volume', { level: 0.5 })
  await delay(250)
  assert.equal(saw, false)
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd server && npx tsx --test src/handlers.recording.test.ts`
Expected: FAIL（ハンドラ未実装のため配信が来ず once がタイムアウト）

- [ ] **Step 3: handlers.ts に import 追加**

`server/src/handlers.ts` の import を調整：
- `./validation` の import に `isValidEmoji, isValidBgmId, isValidSfxId` を追加。
- 新規行を追加：`import { combineFreshVolumes } from './volume'`

`registerHandlers` の直前（module スコープ）に定数を追加：

```typescript
const VOLUME_BROADCAST_MS = 200
```

- [ ] **Step 4: 4ハンドラを実装**

`start_recording` ハンドラの閉じ `})` の後、`disconnect` ハンドラの前に追加：

```typescript
  socket.on('send_reaction', ({ emoji }) => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.status !== 'recording') return
    if (!isValidEmoji(emoji)) return
    const playerName = room.players.get(socket.id)?.name
    if (!playerName) return
    socket.to(room.code).emit('reaction_received', { emoji, playerName })
  })

  socket.on('send_sfx', ({ sfxId }) => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.status !== 'recording') return
    if (!isValidSfxId(sfxId)) return
    const playerName = room.players.get(socket.id)?.name
    if (!playerName) return
    socket.to(room.code).emit('sfx_played', { sfxId, playerName })
  })

  socket.on('send_bgm', ({ bgmId }) => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.status !== 'recording') return
    if (!isValidBgmId(bgmId)) return
    const playerName = room.players.get(socket.id)?.name
    if (!playerName) return
    room.bgm = bgmId
    touch(room)
    io.to(room.code).emit('bgm_changed', { bgmId, playerName })
  })

  socket.on('send_volume', ({ level }) => {
    const room = findRoomBySocket(socket.id)
    if (!room || room.status !== 'recording') return
    const now = Date.now()
    room.volumes.set(socket.id, { level, ts: now })
    if (now - room.lastVolumeBroadcast < VOLUME_BROADCAST_MS) return
    room.lastVolumeBroadcast = now
    const combined = combineFreshVolumes(room.volumes.values(), now)
    io.to(room.code).emit('volume_update', { level: combined })
  })
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.recording.test.ts`
Expected: PASS（10件）

- [ ] **Step 6: package.json の test に追加**

`server/package.json` の `"test"` スクリプト末尾に `src/handlers.recording.test.ts` を追加。

- [ ] **Step 7: サーバー全テスト確認**

Run: `cd server && npm test`
Expected: PASS（既存＋Task1〜4 追加分すべて）

- [ ] **Step 8: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.recording.test.ts server/package.json
git commit -m "feat: send_reaction/sfx/bgm/volume ハンドラ（録音中インタラクション同期）"
```

---

### Task 5: client の BGM 配線（useGameSocket / GameContext）

**Files:**
- Modify: `client/src/App.tsx`（`GameContext` 型, `INITIAL_CTX`, `RecordingScreen` 呼び出し）
- Modify: `client/src/useGameSocket.ts`（`bgm_changed` リスナ, `sendBgm` アクション, `GameActions` 型）

**Interfaces:**
- Consumes: Server→Client `bgm_changed`（Task 4）。
- Produces: `GameContext.bgm: string | null`、`GameActions.sendBgm(bgmId: string | null): void`。Task 6 の `RecordingScreen` が `ctx.bgm` と `actions.sendBgm` を使う。

- [ ] **Step 1: GameContext に bgm 追加**

`client/src/App.tsx` の `GameContext` interface、`readyMap` 行の後に追加：

```typescript
  bgm: string | null
```

`INITIAL_CTX`、`readyMap: {},` の後に追加：

```typescript
  bgm: null,
```

- [ ] **Step 2: RecordingScreen に actions を渡す**

`client/src/App.tsx` の RecordingScreen 呼び出し行を変更：

```tsx
      {screen === 'recording'  && <RecordingScreen ctx={ctx} actions={actions} onNavigate={navigate} />}
```

- [ ] **Step 3: useGameSocket に bgm_changed リスナと sendBgm アクション**

`client/src/useGameSocket.ts`：

`GameActions` interface の `startRecording` 行の後に追加：

```typescript
  sendBgm: (bgmId: string | null) => void
```

`onRecordingStarted` の後にリスナ関数を追加：

```typescript
    function onBgmChanged({ bgmId }: { bgmId: string | null; playerName: string }) {
      setCtx(prev => ({ ...prev, bgm: bgmId }))
    }
```

`socket.on('recording_started', onRecordingStarted)` の後に登録を追加：

```typescript
    socket.on('bgm_changed', onBgmChanged)
```

`socket.off('recording_started', onRecordingStarted)` の後に解除を追加：

```typescript
    socket.off('bgm_changed', onBgmChanged)
```

`return { ... }` のアクション群、`startRecording()` の後に追加：

```typescript
    sendBgm(bgmId) {
      socket.emit('send_bgm', { bgmId })
    },
```

- [ ] **Step 4: 型チェック確認**

Run: `cd client && npx tsc --noEmit`
Expected: PASS（`RecordingScreen` の props 追加は Task 6 で対応するため、ここで `actions` 未使用の型エラーが出る場合は Task 6 と合わせて解消。単独で通らなければ Step 5 の暫定として RecordingScreen の Props に `actions?: GameActions` を許容してもよいが、原則 Task 6 とまとめてコミット可）

> 注：Task 5 と Task 6 はクライアントの `tsc` が相互依存するため、**Task 5 のコミットは型が通る範囲**で行い（`GameContext.bgm`・`useGameSocket` 追加のみ。`App.tsx` の RecordingScreen 呼び出し変更は Task 6 と同じコミットにまとめてよい）、`tsc` が緑になるのを Task 6 完了時点で担保する。実装者はどちらでまとめるか判断し、レビュー時に `tsc`/`build` が緑であることを確認する。

- [ ] **Step 5: コミット**

```bash
git add client/src/App.tsx client/src/useGameSocket.ts
git commit -m "feat: client に bgm 状態と bgm_changed/sendBgm を配線"
```

---

### Task 6: RecordingScreen 実接続化

**Files:**
- Modify: `client/src/screens/RecordingScreen.tsx`

**Interfaces:**
- Consumes: `ctx.script`/`ctx.playerName`/`ctx.players`/`ctx.bgm`（`GameContext`）、`actions.sendBgm`（Task 5）、`socket`（`../socket`）で `send_reaction`/`send_sfx`/`send_volume` を emit、`reaction_received`/`sfx_played`/`volume_update` を購読。

- [ ] **Step 1: props に actions を追加し、モックの他人リアクションを撤去**

`RecordingScreen.tsx` の Props と import を変更：

```typescript
import { useState, useEffect, useRef } from 'react'
import type { GameContext, NavigateFn } from '../App'
import type { GameActions } from '../useGameSocket'
import { socket } from '../socket'
import { FULL_SCRIPT, getMockPlayer } from '../mockScript'

interface Props {
  ctx: GameContext
  actions: GameActions
  onNavigate: NavigateFn
}
```

`export default function RecordingScreen({ ctx, actions, onNavigate }: Props) {` に変更。

**削除するもの：**
- 現行の「他プレイヤーからの自動リアクション（モック）」`useEffect`（88-101 行相当）と、その下の `const timerRef = useRef<...>()`。
- 声量メーターのモック `useEffect`（`setBars(prev => prev.map(...Math.random()...)`）。
- ローカル `const [currentBgm, setCurrentBgm] = useState<string | null>(null)`（`ctx.bgm` に置換）。

- [ ] **Step 2: 台本を ctx.script 方式へ移行**

`const myPlayer = getMockPlayer(ctx.isHost, ctx.playerName)` を次に変更：

```typescript
  const entries = ctx.script?.entries ?? FULL_SCRIPT
  const myPlayer = ctx.script ? ctx.playerName : getMockPlayer(ctx.isHost, ctx.playerName)
```

台本描画の `FULL_SCRIPT.map(...)` を `entries.map(...)` に変更。

- [ ] **Step 3: リアクションを実接続化（楽観的表示＋受信表示）**

既存の `sendReaction` を「浮遊表示を生成する内部関数」に整理し、送信は emit を伴わせる。次のように置換：

```typescript
  // 浮遊リアクションを画面に出す（送信・受信 共通）
  const spawnReaction = (emoji: string) => {
    const id = ++reactionIdRef.current
    const x = 10 + Math.random() * 80
    setReactions(prev => [...prev, { id, emoji, x }])
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 2200)
  }

  // 自分の送信：楽観的表示＋サーバー配信
  const handleReaction = (emoji: string) => {
    spawnReaction(emoji)
    socket.emit('send_reaction', { emoji })
  }
```

下部バーのスタンプボタン `onClick={() => sendReaction(emoji)}` を `onClick={() => handleReaction(emoji)}` に変更。

- [ ] **Step 4: SFX / BGM を実接続化**

SFX：既存のフラッシュ発火を関数化し、ボタンで emit も行う。

```typescript
  const flashSfx = (sfxId: string) => {
    setSfxFlash(sfxId)
    setTimeout(() => setSfxFlash(null), 400)
  }
  const handleSfx = (sfxId: string) => {
    flashSfx(sfxId)
    socket.emit('send_sfx', { sfxId })
  }
```

SFX ボタンの `onClick`（現行 `setSfxFlash(...)` 直書き）を `onClick={() => handleSfx(s.id)}` に変更。

BGM：`currentBgm` 参照を `ctx.bgm` に置換。BGM ボタンの `onClick={() => setCurrentBgm(prev => prev === b.id ? null : b.id)}` を次に変更：

```tsx
                    onClick={() => actions.sendBgm(ctx.bgm === b.id ? null : b.id)}
```

`currentBgm === b.id` の比較は `ctx.bgm === b.id` に、停止ボタン `onClick={() => setCurrentBgm(null)}` は `onClick={() => actions.sendBgm(null)}` に、`{currentBgm && (` は `{ctx.bgm && (` に変更。

- [ ] **Step 5: 受信リスナ（reaction/sfx/volume）を購読**

録音フェーズ中にソケットを直接購読する `useEffect` を追加（`phase` に依存）：

```typescript
  useEffect(() => {
    if (phase !== 'recording') return
    function onReaction({ emoji }: { emoji: string; playerName: string }) {
      spawnReaction(emoji)
    }
    function onSfx({ sfxId }: { sfxId: string; playerName: string }) {
      flashSfx(sfxId)
    }
    function onVolume({ level }: { level: number }) {
      setBars(prev => [...prev.slice(1), level]) // ルーム声量のスクロール波形
    }
    socket.on('reaction_received', onReaction)
    socket.on('sfx_played', onSfx)
    socket.on('volume_update', onVolume)
    return () => {
      socket.off('reaction_received', onReaction)
      socket.off('sfx_played', onSfx)
      socket.off('volume_update', onVolume)
    }
  }, [phase])
```

（`spawnReaction`/`flashSfx` は上で定義済み。`eslint` の exhaustive-deps 警告は既存方針に合わせて可。）

- [ ] **Step 6: Web Audio で声量を実測して送信**

録音フェーズ中にマイクを取得し、100ms ごとに `send_volume` する `useEffect` を追加：

```typescript
  useEffect(() => {
    if (phase !== 'recording') return
    let audioCtx: AudioContext | null = null
    let stream: MediaStream | null = null
    let raf = 0
    let lastSent = 0
    let cancelled = false

    navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
      if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
      stream = s
      audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(s)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        const level = Math.min(1, rms * 2) // ゲイン補正
        const now = performance.now()
        if (now - lastSent >= 100) {
          lastSent = now
          socket.emit('send_volume', { level })
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }).catch(() => { /* マイク不許可時は声量送信をスキップ */ })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
      audioCtx?.close()
    }
  }, [phase])
```

- [ ] **Step 7: 型チェック・ビルド**

Run: `cd client && npx tsc --noEmit`
Expected: PASS

Run: `cd client && npx vite build`
Expected: 成功（エラーなし）

- [ ] **Step 8: 手動 2 タブ確認（record フェーズ）**

サーバー・クライアントを起動し、2 タブでホスト＋ゲストで録音まで進める。確認：
- 一方でリアクション絵文字を押す → **両タブ**に浮遊表示される。
- 一方で BGM を選ぶ → **両タブ**のパネルが同じ BGM をハイライト（最後に押した人が勝つ）。
- 一方で SFX を押す → **両タブ**でフラッシュ。
- 両方で声を出す → 声量メーターが**合算されたルーム声量**で上下する（無音で静か・複数人で高く）。マイク許可が必要。

（Web Audio 実測は headless で検証困難なため、この 2 タブ目視で担保。reaction/bgm/sfx の配信自体は Task 4 のサーバー統合テストでカバー済み。）

- [ ] **Step 9: コミット**

```bash
git add client/src/screens/RecordingScreen.tsx
git commit -m "feat: RecordingScreen を実接続化（reaction/bgm/sfx/声量の同期・Web Audio 実測）"
```

---

## 完了条件

- サーバー全テスト green（`cd server && npm test`）：Task 1〜4 の追加分含む。
- クライアント `tsc --noEmit` / `vite build` green。
- 2 タブ手動で reaction/bgm/sfx/声量の同期が確認できる。
- モック（他人の自動リアクション・ランダム声量・ローカル BGM）が撤去され、録音中インタラクションが実サーバー駆動になっている。

## 非スコープ（この計画で触らない）

- `stop_recording`・評価スタブ・結果・`return_to_lobby`・`room_reset`（**B3**）。「録音終了」ボタンは現状のローカル `onNavigate('evaluating')` のまま。
- MediaRecorder 実録音・アップロード、BGM/SFX 実音声再生、Whisper・Claude（**Phase C**）。
- `send_reaction` 等の引数なし emit ガード（既存ハンドラと同じ素の分割代入に合わせる。全体 hardening として別途）。
- Phase A 繰り越し（`start_game` の genre/最小人数ガード、host 権限拒否の統合テスト、正規名エコー）。
```