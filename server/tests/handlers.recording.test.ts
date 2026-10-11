import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// 待機中(status='waiting')の host/guest を返す（status ガード検証用）
async function makeWaitingRoom() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  await once(host, 'player_joined')
  return { host, guest }
}

test('send_reaction は許可絵文字を送信者以外へ reaction_received で配信', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestSaw = once<{ emoji: string; playerName: string }>(guest, 'reaction_received')
  let hostSaw = false
  host.on('reaction_received', () => { hostSaw = true })
  host.emit('send_reaction', { emoji: '🔥' })
  const r = await guestSaw
  assert.equal(r.emoji, '🔥')
  assert.equal(r.playerName, 'たろう')
  await delay(150)
  assert.equal(hostSaw, false) // socket.to：送信者自身には届かない
  host.disconnect(); guest.disconnect()
})

test('send_reaction は不正絵文字を無視', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  let guestSaw = false
  guest.on('reaction_received', () => { guestSaw = true })
  host.emit('send_reaction', { emoji: '💩' })
  await delay(200)
  assert.equal(guestSaw, false)
  host.disconnect(); guest.disconnect()
})

test('send_sfx は許可IDを送信者以外へ sfx_played で配信', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestSaw = once<{ sfxId: string; playerName: string }>(guest, 'sfx_played')
  host.emit('send_sfx', { sfxId: 'drum' })
  const s = await guestSaw
  assert.equal(s.sfxId, 'drum')
  assert.equal(s.playerName, 'たろう')
  host.disconnect(); guest.disconnect()
})

test('send_sfx は不正IDを無視', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  let guestSaw = false
  guest.on('sfx_played', () => { guestSaw = true })
  host.emit('send_sfx', { sfxId: 'explode' })
  await delay(200)
  assert.equal(guestSaw, false)
  host.disconnect(); guest.disconnect()
})

test('send_bgm は bgm_changed を送信者含む全員へ配信（null で解除）', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestSaw = once<{ bgmId: string | null; playerName: string }>(guest, 'bgm_changed')
  const hostSaw = once<{ bgmId: string | null }>(host, 'bgm_changed')
  host.emit('send_bgm', { bgmId: 'dramatic' })
  const g = await guestSaw
  const h = await hostSaw
  assert.equal(g.bgmId, 'dramatic')
  assert.equal(g.playerName, 'たろう')
  assert.equal(h.bgmId, 'dramatic') // io.to：送信者も受け取る
  // null で解除
  const guestSaw2 = once<{ bgmId: string | null }>(guest, 'bgm_changed')
  host.emit('send_bgm', { bgmId: null })
  const g2 = await guestSaw2
  assert.equal(g2.bgmId, null)
  host.disconnect(); guest.disconnect()
})

test('send_bgm は不正IDを無視', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  let guestSaw = false
  guest.on('bgm_changed', () => { guestSaw = true })
  host.emit('send_bgm', { bgmId: 'rock' })
  await delay(200)
  assert.equal(guestSaw, false)
  host.disconnect(); guest.disconnect()
})

test('send_volume は volume_update を配信し、初回は自分の level を反映', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestSaw = once<{ level: number }>(guest, 'volume_update')
  host.emit('send_volume', { level: 0.5 })
  const v = await guestSaw
  assert.ok(Math.abs(v.level - 0.5) < 0.01, `level=${v.level}`)
  host.disconnect(); guest.disconnect()
})

test('send_volume は複数プレイヤーの声量を合算(sum-clamp)', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const first = once<{ level: number }>(guest, 'volume_update')
  host.emit('send_volume', { level: 0.5 })
  const f = await first
  assert.ok(Math.abs(f.level - 0.5) < 0.01)
  await delay(250) // スロットル解除＋host の値は 500ms 窓内に残る
  const second = once<{ level: number }>(guest, 'volume_update')
  guest.emit('send_volume', { level: 0.5 })
  const s = await second
  assert.ok(s.level > 0.99, `合算 level=${s.level}`) // 0.5+0.5=1.0 にクランプ
  host.disconnect(); guest.disconnect()
})

test('send_volume は 200ms 未満の連続送信をスロットル（1回だけ配信）', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  let count = 0
  guest.on('volume_update', () => { count++ })
  host.emit('send_volume', { level: 0.3 })
  host.emit('send_volume', { level: 0.6 })
  host.emit('send_volume', { level: 0.9 })
  await delay(150)
  assert.equal(count, 1)
  host.disconnect(); guest.disconnect()
})

test('start_recording は status が casting 以外では無視される（waiting 中は録音開始しない）', async () => {
  const { host, guest } = await makeWaitingRoom()
  host.emit('start_recording')
  await expectNoEvent(host, 'recording_started')
  host.disconnect(); guest.disconnect()
})

test('status が recording 以外では 4イベントとも無視', async () => {
  const { host, guest } = await makeWaitingRoom()
  let saw = false
  guest.on('reaction_received', () => { saw = true })
  guest.on('sfx_played', () => { saw = true })
  guest.on('bgm_changed', () => { saw = true })
  guest.on('volume_update', () => { saw = true })
  host.emit('send_reaction', { emoji: '🔥' })
  host.emit('send_sfx', { sfxId: 'drum' })
  host.emit('send_bgm', { bgmId: 'dramatic' })
  host.emit('send_volume', { level: 0.5 })
  await delay(250)
  assert.equal(saw, false)
  host.disconnect(); guest.disconnect()
})

test('録音時間の上限に達すると自動で recording_stopped が配信される', async () => {
  // 上限を短縮（makeRecordingRoom より前に設定すること）
  await server.close()
  server = await startTestServer({ limits: { recordingLimitMs: 800 } })
  const { host, guest } = await makeRecordingRoom(server.port)
  // ホストは stop_recording を送らない。上限タイマーだけで終了すること。
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  await Promise.all([stoppedGuest, stoppedHost])
  host.disconnect(); guest.disconnect()
})

test('ホストが上限前に停止したら上限タイマーは二重に発火しない', async () => {
  await server.close()
  server = await startTestServer({ limits: { recordingLimitMs: 300 } })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedGuest, stoppedHost])
  // 上限(300ms)を跨いでも 2 回目の recording_stopped は来ない（タイマーは解除済み）
  await expectNoEvent(guest, 'recording_stopped', 500)
  host.disconnect(); guest.disconnect()
})

test('収集中に上限タイマーが満了しても収集はやり直されない', async () => {
  await server.close()
  server = await startTestServer({ limits: { recordingLimitMs: 300 } })
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedGuest, stoppedHost])
  const room = server.rooms.get(roomCode)!
  assert.equal(room.collectingAudio, true)
  // 上限を跨いでも beginAudioCollection は status ガードで空振りし、
  // 収集ウィンドウが作り直されない（アップロードのタイムアウトは既定 15s のまま）
  await new Promise(r => setTimeout(r, 500))
  assert.equal(room.collectingAudio, true)
  assert.equal(room.status, 'evaluating')
  host.disconnect(); guest.disconnect()
})
