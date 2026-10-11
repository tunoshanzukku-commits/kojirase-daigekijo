# リアルタイム演技配信（ライブ音声）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 離れた場所にいるプレイヤーが、録音中に互いの演技を聞きながら掛け合えるようにする。

**Architecture:** WebRTC の mesh を**端末（`deviceId`）単位**で張る。サーバーは SDP も ICE も理解せず、宛先を検証して中継するだけ。無料の STUN のみを使い、繋がらないピアは「その人の声が聞こえない」だけに劣化させる（録音・採点・結果は一切影響を受けない）。接続は準備フェーズで張っておき、録音開始で `replaceTrack` によりマイクを差し込む。

**Tech Stack:** TypeScript / Node 20 / Express 4 / Socket.io 4 / React 18 / Vite / Tailwind / node:test（`tsx --test`）/ WebRTC（ブラウザ標準API・ライブラリ追加なし）

**Spec:** `docs/superpowers/specs/2026-08-26-live-audio-design.md`

## Global Constraints

- **繋がらなくてもゲームの中核（録音・アップロード・採点・結果）は完全に無傷であること。** この性質がベストエフォートを成立させている。ライブ音声の失敗が他に波及する経路を作らない
- **サーバーは SDP も ICE も理解しない。** `data` は `unknown` のまま素通しする
- **`fromDeviceId` はサーバーが解決して付ける。** クライアントの自己申告は使わない（なりすまし防止）
- **`rtc_signal` の中継条件の `status` は `casting` または `recording` のみ。`'preparing'` を入れてはいけない** — `RoomStatus` に宣言はあるがサーバーは一度も代入しておらず、準備フェーズ中のサーバー状態は `'casting'` のまま。`'preparing'` を条件に入れると**シグナリングが1件も通らず機能全体が動かない**
- `MAX_LIVE_AUDIO_DEVICES = 6`（`shared/constants.ts`）。mesh は端末数の2乗で増える
- シグナルのレート制限は**1端末あたり1ゲームで 500 件**（`limits.rtcSignalMaxPerGame`）。超過は黙って捨ててログに残す。**エラーイベントは返さない**（シグナルは大量に飛ぶので、返すとエラーが溢れる）
- **`recorder.ts` の既存ロジックは変更しない。** 追加するのは任意のコールバック1つだけ
- **`getUserMedia` を新たに呼ばない。** このアプリは既に `recorder.ts` と `RecordingScreen` の音量メーターで2本並行しており、3本目を増やさない
- リモート音声は **`<audio>` 要素で再生**し、録音用に **mixDest へ分岐**する。Web Audio 経由（`ctx.destination`）で鳴らすと AEC の参照信号から外れる
- **失敗したピアへの再試行は実装しない**
- 採点プロンプト（`prompts/*.md`）・`RECORDING_LIMIT_SEC`・ホスト切断時の即解散は**変更しない**
- `tsc --noEmit` が実質のゲート（server は tsx 実行のため型チェックが走らない）
- 統合テストは「**先に両方のリスナを登録してから emit**」で書くこと（`io.to` は送信者にも配信されるため。Windows で再現性100%）
- コミットメッセージは日本語。末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## コマンド早見表

```bash
(cd server && npm test)
(cd server && npx tsx --test tests/handlers.liveAudio.test.ts)
(cd client && npm test)
(cd client && npx tsx --test tests/liveAudio.test.ts)
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
```

## File Structure

| ファイル | 責務 | タスク |
|---|---|---|
| `shared/constants.ts` | `MAX_LIVE_AUDIO_DEVICES` | 1 |
| `shared/types.ts` | `RoomSnapshot.liveAudio` | 1 |
| `shared/events.ts` | `set_live_audio` / `live_audio_changed` / `rtc_signal` | 1, 2 |
| `server/src/limits.ts` | `rtcSignalMaxPerGame` | 2 |
| `server/src/roomStore.ts` | `Room.liveAudio` / `Device.signalCount` | 1, 2 |
| `server/src/handlers.ts` | トグルのガード・シグナルの検証と中継・上限超過時の強制OFF | 1, 2 |
| `client/src/liveAudioPure.ts` | offer の主導権判定・接続先の算出・トグルの状態（**純粋関数・テストあり**） | 3 |
| `client/src/liveAudio.ts` | `RTCPeerConnection` の管理・`<audio>` 要素・シグナリング | 4 |
| `client/src/audioBus.ts` | `connectRemote` / `disconnectRemote` | 4 |
| `client/src/recorder.ts` | マイク取得を知らせる任意コールバック（**これだけ**） | 4 |
| `client/src/useGameSocket.ts` | ライフサイクルの配線・`ctx.liveAudio` | 4 |
| `client/src/App.tsx` | `GameContext.liveAudio` / `peerStates` | 4 |
| `client/src/screens/LobbyScreen.tsx` | 声の配信トグル | 5 |
| `client/src/screens/PrepareScreen.tsx` | 準備完了で `startLiveAudio()` | 5 |
| `client/src/screens/RecordingScreen.tsx` | 接続状態の表示 | 5 |
| `client/src/screens/ResultScreen.tsx` | 見出し条件に配信ONを混ぜる | 5 |
| `doc/*.md` ほか | 仕様書・実機確認チェックリスト | 6 |

---

## Task 1: 部屋の設定としての `liveAudio`

ホストがロビーで ON/OFF するだけの部分。WebRTC はまだ何も入らない。

**Files:**
- Modify: `shared/constants.ts`
- Modify: `shared/types.ts`
- Modify: `shared/events.ts`
- Modify: `server/src/roomStore.ts`
- Modify: `server/src/handlers.ts`
- Test: `server/tests/handlers.liveAudio.test.ts`（新規）

**Interfaces:**
- Consumes: 既存の `addDevice` / `deviceBySocket` / `toSnapshot` / `touch` / `isHostSocket`（handlers 内のローカルヘルパー）/ `activeDevices`
- Produces:
  - `MAX_LIVE_AUDIO_DEVICES: number`（`shared/constants.ts`）
  - `Room.liveAudio: boolean`
  - `RoomSnapshot.liveAudio: boolean`
  - イベント `set_live_audio: { enabled: boolean }` / `live_audio_changed: { enabled: boolean }`

- [ ] **Step 1: 失敗する統合テストを書く**

`server/tests/handlers.liveAudio.test.ts` を新規作成する。

```ts
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRoom, makeCastingRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => { server = await startTestServer() })
afterEach(async () => { await server.close() })

test('ホストは声の配信を ON にでき、全員に通知される', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const changedGuest = once<{ enabled: boolean }>(guest, 'live_audio_changed')
  const changedHost = once<{ enabled: boolean }>(host, 'live_audio_changed')
  host.emit('set_live_audio', { enabled: true })
  assert.equal((await changedGuest).enabled, true)
  assert.equal((await changedHost).enabled, true)
  assert.equal(server.rooms.get(roomCode)?.liveAudio, true)
  host.disconnect(); guest.disconnect()
})

test('ゲストの set_live_audio は無視される', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  guest.emit('set_live_audio', { enabled: true })
  await expectNoEvent(host, 'live_audio_changed', 300)
  assert.equal(server.rooms.get(roomCode)?.liveAudio, false)
  host.disconnect(); guest.disconnect()
})

test('waiting 以外では set_live_audio は無視される', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  host.emit('set_live_audio', { enabled: true })
  await expectNoEvent(guest, 'live_audio_changed', 300)
  assert.equal(server.rooms.get(roomCode)?.liveAudio, false)
  host.disconnect(); guest.disconnect()
})

test('liveAudio は RoomSnapshot に載り、後から参加した人にも伝わる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const changed = once(guest, 'live_audio_changed')
  host.emit('set_live_audio', { enabled: true })
  await changed
  const late = connectClient(server.port)
  late.emit('join_room', { roomCode, playerName: 'さぶろう' })
  const joined = await once<{ room: { liveAudio: boolean } }>(late, 'room_joined')
  assert.equal(joined.room.liveAudio, true)
  host.disconnect(); guest.disconnect(); late.disconnect()
})

test('liveAudio は resetRoom で保持される（ジャンルと同じ扱い）', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const changed = once(guest, 'live_audio_changed')
  host.emit('set_live_audio', { enabled: true })
  await changed
  const aborted = once(guest, 'game_aborted')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  const ready = once(guest, 'script_ready')
  const readyHost = once(host, 'script_ready')
  host.emit('start_game')
  await ready; await readyHost
  host.emit('abort_game')
  await aborted
  assert.equal(server.rooms.get(roomCode)?.liveAudio, true)
  host.disconnect(); guest.disconnect()
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd server && npx tsx --test tests/handlers.liveAudio.test.ts)`
Expected: FAIL（`set_live_audio` を誰も受けないので `live_audio_changed` が来ずタイムアウト、`room.liveAudio` が undefined）

- [ ] **Step 3: `shared/constants.ts` に上限を足す**

ファイル末尾に追記する。

```ts
// ライブ音声（WebRTC mesh）を許す端末数の上限。mesh の接続数は端末数の2乗で
// 増えるため（6台＝15接続）、スマホの CPU と帯域が保つ範囲で切る。
// 部屋の人数上限（MAX_PLAYERS）とは別物：1台に複数人乗るので端末数 ≦ 人数。
export const MAX_LIVE_AUDIO_DEVICES = 6
```

- [ ] **Step 4: `shared/types.ts` の `RoomSnapshot` に足す**

```ts
export interface RoomSnapshot {
  code: string
  status: RoomStatus
  genre: string
  players: PlayerSnapshot[]
  script: ScriptData | null
  scores: PlayerScore[]
  bgm: string | null
  aiAvailable: boolean
  liveAudio: boolean // ホストがロビーで決める。録音中に他端末の声が聞こえるか
}
```

- [ ] **Step 5: `shared/events.ts` にイベントを足す**

```ts
  // ClientToServerEvents に追加
  set_live_audio: (payload: { enabled: boolean }) => void
```

```ts
  // ServerToClientEvents に追加
  live_audio_changed: (payload: { enabled: boolean }) => void
```

- [ ] **Step 6: `server/src/roomStore.ts` に状態を足す**

`Room` インターフェースに追加する（`bgm` の隣が読みやすい）。

```ts
  // ホストがロビーで決める。録音中に他端末の声が聞こえるか（ジャンルと同じく再戦で保持）
  liveAudio: boolean
```

`create()` の `room` リテラルに `liveAudio: false,` を追加する。

`toSnapshot` の返り値に追加する。

```ts
    bgm: room.bgm,
    liveAudio: room.liveAudio,
```

`resetRoom` では**触らない**（保持する）。`genre` と同じ扱いであることをコメントで示す。

```ts
  // genre と liveAudio は保持（同じ部屋で再戦するとき毎回付け直させない）
```

（既存の `// genre は保持（同じ部屋で再戦）` の行をこの文言に置き換える。）

- [ ] **Step 7: `server/src/handlers.ts` にハンドラを足す**

`set_genre` の直後に置く。ガードは `set_genre` と同じ形にする。

```ts
    // 声の配信の ON/OFF。ジャンルと同じく「ホストが部屋全体で決める」設定なので、
    // ガードも set_genre に揃える（ホストのみ・waiting のみ）。
    socket.on('set_live_audio', ({ enabled }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (room.status !== 'waiting') return
      room.liveAudio = !!enabled
      touch(room)
      io.to(room.code).emit('live_audio_changed', { enabled: room.liveAudio })
    })
```

- [ ] **Step 8: `start_game` に上限超過の防御を足す**

`room.aiMode = ...` の行の直前に挿入する。

```ts
      // ロビーで ON にしたあとに人が増えて上限を超えることがある。クライアントの
      // 表示だけに頼らず、開始の瞬間にサーバー側で落とす（mesh の接続数を守る唯一の砦）。
      if (room.liveAudio && room.devices.size > MAX_LIVE_AUDIO_DEVICES) {
        room.liveAudio = false
        io.to(code).emit('live_audio_changed', { enabled: false })
      }
```

import に `MAX_LIVE_AUDIO_DEVICES` を足す。

```ts
import { NAME_MAX, MAX_PLAYERS, MIN_PLAYERS, MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'
```

- [ ] **Step 9: 上限超過のテストを足す**

`server/tests/handlers.liveAudio.test.ts` に追記する。

```ts
test('端末数が上限を超えた状態で start_game すると liveAudio が落ちる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const changed = once(guest, 'live_audio_changed')
  host.emit('set_live_audio', { enabled: true })
  await changed
  // 上限（6台）を超えるまで端末を増やす。makeRoom で既に2台ある。
  const extras = []
  for (let i = 0; i < 5; i++) {
    const c = connectClient(server.port)
    c.emit('join_room', { roomCode, playerName: `ひと${i}` })
    await once(c, 'room_joined')
    await once(host, 'player_joined')
    extras.push(c)
  }
  assert.equal(server.rooms.get(roomCode)!.devices.size, 7)
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  const off = once<{ enabled: boolean }>(guest, 'live_audio_changed')
  const readyHost = once(host, 'script_ready')
  host.emit('start_game')
  assert.equal((await off).enabled, false)
  await readyHost
  assert.equal(server.rooms.get(roomCode)!.liveAudio, false)
  host.disconnect(); guest.disconnect(); extras.forEach(c => c.disconnect())
})
```

- [ ] **Step 10: テストが通ることを確認する**

Run: `(cd server && npx tsx --test tests/handlers.liveAudio.test.ts)`
Expected: PASS（6本）

- [ ] **Step 11: 回帰と型チェック**

Run:
```bash
(cd server && npm test)
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
```
Expected: すべて PASS。`RoomSnapshot` に必須プロパティが増えたので、client でテスト用のスナップショットを組み立てている箇所があれば型エラーが出る。出たら `liveAudio: false` を足して直す。

- [ ] **Step 12: コミット**

```bash
git add shared server
git commit -m "$(cat <<'MSG'
feat: 部屋の設定として声の配信の ON/OFF を持つ

ジャンルと同じく「ホストが部屋全体で決める」設定なので、ガードも
保持のされ方(resetRoom で残す)も set_genre に揃えた。

ロビーで ON にしたあとに人が増えることがあるので、start_game の
瞬間にサーバー側でも端末数の上限を見て落とす。クライアントの表示
だけに頼らない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 2: シグナリングの中継

サーバーが `rtc_signal` を検証して1対1で流す部分。ここが security の要。

**Files:**
- Modify: `shared/events.ts`
- Modify: `server/src/limits.ts`
- Modify: `server/src/roomStore.ts`
- Modify: `server/src/handlers.ts`
- Test: `server/tests/handlers.liveAudio.test.ts`

**Interfaces:**
- Consumes: Task 1 の `Room.liveAudio`、既存の `deviceBySocket` / `touch`
- Produces:
  - イベント `rtc_signal`（C→S: `{ toDeviceId: string; data: unknown }` / S→C: `{ fromDeviceId: string; data: unknown }`）
  - `Device.signalCount: number`
  - `Limits.rtcSignalMaxPerGame: number`（既定 500）

- [ ] **Step 1: 失敗するテストを書く**

`server/tests/handlers.liveAudio.test.ts` に追記する。

```ts
// 配信ONの casting ルーム（シグナリングが許される唯一の状態のひとつ）
async function makeSignalingRoom(port: number) {
  const r = await makeRoom(port)
  const changed = once(r.guest, 'live_audio_changed')
  r.host.emit('set_live_audio', { enabled: true })
  await changed
  r.host.emit('set_genre', { genre: 'comedy' })
  await once(r.guest, 'genre_changed')
  const rg = once(r.guest, 'script_ready')
  const rh = once(r.host, 'script_ready')
  r.host.emit('start_game')
  await rg; await rh
  return r
}

test('rtc_signal は宛先の端末にだけ中継される', async () => {
  const { host, guest, guestDeviceId, hostDeviceId } = await makeSignalingRoom(server.port)
  const relayed = once<{ fromDeviceId: string; data: unknown }>(guest, 'rtc_signal')
  host.emit('rtc_signal', { toDeviceId: guestDeviceId, data: { kind: 'offer', sdp: 'x' } })
  const got = await relayed
  assert.equal(got.fromDeviceId, hostDeviceId)
  assert.deepEqual(got.data, { kind: 'offer', sdp: 'x' })
  host.disconnect(); guest.disconnect()
})

test('fromDeviceId はサーバーが付ける（なりすませない）', async () => {
  const { host, guest, guestDeviceId, hostDeviceId } = await makeSignalingRoom(server.port)
  const relayed = once<{ fromDeviceId: string }>(guest, 'rtc_signal')
  // クライアントが偽の送信元を混ぜても、サーバーの解決結果が優先される
  host.emit('rtc_signal', {
    toDeviceId: guestDeviceId,
    data: { fromDeviceId: 'なりすまし', kind: 'offer' },
  })
  assert.equal((await relayed).fromDeviceId, hostDeviceId)
  host.disconnect(); guest.disconnect()
})

test('別の部屋の端末には中継されない', async () => {
  const a = await makeSignalingRoom(server.port)
  const b = await makeSignalingRoom(server.port)
  a.host.emit('rtc_signal', { toDeviceId: b.guestDeviceId, data: { kind: 'offer' } })
  await expectNoEvent(b.guest, 'rtc_signal', 300)
  a.host.disconnect(); a.guest.disconnect(); b.host.disconnect(); b.guest.disconnect()
})

test('liveAudio が OFF なら中継されない', async () => {
  const { host, guest, guestDeviceId } = await makeCastingRoom(server.port) // 配信ONにしていない
  host.emit('rtc_signal', { toDeviceId: guestDeviceId, data: { kind: 'offer' } })
  await expectNoEvent(guest, 'rtc_signal', 300)
  host.disconnect(); guest.disconnect()
})

test('waiting のあいだは中継されない', async () => {
  const { host, guest, guestDeviceId } = await makeRoom(server.port)
  const changed = once(guest, 'live_audio_changed')
  host.emit('set_live_audio', { enabled: true })
  await changed
  host.emit('rtc_signal', { toDeviceId: guestDeviceId, data: { kind: 'offer' } })
  await expectNoEvent(guest, 'rtc_signal', 300)
  host.disconnect(); guest.disconnect()
})

// 切断済みのクライアントはそもそも受信できないので、「相手に届かないこと」を
// 見ても何も証明できない（トートロジーになる）。サーバーが中継前に捨てたことは
// 送信側の signalCount が増えていないことで観測する（実装が枠を数える前に
// return しているため）。
test('切断中の端末には中継されず、送信枠も消費されない', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000 } })
  const { host, guest, roomCode, hostDeviceId, guestDeviceId } = await makeSignalingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const room = server.rooms.get(roomCode)!
  const before = room.devices.get(hostDeviceId)!.signalCount
  host.emit('rtc_signal', { toDeviceId: guestDeviceId, data: { kind: 'offer' } })
  await expectNoEvent(host, 'error', 300) // 送信側にエラーは返さない（＋処理の待ち時間を稼ぐ）
  assert.equal(room.devices.get(hostDeviceId)!.signalCount, before)
  host.disconnect()
})

test('シグナルのレート制限を超えると中継されなくなる', async () => {
  await server.close()
  server = await startTestServer({ limits: { rtcSignalMaxPerGame: 3 } })
  const { host, guest, guestDeviceId } = await makeSignalingRoom(server.port)
  for (let i = 0; i < 3; i++) {
    const relayed = once(guest, 'rtc_signal')
    host.emit('rtc_signal', { toDeviceId: guestDeviceId, data: { n: i } })
    await relayed
  }
  host.emit('rtc_signal', { toDeviceId: guestDeviceId, data: { n: 99 } })
  await expectNoEvent(guest, 'rtc_signal', 300)
  host.disconnect(); guest.disconnect()
})
```

**`makeSignalingRoom` は `makeRoom` の戻り値をそのまま返すので、`hostDeviceId` / `guestDeviceId` が使える。**

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd server && npx tsx --test tests/handlers.liveAudio.test.ts)`
Expected: FAIL（`rtc_signal` を誰も受けないので中継テストがタイムアウト、`rtcSignalMaxPerGame` が型に無い）

- [ ] **Step 3: `shared/events.ts` にイベントを足す**

```ts
  // ClientToServerEvents に追加
  // data は SDP / ICE候補。サーバーは中身を理解せず素通しする。
  rtc_signal: (payload: { toDeviceId: string; data: unknown }) => void
```

```ts
  // ServerToClientEvents に追加
  // fromDeviceId はサーバーが解決して付ける（クライアントの自己申告は使わない）。
  rtc_signal: (payload: { fromDeviceId: string; data: unknown }) => void
```

- [ ] **Step 4: `server/src/limits.ts` に上限を足す**

`Limits` インターフェースに追加する。

```ts
  /** 1端末が1ゲーム中に中継できる WebRTC シグナルの数。超過分は黙って捨てる */
  rtcSignalMaxPerGame: number
```

`DEFAULT_LIMITS` に追加する。

```ts
  rtcSignalMaxPerGame: 500,
```

**500 の根拠をコメントで残す。**

```ts
  // 上限6台＝1端末あたり5ピア。1接続で offer/answer 各1＋ICE候補が多くて30程度なので
  // 5ピアで概ね160件。異常時のバーストを見込んでその3倍を取る。正常なプレイを
  // 止めないことを優先し、ここは荒らし対策の粗い網に徹する。
  rtcSignalMaxPerGame: 500,
```

- [ ] **Step 5: `server/src/roomStore.ts` にカウンタを足す**

`Device` インターフェースに追加する。

```ts
  signalCount: number            // 1ゲーム中に中継した WebRTC シグナル数（resetRoom で 0 に戻す）
```

`addDevice` の `device` リテラルに `signalCount: 0,` を追加する。

`resetRoom` のループに追加する。

```ts
  for (const d of room.devices.values()) {
    d.isReady = false
    d.signalCount = 0 // 次のゲームぶんのシグナル枠を戻す
  }
```

- [ ] **Step 6: `server/src/handlers.ts` に中継を実装する**

`set_live_audio` の直後に置く。

```ts
    // WebRTC のシグナリング中継。サーバーは SDP も ICE も理解せず、
    // 宛先を検証して素通しするだけ（ブラウザの実装が変わってもここは変わらない）。
    socket.on('rtc_signal', ({ toDeviceId, data }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !room.liveAudio) return
      // 準備フェーズ中のサーバー状態は 'casting' のまま（'preparing' は
      // RoomStatus に宣言はあるが一度も代入されない）。ここに 'preparing' を
      // 足しても意味は無く、逆に 'casting' を外すと接続が一切張れなくなる。
      if (room.status !== 'casting' && room.status !== 'recording') return
      const from = deviceBySocket(room, socket.id)
      if (!from) return
      if (from.signalCount >= limits.rtcSignalMaxPerGame) {
        // 大量に飛ぶ経路なのでエラーは返さない（返すと今度はエラーが溢れる）。
        // 正常なプレイでは到達しない値なので、到達したこと自体をログに残す。
        if (from.signalCount === limits.rtcSignalMaxPerGame) {
          console.log(`[server] rtc_signal rate limited: room=${room.code} device=${from.id}`)
          from.signalCount++ // ログを1回だけにするため進めておく
        }
        return
      }
      const target = typeof toDeviceId === 'string' ? room.devices.get(toDeviceId) : undefined
      if (!target || target.disconnectedAt != null) return // 別部屋・不在・切断中は黙って捨てる
      from.signalCount++
      touch(room)
      // fromDeviceId はサーバーが解決した値を使う（クライアントの自己申告は信じない）
      io.to(target.socketId).emit('rtc_signal', { fromDeviceId: from.id, data })
    })
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `(cd server && npx tsx --test tests/handlers.liveAudio.test.ts)`
Expected: PASS（13本）

- [ ] **Step 8: 回帰と型チェック**

Run:
```bash
(cd server && npm test)
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
```
Expected: すべて PASS

- [ ] **Step 9: コミット**

```bash
git add shared server
git commit -m "$(cat <<'MSG'
feat: WebRTC のシグナリングを中継する

サーバーは SDP も ICE も理解せず、宛先を検証して素通しするだけに
する。WebRTC の知識をサーバーに持ち込むと、ブラウザの実装が変わる
たびにサーバーを直すことになるため。

fromDeviceId はサーバーが解決して付ける。deviceId は全員に配られて
いるので、クライアントの自己申告を信じると他人になりすまして接続を
仕掛けられる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 3: クライアントの純粋関数

WebRTC に触らない、テストできる判定ロジックだけを先に作る。

**Files:**
- Create: `client/src/liveAudioPure.ts`
- Test: `client/tests/liveAudioPure.test.ts`（新規）

**Interfaces:**
- Consumes: `PlayerSnapshot`（`client/src/types.ts` 経由で `@shared/types`）、`MAX_LIVE_AUDIO_DEVICES`
- Produces:
  - `shouldCreateOffer(selfDeviceId: string, peerDeviceId: string): boolean`
  - `peerDeviceIds(players: PlayerSnapshot[], selfDeviceId: string): string[]`
  - `deviceCount(players: PlayerSnapshot[]): number`
  - `liveAudioToggleState(deviceCount: number): 'available' | 'alone' | 'too-many'`

- [ ] **Step 1: 失敗するテストを書く**

`client/tests/liveAudioPure.test.ts` を新規作成する。

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldCreateOffer, peerDeviceIds, deviceCount, liveAudioToggleState,
} from '../src/liveAudioPure'
import type { PlayerSnapshot } from '../src/types'
import { MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'

const P = (name: string, deviceId: string): PlayerSnapshot => ({
  id: name, deviceId, name, isHost: false, isReady: false, connected: true,
})

test('offer を出すのは deviceId が辞書順で小さいほう', () => {
  assert.equal(shouldCreateOffer('aaa', 'bbb'), true)
  assert.equal(shouldCreateOffer('bbb', 'aaa'), false)
})

test('同じ deviceId には offer を出さない（自分自身との接続を作らない）', () => {
  assert.equal(shouldCreateOffer('aaa', 'aaa'), false)
})

test('両側で判定が必ず食い違う（glare が起きない）', () => {
  const ids = ['d1', 'd2', 'd3', 'zz', 'a']
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue
      assert.notEqual(shouldCreateOffer(a, b), shouldCreateOffer(b, a))
    }
  }
})

test('peerDeviceIds は自分以外の端末を重複なく参加順で返す', () => {
  const players = [P('ミチ', 'd1'), P('タロウ', 'd1'), P('ジロウ', 'd2'), P('ハナコ', 'd3')]
  assert.deepEqual(peerDeviceIds(players, 'd1'), ['d2', 'd3'])
  assert.deepEqual(peerDeviceIds(players, 'd2'), ['d1', 'd3'])
})

test('peerDeviceIds は deviceId が空なら空配列', () => {
  assert.deepEqual(peerDeviceIds([P('ミチ', 'd1')], ''), [])
})

test('deviceCount は端末の数を数える（人数ではない）', () => {
  assert.equal(deviceCount([P('ミチ', 'd1'), P('タロウ', 'd1'), P('ジロウ', 'd2')]), 2)
  assert.equal(deviceCount([]), 0)
})

test('トグルの状態は端末数で決まる', () => {
  assert.equal(liveAudioToggleState(1), 'alone')
  assert.equal(liveAudioToggleState(2), 'available')
  assert.equal(liveAudioToggleState(MAX_LIVE_AUDIO_DEVICES), 'available')
  assert.equal(liveAudioToggleState(MAX_LIVE_AUDIO_DEVICES + 1), 'too-many')
})

test('端末が0台でも落ちない（トップ画面など未参加の状態）', () => {
  assert.equal(liveAudioToggleState(0), 'alone')
})
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `(cd client && npx tsx --test tests/liveAudioPure.test.ts)`
Expected: FAIL（`../src/liveAudioPure` が存在しない）

- [ ] **Step 3: `client/src/liveAudioPure.ts` を作る**

```ts
import type { PlayerSnapshot } from './types'
import { MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'

// ライブ音声の判定のうち、WebRTC に触らない部分だけをここに置く。
// クライアントには React のテスト基盤が無く、RTCPeerConnection も Node に無いので、
// テストできるのは純粋関数だけ。テストできるものをここへ寄せておく。

/**
 * どちらが offer を出すかを deviceId の辞書順で決める（小さいほうが出す）。
 * 双方が同時に offer を出す glare を、追加のやり取り無しで防ぐ。
 * 判定は必ず片側だけ true になる。
 */
export function shouldCreateOffer(selfDeviceId: string, peerDeviceId: string): boolean {
  return selfDeviceId < peerDeviceId
}

/**
 * 接続先の端末ID。自分の端末は除き、参加順（players の並び順）を保つ。
 * 1台に複数人乗っていても端末は1つなので、重複は畳む。
 */
export function peerDeviceIds(players: PlayerSnapshot[], selfDeviceId: string): string[] {
  if (!selfDeviceId) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of players) {
    if (p.deviceId === selfDeviceId || seen.has(p.deviceId)) continue
    seen.add(p.deviceId)
    out.push(p.deviceId)
  }
  return out
}

/** 部屋の端末数（人数ではない）。mesh の規模はこちらで決まる。 */
export function deviceCount(players: PlayerSnapshot[]): number {
  return new Set(players.map(p => p.deviceId)).size
}

/**
 * ロビーのトグルの状態。理由を出し分けるために3値で返す。
 * - alone: 相手がいないので意味が無い
 * - too-many: mesh が保たない
 */
export function liveAudioToggleState(count: number): 'available' | 'alone' | 'too-many' {
  if (count > MAX_LIVE_AUDIO_DEVICES) return 'too-many'
  if (count < 2) return 'alone'
  return 'available'
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `(cd client && npx tsx --test tests/liveAudioPure.test.ts)`
Expected: PASS（8本）

- [ ] **Step 5: 型チェックとコミット**

Run: `(cd client && npx tsc --noEmit)`
Expected: エラーなし

```bash
git add client/src/liveAudioPure.ts client/tests/liveAudioPure.test.ts
git commit -m "$(cat <<'MSG'
feat: ライブ音声の判定のうち純粋関数だけを先に作る

RTCPeerConnection は Node に無く React のテスト基盤も無いので、
テストできるのは純粋関数だけ。offer の主導権・接続先の算出・
トグルの状態をここへ寄せ、テストで固定する。

offer は deviceId の辞書順で小さいほうが出す。追加のやり取り
無しで glare を防げる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 4: WebRTC 本体と配線

**このタスクには自動テストがありません。** `RTCPeerConnection` は Node にも jsdom にも存在せず、Playwright も使えない。ゲートは `tsc --noEmit` とレビューだけ。

**Files:**
- Create: `client/src/liveAudio.ts`
- Modify: `client/src/audioBus.ts`
- Modify: `client/src/recorder.ts`（**コールバック1つだけ**）
- Modify: `client/src/useGameSocket.ts`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: Task 3 の `shouldCreateOffer` / `peerDeviceIds`、Task 1-2 の `rtc_signal` / `ctx.liveAudio`
- Produces:
  - `startLiveAudio(params: { selfDeviceId: string; peerDeviceIds: string[]; onPeerState: (deviceId: string, state: PeerState) => void }): void`
  - `enableLiveAudio(micStream: MediaStream): void`
  - `stopLiveAudio(): void`
  - `handleSignal(fromDeviceId: string, data: unknown): void`
  - `PeerState = 'connecting' | 'connected' | 'failed'`
  - `audioBus.connectRemote(deviceId: string, stream: MediaStream): void` / `disconnectRemote(deviceId: string): void`
  - `GameContext.liveAudio: boolean` / `GameContext.peerStates: Record<string, PeerState>`
  - `GameActions.setLiveAudio(enabled: boolean): void`

- [ ] **Step 1: `audioBus.ts` にリモート音声の口を足す**

既存の `connectMic` / `disconnectMic` の直後に追加する。

```ts
// リモート音声（他端末の声）。マイクと同じく mixDest にだけ繋ぐ。
// スピーカー側へは繋がない：再生は liveAudio.ts の <audio> 要素が担当しており、
// ここで ctx.destination にも繋ぐと二重に鳴る。
// 分けている理由はもう1つある。ブラウザのエコーキャンセラは「スピーカーに出た音」を
// 参照して打ち消すが、Web Audio 経由で鳴らすとその参照から外れることがあり
// AEC が効かなくなる。<audio> 要素は AEC が想定している経路。
const remoteNodes = new Map<string, MediaStreamAudioSourceNode>()

export function connectRemote(deviceId: string, stream: MediaStream): void {
  const c = getCtx()
  if (!c || !mixDest) return
  disconnectRemote(deviceId)
  const node = c.createMediaStreamSource(stream)
  node.connect(mixDest)
  remoteNodes.set(deviceId, node)
}

export function disconnectRemote(deviceId: string): void {
  const node = remoteNodes.get(deviceId)
  if (!node) return
  node.disconnect()
  remoteNodes.delete(deviceId)
}

export function disconnectAllRemote(): void {
  for (const id of [...remoteNodes.keys()]) disconnectRemote(id)
}
```

- [ ] **Step 2: `recorder.ts` にコールバックを足す**

`startUploadRecorder` のシグネチャだけを変える。**それ以外のロジックには触らない。**

```ts
// 録音開始。冪等（多重呼び出しは無視）。マイク拒否時は録音なしのまま進み、
// 停止時に skip マーカーを送ってサーバーの待機を解く。
//
// onMicStream: マイクを取得できたときに1回だけ呼ぶ。ライブ音声がこのストリームを
// 借りて WebRTC の送信トラックに差し込む。ここで渡すのは「録音用に取った1本」で、
// ライブ音声のために新たに getUserMedia を呼ばないための口（このアプリは既に
// recorder と音量メーターで2本並行しており、3本目を増やしたくない）。
export function startUploadRecorder(onMicStream?: (stream: MediaStream) => void): void {
```

`.then(s => { ... })` の中、`startMixRecorder(s)` の直後に1行足す。

```ts
        rec.start()
        mediaRecorder = rec
        startMixRecorder(s)
        onMicStream?.(s) // ライブ音声へ受け渡す（失敗しても録音は続く）
```

- [ ] **Step 3: `client/src/liveAudio.ts` を作る**

```ts
import { socket } from './socket'
import { shouldCreateOffer } from './liveAudioPure'
import { connectRemote, disconnectRemote, disconnectAllRemote } from './audioBus'

export type PeerState = 'connecting' | 'connected' | 'failed'

// STUN は無料の公開サーバーだけを使う（ベストエフォート）。TURN は導入しない。
// 失敗率が高ければここに TURN の設定を足すだけで済むよう、設定はこの定数1箇所に閉じる。
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

interface Peer {
  pc: RTCPeerConnection
  sender: RTCRtpSender
  audio: HTMLAudioElement | null
}

const peers = new Map<string, Peer>()
let selfId = ''
let notify: (deviceId: string, state: PeerState) => void = () => {}
let unmuted = false // 録音が始まったか（あとから届いたトラックにも同じ状態を適用する）

function send(toDeviceId: string, data: unknown): void {
  socket.emit('rtc_signal', { toDeviceId, data })
}

/**
 * ピアとの接続を1つ作る。トラックはまだ差し込まない（addTransceiver で
 * 「送る枠」だけ先に用意する）。こうすると ICE / DTLS を録音開始前に
 * 終わらせられて、録音開始時は replaceTrack だけで即座に音が通る。
 * replaceTrack は SDP の再交渉を伴わないので、ここが成立する。
 */
function createPeer(peerId: string): Peer | null {
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection(RTC_CONFIG)
  } catch (err) {
    // 非対応環境・非セキュアオリジン。ライブ音声だけ諦めてゲームは続ける。
    console.warn('[liveAudio] RTCPeerConnection を作れませんでした', err)
    notify(peerId, 'failed')
    return null
  }
  const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })
  const peer: Peer = { pc, sender: transceiver.sender, audio: null }

  pc.onicecandidate = e => {
    if (e.candidate) send(peerId, { kind: 'ice', candidate: e.candidate.toJSON() })
  }
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState
    if (s === 'connected') notify(peerId, 'connected')
    // 失敗は取り戻さない（再試行は実装しない）。表示だけ更新する。
    else if (s === 'failed' || s === 'closed' || s === 'disconnected') notify(peerId, 'failed')
  }
  pc.ontrack = e => {
    const stream = e.streams[0]
    if (!stream) return
    // <audio> で鳴らす。muted のうちは自動再生ポリシーに引っかからないので、
    // 準備フェーズで先に再生を始めておき、録音開始で muted を外すだけにする。
    const el = document.createElement('audio')
    el.srcObject = stream
    el.autoplay = true
    el.muted = !unmuted
    el.setAttribute('playsinline', '') // iOS で全画面プレイヤーに乗っ取られないように
    document.body.appendChild(el)
    el.play().catch(err => console.warn('[liveAudio] 再生を開始できませんでした', err))
    peer.audio = el
    // iOS Safari は <audio> に付けないと createMediaStreamSource が無音になる。
    // 上で必ず付けているので、この順序を入れ替えないこと。
    connectRemote(peerId, stream)
  }
  peers.set(peerId, peer)
  return peer
}

async function makeOffer(peerId: string, peer: Peer): Promise<void> {
  try {
    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    send(peerId, { kind: 'offer', sdp: peer.pc.localDescription })
  } catch (err) {
    console.warn('[liveAudio] offer を作れませんでした', err)
    notify(peerId, 'failed')
  }
}

/** 準備フェーズで呼ぶ。全ピアと接続を張るが、まだ音は出さない。冪等。 */
export function startLiveAudio(params: {
  selfDeviceId: string
  peerDeviceIds: string[]
  onPeerState: (deviceId: string, state: PeerState) => void
}): void {
  if (peers.size > 0) return // 冪等
  selfId = params.selfDeviceId
  notify = params.onPeerState
  unmuted = false
  for (const peerId of params.peerDeviceIds) {
    notify(peerId, 'connecting')
    const peer = createPeer(peerId)
    if (!peer) continue
    // 片側だけが offer を出す。相手は offer が届いてから answer を返す。
    if (shouldCreateOffer(selfId, peerId)) void makeOffer(peerId, peer)
  }
}

/** サーバーから中継されたシグナルを processing する。冪等ではない（順序に意味がある）。 */
export function handleSignal(fromDeviceId: string, data: unknown): void {
  const msg = data as { kind?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
  let peer = peers.get(fromDeviceId)
  // offer が先に届く側は、まだ peer を作っていないことがある
  if (!peer && msg.kind === 'offer') {
    notify(fromDeviceId, 'connecting')
    peer = createPeer(fromDeviceId) ?? undefined
  }
  if (!peer) return
  void (async () => {
    try {
      if (msg.kind === 'offer' && msg.sdp) {
        await peer.pc.setRemoteDescription(msg.sdp)
        const answer = await peer.pc.createAnswer()
        await peer.pc.setLocalDescription(answer)
        send(fromDeviceId, { kind: 'answer', sdp: peer.pc.localDescription })
      } else if (msg.kind === 'answer' && msg.sdp) {
        await peer.pc.setRemoteDescription(msg.sdp)
      } else if (msg.kind === 'ice' && msg.candidate) {
        await peer.pc.addIceCandidate(msg.candidate)
      }
    } catch (err) {
      // 順序の乱れや相手の切断で普通に起きる。そのピアだけ諦める。
      console.warn(`[liveAudio] シグナルを処理できませんでした from=${fromDeviceId}`, err)
      notify(fromDeviceId, 'failed')
    }
  })()
}

/**
 * 録音開始で呼ぶ。録音用に取ったマイクを送信トラックへ差し込み、リモート再生の
 * muted を外す。replaceTrack は再ネゴシエーションを伴わないので即座に通る。
 */
export function enableLiveAudio(micStream: MediaStream): void {
  unmuted = true
  const track = micStream.getAudioTracks()[0] ?? null
  for (const peer of peers.values()) {
    if (track) {
      peer.sender.replaceTrack(track).catch(err => {
        console.warn('[liveAudio] マイクを差し込めませんでした', err)
      })
    }
    if (peer.audio) peer.audio.muted = false
  }
}

/** 録音終了・中断・退出・解散で呼ぶ。冪等。 */
export function stopLiveAudio(): void {
  for (const [id, peer] of peers) {
    peer.pc.onicecandidate = null
    peer.pc.onconnectionstatechange = null
    peer.pc.ontrack = null
    try { peer.pc.close() } catch { /* 既に閉じている */ }
    if (peer.audio) {
      peer.audio.pause()
      peer.audio.srcObject = null
      peer.audio.remove()
    }
    disconnectRemote(id)
  }
  peers.clear()
  disconnectAllRemote() // 取りこぼし防止
  selfId = ''
  unmuted = false
  notify = () => {}
}
```

- [ ] **Step 4: `App.tsx` の `GameContext` に足す**

```ts
export interface GameContext {
  playerName: string
  deviceId: string
  isHost: boolean
  roomCode: string
  genre: string
  liveAudio: boolean                       // 追加：ホストが決めた「声の配信」の ON/OFF
  peerStates: Record<string, PeerState>    // 追加：deviceId → 接続状態（録音画面の表示用）
  players: PlayerSnapshot[]
  // …以降は現行のまま…
}
```

`import type { PeerState } from './liveAudio'` を足す。

`INITIAL_CTX` に追加する。

```ts
  liveAudio: false,
  peerStates: {},
```

- [ ] **Step 5: `useGameSocket.ts` に配線する**

import を足す。

```ts
import { startLiveAudio, enableLiveAudio, stopLiveAudio, handleSignal } from './liveAudio'
import { peerDeviceIds } from './liveAudioPure'
```

`room_created` / `room_joined` / `rejoined` / `room_reset` / `game_aborted` / `evaluation_failed` の各ハンドラで `liveAudio: room.liveAudio,` を `setCtx` に足す（`genre: room.genre` を書いている場所すべて）。

新しいリスナを2つ足す。

```ts
    function onLiveAudioChanged({ enabled }: { enabled: boolean }) {
      setCtx(prev => ({ ...prev, liveAudio: enabled }))
    }
    function onRtcSignal({ fromDeviceId, data }: { fromDeviceId: string; data: unknown }) {
      handleSignal(fromDeviceId, data)
    }
```

`socket.on` / `socket.off` の両方に登録する。

```ts
    socket.on('live_audio_changed', onLiveAudioChanged)
    socket.on('rtc_signal', onRtcSignal)
```

`onRecordingStarted` を変える。

```ts
    function onRecordingStarted() {
      // 正規の録音開始＝この回は記録される。前回の「復帰したので録音なし」を必ず解除する。
      setCtx(prev => ({ ...prev, rejoinedNoRecord: false }))
      setScreen('recording')
      // マイクを取得できたらライブ音声へ渡す。ライブ音声のために getUserMedia を
      // 増やさないための経路（recorder が取った1本を借りる）。
      startUploadRecorder(stream => enableLiveAudio(stream))
    }
```

`stopLiveAudio()` を呼ぶ箇所を足す（`cancelRecording()` を呼んでいる場所と、録音終了）。

```ts
    function onRecordingStopped() {
      stopLiveAudio() // 録音が終わったら声も切る（音が出るのは録音中だけ）
      setScreen('evaluating')
      void stopAndUpload(socket.id!)
    }
```

`onGameAborted` / `onDissolved` / `onDisconnect` / `onEvaluationFailed` の先頭にも `stopLiveAudio()` を足す。`leaveRoom` アクションにも足す。

新しいアクションを足す。

```ts
    setLiveAudio(enabled) {
      socket.emit('set_live_audio', { enabled })
    },
```

`GameActions` に `setLiveAudio: (enabled: boolean) => void` を追加する。

- [ ] **Step 6: `peerStates` の更新経路を作る**

`useGameSocket` の `Params` に `setCtx` があるので、`startLiveAudio` に渡すコールバックからそれを更新する。`PrepareScreen` が `startLiveAudio` を呼ぶので（Task 5）、そのためのアクションを `GameActions` に足す。

```ts
    startLiveAudioIfEnabled(liveAudio: boolean, players: PlayerSnapshot[], selfDeviceId: string) {
      if (!liveAudio) return
      const peerIds = peerDeviceIds(players, selfDeviceId)
      if (peerIds.length === 0) return
      startLiveAudio({
        selfDeviceId,
        peerDeviceIds: peerIds,
        onPeerState: (deviceId, state) => {
          setCtx(prev => ({ ...prev, peerStates: { ...prev.peerStates, [deviceId]: state } }))
        },
      })
    },
```

`GameActions` に追加する。

```ts
  startLiveAudioIfEnabled: (liveAudio: boolean, players: PlayerSnapshot[], selfDeviceId: string) => void
```

`import type { PlayerSnapshot }` が既にあることを確認する（無ければ足す）。

- [ ] **Step 7: 型チェック**

Run:
```bash
(cd client && npx tsc --noEmit)
(cd server && npx tsc --noEmit)
(cd client && npm test)
```
Expected: エラーなし・既存テスト全 PASS

- [ ] **Step 8: 自分の diff を通しで読み直す**

自動テストが無いので、ここが唯一の検証になる。次を1つずつ確認すること。

1. `stopLiveAudio()` が**すべての離脱経路**（録音終了・中断・解散・切断・退出・評価失敗）から呼ばれているか。漏れると `RTCPeerConnection` とマイク送信が生き残る
2. `connectRemote` が `ontrack` の中で、**`<audio>` に `srcObject` を設定したあとに**呼ばれているか（iOS の無音バグ）
3. `enableLiveAudio` が、**まだトラックが届いていないピア**にも後から効くか（`unmuted` フラグを見ているか）
4. `recorder.ts` の変更が**コールバック1行とシグネチャだけ**に収まっているか

- [ ] **Step 9: コミット**

```bash
git add client
git commit -m "$(cat <<'MSG'
feat: WebRTC でリモートの声を流す

接続は準備フェーズで addTransceiver だけ張っておき、録音開始で
replaceTrack でマイクを差し込む。replaceTrack は再ネゴシエーションを
伴わないので、ICE を録音開始前に終わらせつつ最初の掛け合いを
取りこぼさずに済む。ライブ音声のために getUserMedia を増やさない。

リモート音声は <audio> で鳴らし、録音用には mixDest へ別に分岐する。
Web Audio 経由で鳴らすとブラウザのエコーキャンセラの参照信号から
外れることがあり、iOS では createMediaStreamSource が無音になる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 5: 画面

**Files:**
- Modify: `client/src/screens/LobbyScreen.tsx`
- Modify: `client/src/screens/PrepareScreen.tsx`
- Modify: `client/src/screens/RecordingScreen.tsx`
- Modify: `client/src/screens/ResultScreen.tsx`

**Interfaces:**
- Consumes: Task 3 の `deviceCount` / `liveAudioToggleState`、Task 4 の `ctx.liveAudio` / `ctx.peerStates` / `actions.setLiveAudio` / `actions.startLiveAudioIfEnabled`
- Produces: なし（画面のみ）

- [ ] **Step 1: ロビーにトグルを置く**

`LobbyScreen.tsx` のジャンルパネルの**直後**に挿入する。ホスト用とゲスト用の出し分けは既存のジャンルUIと同じ構造にする。

```tsx
import { deviceCount, liveAudioToggleState } from '../liveAudioPure'
```

```tsx
  const toggleState = liveAudioToggleState(deviceCount(ctx.players))
```

```tsx
      {/* 声の配信：ジャンルと同じく「ホストが部屋全体で決める」設定なので、
          操作の作法もジャンル選択に揃える（新しい作法を発明しない）。 */}
      <div className="washi-panel mb-4">
        <div className="flex items-center justify-between mb-3">
          <p className="font-bold text-usuzumi text-sm">声の配信</p>
          {!ctx.isHost && (
            <span className="text-xs bg-sumi text-kinari px-2 py-0.5 font-medium">ホストが選択</span>
          )}
        </div>
        {toggleState === 'available' ? (
          <div className="flex gap-2">
            {[true, false].map(on => (
              <button
                key={String(on)}
                type="button"
                onClick={() => {
                  if (!ctx.isHost) {
                    setHostOnlyNudge(true)
                    setTimeout(() => setHostOnlyNudge(false), 1600)
                    return
                  }
                  actions.setLiveAudio(on)
                }}
                aria-disabled={!ctx.isHost}
                style={ctx.liveAudio === on ? { background: 'var(--genre)' } : undefined}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${
                  ctx.liveAudio === on ? 'text-kinari' : 'border border-sumi text-sumi hover:bg-sumi/5'
                } ${ctx.isHost ? '' : 'cursor-not-allowed'}`}
              >
                {on ? 'ON' : 'OFF'}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-usuzumi text-xs">
            {toggleState === 'alone'
              ? '他の端末が参加すると使えます'
              : `${MAX_LIVE_AUDIO_DEVICES}台までです（いまは${deviceCount(ctx.players)}台）`}
          </p>
        )}
        <p className="text-usuzumi text-xs mt-2">
          録音中、他の端末の声が聞こえます。離れた場所の人と掛け合うための機能です。
        </p>
      </div>
```

`MAX_LIVE_AUDIO_DEVICES` を `@shared/constants` の import に足す。

- [ ] **Step 2: 準備完了で接続を張る**

`PrepareScreen.tsx` の準備完了ボタンの `onClick` に1行足す。**ユーザー操作起点であることが重要**（`<audio>` の `play()` と `AudioContext` の resume が両方この文脈で通る）。

```tsx
        onClick={() => {
          resumeAudio() // ブラウザの自動再生ポリシー解除はユーザー操作起点でないと効かない
          // ライブ音声の接続もここで張る。理由は resumeAudio と同じで、
          // <audio> の play() がユーザー操作起点でないと弾かれるため。
          // 音が出るのは録音開始から（それまで <audio> は muted）。
          actions.startLiveAudioIfEnabled(ctx.liveAudio, ctx.players, ctx.deviceId)
          actions.setReady(!isReady)
        }}
```

配信ONのときだけ、台本パネルの下に注記を出す。

```tsx
      {ctx.liveAudio && (
        <div className="washi-panel mb-4">
          <p className="text-sumi text-sm">
            この回は<span className="font-bold">声の配信</span>が ON です。準備完了を押すと接続の準備を始め、
            録音が始まると他の端末の声が聞こえます。
          </p>
        </div>
      )}
```

- [ ] **Step 3: 録音画面に接続状態を出す**

`RecordingScreen.tsx` に、録音中フェーズの表示として追加する。**繋がらない人がいることが前提の機能なので隠さない。**

```tsx
import { peerDeviceIds } from '../liveAudioPure'
```

```tsx
  // 端末ごとの接続状態。表示名はその端末の代表プレイヤー名を使う。
  const peers = ctx.liveAudio ? peerDeviceIds(ctx.players, ctx.deviceId) : []
  const peerLabel = (deviceId: string) =>
    ctx.players.find(p => p.deviceId === deviceId)?.name ?? '相手'
  const anyFailed = peers.some(id => ctx.peerStates[id] === 'failed')
```

```tsx
      {peers.length > 0 && (
        <div className="washi-panel mb-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-usuzumi text-xs font-bold tracking-wider">声の配信</span>
            {peers.map(id => {
              const state = ctx.peerStates[id] ?? 'connecting'
              return (
                <span key={id} className="text-xs">
                  <span className="text-sumi">{peerLabel(id)}</span>
                  <span
                    className={state === 'connected' ? 'text-sumi' : 'text-shu'}
                  >
                    {state === 'connected' ? ' ✓' : state === 'failed' ? ' ✕' : ' …'}
                  </span>
                </span>
              )
            })}
          </div>
          {anyFailed && (
            <p className="text-usuzumi text-xs mt-1">
              ✕ の相手とは声が繋がりませんでした。<span className="font-bold">録音と採点は正常です。</span>
            </p>
          )}
        </div>
      )}
```

- [ ] **Step 4: 結果画面の見出し条件に配信ONを混ぜる**

`ResultScreen.tsx` の `soloDevice` を使っている「自分の演技を聞く」の見出しと、テイクの共有文言を変える。

```tsx
  // 配信ONの回は、1人しか乗っていない端末のテイクにも全員の声が入っている。
  // 「自分の演技」ではなく「みんなの熱演」と呼ぶのが正しい。
  const takeIsSolo = soloDevice && !ctx.liveAudio
```

`{soloDevice ? '自分の演技を聞く' : 'みんなの熱演を聞く'}` を `{takeIsSolo ? ... : ...}` に変える。`shareTake` の文言分岐も `soloDevice` から `takeIsSolo` に変える。

**「自分の結果を X でシェア」の条件（`hasMyScore`）は `soloDevice` のまま変えない。** スコアは端末に1人なら常に特定できるので、配信の ON/OFF とは無関係。

- [ ] **Step 5: 型チェック**

Run:
```bash
(cd client && npx tsc --noEmit)
(cd server && npx tsc --noEmit)
(cd client && npm test)
```
Expected: エラーなし・既存テスト全 PASS

- [ ] **Step 6: 自分の diff を通しで読み直す**

1. ゲストがトグルを押したとき、`setHostOnlyNudge` が既存のジャンルと同じ形で効いているか
2. `toggleState` が `available` でないときにトグルが**押せない**（そもそも描かれない）か
3. 録音画面の接続状態が、配信OFFの回には**出ない**か
4. 結果画面で「自分の結果を X でシェア」の条件を**変えていない**か

- [ ] **Step 7: コミット**

```bash
git add client/src/screens
git commit -m "$(cat <<'MSG'
feat: 声の配信の UI を置く

トグルはジャンル選択と同じ作法にする(ホストのみ操作可・ゲストは
バッジ表示)。無効化の理由は「相手がいない」と「台数超過」で
出し分ける。

録音画面には接続状態を出す。繋がらない人がいることが前提の機能
なので隠すと、ユーザーは録音そのものが失敗したと誤解する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Task 6: 通し確認と文書

**Files:**
- Create: `docs/superpowers/specs/2026-08-26-live-audio-manual-checklist.md`
- Modify: `doc/仕様書.md`
- Modify: `doc/frontend仕様書.md`
- Modify: `doc/backend仕様書.md`

- [ ] **Step 1: 全テストと型チェック**

Run:
```bash
(cd server && npm test)
(cd client && npm test)
(cd server && npx tsc --noEmit)
(cd client && npx tsc --noEmit)
```
Expected: すべて PASS。1本でも落ちたら止めて報告すること。

- [ ] **Step 2: 実機確認チェックリストを書く**

`docs/superpowers/specs/2026-08-26-live-audio-manual-checklist.md` を作る。設計書 9.3 節の6項目をベースに、**やる順**に並べること。冒頭に必ず次を書く。

- **同じ Wi-Fi の2台では意味がない。** NAT越えの検証にならないので、少なくとも1台はモバイル回線にすること
- マイクは HTTPS か localhost でしか使えない
- 実AI採点で確認すること（簡易モードでは帰属精度を判定できない）

各項目に「何をして、何が見えたら OK か」と「ダメなら何を疑うか」を添える。最重要は次の3つで、先頭に集めること。

1. **声が聞こえるか・遅延は掛け合いとして成立するか**（疑うところ: STUN で NAT を越えられたか。録音画面の ✓/✕ 表示を見る）
2. **帰属精度が落ちていないか** — 配信ONで演じた回の採点コメントが他人の演技を指していないか（疑うところ: AEC が効いていない。`<audio>` 経由で鳴らしているか）
3. **鑑賞用トラックに全員の声が入っているか** ＝ 繰り越していた C が実際に手に入ったかの確認（疑うところ: `connectRemote` が mixDest に繋がっているか）

- [ ] **Step 3: 仕様書を更新する**

まず3本とも読んでから、各仕様書の既存の粒度に合わせて追記する。**設計書へのリンクを張り、詳細はそちらに委ねる**（内容を全部コピーしない）。

- `doc/仕様書.md`: 「3. 進行フロー」の録音の項に、配信ONのときの挙動を1〜2行
- `doc/backend仕様書.md`: シグナリング中継の責務（サーバーは SDP を理解しない・`fromDeviceId` はサーバーが付ける）を1段落
- `doc/frontend仕様書.md`: `<audio>` 再生と mixDest 分岐の配線、`replaceTrack` でマイクを差し込む理由を1段落

実装と食い違っている既存の記述を見つけても**直さずに報告する**。

- [ ] **Step 4: 設計書の繰り越し節を更新する**

`docs/superpowers/specs/2026-08-26-live-audio-design.md` の11節の **C の行**に、実機確認待ちである旨を明記する（**確認結果そのものはユーザーが書き足す**ので、ここでは埋めない）。

- [ ] **Step 5: コミット**

```bash
git add doc docs
git commit -m "$(cat <<'MSG'
docs: ライブ音声の仕様と実機確認チェックリストを残す

この機能は中核が自動テストで守れない(RTCPeerConnection が Node にも
jsdom にも無く Playwright も使えない)ので、実機確認が事実上の唯一の
ゲートになる。手順を1本にまとめる。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Self-Review（この計画を書いたあとの確認結果）

**1. 仕様カバレッジ:** 設計書の全11節を照合した。

| 設計書の節 | 実装タスク |
|---|---|
| 4.1 部屋の状態 | Task 1 |
| 4.2 イベント | Task 1（トグル）・Task 2（シグナル） |
| 4.3 `rtc_signal` の検証 | Task 2 |
| 4.4 レート制限 | Task 2 |
| 4.5 端末数の上限 | Task 1（サーバー側の強制OFF）・Task 5（トグルの無効化） |
| 5.1 マイクは1本だけ | Task 4（`recorder.ts` のコールバック＋`replaceTrack`） |
| 5.2 `liveAudio.ts` | Task 3（純粋関数）・Task 4（本体） |
| 5.3 音の配線 | Task 4 |
| 5.4 ライフサイクル | Task 4（配線）・Task 5（準備完了での起動） |
| 6 UI | Task 5 |
| 7 既存機能との相互作用 | Task 5（結果画面）・他は「変更しない」＝実装なしが正 |
| 9 テスト方針 | Task 1-3 に分散＋Task 6 |
| 10 変更しないもの | Global Constraints |
| 11 繰り越し | Task 6 Step 4 |

**2. 見つけて直したギャップ:**
- Task 2 の「切断中の端末には中継されない」テストが**トートロジーだった**。切断済みのクライアントはそもそも受信できないので、「相手に届かない」ことを見ても実装が正しいことを何も証明しない。サーバーが中継前に捨てたことを**送信側の `signalCount` が増えていないこと**で観測する形に書き直した
- 設計書は `peerStates` の更新経路を書いていなかった。`startLiveAudio` のコールバックから `setCtx` を叩く必要があるが、`PrepareScreen` は `setCtx` を持たない。**`GameActions.startLiveAudioIfEnabled` を経由させる**形を Task 4 Step 6 で明示した
- 設計書 9.1 のテスト一覧は「`waiting` や `evaluating` のとき中継されない」と書いていたが、`evaluating` の状態を統合テストで作るには録音を通す必要があり、`waiting` のテストで同じガード（`status` の判定）を通せる。**`waiting` のケースだけを書く**ことにした（同じ1行のガードを2度検証しても得るものが無い）

**3. 型の一貫性:** `PeerState` / `startLiveAudio` / `enableLiveAudio` / `stopLiveAudio` / `handleSignal` / `connectRemote` / `shouldCreateOffer` / `peerDeviceIds` / `deviceCount` / `liveAudioToggleState` の名前と引数は Task 3 → 4 → 5 で一貫している。`liveAudio` は `Room` / `RoomSnapshot` / `GameContext` で同じ名前を使っている。
