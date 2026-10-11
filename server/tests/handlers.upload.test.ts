import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, once, expectNoEvent, makeRecordingRoom, uploadSkip } from './testUtils'
import type { PlayerScore } from '@shared/types'
import type { Socket } from 'socket.io-client'

// socket.io-client は id を string | undefined と型付けするが、接続確立後は必ず存在する
const sid = (s: Socket): string => s.id as string

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  // 既定はタイムアウトで確定させない（ゲートを見るため）
  server = await startTestServer({ limits: { uploadTimeoutMs: 5000 } })
})
afterEach(async () => {
  await server.close()
})

// webm の先頭バイト列を模した少量のダミー音声
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])

function uploadAudio(port: number, socketId: string, bytes: Uint8Array = AUDIO) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('audio', new Blob([bytes], { type: 'audio/webm' }), 'take.webm')
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

// 収集ウィンドウを開いた（stop_recording 済みの）host/guest を返す
async function makeCollectingRoom() {
  const { host, guest, roomCode, hostDeviceId } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  return { host, guest, roomCode, hostDeviceId }
}

test('収集中の /upload は受理され Room.audio に格納される', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const res = await uploadAudio(server.port, sid(host))
  assert.equal(res.status, 200)
  const stored = server.rooms.get(roomCode)!.audio.get(hostDeviceId)
  assert.ok(stored, 'host の音声が格納されていること')
  assert.equal(stored.buffer.length, AUDIO.length)
  assert.match(stored.mime, /audio\/webm/)
  host.disconnect(); guest.disconnect()
})

test('全員のアップロードが揃うまで evaluation_complete は出ない', async () => {
  const { host, guest } = await makeCollectingRoom()
  await uploadAudio(server.port, sid(host))
  await expectNoEvent(host, 'evaluation_complete', 300) // 片方だけでは確定しない
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  await uploadAudio(server.port, sid(guest))
  const e = await hostEval
  assert.equal(e.scores.length, 2)
  assert.deepEqual(e.scores.map(s => s.playerName).sort(), ['たろう', 'はなこ'])
  host.disconnect(); guest.disconnect()
})

test('収集中でない /upload は 409 で拒否される', async () => {
  const { host, guest } = await makeRecordingRoom(server.port) // まだ stop_recording していない
  const res = await uploadAudio(server.port, sid(host))
  assert.equal(res.status, 409)
  host.disconnect(); guest.disconnect()
})

test('部屋に属さない socketId の /upload は 409', async () => {
  const { host, guest } = await makeCollectingRoom()
  const res = await uploadAudio(server.port, 'not-a-real-socket-id')
  assert.equal(res.status, 409)
  host.disconnect(); guest.disconnect()
})

test('socketId 欠落の /upload は 400', async () => {
  const { host, guest } = await makeCollectingRoom()
  const form = new FormData()
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  const res = await fetch(`http://localhost:${server.port}/upload`, { method: 'POST', body: form })
  assert.equal(res.status, 400)
  host.disconnect(); guest.disconnect()
})

test('skip マーカーだけでも収集は進み finalize される', async () => {
  const { host, guest, roomCode } = await makeCollectingRoom()
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  await uploadSkip(server.port, sid(host))
  await uploadSkip(server.port, sid(guest))
  const e = await hostEval // 音声ゼロでもタイムアウトを待たず確定する
  assert.equal(e.scores.length, 2)
  assert.equal(server.rooms.get(roomCode)!.audio.size, 0)
  host.disconnect(); guest.disconnect()
})

test('未着があってもタイムアウトで evaluation_complete が出る', async () => {
  await server.close()
  server = await startTestServer({ limits: { uploadTimeoutMs: 80 } })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await uploadAudio(server.port, sid(host)) // guest は送らない
  const e = await hostEval
  assert.equal(e.scores.length, 2)
  host.disconnect(); guest.disconnect()
})

test('収集中に相手が離脱したら残りだけで finalize（デッドロック回避）', async () => {
  const { host, guest } = await makeCollectingRoom()
  await uploadAudio(server.port, sid(host)) // host は到達済み → 残りの待ち対象は guest だけ
  const hostEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(host, 'evaluation_complete')
  guest.disconnect() // 最後の待ち対象が抜ける → 残りだけで確定しなければならない
  const e = await hostEval
  assert.deepEqual(e.scores.map(s => s.playerName), ['たろう'])
  assert.deepEqual(e.leftPlayers, ['はなこ'])
  host.disconnect()
})

test('finalize 後に遅れて届いた /upload は 409 で弾かれる', async () => {
  const { host, guest, roomCode } = await makeCollectingRoom()
  const hostEval = once(host, 'evaluation_complete')
  await uploadSkip(server.port, sid(host))
  await uploadSkip(server.port, sid(guest))
  await hostEval // 収集ウィンドウは閉じた
  const res = await uploadAudio(server.port, sid(host))
  assert.equal(res.status, 409)
  assert.equal(server.rooms.get(roomCode)!.audio.size, 0)
  host.disconnect(); guest.disconnect()
})

test('25MBを超える音声の /upload は413で拒否されゲートも解放される', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const oversized = new Uint8Array(26 * 1024 * 1024) // MAX_UPLOAD_BYTES(25MB) を超える
  const res = await uploadAudio(server.port, sid(host), oversized)
  assert.equal(res.status, 413)
  assert.equal(server.rooms.get(roomCode)!.audio.has(hostDeviceId), false, '超過分は格納されない')
  assert.equal(server.rooms.get(roomCode)!.uploadExpected.has(hostDeviceId), false, 'ゲートは解放される')
  host.disconnect(); guest.disconnect()
})

test('POST /upload は同一IPから短時間に叩きすぎると 429 を返す', async () => {
  const server = await startTestServer()
  try {
    // 上限は 60 秒に 30 回。socketId 無しの 400 でもレート制限は数える。
    let last = 0
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`http://localhost:${server.port}/upload`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.1' },
        body: new FormData(),
      })
      last = res.status
    }
    assert.equal(last, 429)
  } finally {
    await server.close()
  }
})

function uploadAudioAt(port: number, socketId: string, startedAt: string) {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('audio', new Blob([AUDIO], { type: 'audio/webm' }), 'take.webm')
  form.append('startedAt', startedAt)
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

test('startedAt から delayMs（録音開始からの遅れ）を算出して保存する', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const startedAt = server.rooms.get(roomCode)!.recordingStartedAt + 250
  const res = await uploadAudioAt(server.port, sid(host), String(startedAt))
  assert.equal(res.status, 200)
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 250)
  host.disconnect(); guest.disconnect()
})

test('startedAt が無ければ delayMs は 0（アップロードは成功する）', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const res = await uploadAudio(server.port, sid(host)) // startedAt を付けない
  assert.equal(res.status, 200)
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 0)
  host.disconnect(); guest.disconnect()
})

test('壊れた startedAt でもアップロードは成功し delayMs は 0 になる', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const res = await uploadAudioAt(server.port, sid(host), 'いつか')
  assert.equal(res.status, 200, '採点は音声が届くことに依存する＝ここで落としてはいけない')
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 0)
  host.disconnect(); guest.disconnect()
})

test('録音開始より前の startedAt は 0 にクランプする', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const startedAt = server.rooms.get(roomCode)!.recordingStartedAt - 5000
  await uploadAudioAt(server.port, sid(host), String(startedAt))
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 0)
  host.disconnect(); guest.disconnect()
})

test('過大な startedAt は 10 秒にクランプする（作品の頭に無音が延々入るのを防ぐ）', async () => {
  const { host, guest, roomCode, hostDeviceId } = await makeCollectingRoom()
  const startedAt = server.rooms.get(roomCode)!.recordingStartedAt + 999_999
  await uploadAudioAt(server.port, sid(host), String(startedAt))
  assert.equal(server.rooms.get(roomCode)!.audio.get(hostDeviceId)!.delayMs, 10_000)
  host.disconnect(); guest.disconnect()
})

test('start_recording で recordingStartedAt が立つ', async () => {
  const before = Date.now()
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const room = server.rooms.get(roomCode)!
  assert.ok(room.recordingStartedAt >= before && room.recordingStartedAt <= Date.now())
  host.disconnect(); guest.disconnect()
})
