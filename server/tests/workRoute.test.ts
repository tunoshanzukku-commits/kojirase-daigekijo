import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, makeRecordingRoom } from './testUtils'
import type { Socket } from 'socket.io-client'
import type { Mixdown } from '../src/mixdown'

const sid = (s: Socket): string => s.id as string
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
const WORK = Buffer.from('mixed-work-bytes')

let server: Awaited<ReturnType<typeof startTestServer>>

afterEach(async () => { await server.close() })

// work が出来上がった部屋を返す
async function roomWithWork() {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown })
  const r = await makeRecordingRoom(server.port)
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const ready = once<{ url: string }>(r.host, 'work_ready')
  for (const s of [r.host, r.guest]) {
    const form = new FormData()
    form.append('socketId', sid(s))
    form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
    await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  }
  const { url } = await ready
  return { ...r, url }
}

test('正しい URL で作品を取得できる', async () => {
  const { host, guest, url } = await roomWithWork()
  const res = await fetch(`http://localhost:${server.port}${url}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /audio\/mp4/)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), WORK)
  host.disconnect(); guest.disconnect()
})

test('トークンが違えば 404（部屋コードの総当たりで他人の演技を引けない）', async () => {
  const { host, guest, roomCode } = await roomWithWork()
  const res = await fetch(`http://localhost:${server.port}/work/${roomCode}/にせトークン`)
  assert.equal(res.status, 404, '403 と撃ち分けない＝存在の有無を漏らさない')
  host.disconnect(); guest.disconnect()
})

test('存在しない部屋は 404', async () => {
  const { host, guest } = await roomWithWork()
  const res = await fetch(`http://localhost:${server.port}/work/ZZZZ/なんでも`)
  assert.equal(res.status, 404)
  host.disconnect(); guest.disconnect()
})

test('まだ作品が無い部屋は 404', async () => {
  server = await startTestServer()
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const res = await fetch(`http://localhost:${server.port}/work/${roomCode}/なんでも`)
  assert.equal(res.status, 404)
  host.disconnect(); guest.disconnect()
})

test('上限を超えたら 429 を返す', async () => {
  const mixdown: Mixdown = async () => WORK
  server = await startTestServer({ mixdown, limits: { workRateMax: 2 } })
  const r = await makeRecordingRoom(server.port)
  const stoppedHost = once(r.host, 'recording_stopped')
  const stoppedGuest = once(r.guest, 'recording_stopped')
  r.host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const ready = once<{ url: string }>(r.host, 'work_ready')
  for (const s of [r.host, r.guest]) {
    const form = new FormData()
    form.append('socketId', sid(s))
    form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
    await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  }
  const { url } = await ready
  await fetch(`http://localhost:${server.port}${url}`)
  await fetch(`http://localhost:${server.port}${url}`)
  const third = await fetch(`http://localhost:${server.port}${url}`)
  assert.equal(third.status, 429)
  r.host.disconnect(); r.guest.disconnect()
})
