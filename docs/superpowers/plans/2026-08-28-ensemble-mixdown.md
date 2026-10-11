# 全員の演技を合体した「作品」 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 録音後、全端末のクリーンなマイク音声と BGM/SE をサーバーの ffmpeg で 1 本の m4a に合成し、結果画面から全員が同じ「作品」を聞ける・共有できるようにする。

**Architecture:** 採点フローには一切割り込まない。`evaluation_complete` を出したあとに非同期で合成を走らせ、出来たら `work_ready` でパスを配る。各端末は簡易時刻同期（ping/pong 3往復・最小RTT）でサーバー時計に対する録音開始時刻を申告し、サーバーがそれで頭を揃える。BGM/SE はサーバーが録音中のタイミングを記録しておき、合成時に同じ mp3 を重ね直す。

**Tech Stack:** Node 20+ / TypeScript / Express / Socket.IO / ffmpeg（`ffmpeg-static` 5.3.0）/ React 18 / node:test

**Spec:** `docs/superpowers/specs/2026-08-28-ensemble-mixdown-design.md`

## Global Constraints

- **この機能が丸ごとコケても、体験は現状より悪くなってはならない。** 合成失敗時は今日とまったく同じ結果画面になること。これは設計要件であり、実装中に崩してはならない
- **採点フローを遅らせない。** 合成は `evaluation_complete` の emit **より後**に開始する。`finalizeEvaluation` は合成を await しない
- **`startedAt` の不備でアップロードを失敗させない。** 採点は音声が届くことに依存しており、頭合わせはそれより優先度が低い
- **ffmpeg の不在でサーバーが起動しないことがあってはならない**
- サーバーは `tsx` で動き型検査をしない。**`npx tsc --noEmit`（server / client 双方）が実質的なゲート**である
- テストは `tests/` 配下に置く（`src/` に置かない）。実行は `npm --prefix server test` / `npm --prefix client test`
- クライアントの純粋モジュールは `import.meta.env` を触る `config.ts` に依存してはならない。socket 依存のあるモジュールとはファイルを分ける（`liveAudioPure.ts` / `liveAudio.ts` と同じ作法）
- 出力形式は **m4a (AAC 128k, 48kHz, stereo)**。mp3 は使わない
- BGM のフェードは **0.1 秒**。`client/src/audioBus.ts` の `FADE_SEC` と同値であること
- タイムラインの上限は **60 エントリ**
- `time_ping` は端末ごと 1 ゲーム **20 回**まで

---

### Task 1: 時刻同期の純粋関数

**Files:**
- Create: `client/src/timeSyncPure.ts`
- Test: `client/tests/timeSync.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `SyncSample { rtt: number; offset: number }`、`pickBestOffset(samples: SyncSample[]): number`

`liveAudioPure.ts` と同じく、DOM にも socket にも依存しない純粋モジュールとして切り出す。`config.ts` は `import.meta.env` を読むため、それに連なるものを import すると `tsx --test` で落ちる。だからファイルを分ける。

- [ ] **Step 1: Write the failing test**

`client/tests/timeSync.test.ts` を新規作成:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestOffset } from '../src/timeSyncPure'

test('RTT が最小のサンプルの offset を採る（平均ではない）', () => {
  const samples = [
    { rtt: 300, offset: 5000 },
    { rtt: 40, offset: 120 },
    { rtt: 180, offset: 900 },
  ]
  assert.equal(pickBestOffset(samples), 120)
})

test('同じ RTT が並んだら先に来たほうを採る', () => {
  const samples = [
    { rtt: 50, offset: 10 },
    { rtt: 50, offset: 99 },
  ]
  assert.equal(pickBestOffset(samples), 10)
})

test('空配列は 0（同期できなければ補正しない＝今日の挙動）', () => {
  assert.equal(pickBestOffset([]), 0)
})

test('NaN / Infinity のサンプルは無視する', () => {
  const samples = [
    { rtt: NaN, offset: 1 },
    { rtt: 10, offset: Infinity },
    { rtt: 200, offset: 77 },
  ]
  assert.equal(pickBestOffset(samples), 77)
})

test('壊れたサンプルしかなければ 0 に落ちる', () => {
  assert.equal(pickBestOffset([{ rtt: NaN, offset: NaN }]), 0)
})

test('負の RTT は無視する（時計が巻き戻った端末を採用しない）', () => {
  const samples = [
    { rtt: -5, offset: 12345 },
    { rtt: 90, offset: 42 },
  ]
  assert.equal(pickBestOffset(samples), 42)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test`
Expected: FAIL — `Cannot find module '../src/timeSyncPure'`

- [ ] **Step 3: Write minimal implementation**

`client/src/timeSyncPure.ts` を新規作成:

```ts
// 時刻同期の判断だけを持つ純粋モジュール。socket にも DOM にも依存しない
// （config.ts を辿ると import.meta.env に触れてしまい、tsx --test で読めなくなる）。
// liveAudioPure.ts と同じ切り出し方。

export interface SyncSample {
  rtt: number      // 往復にかかったミリ秒
  offset: number   // サーバー時計 - この端末の時計（ミリ秒）
}

/**
 * 採用する offset を1つ選ぶ。
 *
 * 平均ではなく「RTT が最小のサンプル」を採る。offset の計算は
 * 「往路と復路の遅延が等しい」という仮定に乗っており、キューイングで
 * 片道だけが伸びた回はその仮定が崩れる。RTT が小さい回ほど仮定に近い。
 * NTP が同じ理由で最小 RTT を選ぶ。
 *
 * 有効なサンプルが1つも無ければ 0 を返す＝補正しない（今日の挙動のまま）。
 */
export function pickBestOffset(samples: SyncSample[]): number {
  let best: SyncSample | null = null
  for (const s of samples) {
    if (!Number.isFinite(s.rtt) || !Number.isFinite(s.offset)) continue
    if (s.rtt < 0) continue // 計測中に時計が巻き戻った＝信用しない
    if (best === null || s.rtt < best.rtt) best = s
  }
  return best === null ? 0 : best.offset
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test`
Expected: PASS（6 件）

- [ ] **Step 5: Type check**

Run: `npx --prefix client tsc --noEmit -p client`
Expected: エラーなし

- [ ] **Step 6: Commit**

```bash
git add client/src/timeSyncPure.ts client/tests/timeSync.test.ts
git commit -m "feat: 時刻同期のオフセット選択（最小RTT）を純粋関数で足す"
```

---

### Task 2: time_ping / time_pong の往復とクライアント配線

**Files:**
- Modify: `shared/events.ts`
- Modify: `server/src/limits.ts`
- Modify: `server/src/roomStore.ts`（`Device.timeSyncCount` の追加・`resetRoom` での復帰）
- Modify: `server/src/handlers.ts`（`time_ping` ハンドラ）
- Create: `client/src/timeSync.ts`
- Modify: `client/src/useGameSocket.ts`
- Test: `server/tests/handlers.timeSync.test.ts`

**Interfaces:**
- Consumes: `pickBestOffset(samples: SyncSample[]): number`（Task 1）
- Produces:
  - イベント `time_ping: (payload: { clientSent: number }) => void`（C2S）、`time_pong: (payload: { clientSent: number; serverNow: number }) => void`（S2C）
  - `client/src/timeSync.ts` の `syncClock(): void`、`serverNow(): number`、`resetTimeSync(): void`
  - `Limits.timeSyncMaxPerGame: number`

**なぜ接続直後ではなく入室後に同期するのか**: `time_ping` は端末ごとの回数を数えるため `Device` が要る。接続直後はまだ部屋に居らず `Device` が無いので、数えられない ping を無制限に受けることになる。入室が確定した時点（`room_created` / `room_joined` / `rejoined`）と、録音の直前（`script_ready`）で同期する。

- [ ] **Step 1: Write the failing test**

`server/tests/handlers.timeSync.test.ts` を新規作成:

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => { server = await startTestServer() })
afterEach(async () => { await server.close() })

test('time_ping には clientSent をそのまま返し serverNow を添える', async () => {
  const { host, guest } = await makeRoom(server.port)
  const before = Date.now()
  host.emit('time_ping', { clientSent: 12345 })
  const pong = await once<{ clientSent: number; serverNow: number }>(host, 'time_pong')
  const after = Date.now()
  assert.equal(pong.clientSent, 12345, 'clientSent はエコーされること')
  assert.ok(pong.serverNow >= before && pong.serverNow <= after, 'serverNow が現在時刻であること')
  host.disconnect(); guest.disconnect()
})

test('time_pong は送信者にだけ返る（部屋にブロードキャストしない）', async () => {
  const { host, guest } = await makeRoom(server.port)
  const quiet = expectNoEvent(guest, 'time_pong', 300)
  host.emit('time_ping', { clientSent: 1 })
  await once(host, 'time_pong')
  await quiet
  host.disconnect(); guest.disconnect()
})

test('clientSent が数値でなければ無視する', async () => {
  const { host, guest } = await makeRoom(server.port)
  host.emit('time_ping', { clientSent: 'いま' as unknown as number })
  await expectNoEvent(host, 'time_pong', 300)
  host.disconnect(); guest.disconnect()
})

test('1ゲームの上限を超えた time_ping は黙って捨てる', async () => {
  await server.close() // beforeEach が作ったぶんを先に閉じる（閉じないとポートが漏れる）
  server = await startTestServer({ limits: { timeSyncMaxPerGame: 2 } })
  const { host, guest } = await makeRoom(server.port)
  host.emit('time_ping', { clientSent: 1 })
  await once(host, 'time_pong')
  host.emit('time_ping', { clientSent: 2 })
  await once(host, 'time_pong')
  host.emit('time_ping', { clientSent: 3 })
  await expectNoEvent(host, 'time_pong', 300)
  host.disconnect(); guest.disconnect()
})

test('部屋に入っていない接続の time_ping は無視する', async () => {
  const lone = connectClient(server.port)
  await once(lone, 'connect')
  lone.emit('time_ping', { clientSent: 1 })
  await expectNoEvent(lone, 'time_pong', 300)
  lone.disconnect()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- --test-name-pattern="time_"`
Expected: FAIL — `timeout waiting for "time_pong"`

- [ ] **Step 3: イベント契約を足す**

`shared/events.ts` の `ClientToServerEvents` に追加（`rtc_signal` の直前）:

```ts
  // 簡易時刻同期。録音開始時刻をサーバー時計に換算するためだけに使う。
  time_ping: (payload: { clientSent: number }) => void
```

`ServerToClientEvents` に追加（`rtc_signal` の直前）:

```ts
  // clientSent はそのままエコーする（クライアントが往復時間を測るため）。
  time_pong: (payload: { clientSent: number; serverNow: number }) => void
```

- [ ] **Step 4: Limits に上限を足す**

`server/src/limits.ts` の `Limits` インターフェース、`rtcSignalMaxPerGame` の直後に追加:

```ts
  /** 1端末が1ゲーム中に投げられる時刻同期 ping の数。超過分は黙って捨てる */
  timeSyncMaxPerGame: number
```

`DEFAULT_LIMITS` の `rtcSignalMaxPerGame: 500,` の直後に追加:

```ts
  // 1回の同期は3往復。入室時と script_ready で最大2回同期しても6回で足りる。
  // 再接続を挟んでも枯れないよう、余裕を見て20に置く。
  timeSyncMaxPerGame: 20,
```

- [ ] **Step 5: Device にカウンタを足す**

`server/src/roomStore.ts` の `Device` インターフェース、`signalCount` の直後に追加:

```ts
  timeSyncCount: number          // 1ゲーム中に投げた時刻同期 ping 数（resetRoom で 0 に戻す）
```

`addDevice` 内の device リテラル、`signalCount: 0,` の直後に `timeSyncCount: 0,` を追加。

`resetRoom` の `d.signalCount = 0` の行の直後に追加:

```ts
    d.timeSyncCount = 0 // 次のゲームぶんの時刻同期枠を戻す
```

- [ ] **Step 6: サーバーのハンドラを足す**

`server/src/handlers.ts`、`socket.on('rtc_signal', ...)` の登録の直前に追加:

```ts
    // 時刻同期。サーバーは状態を持たず、受け取った clientSent をエコーして
    // 自分の現在時刻を添えるだけ。クライアントが RTT と offset を計算する。
    socket.on('time_ping', ({ clientSent }) => {
      if (typeof clientSent !== 'number' || !Number.isFinite(clientSent)) return
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      // 数えるために Device が要る＝入室前の接続からは受けない。
      if (device.timeSyncCount >= limits.timeSyncMaxPerGame) return
      device.timeSyncCount++
      socket.emit('time_pong', { clientSent, serverNow: Date.now() })
    })
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm --prefix server test -- --test-name-pattern="time_"`
Expected: PASS（5 件）

- [ ] **Step 8: クライアント側の同期モジュールを書く**

`client/src/timeSync.ts` を新規作成:

```ts
import { socket } from './socket'
import { pickBestOffset, type SyncSample } from './timeSyncPure'

// サーバー時計との差。録音開始時刻を全端末で同じ物差しに載せるためだけに使う。
// 同期できていなければ 0＝補正なし（今日と同じ挙動）に落ちる。
let offsetMs = 0

const ROUNDS = 3
const GAP_MS = 200
const GIVE_UP_MS = ROUNDS * GAP_MS + 2000

let syncing = false

/** サーバー時計での「いま」。同期に失敗していれば端末の時計そのまま。 */
export function serverNow(): number {
  return Date.now() + offsetMs
}

/** 部屋を出るとき用。次の部屋へ古い補正を持ち越さない。 */
export function resetTimeSync(): void {
  offsetMs = 0
}

/**
 * 3往復して offset を測り直す。多重呼び出しは無視する（冪等）。
 * 失敗しても何も起きない＝offset は前の値のまま。録音も採点も止めない。
 */
export function syncClock(): void {
  if (syncing) return
  syncing = true
  const samples: SyncSample[] = []
  let sent = 0

  function finish(): void {
    if (!syncing) return
    syncing = false
    socket.off('time_pong', onPong)
    window.clearTimeout(giveUp)
    if (samples.length > 0) offsetMs = pickBestOffset(samples)
  }

  function onPong({ clientSent, serverNow: srv }: { clientSent: number; serverNow: number }): void {
    const rtt = Date.now() - clientSent
    // 往路と復路が等しいと仮定して、サーバーの「いま」を自分の時計へ写す
    samples.push({ rtt, offset: srv - (clientSent + rtt / 2) })
    if (samples.length >= ROUNDS) finish()
  }

  function tick(): void {
    if (sent >= ROUNDS) return
    sent++
    socket.emit('time_ping', { clientSent: Date.now() })
    if (sent < ROUNDS) window.setTimeout(tick, GAP_MS)
  }

  socket.on('time_pong', onPong)
  // 応答が欠けても必ず後始末する（listener を積み残さない）
  const giveUp = window.setTimeout(finish, GIVE_UP_MS)
  tick()
}
```

- [ ] **Step 9: 同期を呼ぶ場所を配線する**

`client/src/useGameSocket.ts` の import に追加（`import { insertPlayer } ...` の下）:

```ts
import { syncClock, resetTimeSync } from './timeSync'
```

以下の4か所の関数本体の**先頭**に `syncClock()` を1行入れる:

- `onRoomCreated` — `sessionStorage.setItem(TOKEN_KEY, token)` の直後
- `onRoomJoined` — `sessionStorage.setItem(TOKEN_KEY, token)` の直後
- `onRejoined` — `setDisconnected(false)` の直後
- `onScriptReady` — 関数の1行目（録音の直前に測り直す）

`onDissolved` の `sessionStorage.removeItem(TOKEN_KEY)` の直後に `resetTimeSync()` を入れる。

- [ ] **Step 10: Type check both sides**

Run: `npx --prefix server tsc --noEmit -p server` と `npx --prefix client tsc --noEmit -p client`
Expected: どちらもエラーなし

- [ ] **Step 11: Run full suites**

Run: `npm --prefix server test` と `npm --prefix client test`
Expected: 全 PASS（既存テストの回帰なし）

- [ ] **Step 12: Commit**

```bash
git add shared/events.ts server/src/limits.ts server/src/roomStore.ts server/src/handlers.ts client/src/timeSync.ts client/src/useGameSocket.ts server/tests/handlers.timeSync.test.ts
git commit -m "feat: 簡易時刻同期(time_ping/time_pong)を足す"
```

---

### Task 3: 録音開始時刻の申告と頭合わせ

**Files:**
- Modify: `server/src/roomStore.ts`（`Room.recordingStartedAt`・`audio` の値型）
- Modify: `server/src/handlers.ts`（`start_recording` で `recordingStartedAt` を立てる）
- Modify: `server/src/uploadRoute.ts`（`startedAt` の受理とクランプ）
- Modify: `client/src/recorder.ts`
- Test: `server/tests/handlers.upload.test.ts`（追記）

**Interfaces:**
- Consumes: `serverNow(): number`（Task 2）
- Produces: `Room.audio` の値が `{ buffer: Buffer; mime: string; delayMs: number }` になる。`delayMs` は「録音開始からこの端末の収録開始までの遅れ（ミリ秒）」で、`[0, 10000]` に収まることが保証される

**なぜ `startedAt` ではなく `delayMs` を保存するのか**: 消費側（合成）が欲しいのは差分だけで、絶対時刻を持ち回ると `recordingStartedAt` との突き合わせが2か所に散る。受け口で1回だけ解決してしまう。

- [ ] **Step 1: Write the failing test**

`server/tests/handlers.upload.test.ts` の末尾に追記:

```ts
function uploadAudioAt(port: number, socketId: string, startedAt: string) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  form.append('startedAt', startedAt)
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

test('startedAt から delayMs（録音開始からの遅れ）を算出して保存する', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const startedAt = server.rooms.get(roomCode)!.recordingStartedAt + 250
  const res = await uploadAudioAt(server.port, sid(host), String(startedAt))
  assert.equal(res.status, 200)
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 250)
  host.disconnect(); guest.disconnect()
})

test('startedAt が無ければ delayMs は 0（アップロードは成功する）', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const res = await uploadAudio(server.port, sid(host)) // startedAt を付けない
  assert.equal(res.status, 200)
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 0)
  host.disconnect(); guest.disconnect()
})

test('壊れた startedAt でもアップロードは成功し delayMs は 0 になる', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const res = await uploadAudioAt(server.port, sid(host), 'いつか')
  assert.equal(res.status, 200, '採点は音声が届くことに依存する＝ここで落としてはいけない')
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 0)
  host.disconnect(); guest.disconnect()
})

test('録音開始より前の startedAt は 0 にクランプする', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const startedAt = server.rooms.get(roomCode)!.recordingStartedAt - 5000
  await uploadAudioAt(server.port, sid(host), String(startedAt))
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 0)
  host.disconnect(); guest.disconnect()
})

test('過大な startedAt は 10 秒にクランプする（作品の頭に無音が延々入るのを防ぐ）', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const startedAt = server.rooms.get(roomCode)!.recordingStartedAt + 999_999
  await uploadAudioAt(server.port, sid(host), String(startedAt))
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 10_000)
  host.disconnect(); guest.disconnect()
})

test('start_recording で recordingStartedAt が立つ', async () => {
  const before = Date.now()
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const room = server.rooms.get(roomCode)!
  assert.ok(room.recordingStartedAt >= before && room.recordingStartedAt <= Date.now())
  host.disconnect(); guest.disconnect()
})
```

`makeCollectingRoom` は同ファイル冒頭に既にあるが `roomCode`/`hostDeviceId` を返しているので、そのまま使える。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- --test-name-pattern="startedAt|recordingStartedAt"`
Expected: FAIL — `recordingStartedAt` が `Room` に無いという型エラー、または `delayMs` が `undefined`

- [ ] **Step 3: Room に項目を足す**

`server/src/roomStore.ts` の `Room` インターフェース、`audio:` の行を差し替え、直前に1行足す:

```ts
  // 録音の開始時刻（サーバー時計）。各端末が申告する startedAt をこれと引き算して
  // 「頭のズレ」に直す。0 は「まだ録音していない」を表す。
  recordingStartedAt: number
  // deviceId ＝ 端末ごとに音声1本。delayMs は録音開始からこの端末の収録開始までの遅れ
  audio: Map<string, { buffer: Buffer; mime: string; delayMs: number }>
```

`createRoomStore` の room リテラル、`audio: new Map(),` の直前に `recordingStartedAt: 0,` を追加。

`resetRoom` の `room.audio.clear()` の直前に `room.recordingStartedAt = 0` を追加。

- [ ] **Step 4: start_recording で時刻を立てる**

`server/src/handlers.ts` の `socket.on('start_recording', ...)` 内、`room.recordingRoster = playerNames(room)` の直前に追加:

```ts
      room.recordingStartedAt = Date.now()
```

- [ ] **Step 5: /upload で受け取ってクランプする**

`server/src/uploadRoute.ts`、`const MAX_UPLOAD_BYTES` の直後に追加:

```ts
// 端末の収録開始が録音開始からどれだけ遅れてよいか。時刻同期の誤差や
// getUserMedia の許可ダイアログを見込んでも十分な幅を取りつつ、壊れた値で
// 作品の頭に無音が延々入るのを防ぐ蓋でもある。
const MAX_START_DELAY_MS = 10_000

// 端末が申告した収録開始時刻（サーバー時計）を「録音開始からの遅れ」に直す。
// 解釈できない値・録音開始前・過大値はすべて安全側（0 または上限）へ倒す。
// ここで例外を投げてはいけない：採点は音声が届くことに依存しており、
// 頭合わせはそれより優先度が低い。
export function resolveDelayMs(raw: unknown, recordingStartedAt: number): number {
  if (recordingStartedAt <= 0) return 0
  if (typeof raw !== 'string') return 0
  const startedAt = Number(raw.trim())
  if (!Number.isFinite(startedAt)) return 0
  const delay = startedAt - recordingStartedAt
  if (!(delay > 0)) return 0 // 負値・NaN・0 はすべてここに落ちる
  return Math.min(delay, MAX_START_DELAY_MS)
}
```

同ファイルのメインハンドラ、`room.audio.set(...)` の行を差し替え:

```ts
        if (file && file.buffer.length > 0) {
          const delayMs = resolveDelayMs(req.body?.startedAt, room.recordingStartedAt)
          room.audio.set(device.id, { buffer: file.buffer, mime: file.mimetype, delayMs })
          const name = room.players.get(device.playerIds[0] ?? '')?.name ?? socketId
          console.log(`[server] audio received: ${name} ${file.buffer.length} bytes ${file.mimetype} +${delayMs}ms`)
        }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm --prefix server test -- --test-name-pattern="startedAt|recordingStartedAt"`
Expected: PASS（6 件）

- [ ] **Step 7: クライアントが申告する**

`client/src/recorder.ts` の import に追加:

```ts
import { serverNow } from './timeSync'
```

`let lastTake: Blob | null = null` の直後に追加:

```ts
// このテイクの収録開始（サーバー時計）。合成時に全端末の頭を揃えるために申告する。
// 同期できていなければ端末の時計そのままで、サーバー側が安全側へ倒す。
let takeStartedAt = 0
```

`startUploadRecorder` の中、`rec.start()` の**直後**（`mediaRecorder = rec` の直前）に追加:

```ts
        takeStartedAt = serverNow() // 収録が始まったこの瞬間を控える
```

`startUploadRecorder` の冒頭、`lastTake = null` の直後に `takeStartedAt = 0` を追加（前回の値を持ち越さない）。

`stopAndUpload` の FormData 組み立てを差し替え:

```ts
  const form = new FormData()
  form.append('socketId', socketId)
  // startedAt は audio より前に積む（multer はフィールドを到着順にパースするため、
  // 25MB 超過で弾かれたときも socketId と一緒に読めている可能性が上がる）。
  if (takeStartedAt > 0) form.append('startedAt', String(takeStartedAt))
  if (blob) form.append('audio', blob, 'take.webm')
  else form.append('skip', '1')
```

`cancelRecording` の `chunks = []` の直後に `takeStartedAt = 0` を追加。

- [ ] **Step 8: Type check both sides**

Run: `npx --prefix server tsc --noEmit -p server` と `npx --prefix client tsc --noEmit -p client`
Expected: どちらもエラーなし

- [ ] **Step 9: Run full suites**

Run: `npm --prefix server test` と `npm --prefix client test`
Expected: 全 PASS

- [ ] **Step 10: Commit**

```bash
git add server/src/roomStore.ts server/src/handlers.ts server/src/uploadRoute.ts client/src/recorder.ts server/tests/handlers.upload.test.ts
git commit -m "feat: 録音開始時刻を申告し端末ごとの頭のズレを求める"
```

---

### Task 4: BGM/SE のタイムライン記録

**Files:**
- Modify: `server/src/roomStore.ts`（`TimelineEntry`・`Room.audioTimeline`・`Room.recordingDurationMs`）
- Modify: `server/src/handlers.ts`（`start_recording` / `send_bgm` / `send_sfx` / `beginAudioCollection`）
- Test: `server/tests/handlers.timeline.test.ts`

**Interfaces:**
- Consumes: `Room.recordingStartedAt`（Task 3）
- Produces:
  - `TimelineEntry { atMs: number; kind: 'bgm' | 'sfx'; id: string | null }`（`roomStore.ts` から export）
  - `Room.audioTimeline: TimelineEntry[]`、`Room.recordingDurationMs: number`
  - `MAX_TIMELINE_ENTRIES = 60`（`roomStore.ts` から export）

- [ ] **Step 1: Write the failing test**

`server/tests/handlers.timeline.test.ts` を新規作成:

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, makeRecordingRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => { server = await startTestServer() })
afterEach(async () => { await server.close() })

test('録音開始時に鳴っている BGM が無ければタイムラインは空で始まる', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  assert.deepEqual(server.rooms.get(roomCode)!.audioTimeline, [])
  host.disconnect(); guest.disconnect()
})

test('send_bgm がタイムラインに積まれる（中継も従来どおり行われる）', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const changed = once<{ bgmId: string | null }>(guest, 'bgm_changed')
  host.emit('send_bgm', { bgmId: 'horror' })
  assert.equal((await changed).bgmId, 'horror', '中継は今までどおり行われること')
  const tl = server.rooms.get(roomCode)!.audioTimeline
  assert.equal(tl.length, 1)
  assert.equal(tl[0].kind, 'bgm')
  assert.equal(tl[0].id, 'horror')
  assert.ok(tl[0].atMs >= 0 && tl[0].atMs < 3000)
  host.disconnect(); guest.disconnect()
})

test('BGM 停止（null）もエントリとして残る', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  host.emit('send_bgm', { bgmId: 'comedy' })
  await once(guest, 'bgm_changed')
  host.emit('send_bgm', { bgmId: null })
  await once(guest, 'bgm_changed')
  const tl = server.rooms.get(roomCode)!.audioTimeline
  assert.equal(tl.length, 2)
  assert.equal(tl[1].id, null, '区間を閉じるために null が要る')
  host.disconnect(); guest.disconnect()
})

test('send_sfx がタイムラインに積まれる', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const played = once(guest, 'sfx_played')
  host.emit('send_sfx', { sfxId: 'drum' })
  await played
  const tl = server.rooms.get(roomCode)!.audioTimeline
  assert.deepEqual(tl.map(e => [e.kind, e.id]), [['sfx', 'drum']])
  host.disconnect(); guest.disconnect()
})

test('不正な id はタイムラインにも積まれない', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  host.emit('send_sfx', { sfxId: 'にせもの' })
  host.emit('send_bgm', { bgmId: 'にせもの' })
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(server.rooms.get(roomCode)!.audioTimeline, [])
  host.disconnect(); guest.disconnect()
})

test('60 件を超えたぶんはタイムラインに積まない（中継は続く）', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  for (let i = 0; i < 70; i++) host.emit('send_sfx', { sfxId: 'drum' })
  await new Promise(r => setTimeout(r, 500))
  assert.equal(server.rooms.get(roomCode)!.audioTimeline.length, 60)
  host.disconnect(); guest.disconnect()
})

test('stop_recording で recordingDurationMs が確定する', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  await new Promise(r => setTimeout(r, 120))
  const stopped = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  const room = server.rooms.get(roomCode)!
  assert.ok(room.recordingDurationMs >= 100, `実尺が入ること (got ${room.recordingDurationMs})`)
  host.disconnect(); guest.disconnect()
})

test('録音していない状態（casting 以前）の send_bgm はタイムラインを汚さない', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stopped = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  host.emit('send_bgm', { bgmId: 'battle' }) // status は evaluating
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(server.rooms.get(roomCode)!.audioTimeline, [])
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- --test-name-pattern="タイムライン|recordingDurationMs"`
Expected: FAIL — `audioTimeline` が `Room` に無い

- [ ] **Step 3: Room に項目を足す**

`server/src/roomStore.ts`、`Room` インターフェースの直前に追加:

```ts
/** 録音中に鳴らした BGM/SE の1件。合成時にこの順で重ね直す。 */
export interface TimelineEntry {
  atMs: number              // 録音開始からの経過ミリ秒
  kind: 'bgm' | 'sfx'
  id: string | null         // bgm の停止を null で表す。sfx では常に非 null
}

// タイムラインの上限。ffmpeg の入力本数が青天井にならないための蓋であり、
// 正常なプレイでこの数に届くことはない（届いたら荒らしである）。
export const MAX_TIMELINE_ENTRIES = 60
```

`Room` インターフェースの `recordingStartedAt: number` の直後に追加:

```ts
  // 録音の実尺。beginAudioCollection で確定する。合成の -t に使う
  recordingDurationMs: number
  // 録音中に鳴らした BGM/SE。合成のためだけに持つ（中継の挙動には影響しない）
  audioTimeline: TimelineEntry[]
```

`createRoomStore` の room リテラル、`recordingStartedAt: 0,` の直後に追加:

```ts
      recordingDurationMs: 0,
      audioTimeline: [],
```

`resetRoom` の `room.recordingStartedAt = 0` の直後に追加:

```ts
  room.recordingDurationMs = 0
  room.audioTimeline = []
```

- [ ] **Step 4: handlers で記録する**

`server/src/handlers.ts` の import、`import type { Room, RoomStore, Device } from './roomStore'` を差し替え:

```ts
import type { Room, RoomStore, Device } from './roomStore'
import { MAX_TIMELINE_ENTRIES } from './roomStore'
```

`createHandlers` 内、`representativeName` 関数の直後に追加:

```ts
  // BGM/SE を合成用タイムラインに1件積む。上限を超えたら黙って捨てる
  // （中継は呼び出し側で既に済んでおり、作品からその1音が抜けるだけで済む）。
  function recordTimeline(room: Room, kind: 'bgm' | 'sfx', id: string | null): void {
    if (room.audioTimeline.length >= MAX_TIMELINE_ENTRIES) return
    room.audioTimeline.push({ atMs: Date.now() - room.recordingStartedAt, kind, id })
  }
```

`socket.on('start_recording', ...)` 内、`room.recordingStartedAt = Date.now()` の直後に追加:

```ts
      room.recordingDurationMs = 0
      room.audioTimeline = []
      // 録音開始の時点で既に鳴っている BGM があれば、0 秒地点から始まる区間として置く
      if (room.bgm) room.audioTimeline.push({ atMs: 0, kind: 'bgm', id: room.bgm })
```

`socket.on('send_sfx', ...)` 内、`socket.to(room.code).emit('sfx_played', ...)` の直後に追加:

```ts
      recordTimeline(room, 'sfx', sfxId)
```

`socket.on('send_bgm', ...)` 内、`io.to(room.code).emit('bgm_changed', ...)` の直後に追加:

```ts
      recordTimeline(room, 'bgm', bgmId)
```

`beginAudioCollection` 内、`room.status = 'evaluating'` の直前に追加:

```ts
    room.recordingDurationMs = Math.max(0, Date.now() - room.recordingStartedAt)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix server test -- --test-name-pattern="タイムライン|recordingDurationMs|BGM"`
Expected: PASS（8 件）

- [ ] **Step 6: Type check and full suite**

Run: `npx --prefix server tsc --noEmit -p server` と `npm --prefix server test`
Expected: エラーなし・全 PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/roomStore.ts server/src/handlers.ts server/tests/handlers.timeline.test.ts
git commit -m "feat: 録音中のBGM/SEを合成用タイムラインに記録する"
```

---

### Task 5: ffmpeg 引数を組み立てる純粋関数

**Files:**
- Create: `server/src/mixdownPlan.ts`
- Test: `server/tests/mixdownPlan.test.ts`

**Interfaces:**
- Consumes: `TimelineEntry`、`MAX_TIMELINE_ENTRIES`（Task 4）
- Produces:
  - `BgmSegment { id: string; startMs: number; endMs: number }`
  - `SfxHit { id: string; atMs: number }`
  - `bgmSegments(timeline: TimelineEntry[], durationMs: number): BgmSegment[]`
  - `sfxHits(timeline: TimelineEntry[], durationMs: number): SfxHit[]`
  - `PlanTrack { path: string; delayMs: number }`
  - `PlanInput { tracks: PlanTrack[]; timeline: TimelineEntry[]; durationMs: number; audioDir: string; outPath: string }`
  - `buildFfmpegArgs(input: PlanInput): string[]`

**仕様書からの精密化**: 設計書の図は `adelay=D|D` と書いているが、この記法は入力のチャンネル数に依存する。マイク（モノラル）と mp3（ステレオ）が混ざるので、チャンネル数に依存しない `adelay=delays=D:all=1` を使う。効果は同じで、モノラル入力で遅延が片チャンネルにしか効かない事故を構造的に防げる。

- [ ] **Step 1: Write the failing test**

`server/tests/mixdownPlan.test.ts` を新規作成:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bgmSegments, sfxHits, buildFfmpegArgs } from '../src/mixdownPlan'
import type { TimelineEntry } from '../src/roomStore'

const bgm = (atMs: number, id: string | null): TimelineEntry => ({ atMs, kind: 'bgm', id })
const sfx = (atMs: number, id: string): TimelineEntry => ({ atMs, kind: 'sfx', id })

test('BGM 区間は次の bgm エントリで閉じる', () => {
  const tl = [bgm(0, 'horror'), bgm(5000, 'comedy')]
  assert.deepEqual(bgmSegments(tl, 12_000), [
    { id: 'horror', startMs: 0, endMs: 5000 },
    { id: 'comedy', startMs: 5000, endMs: 12_000 },
  ])
})

test('最後の BGM 区間は録音の実尺で閉じる', () => {
  assert.deepEqual(bgmSegments([bgm(2000, 'battle')], 9000), [
    { id: 'battle', startMs: 2000, endMs: 9000 },
  ])
})

test('id が null のエントリは区間を閉じるだけで新しい区間を作らない', () => {
  const tl = [bgm(0, 'horror'), bgm(3000, null), bgm(8000, 'comedy')]
  assert.deepEqual(bgmSegments(tl, 10_000), [
    { id: 'horror', startMs: 0, endMs: 3000 },
    { id: 'comedy', startMs: 8000, endMs: 10_000 },
  ])
})

test('sfx エントリは BGM 区間の切れ目に影響しない', () => {
  const tl = [bgm(0, 'horror'), sfx(1000, 'drum'), bgm(4000, null)]
  assert.deepEqual(bgmSegments(tl, 10_000), [{ id: 'horror', startMs: 0, endMs: 4000 }])
})

test('長さ 0 以下になる区間は落とす', () => {
  const tl = [bgm(5000, 'horror'), bgm(5000, 'comedy')]
  assert.deepEqual(bgmSegments(tl, 9000), [{ id: 'comedy', startMs: 5000, endMs: 9000 }])
})

test('実尺を超えた位置で始まる区間は落とす', () => {
  assert.deepEqual(bgmSegments([bgm(20_000, 'horror')], 9000), [])
})

test('sfxHits は sfx だけを拾い実尺を超えたものは落とす', () => {
  const tl = [bgm(0, 'horror'), sfx(1000, 'drum'), sfx(50_000, 'boom')]
  assert.deepEqual(sfxHits(tl, 9000), [{ id: 'drum', atMs: 1000 }])
})

test('タイムラインは 60 件までしか読まない', () => {
  const tl: TimelineEntry[] = []
  for (let i = 0; i < 100; i++) tl.push(sfx(i * 10, 'drum'))
  assert.equal(sfxHits(tl, 60_000).length, 60)
})

// --- buildFfmpegArgs ---

const PLAN = {
  tracks: [
    { path: '/tmp/a.webm', delayMs: 0 },
    { path: '/tmp/b.mp4', delayMs: 250 },
  ],
  timeline: [bgm(0, 'horror'), sfx(3000, 'drum')],
  durationMs: 10_000,
  audioDir: '/app/audio',
  outPath: '/tmp/out.m4a',
}

test('声のトラックが先頭から順に -i に並ぶ', () => {
  const args = buildFfmpegArgs(PLAN)
  assert.equal(args.indexOf('/tmp/a.webm'), args.indexOf('/tmp/b.mp4') - 2)
})

test('BGM は -stream_loop -1 付きで入力に並ぶ（録音より短くても最後まで鳴る）', () => {
  const args = buildFfmpegArgs(PLAN)
  const i = args.findIndex(a => a.endsWith('horror.mp3'))
  assert.ok(i > 0)
  assert.equal(args[i - 1], '-i')
  assert.equal(args[i - 2], '-1')
  assert.equal(args[i - 3], '-stream_loop')
})

test('SE は stream_loop なしで入力に並ぶ', () => {
  const args = buildFfmpegArgs(PLAN)
  const i = args.findIndex(a => a.endsWith('drum.mp3'))
  assert.equal(args[i - 1], '-i')
  assert.notEqual(args[i - 2], '-1')
})

test('端末ごとの遅れが adelay に反映される', () => {
  const filter = buildFfmpegArgs(PLAN)[buildFfmpegArgs(PLAN).indexOf('-filter_complex') + 1]
  assert.match(filter, /\[0:a\][^;]*adelay=delays=0:all=1/)
  assert.match(filter, /\[1:a\][^;]*adelay=delays=250:all=1/)
})

test('amix は normalize=0（人数が増えても音が小さくならない）', () => {
  const filter = buildFfmpegArgs(PLAN)[buildFfmpegArgs(PLAN).indexOf('-filter_complex') + 1]
  assert.match(filter, /amix=inputs=4:normalize=0:dropout_transition=0/)
  assert.match(filter, /alimiter/)
})

test('BGM のフェードは 0.1 秒（audioBus.ts の FADE_SEC と同値）', () => {
  const filter = buildFfmpegArgs(PLAN)[buildFfmpegArgs(PLAN).indexOf('-filter_complex') + 1]
  assert.match(filter, /afade=t=in:st=0:d=0\.1/)
  assert.match(filter, /afade=t=out:st=9\.900:d=0\.1/) // toFixed(3) なので 9.9 ではなく 9.900
})

test('出力は m4a/AAC で、-t が録音の実尺に一致する', () => {
  const args = buildFfmpegArgs(PLAN)
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
  assert.equal(args[args.indexOf('-t') + 1], '10.000')
  assert.equal(args[args.length - 1], '/tmp/out.m4a')
})

test('BGM も SE も無ければ声だけで組み立てる', () => {
  const args = buildFfmpegArgs({ ...PLAN, timeline: [] })
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /amix=inputs=2:normalize=0/)
})

test('声が1本でも組み立てられる（1人プレイ）', () => {
  const args = buildFfmpegArgs({ ...PLAN, tracks: [{ path: '/tmp/a.webm', delayMs: 0 }], timeline: [] })
  const filter = args[args.indexOf('-filter_complex') + 1]
  assert.match(filter, /amix=inputs=1:normalize=0/)
})

test('入力が1本も無ければ投げる（呼び出し側が先に弾く契約）', () => {
  assert.throws(() => buildFfmpegArgs({ ...PLAN, tracks: [], timeline: [] }), /no inputs/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server test -- --test-name-pattern="BGM 区間|adelay|amix|m4a"`
Expected: FAIL — `Cannot find module '../src/mixdownPlan'`

- [ ] **Step 3: Write the implementation**

`server/src/mixdownPlan.ts` を新規作成:

```ts
import { join } from 'node:path'
import { MAX_TIMELINE_ENTRIES } from './roomStore'
import type { TimelineEntry } from './roomStore'

// ffmpeg の引数を組み立てるだけの純粋モジュール。プロセスも一時ファイルも触らない
// （そちらは mixdown.ts の仕事）。ここを分けているのは、合成の「判断」の部分だけを
// ffmpeg 無しでテストできるようにするため。

/** 1つの BGM が鳴っていた区間 */
export interface BgmSegment { id: string; startMs: number; endMs: number }
/** 1回鳴った SE */
export interface SfxHit { id: string; atMs: number }

export interface PlanTrack {
  path: string      // 一時ファイルに書き出した端末の録音
  delayMs: number   // 録音開始からこの端末の収録開始までの遅れ
}

export interface PlanInput {
  tracks: PlanTrack[]
  timeline: TimelineEntry[]
  durationMs: number
  audioDir: string  // BGM/SE の mp3 の置き場（bgm/ と sfx/ を含むディレクトリ）
  outPath: string
}

// クライアントの audioBus.ts の FADE_SEC と同値。耳で聞いた切り替わりと
// 合成版を揃えるための一致であり、片方だけ変えてはならない。
const FADE_SEC = 0.1
// 全入力をここに揃えてから混ぜる。マイクはモノラル、mp3 はステレオで来るため。
const FORMAT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

function sec(ms: number): string {
  return (ms / 1000).toFixed(3)
}

/**
 * タイムラインを「BGM が鳴っていた区間」の列に畳む。
 * 区間は次の bgm エントリで閉じ、最後の区間は録音の実尺で閉じる。
 * id が null のエントリは区間を閉じるだけで新しい区間を開かない。
 */
export function bgmSegments(timeline: TimelineEntry[], durationMs: number): BgmSegment[] {
  const entries = timeline.slice(0, MAX_TIMELINE_ENTRIES).filter(e => e.kind === 'bgm')
  const out: BgmSegment[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.id === null) continue
    const startMs = Math.max(0, e.atMs)
    const endMs = Math.min(entries[i + 1]?.atMs ?? durationMs, durationMs)
    if (endMs - startMs <= 0) continue // 即座に切り替えられた＝鳴っていない
    out.push({ id: e.id, startMs, endMs })
  }
  return out
}

/** タイムラインから SE の発音だけを拾う。実尺を超えたものは落とす。 */
export function sfxHits(timeline: TimelineEntry[], durationMs: number): SfxHit[] {
  return timeline
    .slice(0, MAX_TIMELINE_ENTRIES)
    .filter((e): e is TimelineEntry & { id: string } => e.kind === 'sfx' && e.id !== null)
    .filter(e => e.atMs >= 0 && e.atMs < durationMs)
    .map(e => ({ id: e.id, atMs: e.atMs }))
}

/**
 * ffmpeg の引数一式を組み立てる。
 *
 * 配線はクライアントの audioBus.ts をそのまま再現する：
 *   声・BGM・SE をすべてゲイン 1.0 で1つに混ぜ、最後にリミッタでクリップだけ止める。
 * amix の既定（normalize=1）は入力数で割ってしまい、人数が増えるほど作品が
 * 小さくなるので必ず normalize=0 にする。
 *
 * adelay は `delays=D:all=1` を使う。`D|D` 記法は入力のチャンネル数に依存し、
 * モノラルのマイクでは片チャンネルにしか効かない。
 */
export function buildFfmpegArgs(input: PlanInput): string[] {
  const { tracks, timeline, durationMs, audioDir, outPath } = input
  const segments = bgmSegments(timeline, durationMs)
  const hits = sfxHits(timeline, durationMs)

  const inputArgs: string[] = []
  const filters: string[] = []
  const labels: string[] = []
  let idx = 0

  for (const t of tracks) {
    inputArgs.push('-i', t.path)
    const label = `v${idx}`
    filters.push(`[${idx}:a]${FORMAT},adelay=delays=${Math.round(t.delayMs)}:all=1[${label}]`)
    labels.push(`[${label}]`)
    idx++
  }

  for (const s of segments) {
    // BGM は録音より短いことがある。-stream_loop -1 で無限ループさせ、
    // atrim で区間の長さに切る（クライアントの src.loop = true と同じ挙動）。
    inputArgs.push('-stream_loop', '-1', '-i', join(audioDir, 'bgm', `${s.id}.mp3`))
    const lenSec = (s.endMs - s.startMs) / 1000
    const label = `b${idx}`
    const parts = [`atrim=0:${lenSec.toFixed(3)}`, 'asetpts=N/SR/TB']
    // 区間が短すぎるとフェードが重なって不自然になるので、その場合は掛けない
    if (lenSec > FADE_SEC * 2) {
      parts.push(`afade=t=in:st=0:d=${FADE_SEC}`)
      parts.push(`afade=t=out:st=${(lenSec - FADE_SEC).toFixed(3)}:d=${FADE_SEC}`)
    }
    parts.push(FORMAT, `adelay=delays=${Math.round(s.startMs)}:all=1`)
    filters.push(`[${idx}:a]${parts.join(',')}[${label}]`)
    labels.push(`[${label}]`)
    idx++
  }

  for (const h of hits) {
    inputArgs.push('-i', join(audioDir, 'sfx', `${h.id}.mp3`))
    const label = `s${idx}`
    filters.push(`[${idx}:a]${FORMAT},adelay=delays=${Math.round(h.atMs)}:all=1[${label}]`)
    labels.push(`[${label}]`)
    idx++
  }

  if (labels.length === 0) throw new Error('mixdown: no inputs')

  filters.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,` +
    `alimiter=level_in=1:limit=0.95[out]`,
  )

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-t', sec(durationMs),
    '-movflags', '+faststart',
    outPath,
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server test -- --test-name-pattern="BGM 区間|sfxHits|adelay|amix|m4a|声が1本|入力が1本"`
Expected: PASS（18 件）

- [ ] **Step 5: Type check and full suite**

Run: `npx --prefix server tsc --noEmit -p server` と `npm --prefix server test`
Expected: エラーなし・全 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/mixdownPlan.ts server/tests/mixdownPlan.test.ts
git commit -m "feat: 合成の ffmpeg 引数を組み立てる純粋関数を足す"
```

---

### Task 6: ffmpeg を実行する mixdown

**Files:**
- Create: `server/src/mixdown.ts`
- Modify: `server/package.json`（`ffmpeg-static` を dependencies に）
- Test: `server/tests/mixdown.test.ts`

**Interfaces:**
- Consumes: `buildFfmpegArgs`、`PlanInput`（Task 5）、`TimelineEntry`（Task 4）
- Produces:
  - `MixTrack { buffer: Buffer; mime: string; delayMs: number }`
  - `MixInput { tracks: MixTrack[]; timeline: TimelineEntry[]; durationMs: number; audioDir: string }`
  - `type Mixdown = (input: MixInput) => Promise<Buffer>`
  - `createMixdown(): Mixdown`
  - `probeFfmpeg(): Promise<boolean>`（起動ログ用）

**同時実行を1本に絞る理由**: 複数の部屋が同時に採点を終えると ffmpeg が同時に立ち上がる。Railway の小さいインスタンスでメモリと CPU を踏み抜かないよう、小さなキューで直列化する。合成は数秒なので、待たせても体感に響かない。

- [ ] **Step 1: 依存を足す**

Run:
```bash
npm --prefix server install ffmpeg-static@^5.3.0
```

`server/package.json` の `dependencies` に `"ffmpeg-static": "^5.3.0"` が入ったことを確認する。**入らなかった場合はここで止めて報告する**（設計書 12 節のとおり、apt 経由への切り替え判断が要る）。

- [ ] **Step 2: Write the failing test**

`server/tests/mixdown.test.ts` を新規作成:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMixdown, probeFfmpeg } from '../src/mixdown'

const here = dirname(fileURLToPath(import.meta.url))
const AUDIO_DIR = resolve(here, '../../client/public/audio')

// 素材として本物の mp3 を使う（マイク録音の代わり）。webm/mp4 を用意しなくても
// 「複数の入力を遅延つきで混ぜて m4a が出る」ことは検証できる。
function realAudio(): Buffer {
  return readFileSync(resolve(AUDIO_DIR, 'sfx/drum.mp3'))
}

test('ffmpeg が使えるかを調べられる', async () => {
  const ok = await probeFfmpeg()
  assert.equal(typeof ok, 'boolean')
})

test('複数トラックと BGM/SE を混ぜて m4a が返る', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const out = await mixdown({
    tracks: [
      { buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 },
      { buffer: realAudio(), mime: 'audio/mpeg', delayMs: 300 },
    ],
    timeline: [
      { atMs: 0, kind: 'bgm', id: 'comedy' },
      { atMs: 500, kind: 'sfx', id: 'drum' },
    ],
    durationMs: 3000,
    audioDir: AUDIO_DIR,
  })
  assert.ok(out.length > 1000, `中身のある m4a が返ること (got ${out.length} bytes)`)
  // ISO BMFF は先頭ボックスが ftyp（4バイト長 + 'ftyp'）
  assert.equal(out.subarray(4, 8).toString('ascii'), 'ftyp')
})

test('トラック1本・BGM なしでも合成できる（1人プレイ）', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const out = await mixdown({
    tracks: [{ buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 }],
    timeline: [],
    durationMs: 2000,
    audioDir: AUDIO_DIR,
  })
  assert.equal(out.subarray(4, 8).toString('ascii'), 'ftyp')
})

test('トラックが空なら reject する', async () => {
  const mixdown = createMixdown()
  await assert.rejects(
    () => mixdown({ tracks: [], timeline: [], durationMs: 1000, audioDir: AUDIO_DIR }),
    /no inputs/,
  )
})

test('壊れた音声を渡しても reject するだけで例外は漏れない', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  await assert.rejects(() => mixdown({
    tracks: [{ buffer: Buffer.from('これは音声ではない'), mime: 'audio/webm', delayMs: 0 }],
    timeline: [],
    durationMs: 1000,
    audioDir: AUDIO_DIR,
  }))
})

test('同時に投げても直列に処理され、すべて解決する', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const one = () => mixdown({
    tracks: [{ buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 }],
    timeline: [],
    durationMs: 1000,
    audioDir: AUDIO_DIR,
  })
  const outs = await Promise.all([one(), one(), one()])
  for (const out of outs) assert.ok(out.length > 500)
})

test('失敗が後続をブロックしない（キューが詰まらない）', async t => {
  if (!(await probeFfmpeg())) return t.skip('ffmpeg が無い環境')
  const mixdown = createMixdown()
  const bad = mixdown({
    tracks: [{ buffer: Buffer.from('だめ'), mime: 'audio/webm', delayMs: 0 }],
    timeline: [], durationMs: 1000, audioDir: AUDIO_DIR,
  }).catch(() => 'failed' as const)
  const good = mixdown({
    tracks: [{ buffer: realAudio(), mime: 'audio/mpeg', delayMs: 0 }],
    timeline: [], durationMs: 1000, audioDir: AUDIO_DIR,
  })
  assert.equal(await bad, 'failed')
  assert.ok((await good).length > 500)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix server test -- --test-name-pattern="ffmpeg|m4a|1人プレイ|キュー"`
Expected: FAIL — `Cannot find module '../src/mixdown'`

- [ ] **Step 4: Write the implementation**

`server/src/mixdown.ts` を新規作成:

```ts
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { buildFfmpegArgs } from './mixdownPlan'
import type { TimelineEntry } from './roomStore'

// ffmpeg を実際に動かす層。引数の組み立ては mixdownPlan.ts が持つ。

export interface MixTrack {
  buffer: Buffer
  mime: string
  delayMs: number
}

export interface MixInput {
  tracks: MixTrack[]
  timeline: TimelineEntry[]
  durationMs: number
  audioDir: string
}

export type Mixdown = (input: MixInput) => Promise<Buffer>

// 30 秒。2分半の素材を数本混ぜるのに実測で数秒しかかからないので、
// これを超えたら何かが刺さっている＝殺してよい。
const TIMEOUT_MS = 30_000

// バイナリの決め方。FFMPEG_BINARY は Railway で apt 版へ切り替える逃げ道
// （設計書 12 節）。どちらも無ければ PATH の ffmpeg に賭ける。
function ffmpegBinary(): string {
  const override = process.env.FFMPEG_BINARY?.trim()
  if (override) return override
  return ffmpegStatic ?? 'ffmpeg'
}

const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}

// ffmpeg はコンテナを中身から判定できるが、拡張子があるほうが確実に当たる。
function extForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  return MIME_EXT[base] ?? 'webm'
}

function run(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      // 全部ためると壊れた入力で巨大になりうる。診断に足るぶんだけ持つ。
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ffmpeg timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    timer.unref()
    child.on('error', err => {
      clearTimeout(timer)
      reject(err) // バイナリが無い等
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))
    })
  })
}

/** ffmpeg が起動できるか。起動ログ用。結果は覚えない（1回しか呼ばれない想定）。 */
export async function probeFfmpeg(): Promise<boolean> {
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-version'])
    return true
  } catch {
    return false
  }
}

// 同時実行を1本に絞る。複数の部屋が同時に採点を終えたときに ffmpeg が
// 並列で立ち上がり、Railway の小さいインスタンスを踏み抜くのを防ぐ。
// 失敗しても鎖を切らない（catch を挟まないと後続が全部巻き添えで落ちる）。
let chain: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn)
  chain = result.catch(() => undefined)
  return result
}

export function createMixdown(): Mixdown {
  return async function mixdown(input: MixInput): Promise<Buffer> {
    if (input.tracks.length === 0) throw new Error('mixdown: no inputs')
    return enqueue(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kojirase-mix-'))
      try {
        const tracks = await Promise.all(
          input.tracks.map(async (t, i) => {
            const path = join(dir, `take${i}.${extForMime(t.mime)}`)
            await writeFile(path, t.buffer)
            return { path, delayMs: t.delayMs }
          }),
        )
        const outPath = join(dir, 'work.m4a')
        await run(buildFfmpegArgs({
          tracks,
          timeline: input.timeline,
          durationMs: input.durationMs,
          audioDir: input.audioDir,
          outPath,
        }))
        return await readFile(outPath)
      } finally {
        // 成功しても失敗しても必ず消す。残すとコンテナの /tmp が育っていく。
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix server test -- --test-name-pattern="ffmpeg|m4a|1人プレイ|キュー|直列|reject"`
Expected: PASS。**ffmpeg が使えない環境では skip が出るが、`ffmpeg が無い環境` の skip が出た場合は先へ進む前に報告すること**（本番で合成が常に失敗する構成になる）

- [ ] **Step 6: Type check and full suite**

Run: `npx --prefix server tsc --noEmit -p server` と `npm --prefix server test`
Expected: エラーなし・全 PASS

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/mixdown.ts server/tests/mixdown.test.ts
git commit -m "feat: ffmpeg で全員の音声とBGM/SEを1本のm4aに合成する"
```

---

### Task 7: 作品の生成・保持・配信

**Files:**
- Modify: `server/src/roomStore.ts`（`Room.work`・`Room.workToken`）
- Modify: `server/src/limits.ts`（`workRateWindowMs` / `workRateMax`）
- Modify: `server/src/handlers.ts`（`mixdown` / `audioDir` の注入・`startMixdown`）
- Modify: `shared/events.ts`（`work_ready` / `work_failed`）
- Create: `server/src/workRoute.ts`
- Modify: `server/src/server.ts`（`resolveAudioDir` の追加と配線）
- Modify: `server/src/index.ts`（起動ログ）
- Test: `server/tests/handlers.work.test.ts`、`server/tests/workRoute.test.ts`

**Interfaces:**
- Consumes: `createMixdown()`、`Mixdown`、`MixInput`（Task 6）、`Room.audio`（Task 3）、`Room.audioTimeline` / `Room.recordingDurationMs`（Task 4）
- Produces:
  - イベント `work_ready: (payload: { url: string }) => void`、`work_failed: () => void`（S2C）
  - `Room.work: Buffer | null`、`Room.workToken: string | null`
  - `createWorkRoute(deps: { rooms: RoomStore; limits: Limits }): (app: Express) => void`
  - `resolveAudioDir(distDir: string): string`（`server.ts` から export）
  - `createHandlers` の deps に `mixdown: Mixdown` と `audioDir: string` が加わる
  - `buildServer` の options に `mixdown?: Mixdown` が加わる

**`work_ready` がパスを運ぶ理由**: 同居デプロイではクライアントの `SERVER_URL` が空文字になる。サーバー側でホスト名を組むとリバースプロキシ配下で壊れるので、サーバーはパスだけを返し、クライアントが `${SERVER_URL}${url}` を組む。

- [ ] **Step 1: Write the failing tests**

`server/tests/handlers.work.test.ts` を新規作成:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, expectNoEvent, makeRecordingRoom, uploadSkip } from './testUtils'
import type { Socket } from 'socket.io-client'
import type { Mixdown } from '../src/mixdown'

const sid = (s: Socket): string => s.id as string
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])
const WORK = Buffer.from('mixed-work-bytes')

let server: Awaited<ReturnType<typeof startTestServer>>

function uploadAudio(port: number, socketId: string) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

afterEach(async () => { await server.close() })

// 収集ウィンドウを開いた host/guest を返す
async function collecting() {
  const r = await makeRecordingRoom(server.port)
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  return r
}

test('採点完了のあとに work_ready がパスつきで届く', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const ready = once<{ url: string }>(host, 'work_ready')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await once(host, 'evaluation_complete')
  const { url } = await ready
  const room = server.rooms.get(roomCode)!
  assert.equal(url, `/work/${roomCode}/${room.workToken}`, 'パスだけを返すこと（ホスト名を組まない）')
  assert.ok(room.workToken && room.workToken.length > 10, '推測できないトークンであること')
  assert.deepEqual(room.work, WORK)
  host.disconnect(); guest.disconnect()
})

test('work_ready は evaluation_complete より後に出る（採点を待たせない）', async () => {
  let resolveMix: (b: Buffer) => void = () => {}
  const mixdown: Mixdown = () => new Promise<Buffer>(r => { resolveMix = r })
  server = await startTestServer({ mixdown })
  const { host, guest } = await collecting()
  const ready = once(host, 'work_ready', 5000)
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await once(host, 'evaluation_complete') // 合成が終わっていなくても採点は出る
  resolveMix(WORK)
  await ready
  host.disconnect(); guest.disconnect()
})

test('合成に成功したら room.audio は破棄される（メモリを抱えない）', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const ready = once(host, 'work_ready')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await ready
  assert.equal(server.rooms.get(roomCode)!.audio.size, 0)
  host.disconnect(); guest.disconnect()
})

test('合成が失敗したら work_failed が出て work は空のまま', async () => {
  const mixdown: Mixdown = async () => { throw new Error('boom') }
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const failed = once(host, 'work_failed')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await failed
  assert.equal(server.rooms.get(roomCode)!.work, null)
  host.disconnect(); guest.disconnect()
})

test('全員がマイク拒否なら合成せず work_failed を出す', async () => {
  let called = false
  const mixdown: Mixdown = async () => { called = true; return WORK }
  server = await startTestServer({ mixdown })
  const { host, guest } = await collecting()
  const failed = once(host, 'work_failed')
  await uploadSkip(server.port, sid(host))
  await uploadSkip(server.port, sid(guest))
  await failed
  assert.equal(called, false, '素材が無いのに ffmpeg を起動しないこと')
  host.disconnect(); guest.disconnect()
})

test('合成中にロビーへ戻ったら work_ready は出ない', async () => {
  let resolveMix: (b: Buffer) => void = () => {}
  const mixdown: Mixdown = () => new Promise<Buffer>(r => { resolveMix = r })
  server = await startTestServer({ mixdown })
  const { host, guest } = await collecting()
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await once(host, 'evaluation_complete')
  const reset = once(host, 'room_reset')
  host.emit('return_to_lobby')
  guest.emit('return_to_lobby')
  await reset
  const quiet = expectNoEvent(host, 'work_ready', 400)
  resolveMix(WORK)
  await quiet
  host.disconnect(); guest.disconnect()
})

test('ロビーへ戻ると work と workToken が消える', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const ready = once(host, 'work_ready')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await ready
  const reset = once(host, 'room_reset')
  host.emit('return_to_lobby')
  guest.emit('return_to_lobby')
  await reset
  const room = server.rooms.get(roomCode)!
  assert.equal(room.work, null)
  assert.equal(room.workToken, null)
  host.disconnect(); guest.disconnect()
})

test('合成には端末ごとの遅れとタイムラインが渡る', async () => {
  let seen: Parameters<Mixdown>[0] | null = null
  const mixdown: Mixdown = async input => { seen = input; return WORK }
  server = await startTestServer({ mixdown })
  const r = await makeRecordingRoom(server.port)
  r.host.emit('send_sfx', { sfxId: 'drum' })
  await once(r.guest, 'sfx_played')
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const ready = once(r.host, 'work_ready')
  const form = new FormData()
  form.append('socketId', sid(r.host))
  form.append('startedAt', String(server.rooms.get(r.roomCode)!.recordingStartedAt + 400))
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  await uploadAudio(server.port, sid(r.guest))
  await ready
  // いったん別の const に移す。let のまま assert.ok に渡すと、TS は
  // 「コールバックの代入は見えない」ので null に絞り、続く参照が never になる。
  const captured = seen as Parameters<Mixdown>[0] | null
  assert.ok(captured, '合成が呼ばれること')
  assert.ok(captured.tracks.some(t => t.delayMs === 400), '申告した遅れが渡ること')
  assert.deepEqual(captured.timeline.map(e => e.id), ['drum'])
  assert.ok(captured.durationMs > 0)
  r.host.disconnect(); r.guest.disconnect()
})
```

`server/tests/workRoute.test.ts` を新規作成:

```ts
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, makeRecordingRoom } from './testUtils'
import type { Socket } from 'socket.io-client'
import type { Mixdown } from '../src/mixdown'

const sid = (s: Socket): string => s.id as string
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
const WORK = Buffer.from('mixed-work-bytes')

let server: Awaited<ReturnType<typeof startTestServer>>

afterEach(async () => { await server.close() })

// work が出来上がった部屋を返す
async function roomWithWork() {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const r = await makeRecordingRoom(server.port)
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const ready = once<{ url: string }>(r.host, 'work_ready')
  for (const s of [r.host, r.guest]) {
    const form = new FormData()
    form.append('socketId', sid(s))
    form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
    await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  }
  const { url } = await ready
  return { ...r, url }
}

test('正しい URL で作品を取得できる', async () => {
  const { host, guest, url } = await roomWithWork()
  const res = await fetch(`http://localhost:${server.port}${url}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /audio\/mp4/)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), WORK)
  host.disconnect(); guest.disconnect()
})

test('トークンが違えば 404（部屋コードの総当たりで他人の演技を引けない）', async () => {
  const { host, guest, roomCode } = await roomWithWork()
  const res = await fetch(`http://localhost:${server.port}/work/${roomCode}/にせトークン`)
  assert.equal(res.status, 404, '403 と撃ち分けない＝存在の有無を漏らさない')
  host.disconnect(); guest.disconnect()
})

test('存在しない部屋は 404', async () => {
  const { host, guest } = await roomWithWork()
  const res = await fetch(`http://localhost:${server.port}/work/ZZZZ/なんでも`)
  assert.equal(res.status, 404)
  host.disconnect(); guest.disconnect()
})

test('まだ作品が無い部屋は 404', async () => {
  server = await startTestServer()
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const res = await fetch(`http://localhost:${server.port}/work/${roomCode}/なんでも`)
  assert.equal(res.status, 404)
  host.disconnect(); guest.disconnect()
})

test('上限を超えたら 429 を返す', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown, limits: { workRateMax: 2 } })
  const r = await makeRecordingRoom(server.port)
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const ready = once<{ url: string }>(r.host, 'work_ready')
  for (const s of [r.host, r.guest]) {
    const form = new FormData()
    form.append('socketId', sid(s))
    form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
    await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  }
  const { url } = await ready
  await fetch(`http://localhost:${server.port}${url}`)
  await fetch(`http://localhost:${server.port}${url}`)
  const third = await fetch(`http://localhost:${server.port}${url}`)
  assert.equal(third.status, 429)
  r.host.disconnect(); r.guest.disconnect()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix server test -- --test-name-pattern="work"`
Expected: FAIL — `startTestServer` が `mixdown` オプションを知らないという型エラー

- [ ] **Step 3: イベント契約を足す**

`shared/events.ts` の `ServerToClientEvents`、`time_pong` の直後に追加:

```ts
  // 合成が終わった。url は**パス**（例 /work/ABCD/<token>）で、
  // クライアントが SERVER_URL を前置して使う。
  work_ready: (payload: { url: string }) => void
  // 合成できなかった。クライアントは今までどおりローカルのテイクを出す。
  work_failed: () => void
```

- [ ] **Step 4: Room に項目を足す**

`server/src/roomStore.ts` の `Room` インターフェース、`audioTimeline` の直後に追加:

```ts
  // 合成済みの作品（m4a）。メモリにだけ持ち、リセット・解散で消える
  work: Buffer | null
  // 作品の取得に必要な不透明トークン。部屋コードは総当たりできるので必須
  workToken: string | null
```

`createRoomStore` の room リテラル、`audioTimeline: [],` の直後に追加:

```ts
      work: null,
      workToken: null,
```

`resetRoom` の `room.audioTimeline = []` の直後に追加:

```ts
  room.work = null
  room.workToken = null
```

- [ ] **Step 5: Limits に配信のレート制限を足す**

`server/src/limits.ts` の `Limits`、`timeSyncMaxPerGame` の直後に追加:

```ts
  /** /work のレート制限の窓 */
  workRateWindowMs: number
  /** /work のレート制限の上限 */
  workRateMax: number
```

`DEFAULT_LIMITS` の `timeSyncMaxPerGame: 20,` の直後に追加:

```ts
  // 作品は結果画面で何度も聞き返される。10人が数回ずつ再生しても届かない値にする。
  workRateWindowMs: 60_000,
  workRateMax: 60,
```

- [ ] **Step 6: 配信ルートを書く**

`server/src/workRoute.ts` を新規作成:

```ts
import type { Express, Request, Response } from 'express'
import type { RoomStore } from './roomStore'
import type { Limits } from './limits'
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'
import { normalizeRoomCode } from './validation'

// 合成済みの作品を配る。部屋コードだけでは取れない：コードは4〜6桁で総当たりでき、
// トークンが無いと無関係な第三者が他人の演技音声を引けてしまう。
export function createWorkRoute(deps: { rooms: RoomStore; limits: Limits }): (app: Express) => void {
  const { rooms, limits } = deps
  const limiter = createRateLimiter(limits.workRateWindowMs, limits.workRateMax)

  return function registerWorkRoute(app: Express): void {
    app.get('/work/:code/:token', (req: Request, res: Response) => {
      const ip = req.ip ?? extractIp(req.headers['x-forwarded-for'], undefined)
      if (!limiter.allow(ip, Date.now())) {
        res.status(429).end()
        return
      }
      const room = rooms.get(normalizeRoomCode(req.params.code ?? ''))
      // 失敗理由を撃ち分けない。部屋の存在も作品の有無も漏らさず、すべて 404 に倒す。
      if (!room || !room.work || !room.workToken || room.workToken !== req.params.token) {
        res.status(404).end()
        return
      }
      res.set('content-type', 'audio/mp4')
      res.set('cache-control', 'no-store')
      res.send(room.work)
    })
  }
}
```

- [ ] **Step 7: handlers に合成の起動を足す**

`server/src/handlers.ts` の import に追加:

```ts
import { randomUUID } from 'node:crypto'
import type { Mixdown } from './mixdown'
```

`createHandlers` の deps 型に追加（`limits: Limits` の直後）:

```ts
  mixdown: Mixdown
  audioDir: string
```

分解の行を差し替え:

```ts
  const { rooms, quota, ai, plays, limits, mixdown, audioDir } = deps
```

`finalizeEvaluation` の**直前**に追加:

```ts
  // 採点とは独立に「作品」を合成する。決して await しない：合成が遅くても
  // 失敗しても、結果発表は今までどおりの速さで出さなければならない。
  // 合成が終わる前にリセット/解散が入った回は evaluationSeq で捨てる
  // （finalizeEvaluation と同じ作法）。
  function startMixdown(io: IO, room: Room): void {
    const code = room.code
    const mySeq = room.evaluationSeq
    const tracks = [...room.audio.values()].map(a => ({
      buffer: a.buffer, mime: a.mime, delayMs: a.delayMs,
    }))
    // 全員マイク拒否＝素材が無い。ffmpeg を起こさずに諦める。
    if (tracks.length === 0) {
      io.to(code).emit('work_failed')
      return
    }
    void mixdown({
      tracks,
      timeline: room.audioTimeline,
      durationMs: room.recordingDurationMs,
      audioDir,
    })
      .then(work => {
        if (rooms.get(code) !== room || room.evaluationSeq !== mySeq) return
        room.work = work
        room.workToken = randomUUID()
        room.audio.clear() // 素材はもう要らない。1部屋あたり数十MBを返す
        touch(room)
        // パスだけを返す。ホスト名を組むとリバースプロキシ配下で壊れる。
        io.to(code).emit('work_ready', { url: `/work/${code}/${room.workToken}` })
      })
      .catch((err: unknown) => {
        console.error('[server] mixdown failed:', err)
        if (rooms.get(code) !== room || room.evaluationSeq !== mySeq) return
        io.to(code).emit('work_failed')
      })
  }
```

`finalizeEvaluation` の中、`io.to(code).emit('evaluation_complete', { scores, leftPlayers })` の**直後**に追加:

```ts
      startMixdown(io, room) // 採点を出し切ってから合成を始める
```

- [ ] **Step 8: server.ts で配線する**

`server/src/server.ts` の import に追加:

```ts
import { existsSync } from 'node:fs'
import { createWorkRoute } from './workRoute'
import { createMixdown } from './mixdown'
import type { Mixdown } from './mixdown'
```

`resolveDistDir` の直後に追加:

```ts
// BGM/SE の mp3 の置き場。本番は client/dist（静的配信が見ているのと同じ場所）、
// 開発では client/dist がまだ無いので public を直接見る。
// 解決を1か所に閉じ込める（2か所で別々に解決すると distDir 差し替え時にズレる）。
export function resolveAudioDir(distDir: string): string {
  const fromDist = resolve(distDir, 'audio')
  if (existsSync(fromDist)) return fromDist
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../client/public/audio')
}
```

`buildServer` の options 型に追加（`limits?` の直後）:

```ts
  mixdown?: Mixdown
```

`const limits = resolveLimits(options.limits)` の直後を差し替え:

```ts
  const limits = resolveLimits(options.limits)
  // distDir は静的配信より前に解決する。合成が BGM/SE の置き場をここから導くため。
  const distDir = options.distDir ?? resolveDistDir()
  const mixdown = options.mixdown ?? createMixdown()
  const handlers = createHandlers({
    rooms, quota, ai, plays, limits, mixdown, audioDir: resolveAudioDir(distDir),
  })
```

`createFeedbackRoute({ sendFeedback, limits })(app)` の直後に追加:

```ts
  createWorkRoute({ rooms, limits })(app)
```

`if (isProduction) {` ブロック内の `const distDir = options.distDir ?? resolveDistDir()` の行を**削除**する（上で解決済み）。

- [ ] **Step 9: テストサーバーが mixdown を差し替えられるようにする**

`server/tests/testUtils.ts` の `startTestServer` は `options` を `buildServer` にそのまま渡しているので変更不要。型は `Parameters<typeof buildServer>[0]` 経由で自動的に `mixdown` を受け付ける。

**ただし既定のままだと全テストで本物の ffmpeg が起動する。** `startTestServer` の `buildServer` 呼び出しを差し替えて、明示指定が無ければ即失敗するスタブを使う:

```ts
  const { httpServer, io, rooms, quota, prompts, plays, ai, sendFeedback } = buildServer({
    // 既定は「決して終わらない合成」。統合テストのたびに ffmpeg が起動すると遅く、
    // ffmpeg の無い環境ではテストが環境依存になる。
    // 投げる実装にすると、採点まで進む既存テスト全部で work_failed と
    // console.error が出て出力が汚れる。解決しないでおけば既存テストの
    // 見え方は今までと1バイトも変わらない。合成を見るテストは自分で渡す。
    mixdown: () => new Promise<Buffer>(() => {}),
    ...options,
    limits: { roomCreateMax: TEST_ROOM_CREATE_MAX, ...options?.limits },
  })
```

- [ ] **Step 10: 起動ログに ffmpeg の可用性を出す**

`server/src/index.ts` の起動ログの近くに追加（import も足す）:

```ts
import { probeFfmpeg } from './mixdown'
```

サーバーが listen したあとに:

```ts
  // 合成機能が生きているかを起動時に1回だけ知らせる。無くてもサーバーは動く
  // （作品が作れなくなるだけで、ゲームは最後まで通常どおり進む）。
  void probeFfmpeg().then(ok => {
    console.log(ok
      ? '[server] ffmpeg あり：作品の合成は有効です'
      : '[server] ffmpeg なし：作品の合成は無効です（ゲームは通常どおり動きます）')
  })
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `npm --prefix server test -- --test-name-pattern="work"`
Expected: PASS（15 件）

- [ ] **Step 12: Type check and full suite**

Run: `npx --prefix server tsc --noEmit -p server` と `npm --prefix server test`
Expected: エラーなし・全 PASS

- [ ] **Step 13: Commit**

```bash
git add shared/events.ts server/src/roomStore.ts server/src/limits.ts server/src/handlers.ts server/src/workRoute.ts server/src/server.ts server/src/index.ts server/tests/testUtils.ts server/tests/handlers.work.test.ts server/tests/workRoute.test.ts
git commit -m "feat: 採点後に作品を合成しトークン付きURLで配る"
```

---

### Task 8: 結果画面で作品を聞く・共有する

**Files:**
- Modify: `client/src/App.tsx`（`GameContext`・`INITIAL_CTX`）
- Modify: `client/src/useGameSocket.ts`（`work_ready` / `work_failed` の受信とリセット）
- Modify: `client/src/xShare.ts`（作品用の文言）
- Modify: `client/src/screens/ResultScreen.tsx`
- Test: `client/tests/xShare.test.ts`（追記）

**Interfaces:**
- Consumes: イベント `work_ready { url }` / `work_failed`（Task 7）
- Produces: `GameContext.workUrl: string | null`、`GameContext.workState: 'pending' | 'ready' | 'failed'`、`buildWorkShareText(soloRoom: boolean, playerName: string, genreLabel: string): string`

**表示の原則**: 合成が失敗しても今日とまったく同じ画面になること。`work_failed` は補足行を消すだけで、ローカルテイクのパネルはそのまま残る。

- [ ] **Step 1: Write the failing test**

`client/tests/xShare.test.ts` 先頭の `from '../src/xShare'` の import 一覧に `buildWorkShareText` を足したうえで、末尾に追記:

```ts
test('作品の共有文は「みんなで作った一本」であることを言う', () => {
  const text = buildWorkShareText(false, 'たろう', 'ホラー')
  assert.match(text, /ホラー/)
  assert.match(text, /#こじらせ大劇場/)
})

test('1人の部屋なら作品も本人の名前で呼ぶ', () => {
  const text = buildWorkShareText(true, 'たろう', 'ホラー')
  assert.match(text, /たろう/)
  assert.match(text, /#こじらせ大劇場/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test`
Expected: FAIL — `buildWorkShareText` が export されていない

- [ ] **Step 3: 共有文言を足す**

`client/src/xShare.ts`、`buildTakeShareText` の直後に追加:

```ts
/**
 * 合成済みの「作品」の共有文。手元のテイクと違い、これは全員のクリーンな録音を
 * 合わせ直した一本なので、そのことが伝わる言い方にする。
 */
export function buildWorkShareText(soloRoom: boolean, playerName: string, genreLabel: string): string {
  return soloRoom
    ? `${playerName} の熱演、${genreLabel}の一本にまとまりました ${HASHTAG}`
    : `みんなの声を合わせて${genreLabel}の一本にしました ${HASHTAG}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test`
Expected: PASS

- [ ] **Step 5: GameContext に状態を足す**

`client/src/App.tsx` の `GameContext`、`aiMode: boolean` の直後に追加:

```ts
  // 合成済みの「作品」。url は取得可能な完全URL。合成が終わるまで workState は 'pending'
  workUrl: string | null
  workState: 'pending' | 'ready' | 'failed'
```

`INITIAL_CTX` の `aiMode: true,` の直後に追加:

```ts
  workUrl: null,
  workState: 'pending',
```

- [ ] **Step 6: 受信を配線する**

`client/src/useGameSocket.ts` の import に追加:

```ts
import { SERVER_URL } from './config'
```

`onEvaluationComplete` の直後に追加:

```ts
    // サーバーはパスだけを返す。同居デプロイでは SERVER_URL が空文字になり、
    // そのまま同一オリジンの絶対パスとして解決される。
    function onWorkReady({ url }: { url: string }) {
      setCtx(prev => ({ ...prev, workUrl: `${SERVER_URL}${url}`, workState: 'ready' }))
    }
    function onWorkFailed() {
      setCtx(prev => ({ ...prev, workUrl: null, workState: 'failed' }))
    }
```

`socket.on('evaluation_complete', ...)` の登録の近くに追加:

```ts
    socket.on('work_ready', onWorkReady)
    socket.on('work_failed', onWorkFailed)
```

クリーンアップ（`socket.off('recording_started', ...)` の並び）に追加:

```ts
      socket.off('work_ready', onWorkReady)
      socket.off('work_failed', onWorkFailed)
```

`onRoomReset` / `onGameAborted` / `onEvaluationFailed` の3つすべての `setCtx` 内、`aiAvailable: room.aiAvailable,` の直前に追加:

```ts
        workUrl: null,
        workState: 'pending',
```

- [ ] **Step 7: 結果画面を書き換える**

`client/src/screens/ResultScreen.tsx` の import を差し替え:

```ts
import { buildRoomShareText, buildMyShareText, buildTakeShareText, buildWorkShareText, buildIntentUrl, buildAppSchemeUrl, isMobileUserAgent } from '../xShare'
```

`takeIsSolo` の定義の直後に追加:

```ts
  // 作品は部屋の全員が入った一本。「ソロかどうか」は端末ではなく部屋で決まる。
  const workIsSolo = ctx.players.length <= 1
  // 3行に分けているのは型のため。三項の中で ctx.workUrl を参照すると
  // string | null のままで、パネルの src に渡せない。
  const workUrl = ctx.workState === 'ready' ? ctx.workUrl : null
  const workReady = workUrl !== null
  const panelSrc = workUrl ?? takeUrl
```

`shareTake` の直後に追加:

```ts
  // 作品はサーバー上にある。共有シートに渡すため一度だけ取り直す。
  // 失敗しても画面は壊さない（再生はそのまま続けられる）。
  async function shareWork() {
    if (!workUrl) return
    try {
      const res = await fetch(workUrl)
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const text = buildWorkShareText(workIsSolo, ctx.playerName, genreLabel(ctx.genre))
      await shareOrDownload(blob, 'kojirase-work.m4a', text)
    } catch (e) {
      console.warn('[result] 作品を取得できませんでした', e)
    }
  }
```

テイクのパネル（`{takeUrl && (...)}` のブロック）を丸ごと差し替え:

```tsx
      {panelSrc && (
        <div className="washi-panel mb-4">
          <p className="font-bold mb-2 text-usuzumi text-sm">
            {workReady ? '決定版（全員の声）' : takeIsSolo ? '自分の演技を聞く' : 'みんなの熱演を聞く'}
          </p>
          <audio controls src={panelSrc} className="w-full" />
          <button
            onClick={() => { void (workReady ? shareWork() : shareTake()) }}
            className="btn-outline mt-3 text-sm"
          >
            音声を共有
          </button>
          {/* 合成中だけ出す補足。失敗したら黙って消える＝今日と同じ画面に戻る */}
          {ctx.workState === 'pending' && (
            <p className="text-usuzumi text-xs mt-2">
              全員の声を合わせた決定版を仕上げています…
            </p>
          )}
        </div>
      )}
```

- [ ] **Step 8: Type check and full suite**

Run: `npx --prefix client tsc --noEmit -p client` と `npm --prefix client test`
Expected: エラーなし・全 PASS

- [ ] **Step 9: ビルドが通ることを確認する**

Run: `npm --prefix client run build`
Expected: 成功（`tsc && vite build`）

- [ ] **Step 10: Commit**

```bash
git add client/src/App.tsx client/src/useGameSocket.ts client/src/xShare.ts client/src/screens/ResultScreen.tsx client/tests/xShare.test.ts
git commit -m "feat: 結果画面で全員の声を合わせた決定版を聞ける・共有できるようにする"
```

---

### Task 9: 実機確認チェックリストと仕上げ

**Files:**
- Create: `docs/superpowers/specs/2026-08-28-ensemble-mixdown-manual-checklist.md`

**Interfaces:**
- Consumes: Task 1〜8 のすべて
- Produces: なし（ドキュメントと最終検証のみ）

自動テストでは確認できないことが3つ残る。**耳で聞かないと分からない頭合わせの精度**、**本番ビルドでの ffmpeg の可用性**、**iPhone での m4a の再生と共有**である。ここを検証項目として残す。

- [ ] **Step 1: 全体の検証を走らせる**

Run:
```bash
npx --prefix server tsc --noEmit -p server
npx --prefix client tsc --noEmit -p client
npm --prefix server test
npm --prefix client test
npm --prefix client run build
```
Expected: すべて成功。**1つでも落ちたらここで止めて報告する**

- [ ] **Step 2: ローカルで通しプレイする**

Run: `npm --prefix server run dev` と `npm --prefix client run dev` を別々に起動し、ブラウザで2タブ（ホスト＋ゲスト）を開いて1ゲーム通す。

確認すること:
- サーバーの起動ログに `[server] ffmpeg あり：作品の合成は有効です` が出る
- 結果画面に「全員の声を合わせた決定版を仕上げています…」が出て、数秒後に見出しが「決定版（全員の声）」へ変わる
- 再生すると**両方のタブの声と BGM/SE が入っている**
- 「音声を共有」でダウンロード/共有シートが開き、`kojirase-work.m4a` が取れる

- [ ] **Step 3: チェックリストを書く**

`docs/superpowers/specs/2026-08-28-ensemble-mixdown-manual-checklist.md` を新規作成:

```markdown
# 全員の演技を合体した「作品」 実機確認チェックリスト

対象: `docs/superpowers/specs/2026-08-28-ensemble-mixdown-design.md`

自動テストで確認できないものだけを並べる。ffmpeg の引数組み立て・イベントの
やりとり・配信ルートの権限はすべて自動テスト済みなので、ここには載せない。

## 1. 頭合わせの精度（耳で聞くしかない）

- [ ] 2台（PC + iPhone）で、ライブ音声 **ON** にして掛け合いのある台本を演じる
- [ ] 出来た作品を聞き、**手元のテイクと比べて掛け合いのタイミングが崩れていない**
      → 崩れていたら時刻同期が効いていない。両端末のコンソールで `time_pong` が
        3往復届いているかを見る
- [ ] 同じことをライブ音声 **OFF** でも行う（OFF では元々タイミングが揃わないので、
      「不自然に重なっていない」程度で可）
- [ ] 片方の端末だけ 4G/5G（Wi-Fi を切る）にして、遅延差が大きい状況でも
      1秒以上ズレていない

## 2. BGM/SE の重なり方

- [ ] 録音中に BGM を2回切り替え、SE を数回鳴らす
- [ ] 作品を聞き、**切り替えの位置が演技と合っている**
- [ ] BGM の切り替わりでプツッと切れず、フェードしている
- [ ] BGM を途中で止めた（なし にした）区間が、作品でも無音になっている
- [ ] 録音の長さが BGM より長いとき、BGM が最後までループして鳴っている

## 3. 音量バランス

- [ ] 人数が増えても作品全体が小さくならない（3人以上で確認）
- [ ] 声が BGM に埋もれていない
- [ ] 音割れしていない

## 4. iPhone（Safari）

- [ ] 結果画面で作品が再生できる
- [ ] 「音声を共有」で共有シートが開き、m4a を他アプリへ渡せる
- [ ] iPhone で録音した回（mp4/aac）と PC で録音した回（webm/opus）が
      同じ作品に混ざっていて、**どちらの声も入っている**

## 5. 壊れ方の確認

- [ ] 全員がマイクを拒否した回で、結果画面が今までどおり出る（補足行が消えるだけ）
- [ ] 合成中に「ロビーへ戻る」を押しても、次のゲームに前回の作品が残らない
- [ ] 作品の URL のトークンを1文字変えると 404 になる

## 6. 本番（Railway）

- [ ] デプロイのビルドログで **`ffmpeg-static` の postinstall が成功している**
      → 失敗していたら `RAILPACK_BUILD_APT_PACKAGES=ffmpeg` を設定し、
        必要なら `FFMPEG_BINARY` でパスを指す（設計書 12 節）
- [ ] 起動ログに `[server] ffmpeg あり：作品の合成は有効です` が出ている
- [ ] 本番で1ゲーム通し、作品が出来て再生・共有できる
- [ ] メモリ使用量が合成前後で戻っている（`room.audio` の破棄が効いている）
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-ensemble-mixdown-manual-checklist.md
git commit -m "docs: 作品合成の実機確認チェックリストを残す"
```

---

## 完了の定義

- `npx tsc --noEmit`（server / client）がどちらも通る
- `npm --prefix server test` と `npm --prefix client test` が全 PASS
- `npm --prefix client run build` が通る
- ローカルの2タブ通しプレイで、結果画面に「決定版（全員の声）」が出て両方の声が聞こえる
- チェックリストの 1〜5 が実機で確認済み（6 はデプロイ時）
