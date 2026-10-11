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
