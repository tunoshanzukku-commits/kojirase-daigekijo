import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent, makeRecordingRoom } from './testUtils'
import type { PlayerScore } from '@shared/types'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  // アップロードしないテストは即タイムアウトで確定させる
  server = await startTestServer({ limits: { uploadTimeoutMs: 50 } })
})
afterEach(async () => {
  await server.close()
})

const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// 復帰待ち中（status='evaluating' かつ音声収集は完了済み）の host/guest を返す。
// join_room は collectingAudio 中を拒否するので、finalize（既定タイムアウト）を待ってから返す。
async function makeEvaluatingRoom() {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  const evalHost = once(host, 'evaluation_complete')
  host.emit('stop_recording')
  await stoppedGuest
  await stoppedHost
  await evalHost
  return { host, guest, roomCode }
}

test('評価中（復帰待ち）でも新規ゲストは join できる', async () => {
  const { host, guest, roomCode } = await makeEvaluatingRoom()
  // 誰もまだロビーに戻っていなくても、後から部屋に入れる
  const late = connectClient(server.port)
  late.emit('join_room', { roomCode, playerName: 'さぶろう' })
  await once(late, 'room_joined')
  host.disconnect(); guest.disconnect(); late.disconnect()
})

test('復帰待ち中に参加した新規プレイヤーは room_reset をブロックしない', async () => {
  const { host, guest, roomCode } = await makeEvaluatingRoom()
  const late = connectClient(server.port)
  late.emit('join_room', { roomCode, playerName: 'さぶろう' })
  await once(late, 'room_joined')
  // 新規参加者は結果を見ていない＝すでにロビーにいる扱い。
  // 結果を見ていた2人が戻れば、新規参加者を待たずに reset されなければならない。
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  const hostReset = once<{ room: { status: string } }>(host, 'room_reset')
  guest.emit('return_to_lobby')
  const r = await hostReset
  assert.equal(r.room.status, 'waiting')
  host.disconnect(); guest.disconnect(); late.disconnect()
})

test('ゲーム進行中（録音中）は新規 join を拒否する', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const late = connectClient(server.port)
  const errored = once<{ message: string }>(late, 'error')
  late.emit('join_room', { roomCode, playerName: 'さぶろう' })
  const e = await errored
  assert.match(e.message, /ゲーム進行中/)
  host.disconnect(); guest.disconnect(); late.disconnect()
})

test('評価中（復帰待ち）はホストの start_game を無視する', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedGuest = once(guest, 'recording_stopped')
  const stoppedHost = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await stoppedGuest
  await stoppedHost
  // まだ誰もロビーに戻っていない（status='evaluating'）。
  // 各自が個別にロビーへ戻る仕様のため、結果を見ている人がいる間にホストが開始できてはいけない。
  let sawScript = false
  guest.on('script_ready', () => { sawScript = true })
  host.emit('start_game')
  await delay(250)
  assert.equal(sawScript, false)
  host.disconnect(); guest.disconnect()
})

test('host の stop_recording は recording_stopped と evaluation_complete を全員へ', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestStopped = once(guest, 'recording_stopped')
  const hostStopped = once(host, 'recording_stopped')
  const guestEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(guest, 'evaluation_complete')
  host.emit('stop_recording')
  await Promise.all([guestStopped, hostStopped])
  const e = await guestEval
  assert.equal(e.scores.length, 2) // 在室2人
  assert.deepEqual(e.scores.map(s => s.playerName).sort(), ['たろう', 'はなこ'])
  assert.deepEqual(e.leftPlayers, [])
  host.disconnect(); guest.disconnect()
})

test('非ホストの stop_recording は無視', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  let hostSaw = false
  host.on('recording_stopped', () => { hostSaw = true })
  guest.emit('stop_recording')
  await delay(250)
  assert.equal(hostSaw, false)
  host.disconnect(); guest.disconnect()
})

test('録音中に離脱したプレイヤーは leftPlayers に入りスコアから除外', async () => {
  // 事故切断の猶予を詰めて「戻ってこなかった」状態を作る
  await server.close()
  server = await startTestServer({ limits: { uploadTimeoutMs: 50, graceMs: 150 } })
  const { host, guest } = await makeRecordingRoom(server.port)
  const hostLeft = once(host, 'player_left')
  guest.disconnect()
  await hostLeft // サーバーが removeDevice 済み
  const hostEval = once<{ scores: PlayerScore[]; leftPlayers: string[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  const e = await hostEval
  assert.deepEqual(e.scores.map(s => s.playerName), ['たろう'])
  assert.deepEqual(e.leftPlayers, ['はなこ'])
  host.disconnect()
})

test('全員 return_to_lobby で room_reset・status=waiting', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestStopped = once(guest, 'recording_stopped')
  const hostStopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([guestStopped, hostStopped])
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  const guestReset = once<{ room: { status: string } }>(guest, 'room_reset')
  guest.emit('return_to_lobby')
  const r = await guestReset
  assert.equal(r.room.status, 'waiting')
  host.disconnect(); guest.disconnect()
})

test('一部だけ return_to_lobby では room_reset されない', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestStopped = once(guest, 'recording_stopped')
  const hostStopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([guestStopped, hostStopped])
  let reset = false
  guest.on('room_reset', () => { reset = true })
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  await delay(250)
  assert.equal(reset, false)
  host.disconnect(); guest.disconnect()
})

test('評価中に相手が離脱→残り全員復帰済みなら room_reset（デッドロック回避）', async () => {
  const { host, guest } = await makeRecordingRoom(server.port)
  const guestStopped = once(guest, 'recording_stopped')
  const hostStopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([guestStopped, hostStopped])
  host.emit('return_to_lobby')
  await once(host, 'player_returned')
  const hostReset = once(host, 'room_reset')
  guest.disconnect() // 復帰待ちの相手が抜ける → 残り(host)は復帰済み
  await hostReset
  host.disconnect()
})

test('room_reset 後は新規ゲストが join できる（既知バグ回帰）', async () => {
  const { host, guest, roomCode } = await makeRecordingRoom(server.port)
  const guestStopped = once(guest, 'recording_stopped')
  const hostStopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([guestStopped, hostStopped])
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  const guestReset = once(guest, 'room_reset')
  guest.emit('return_to_lobby')
  await guestReset
  const g2 = connectClient(server.port)
  g2.emit('join_room', { roomCode, playerName: 'さぶろう' })
  await once(g2, 'room_joined') // status=waiting なので成功（進行中なら error になる）
  host.disconnect(); guest.disconnect(); g2.disconnect()
})

test('stop_recording 直後は evaluation_complete を出さず収集を待つ', async () => {
  await server.close()
  server = await startTestServer({ limits: { uploadTimeoutMs: 5000 } }) // タイムアウトで確定させない
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  // 誰もアップロードしていないので評価は始まらない
  await expectNoEvent(host, 'evaluation_complete', 300)
  host.disconnect(); guest.disconnect()
})

test('収集中に全員がロビーへ戻ったら評価は破棄してロビーへ戻す', async () => {
  await server.close()
  server = await startTestServer({ limits: { uploadTimeoutMs: 5000 } }) // タイムアウトでは終わらせない
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  // 収集中に全員がロビーへ戻る → 誰も結果を見ないので評価せずリセットのみ
  const hostReset = once<{ room: { status: string } }>(host, 'room_reset')
  const guestReturned = once(guest, 'player_returned')
  host.emit('return_to_lobby')
  await guestReturned
  let sawEval = false
  host.on('evaluation_complete', () => { sawEval = true })
  guest.emit('return_to_lobby')
  const r = await hostReset
  assert.equal(r.room.status, 'waiting')
  await delay(150)
  assert.equal(sawEval, false) // 評価は破棄され evaluation_complete は来ない
  host.disconnect(); guest.disconnect()
})

test('採点成功で evaluation_complete が全員へ届く（評価器を注入）', async () => {
  await server.close()
  server = await startTestServer({
    limits: { uploadTimeoutMs: 60 }, // アップロードせずタイムアウトで収集ゲートを閉じる
    ai: {
      evaluate: async (_script, performers) =>
        performers.map(name => ({ playerName: name, acting: 4, emotion: 4, kojirase: 4, comment: `${name}講評`, title: '称号' })),
    },
  })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  const hostEval = once<{ scores: PlayerScore[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const e = await hostEval // 60ms のタイムアウトで finalize→注入評価器→配信
  assert.equal(e.scores.length, 2)
  assert.deepEqual(e.scores.map(s => s.comment).sort(), ['たろう講評', 'はなこ講評'].sort())
  host.disconnect(); guest.disconnect()
})

test('採点失敗で evaluation_failed が届き room が waiting に戻る（throw を注入）', async () => {
  await server.close()
  server = await startTestServer({
    limits: { uploadTimeoutMs: 60 }, // タイムアウトで収集を閉じ finalize を走らせる
    ai: { evaluate: async () => { throw new Error('boom') } },
  })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  const hostFailed = once<{ room: { status: string }; message: string }>(host, 'evaluation_failed')
  const guestFailed = once<{ room: { status: string } }>(guest, 'evaluation_failed')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  const [hf] = await Promise.all([hostFailed, guestFailed])
  assert.equal(hf.room.status, 'waiting')
  assert.match(hf.message, /採点に失敗/)
  host.disconnect(); guest.disconnect()
})

test('evaluation_complete は重複配信されない', async () => {
  await server.close()
  server = await startTestServer({
    limits: { uploadTimeoutMs: 40 },
    ai: {
      evaluate: async (_s, performers) =>
        performers.map(name => ({ playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: 'x', title: '称号' })),
    },
  })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  let count = 0
  host.on('evaluation_complete', () => { count++ })
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await delay(200) // タイムアウト finalize が走る。collectingAudio ガードで emit は1回だけ
  assert.equal(count, 1)
  host.disconnect(); guest.disconnect()
})

test('評価の解決前に全員が戻ると stale な evaluation_complete は来ない（世代トークン）', async () => {
  await server.close()
  // 200ms 遅れて解決する評価器。その間に全員 return_to_lobby → resetRoom で世代が進む
  server = await startTestServer({
    limits: { uploadTimeoutMs: 40 },
    ai: {
      evaluate: async (_s, performers) => {
        await delay(200)
        return performers.map(name => ({ playerName: name, acting: 5, emotion: 5, kojirase: 5, comment: 'late', title: '称号' }))
      },
    },
  })
  const { host, guest } = await makeRecordingRoom(server.port)
  const stoppedHost = once(host, 'recording_stopped')
  const stoppedGuest = once(guest, 'recording_stopped')
  host.emit('stop_recording')
  await Promise.all([stoppedHost, stoppedGuest])
  await delay(60) // タイムアウトで finalize 開始（評価器は 200ms 保留）
  let sawEval = false
  host.on('evaluation_complete', () => { sawEval = true })
  const hostReset = once(host, 'room_reset')
  host.emit('return_to_lobby')
  await once(guest, 'player_returned')
  guest.emit('return_to_lobby')
  await hostReset // 全員復帰で resetRoom（世代 ++）
  await delay(250) // 保留していた評価器が解決するのを待つ
  assert.equal(sawEval, false) // 世代不一致で emit されない
  host.disconnect(); guest.disconnect()
})

test('1端末に3人乗っていると uploadExpected は1件、sources は3人1本になる', async () => {
  let seen: { players: string[] }[] = []
  await server.close()
  server = await startTestServer({
    limits: { uploadTimeoutMs: 60 }, // アップロードせずタイムアウトで収集ゲートを閉じる
    ai: {
      evaluate: async (_script, performers, sources) => {
        seen = sources
        return performers.map(name => ({
          playerName: name, acting: 3, emotion: 3, kojirase: 3, comment: '', title: '',
        }))
      },
    },
  })
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  for (const name of ['はなこ', 'じろう']) {
    const joined = once(host, 'player_joined')
    host.emit('add_local_player', { playerName: name })
    await joined
  }
  host.emit('set_genre', { genre: 'comedy' })
  const ready = once(host, 'script_ready')
  host.emit('start_game')
  await ready
  const started = once(host, 'recording_started')
  host.emit('start_recording')
  await started
  const room = server.rooms.get(roomCode)!
  assert.equal(room.players.size, 3)
  const stopped = once(host, 'recording_stopped')
  host.emit('stop_recording')
  await stopped
  assert.equal(room.uploadExpected.size, 1) // 人数(3)ではなく台数(1)
  const done = once(host, 'evaluation_complete')
  // アップロードは来ないのでタイムアウト経路で確定する（startTestServer に渡した uploadTimeoutMs: 60）
  await done
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0]!.players, ['たろう', 'はなこ', 'じろう'])
  host.disconnect()
})

test('1人でも録音終了から evaluation_complete まで到達する', async () => {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  await once(host, 'room_created')
  host.emit('set_genre', { genre: 'comedy' })
  await once(host, 'genre_changed')
  const scriptReady = once(host, 'script_ready')
  host.emit('start_game')
  await scriptReady
  host.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  const recStarted = once(host, 'recording_started')
  host.emit('start_recording')
  await recStarted

  const complete = once<{ scores: unknown[] }>(host, 'evaluation_complete')
  host.emit('stop_recording')
  const { scores } = await complete
  assert.equal(scores.length, 1, '1人ぶんの採点が返っていない')
  host.disconnect()
})
