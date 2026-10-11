import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, makeRecordingRoom } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => { server = await startTestServer() })
afterEach(async () => { await server.close() })

test('録音開始時に鳴っている BGM が無ければタイムラインは空で始まる', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  assert.deepEqual(server.rooms.get(roomCode)!.audioTimeline, [])
  host.disconnect(); guest.disconnect()
})

test('send_bgm がタイムラインに積まれる（中継も従来どおり行われる）', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const changed = once<{ bgmId: string | null }>(guest, 'bgm_changed')
  host.emit('send_bgm', { bgmId: 'horror' })
  assert.equal((await changed).bgmId, 'horror', '中継は今までどおり行われること')
  const tl = server.rooms.get(roomCode)!.audioTimeline
  assert.equal(tl.length, 1)
  assert.equal(tl[0].kind, 'bgm')
  assert.equal(tl[0].id, 'horror')
  assert.ok(tl[0].atMs >= 0 && tl[0].atMs < 3000)
  host.disconnect(); guest.disconnect()
})

test('BGM 停止（null）もエントリとして残る', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  host.emit('send_bgm', { bgmId: 'comedy' })
  await once(guest, 'bgm_changed')
  host.emit('send_bgm', { bgmId: null })
  await once(guest, 'bgm_changed')
  const tl = server.rooms.get(roomCode)!.audioTimeline
  assert.equal(tl.length, 2)
  assert.equal(tl[1].id, null, '区間を閉じるために null が要る')
  host.disconnect(); guest.disconnect()
})

test('send_sfx がタイムラインに積まれる', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const played = once(guest, 'sfx_played')
  host.emit('send_sfx', { sfxId: 'drum' })
  await played
  const tl = server.rooms.get(roomCode)!.audioTimeline
  assert.deepEqual(tl.map(e => [e.kind, e.id]), [['sfx', 'drum']])
  host.disconnect(); guest.disconnect()
})

test('不正な id はタイムラインにも積まれない', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  host.emit('send_sfx', { sfxId: 'にせもの' })
  host.emit('send_bgm', { bgmId: 'にせもの' })
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(server.rooms.get(roomCode)!.audioTimeline, [])
  host.disconnect(); guest.disconnect()
})

test('60 件を超えたぶんはタイムラインに積まない（中継は続く）', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  for (let i = 0; i < 70; i++) host.emit('send_sfx', { sfxId: 'drum' })
  await new Promise(r => setTimeout(r, 500))
  assert.equal(server.rooms.get(roomCode)!.audioTimeline.length, 60)
  host.disconnect(); guest.disconnect()
})

test('stop_recording で recordingDurationMs が確定する', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  await new Promise(r => setTimeout(r, 120))
  const stopped = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  const room = server.rooms.get(roomCode)!
  assert.ok(room.recordingDurationMs >= 100, `実尺が入ること (got ${room.recordingDurationMs})`)
  host.disconnect(); guest.disconnect()
})

test('録音していない状態（casting 以前）の send_bgm はタイムラインを汚さない', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stopped = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  host.emit('send_bgm', { bgmId: 'battle' }) // status は evaluating
  await new Promise(r => setTimeout(r, 200))
  assert.deepEqual(server.rooms.get(roomCode)!.audioTimeline, [])
  host.disconnect(); guest.disconnect()
})
