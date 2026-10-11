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

async function makeRoomWithTwo() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest, roomCode }
}

test('set_ready は ready_updated を全員（送信元含む）に配信し、全員完了までは allReady=false', async () => {
  const { host, guest } = await makeRoomWithTwo()
  const guestSaw = once<{ playerName: string; isReady: boolean; allReady: boolean }>(guest, 'ready_updated')
  const hostSaw = once<{ playerName: string; allReady: boolean }>(host, 'ready_updated')
  host.emit('set_ready', { isReady: true })
  const u = await guestSaw
  assert.equal(u.playerName, 'たろう')
  assert.equal(u.isReady, true)
  assert.equal(u.allReady, false)
  // 送信元（ホスト）自身も自分の ready_updated を受け取る（io.to が socket.to に退行していないこと）
  const self = await hostSaw
  assert.equal(self.playerName, 'たろう')
  assert.equal(self.allReady, false)
  host.disconnect(); guest.disconnect()
})

test('全員 set_ready で allReady=true になる', async () => {
  const { host, guest } = await makeRoomWithTwo()
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  const hostSaw = once<{ allReady: boolean }>(host, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  const u = await hostSaw
  assert.equal(u.allReady, true)
  host.disconnect(); guest.disconnect()
})

test('set_ready(false) で allReady が false に戻る', async () => {
  const { host, guest } = await makeRoomWithTwo()
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  const hostSaw = once<{ allReady: boolean }>(host, 'ready_updated')
  guest.emit('set_ready', { isReady: false })
  const u = await hostSaw
  assert.equal(u.allReady, false)
  host.disconnect(); guest.disconnect()
})

test('ホストの start_recording は全員（送信元含む）に recording_started を配信', async () => {
  const { host, guest } = await makeRoomWithTwo()
  // start_recording は status='casting' でのみ有効なため、先に start_game で casting まで進める。
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  const scriptReadyGuest = once(guest, 'script_ready')
  const scriptReadyHost = once(host, 'script_ready')
  host.emit('start_game')
  await Promise.all([scriptReadyGuest, scriptReadyHost])
  const guestRec = once(guest, 'recording_started')
  const hostRec = once(host, 'recording_started') // 送信元自身も受け取る（ホストの自画面遷移に必要）
  host.emit('start_recording')
  await Promise.all([guestRec, hostRec])
  host.disconnect(); guest.disconnect()
})

test('非ホストの start_recording は無視される', async () => {
  const { host, guest } = await makeRoomWithTwo()
  let hostGotRec = false
  host.on('recording_started', () => { hostGotRec = true })
  guest.emit('start_recording')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(hostGotRec, false)
  host.disconnect(); guest.disconnect()
})
