import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, expectNoEvent, makeRecordingRoom, uploadSkip } from './testUtils'
import type { Socket } from 'socket.io-client'
import type { Mixdown } from '../src/mixdown'

const sid = (s: Socket): string => s.id as string
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])
const WORK = Buffer.from('mixed-work-bytes')

let server: Awaited<ReturnType<typeof startTestServer>>

function uploadAudio(port: number, socketId: string) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

afterEach(async () => { await server.close() })

// 収集ウィンドウを開いた host/guest を返す
async function collecting() {
  const r = await makeRecordingRoom(server.port)
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  return r
}

test('採点完了のあとに work_ready がパスつきで届く', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const ready = once<{ url: string }>(host, 'work_ready')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await once(host, 'evaluation_complete')
  const { url } = await ready
  const room = server.rooms.get(roomCode)!
  assert.equal(url, `/work/${roomCode}/${room.workToken}`, 'パスだけを返すこと（ホスト名を組まない）')
  assert.ok(room.workToken && room.workToken.length > 10, '推測できないトークンであること')
  assert.deepEqual(room.work, WORK)
  host.disconnect(); guest.disconnect()
})

test('work_ready は evaluation_complete より後に出る（採点を待たせない）', async () => {
  let resolveMix: (b: Buffer) => void = () => {}
  const mixdown: Mixdown = () => new Promise<Buffer>(r => { resolveMix = r })
  server = await startTestServer({ mixdown })
  const { host, guest } = await collecting()
  const ready = once(host, 'work_ready', 5000)
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await once(host, 'evaluation_complete') // 合成が終わっていなくても採点は出る
  resolveMix(WORK)
  await ready
  host.disconnect(); guest.disconnect()
})

test('合成に成功したら room.audio は破棄される（メモリを抱えない）', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const ready = once(host, 'work_ready')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await ready
  assert.equal(server.rooms.get(roomCode)!.audio.size, 0)
  host.disconnect(); guest.disconnect()
})

test('合成が失敗したら work_failed が出て work は空のまま', async () => {
  const mixdown: Mixdown = async () => { throw new Error('boom') }
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const failed = once(host, 'work_failed')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await failed
  assert.equal(server.rooms.get(roomCode)!.work, null)
  host.disconnect(); guest.disconnect()
})

test('全員がマイク拒否なら合成せず work_failed を出す', async () => {
  let called = false
  const mixdown: Mixdown = async () => { called = true; return WORK }
  server = await startTestServer({ mixdown })
  const { host, guest } = await collecting()
  const failed = once(host, 'work_failed')
  await uploadSkip(server.port, sid(host))
  await uploadSkip(server.port, sid(guest))
  await failed
  assert.equal(called, false, '素材が無いのに ffmpeg を起動しないこと')
  host.disconnect(); guest.disconnect()
})

test('合成中にロビーへ戻ったら work_ready は出ない', async () => {
  let resolveMix: (b: Buffer) => void = () => {}
  const mixdown: Mixdown = () => new Promise<Buffer>(r => { resolveMix = r })
  server = await startTestServer({ mixdown })
  const { host, guest } = await collecting()
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await once(host, 'evaluation_complete')
  const reset = once(host, 'room_reset')
  host.emit('return_to_lobby')
  guest.emit('return_to_lobby')
  await reset
  const quiet = expectNoEvent(host, 'work_ready', 400)
  resolveMix(WORK)
  await quiet
  host.disconnect(); guest.disconnect()
})

test('ロビーへ戻ると work と workToken が消える', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const { host, guest, roomCode } = await collecting()
  const ready = once(host, 'work_ready')
  await uploadAudio(server.port, sid(host))
  await uploadAudio(server.port, sid(guest))
  await ready
  const reset = once(host, 'room_reset')
  host.emit('return_to_lobby')
  guest.emit('return_to_lobby')
  await reset
  const room = server.rooms.get(roomCode)!
  assert.equal(room.work, null)
  assert.equal(room.workToken, null)
  host.disconnect(); guest.disconnect()
})

test('合成には端末ごとの遅れとタイムラインが渡る', async () => {
  let seen: Parameters<Mixdown>[0] | null = null
  const mixdown: Mixdown = async input => { seen = input; return WORK }
  server = await startTestServer({ mixdown })
  const r = await makeRecordingRoom(server.port)
  r.host.emit('send_sfx', { sfxId: 'drum' })
  await once(r.guest, 'sfx_played')
  // Windows の Date.now() は往復だけでは経過を捉えられないことがある
  // （実測: 明示的な待ちが無いと durationMs が 0 になり得る）。
  // handlers.timeline.test.ts の「stop_recording で recordingDurationMs が確定する」
  // と同じ理由で、確実に経過させてから止める。
  await new Promise(res => setTimeout(res, 50))
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const ready = once(r.host, 'work_ready')
  const form = new FormData()
  form.append('socketId', sid(r.host))
  form.append('startedAt', String(server.rooms.get(r.roomCode)!.recordingStartedAt + 400))
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  await uploadAudio(server.port, sid(r.guest))
  await ready
  // いったん別の const に移す。let のまま assert.ok に渡すと、TS は
  // 「コールバックの代入は見えない」ので null に絞り、続く参照が never になる。
  const captured = seen as Parameters<Mixdown>[0] | null
  assert.ok(captured, '合成が呼ばれること')
  assert.ok(captured.tracks.some(t => t.delayMs === 400), '申告した遅れが渡ること')
  assert.deepEqual(captured.timeline.map(e => e.id), ['drum'])
  assert.ok(captured.durationMs > 0)
  r.host.disconnect(); r.guest.disconnect()
})
