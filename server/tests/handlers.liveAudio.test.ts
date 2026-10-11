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
