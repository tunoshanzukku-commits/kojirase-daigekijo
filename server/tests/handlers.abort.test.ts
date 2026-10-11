import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom } from './testUtils'
import type { RoomSnapshot } from '@shared/types'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

// status='casting'（配役/準備）まで進めた host(たろう)/guest(はなこ) を返す。
async function makeCastingRoom(port: number) {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  // io.to で送信者含む全員へ同時配信されるため、先に両方 listen してから emit する
  const scriptReadyGuest = once(guest, 'script_ready')
  const scriptReadyHost = once(host, 'script_ready')
  host.emit('start_game')
  await scriptReadyGuest
  await scriptReadyHost
  return { host, guest, roomCode }
}

// status='waiting' の host/guest（対象外ステータス検証用）
async function makeWaitingRoom(port: number) {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest, roomCode }
}

test('casting 中にホストが abort_game → 全員に game_aborted・room は waiting へ・genre 保持', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  const abortedGuest = once<{ room: RoomSnapshot }>(guest, 'game_aborted')
  const abortedHost = once<{ room: RoomSnapshot }>(host, 'game_aborted')
  host.emit('abort_game')
  const g = await abortedGuest
  const h = await abortedHost
  assert.equal(g.room.status, 'waiting')
  assert.equal(g.room.genre, 'comedy') // genre 保持
  assert.equal(g.room.script, null)
  assert.equal(h.room.status, 'waiting')
  const room = server.rooms.get(roomCode)!
  assert.equal(room.status, 'waiting')
  assert.equal(room.script, null)
  host.disconnect(); guest.disconnect()
})

test('recording 中にホストが abort_game → game_aborted 配信・評価に進まない', async () => {
  // 上限で勝手に終わらないよう十分長く（makeRecordingRoom より前に設定）
  await server.close()
  server = await startTestServer({ limits: { recordingLimitMs: 10_000 } })
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const abortedGuest = once(guest, 'game_aborted')
  host.emit('abort_game')
  await abortedGuest
  const room = server.rooms.get(roomCode)!
  assert.equal(room.status, 'waiting')
  // 中断後は録音終了フローが動かない
  await expectNoEvent(guest, 'recording_stopped', 400)
  host.disconnect(); guest.disconnect()
})

test('非ホストの abort_game は無視される', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  guest.emit('abort_game')
  await expectNoEvent(host, 'game_aborted', 300)
  const room = server.rooms.get(roomCode)!
  assert.equal(room.status, 'casting') // 変わらない
  host.disconnect(); guest.disconnect()
})

test('waiting 中の abort_game は無視される（対象外ステータス）', async () => {
  const { host, guest } = await makeWaitingRoom(server.port)
  host.emit('abort_game')
  await expectNoEvent(guest, 'game_aborted', 300)
  host.disconnect(); guest.disconnect()
})

test('evaluating 中の abort_game は無視される（対象外ステータス）', async () => {
  await server.close()
  server = await startTestServer({ limits: { recordingLimitMs: 10_000 } })
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await stoppedGuest // status→evaluating, collectingAudio=true
  host.emit('abort_game')
  await expectNoEvent(guest, 'game_aborted', 300)
  const room = server.rooms.get(roomCode)!
  assert.equal(room.status, 'evaluating')
  host.disconnect(); guest.disconnect()
})
