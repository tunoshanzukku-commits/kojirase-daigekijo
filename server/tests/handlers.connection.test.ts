import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
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

// 接続待ちの間に連打された分は socket.io のクライアントが溜め、繋がった瞬間にまとめて届く。
// 1つの接続から作れる部屋は1つまで。2回目以降は黙って無視する（成功した人にエラーを見せない）。
test('同じ接続から create_room がまとめて届いても部屋は1つだけ作る', async () => {
  const host = connectClient(server.port)
  const created: { roomCode: string }[] = []
  const errors: unknown[] = []
  host.on('room_created', p => created.push(p))
  host.on('error', e => errors.push(e))
  for (let i = 0; i < 3; i++) host.emit('create_room', { playerName: 'たろう' })
  await once(host, 'room_created')
  await new Promise(r => setTimeout(r, 300)) // 残りの2回ぶんが届く猶予
  assert.equal(created.length, 1)
  assert.deepEqual(errors, [])
  assert.equal(server.rooms.findBySocket(host.id!)?.code, created[0].roomCode)
  host.disconnect()
})

test('部屋に入っている接続からの join_room は無視する（重複送信・別の部屋どちらも）', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')

  const guest = connectClient(server.port)
  const joined: unknown[] = []
  const errors: unknown[] = []
  guest.on('room_joined', p => joined.push(p))
  guest.on('error', e => errors.push(e))
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  guest.emit('join_room', { roomCode, playerName: 'はなこ' }) // 連打の2回目（これまでは「名前が使われています」が出ていた）
  await once(guest, 'room_joined')

  // ホストが別の部屋への参加を送っても入らない
  const other = connectClient(server.port)
  other.emit('create_room', { playerName: 'じろう' })
  const { roomCode: otherCode } = await once<{ roomCode: string }>(other, 'room_created')
  const otherNotified = expectNoEvent(other, 'player_joined', 300)
  host.emit('join_room', { roomCode: otherCode, playerName: 'たろう' })
  await otherNotified

  assert.equal(joined.length, 1)
  assert.deepEqual(errors, [])
  assert.equal(server.rooms.get(roomCode)?.players.size, 2)
  assert.equal(server.rooms.get(otherCode)?.players.size, 1)
  assert.equal(server.rooms.findBySocket(host.id!)?.code, roomCode)
  host.disconnect(); guest.disconnect(); other.disconnect()
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
