import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

// 事故切断は猶予（既定60秒）を挟むので、テストでは猶予を詰めて満了後の退出を見る。
// 「猶予中は保持される」側の検証は handlers.reconnect.test.ts。
test('ゲスト切断は猶予満了後にホストへ player_left を通知', async () => {
  await server.close()
  server = await startTestServer({ limits: { graceMs: 150 } })
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
  assert.equal(server.rooms.exists(roomCode), false)
  guest.disconnect()
})
