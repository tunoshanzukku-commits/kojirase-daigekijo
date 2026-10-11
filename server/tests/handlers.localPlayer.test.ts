import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRoom, makeCastingRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => { server = await startTestServer() })
afterEach(async () => { await server.close() })

test('ホストは自分の端末にプレイヤーを追加できる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  // add_local_player は io.to（送信者にも配信）を使う設計なので、追加した本人(host)にも
  // player_joined が届くことをここで確認する。io.to は送信者にも同時配信されるため、
  // 先に両方 listen してから emit する（逐次 await だと host 側を Windows で取りこぼす）。
  const joined = once<{ player: { name: string; deviceId: string; isHost: boolean } }>(guest, 'player_joined')
  const joinedSelf = once<{ player: { name: string; deviceId: string; isHost: boolean } }>(host, 'player_joined')
  host.emit('add_local_player', { playerName: 'じろう' })
  const { player } = await joined
  assert.equal(player.name, 'じろう')
  assert.equal(player.isHost, false) // 代表ではないのでホストバッジは付かない
  const selfPayload = await joinedSelf
  assert.equal(selfPayload.player.name, 'じろう') // 追加した本人にも自己配信される
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 3)
  assert.equal(room.devices.size, 2) // 端末は増えない
  host.disconnect(); guest.disconnect()
})

test('ゲストの端末にも追加できる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const joined = once(host, 'player_joined')
  guest.emit('add_local_player', { playerName: 'じろう' })
  await joined
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 3)
  assert.equal(room.devices.size, 2)
  host.disconnect(); guest.disconnect()
})

test('重複した名前は拒否される', async () => {
  const { host, guest } = await makeRoom(server.port)
  const err = once<{ message: string }>(host, 'error')
  host.emit('add_local_player', { playerName: 'はなこ' })
  assert.match((await err).message, /使われています/)
  host.disconnect(); guest.disconnect()
})

test('長すぎる名前は拒否される', async () => {
  const { host, guest } = await makeRoom(server.port)
  const err = once<{ message: string }>(host, 'error')
  host.emit('add_local_player', { playerName: 'あいうえおかきくけこさ' }) // 11文字
  assert.match((await err).message, /名前は/)
  host.disconnect(); guest.disconnect()
})

test('満員（10人）では追加できない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  for (let i = 0; i < 8; i++) {
    const joined = once(guest, 'player_joined')
    host.emit('add_local_player', { playerName: `ひと${i}` })
    await joined
  }
  assert.equal(server.rooms.get(roomCode)!.players.size, 10)
  const err = once<{ message: string }>(host, 'error')
  host.emit('add_local_player', { playerName: 'あふれ' })
  assert.match((await err).message, /満員/)
  host.disconnect(); guest.disconnect()
})

test('ゲーム進行中（casting）は追加できない', async () => {
  const { host, guest, roomCode } = await makeCastingRoom(server.port)
  host.emit('add_local_player', { playerName: 'じろう' })
  await expectNoEvent(guest, 'player_joined', 300)
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('追加したプレイヤーを削除できる', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const joined = once<{ player: { id: string } }>(guest, 'player_joined')
  host.emit('add_local_player', { playerName: 'じろう' })
  const playerId = (await joined).player.id
  const left = once<{ playerName: string }>(guest, 'player_left')
  host.emit('remove_local_player', { playerId })
  assert.equal((await left).playerName, 'じろう')
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('代表プレイヤーは remove_local_player で消せない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const room = server.rooms.get(roomCode)!
  const hostDevice = [...room.devices.values()].find(d => d.isHost)!
  host.emit('remove_local_player', { playerId: hostDevice.playerIds[0]! })
  await expectNoEvent(guest, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})

test('他端末のプレイヤーは削除できない', async () => {
  const { host, guest, roomCode } = await makeRoom(server.port)
  const room = server.rooms.get(roomCode)!
  const guestDevice = [...room.devices.values()].find(d => !d.isHost)!
  host.emit('remove_local_player', { playerId: guestDevice.playerIds[0]! })
  await expectNoEvent(guest, 'player_left', 300)
  assert.equal(server.rooms.get(roomCode)!.players.size, 2)
  host.disconnect(); guest.disconnect()
})
