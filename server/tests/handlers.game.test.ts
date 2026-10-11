import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, connectClient, once, expectNoEvent } from './testUtils'

let server: Awaited<ReturnType<typeof startTestServer>>

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

async function createRoomWithHost() {
  const host = connectClient(server.port)
  host.emit('create_room', { playerName: 'たろう' })
  const { roomCode } = await once<{ roomCode: string }>(host, 'room_created')
  return { host, roomCode }
}

test('set_genre（ホスト）は全員へ genre_changed をブロードキャスト', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')

  const guestGenre = once<{ genre: string }>(guest, 'genre_changed')
  host.emit('set_genre', { genre: 'horror' })
  const { genre } = await guestGenre
  assert.equal(genre, 'horror')
  host.disconnect(); guest.disconnect()
})

test('set_genre は無効ジャンルを error で拒否しブロードキャストしない', async () => {
  const { host } = await createRoomWithHost()
  host.emit('set_genre', { genre: 'not-a-genre' })
  const err = await once<{ message: string }>(host, 'error')
  assert.match(err.message, /ジャンル/)
  host.disconnect()
})

test('start_game は全プレイヤー分の台本で script_ready をブロードキャスト', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'jidai' })
  await once(guest, 'genre_changed')

  const guestScript = once<{ script: { roles: { player: string }[] } }>(guest, 'script_ready')
  host.emit('start_game')
  const { script } = await guestScript
  assert.equal(script.roles.length, 2)
  const players = script.roles.map(r => r.player).sort()
  assert.deepEqual(players, ['たろう', 'はなこ'].sort())
  host.disconnect(); guest.disconnect()
})

test('start_game は script_generating→script_ready の順に配信する', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  const gen = once(guest, 'script_generating')
  const ready = once<{ script: { roles: unknown[] } }>(guest, 'script_ready')
  host.emit('start_game')
  await gen
  const { script } = await ready
  assert.equal(script.roles.length, 2)
  host.disconnect(); guest.disconnect()
})

test('start_game は genre 未設定なら error でガードし生成を始めない', async () => {
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')

  const noGen = expectNoEvent(host, 'script_generating')
  host.emit('start_game')
  const err = await once<{ message: string }>(host, 'error')
  assert.match(err.message, /ジャンル/)
  await noGen
  host.disconnect(); guest.disconnect()
})

test('start_game は1人でも開始できる', async () => {
  const { host } = await createRoomWithHost()
  host.emit('set_genre', { genre: 'comedy' })
  await once(host, 'genre_changed')

  const ready = once<{ script: { roles: unknown[] } }>(host, 'script_ready')
  host.emit('start_game')
  const payload = await ready
  assert.equal(payload.script.roles.length, 1, '1人ぶんの役が割り当たっていない')
  host.disconnect()
})

test('降格した回も部屋は配役フェーズへ正常に進む', async () => {
  await server.close()
  server = await startTestServer({ ai: { generateScript: () => Promise.reject(new Error('boom')) } })
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  const ready = once(guest, 'script_ready')
  host.emit('start_game')
  await ready

  // 降格は「台本の出どころ」だけの話で、進行状態は成功時と同じでなければならない
  const room = server.rooms.findBySocket(host.id!)
  assert.equal(room?.status, 'casting')
  assert.equal(room?.generatingScript, false, '生成中フラグが残ると以降の操作が通らない')
  assert.ok(room?.script, '台本が部屋に保存されていない')
  host.disconnect(); guest.disconnect()
})

test('実AI呼び出しが失敗したら手書き台本に降格してゲームを続行する', async () => {
  // 支払上限の到達・APIエラー・不正応答はすべてここに現れる。ロビーへ戻すと
  // 上限に当たった月は「開始しても必ず失敗する」状態になるので、
  // 枠切れと同じ手書き台本へ降格して最後まで通す。
  await server.close()
  server = await startTestServer({ ai: { generateScript: () => Promise.reject(new Error('boom')) } })
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  const ready = once<{ script: { roles: unknown[] }; aiMode: boolean }>(guest, 'script_ready')
  host.emit('start_game')
  const payload = await ready

  assert.equal(payload.script.roles.length, 2, '人数分の役がある台本が届いていない')
  assert.equal(payload.aiMode, false, '降格した回が実AIのまま伝わっている')
  // 台本がAIでない以上、採点も実APIを呼ばない（finalizeEvaluation は room.aiMode を見る）
  const room = server.rooms.findBySocket(host.id!)
  assert.equal(room?.aiMode, false, '降格が採点側に伝わっていない')
  host.disconnect(); guest.disconnect()
})

test('生成中の二重 start_game は無視される', async () => {
  await server.close()
  server = await startTestServer({ ai: { generateScript: () => new Promise<never>(() => {}) } }) // 解決しない＝生成中を保持
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  const firstGen = once(host, 'script_generating')
  host.emit('start_game')
  await firstGen

  const noSecond = expectNoEvent(host, 'script_generating') // 2回目は出ない
  host.emit('start_game')
  await noSecond
  host.disconnect(); guest.disconnect()
})

test('生成中の join_room は error で拒否する', async () => {
  await server.close()
  server = await startTestServer({ ai: { generateScript: () => new Promise<never>(() => {}) } }) // 生成中を保持
  const { host, roomCode } = await createRoomWithHost()
  const guest = connectClient(server.port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  await once(guest, 'room_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')

  const gen = once(host, 'script_generating')
  host.emit('start_game')
  await gen

  const late = connectClient(server.port)
  late.emit('join_room', { roomCode, playerName: 'さぶろう' })
  const err = await once<{ message: string }>(late, 'error')
  assert.match(err.message, /参加できません/)
  host.disconnect(); guest.disconnect(); late.disconnect()
})
