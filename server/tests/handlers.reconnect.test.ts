import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Socket } from 'socket.io-client'
import type { PlayerScore } from '@shared/types'
import {
  startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom,
  makeRoom, makeCastingRoom, uploadSkip,
} from './testUtils'
import { deviceBySocket } from '../src/roomStore'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

const sid = (s: Socket) => s.id!

test('room_created / room_joined は token を返す', async () => {
  const { host, guest, hostToken, guestToken } = await makeRoom(server.port)
  assert.equal(typeof hostToken, 'string')
  assert.ok(hostToken.length > 0)
  assert.ok(guestToken.length > 0)
  assert.notEqual(hostToken, guestToken)
  host.disconnect(); guest.disconnect()
})

test('非ホストの事故切断は即 player_left せず player_disconnected を配信（猶予保持）', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000 } })
  const { host, guest, roomCode } = await makeRoom(server.port)
  const dc = once<{ playerName: string }>(host, 'player_disconnected')
  guest.disconnect() // 事故切断（leave_room を経ない）
  const p = await dc
  assert.equal(p.playerName, 'はなこ')
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 2, '猶予中はスロットを保持する')
  host.disconnect()
})

test('猶予満了で player_left（未復帰）', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 200 } })
  const { host, roomCode, guest } = await makeRoom(server.port)
  const left = once<{ playerName: string }>(host, 'player_left')
  guest.disconnect()
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(server.rooms.get(roomCode)?.players.size, 1)
  host.disconnect()
})

test('leave_room は即 player_left（猶予なし）', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000 } })
  const { host, guest, roomCode } = await makeRoom(server.port)
  const left = once<{ playerName: string }>(host, 'player_left')
  guest.emit('leave_room')
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(server.rooms.get(roomCode)?.players.size, 1)
  host.disconnect(); guest.disconnect()
})

test('ホストの leave_room は従来どおり room_dissolved＋ルーム削除', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const dissolved = once(guest, 'room_dissolved')
  host.emit('leave_room')
  await dissolved
  assert.equal(server.rooms.get(roomCode), undefined)
  host.disconnect(); guest.disconnect()
})

// 中断/room_reset は resetRoom を通る。ここで猶予タイマーを消してしまうと切断中プレイヤーが
// 誰にも削除されず、永久に「復帰待ち…」のゴーストとして残る（人数カウントにも混じる）。
test('中断(abort_game)後も猶予満了で退出する', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 300, recordingLimitMs: 10_000 } })
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const aborted = once(host, 'game_aborted')
  host.emit('abort_game')
  await aborted
  const left = once<{ playerName: string }>(host, 'player_left', 2000)
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(server.rooms.get(roomCode)?.players.size, 1)
  host.disconnect()
})

test('切断中プレイヤーを待たずに allReady が成立する', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000 } })
  const { host, guest } = await makeCastingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const updated = once<{ allReady: boolean }>(host, 'ready_updated')
  host.emit('set_ready', { isReady: true }) // 接続中はホストだけ
  assert.equal((await updated).allReady, true)
  host.disconnect()
})

test('切断中プレイヤーは uploadExpected に入らず収集を止めない', async () => {
  await server.close()
  // タイムアウトで確定させない
  server = await startTestServer({ limits: { graceMs: 10_000, uploadTimeoutMs: 5_000, recordingLimitMs: 10_000 } })
  const { host, guest, roomCode, hostDeviceId } = await makeRecordingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const stopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  const room = server.rooms.get(roomCode)!
  assert.equal(room.uploadExpected.size, 1)
  assert.equal(room.uploadExpected.has(hostDeviceId), true)
  host.disconnect()
})

// --- rejoin（本人再接続）---

// 進行中に落とすテストではトークンを部屋から引く（makeRecordingRoom は token を返さないため）
const guestTokenOf = (roomCode: string) =>
  [...server.rooms.get(roomCode)!.devices.values()].find(d => !d.isHost)!.token

test('猶予内に rejoin(token) で復帰＝rejoined と player_reconnected', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000 } })
  const { host, guest, roomCode, guestToken, guestDeviceId } = await makeRoom(server.port)
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  const reconnected = once<{ playerName: string }>(host, 'player_reconnected')
  g2.emit('rejoin', { token: guestToken })
  const rj = await once<{ status: string; selfPlayerNames: string[]; room: { players: { name: string; connected: boolean }[] } }>(g2, 'rejoined')
  assert.deepEqual(rj.selfPlayerNames, ['はなこ'])
  assert.equal(rj.status, 'waiting')
  assert.equal(rj.room.players.find(p => p.name === 'はなこ')?.connected, true)
  assert.equal((await reconnected).playerName, 'はなこ')
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 2)
  assert.equal(deviceBySocket(room, sid(g2))?.id, guestDeviceId, '新しい socketId に付け替わる')
  host.disconnect(); g2.disconnect()
})

test('復帰後は猶予満了で退出させられない', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 200 } })
  const { host, guest, roomCode, guestToken } = await makeRoom(server.port)
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  await once(g2, 'rejoined')
  await expectNoEvent(host, 'player_left', 500) // 旧タイマーが発火しても消してはいけない
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  host.disconnect(); g2.disconnect()
})

test('無効トークンの rejoin は rejoin_failed', async () => {
  const c = connectClient(server.port)
  c.emit('rejoin', { token: 'bogus' })
  const f = await once<{ message: string }>(c, 'rejoin_failed')
  assert.ok(f.message.length > 0)
  c.disconnect()
})

test('猶予満了後の rejoin は rejoin_failed', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 150 } })
  const { host, guest, guestToken } = await makeRoom(server.port)
  const left = once(host, 'player_left')
  guest.disconnect()
  await left // スロットは消えた
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  await once(g2, 'rejoin_failed')
  host.disconnect(); g2.disconnect()
})

test('ホスト切断で解散した後の rejoin は rejoin_failed（ホストは対象外）', async () => {
  const { host, guest, guestToken } = await makeRoom(server.port)
  const dissolved = once(guest, 'room_dissolved')
  host.disconnect()
  await dissolved
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  await once(g2, 'rejoin_failed')
  guest.disconnect(); g2.disconnect()
})

test('casting 中に切断→rejoin で status=casting と台本を復元', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000 } })
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  const guestToken = guestTokenOf(roomCode)
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  const rj = await once<{ status: string; room: { script: unknown } }>(g2, 'rejoined')
  assert.equal(rj.status, 'casting')
  assert.ok(rj.room.script, '台本が snapshot に含まれる')
  host.disconnect(); g2.disconnect()
})

test('recording 中に切断→rejoin で status=recording を復元', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000, recordingLimitMs: 10_000 } })
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const guestToken = guestTokenOf(roomCode)
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  const rj = await once<{ status: string }>(g2, 'rejoined')
  assert.equal(rj.status, 'recording')
  host.disconnect(); g2.disconnect()
})

test('結果閲覧中(evaluating)に切断→rejoin で scores 入りの snapshot を復元', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000, uploadTimeoutMs: 80, recordingLimitMs: 10_000 } })
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const guestToken = guestTokenOf(roomCode)
  const evalHost = once(host, 'evaluation_complete')
  const evalGuest = once(guest, 'evaluation_complete')
  host.emit('stop_recording')
  await evalHost
  await evalGuest
  guest.disconnect()
  await once(host, 'player_disconnected')
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  const rj = await once<{ status: string; room: { scores: PlayerScore[] } }>(g2, 'rejoined')
  assert.equal(rj.status, 'evaluating')
  assert.ok(rj.room.scores.length > 0, 'scores があるのでクライアントは結果画面へ戻せる')
  host.disconnect(); g2.disconnect()
})

test('切断中プレイヤーは採点対象から外れ leftPlayers に入る', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000, uploadTimeoutMs: 80, recordingLimitMs: 10_000 } })
  const { host, guest } = await makeRecordingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const hostEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  const e = await hostEval
  assert.deepEqual(e.scores.map(s => s.playerName), ['たろう'])
  assert.deepEqual(e.leftPlayers, ['はなこ'])
  host.disconnect()
})

// 収集ウィンドウ中の再接続では「旧ソケットの disconnect より先に新ソケットの rejoin が処理される」
// 順序があり得る。その場合 reattachDevice が socketIndex から旧 socketId を消してしまうので、
// 後から届く旧ソケットの disconnect は findBySocket で部屋を引けず早期 return する
// ＝誰も uploadExpected を解放しない。ここを rejoin 側が塞いでいることを固定する。
// 旧ソケットを繋いだまま新ソケットから rejoin することで、この順序を決定的に再現する。
test('収集中は disconnect より先に rejoin が来ても収集ゲートが解放される', async () => {
  await server.close()
  // uploadTimeoutMs を長く取る＝タイムアウト経由ではなくゲート解放経由で確定したことを区別できる
  server = await startTestServer({
    limits: { graceMs: 10_000, uploadTimeoutMs: 10_000, recordingLimitMs: 10_000 },
  })
  const { host, guest, roomCode, guestDeviceId } = await makeRecordingRoom(server.port)
  const guestToken = guestTokenOf(roomCode)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await uploadSkip(server.port, sid(host)) // host は到達済み → 残る待ち対象はゲスト端末だけ
  assert.equal(server.rooms.get(roomCode)!.uploadExpected.has(guestDeviceId), true)

  const g2 = connectClient(server.port)
  // evaluation_complete は io.to で送信者含む全員へ同時配信されるため、先に listen してから emit
  const evalHost = once(host, 'evaluation_complete')
  const rejoined = once(g2, 'rejoined')
  g2.emit('rejoin', { token: guestToken })
  await rejoined
  await evalHost // 既定3秒で待つ＝10秒の uploadTimeoutMs 経由では間に合わない
  assert.equal(server.rooms.get(roomCode)!.uploadExpected.size, 0)
  host.disconnect(); guest.disconnect(); g2.disconnect()
})
