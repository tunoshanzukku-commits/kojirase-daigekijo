import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  startTestServer, connectClient, once, expectNoEvent,
  makeRoom, makeCastingRoom, makeRecordingRoom,
} from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  // 猶予満了ではなくキックで消えたことを確かめるため長めに取る
  server = await startTestServer({ limits: { graceMs: 10_000 } })
})
afterEach(async () => {
  await server.close()
})

// はなこ が切断中（猶予スロット保持＝「復帰待ち…」）の waiting ルーム
async function makeRoomWithGhost(port: number) {
  const r = await makeRoom(port)
  const dc = once(r.host, 'player_disconnected')
  r.guest.disconnect()
  await dc
  return r
}

test('ホストは切断中の端末をキックできる', async () => {
  const { host, roomCode, guestDeviceId } = await makeRoomWithGhost(server.port)
  const left = once<{ playerName: string }>(host, 'player_left')
  host.emit('kick_device', { deviceId: guestDeviceId })
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(server.rooms.get(roomCode)?.players.size, 1)
  assert.equal(server.rooms.get(roomCode)?.devices.size, 1)
  host.disconnect()
})

test('接続中の端末はキックできない', async () => {
  const { host, guest, roomCode, guestDeviceId } = await makeRoom(server.port)
  host.emit('kick_device', { deviceId: guestDeviceId })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('存在しない deviceId の kick_device は無視される', async () => {
  const { host, roomCode } = await makeRoomWithGhost(server.port)
  host.emit('kick_device', { deviceId: 'no-such-device' })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  host.disconnect()
})

test('非ホストの kick_device は無視される', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const g2 = connectClient(server.port)
  g2.emit('join_room', { roomCode, playerName: 'さぶろう' })
  const g2j = await once<{ deviceId: string }>(g2, 'room_joined')
  await once(host, 'player_joined') // makeRoom で1回目は消化済み＝これは さぶろう の分
  const dc = once(host, 'player_disconnected')
  g2.disconnect() // さぶろう を「復帰待ち」にする
  await dc
  guest.emit('kick_device', { deviceId: g2j.deviceId }) // ゲストが要求 → 無視されるべき
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 3)
  host.disconnect(); guest.disconnect()
})

test('casting 中の kick_device は無視される', async () => {
  const { host, guest, roomCode, guestDeviceId } = await makeCastingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  host.emit('kick_device', { deviceId: guestDeviceId })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  host.disconnect()
})

test('recording 中の kick_device は無視される', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 10_000, recordingLimitMs: 10_000 } })
  const { host, guest, roomCode, guestDeviceId } = await makeRecordingRoom(server.port)
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  host.emit('kick_device', { deviceId: guestDeviceId })
  await expectNoEvent(host, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  host.disconnect()
})

test('結果待ち(evaluating)でもキックできる', async () => {
  await server.close()
  // 誰もアップロードしないので即 finalize させる
  server = await startTestServer({ limits: { graceMs: 10_000, recordingLimitMs: 10_000, uploadTimeoutMs: 80 } })
  const { host, guest, roomCode, guestDeviceId } = await makeRecordingRoom(server.port)
  const evalHost = once(host, 'evaluation_complete')
  host.emit('stop_recording')
  await evalHost // status='evaluating'（結果待ち）
  const dc = once(host, 'player_disconnected')
  guest.disconnect()
  await dc
  const left = once<{ playerName: string }>(host, 'player_left')
  host.emit('kick_device', { deviceId: guestDeviceId })
  assert.equal((await left).playerName, 'はなこ')
  assert.equal(server.rooms.get(roomCode)?.players.size, 1)
  host.disconnect()
})

test('キック後に猶予が満了しても player_left は二度飛ばない', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 800 } })
  const { host, roomCode, guestDeviceId } = await makeRoomWithGhost(server.port)
  const left = once(host, 'player_left')
  host.emit('kick_device', { deviceId: guestDeviceId })
  await left
  assert.equal(server.rooms.get(roomCode)!.graceTimers.size, 0, 'キックで猶予タイマーも解除されている')
  await expectNoEvent(host, 'player_left', 1200) // 猶予満了(800ms)を跨いで再送が無いこと
  host.disconnect()
})

test('キックされたプレイヤーは token で戻れない', async () => {
  const { host, guestToken, guestDeviceId } = await makeRoomWithGhost(server.port)
  const left = once(host, 'player_left')
  host.emit('kick_device', { deviceId: guestDeviceId })
  await left
  const g2 = connectClient(server.port)
  g2.emit('rejoin', { token: guestToken })
  await once(g2, 'rejoin_failed')
  host.disconnect(); g2.disconnect()
})
