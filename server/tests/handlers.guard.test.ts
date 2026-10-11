import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeRoom, once } from './testUtils'
import { createScriptLibrary } from '../src/ai/scriptLibrary'

// 台本ゼロ＝スタブに落ちる。台本の中身に依存しないテストにする
function noPlays() {
  return createScriptLibrary([])
}

afterEach(() => {
  delete process.env.DAILY_GAME_LIMIT
  delete process.env.AI_ENABLED
  delete process.env.PUBLIC_ENABLED
})

test('枠が残っていれば aiMode=true で開始する', async () => {
  process.env.DAILY_GAME_LIMIT = '1'
  const server = await startTestServer({ plays: noPlays() })
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once<{ aiMode: boolean }>(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    const payload = await readyGuest
    await readyHost
    const room = server.rooms.findBySocket(r.host.id!)
    assert.equal(room?.aiMode, true)
    assert.equal(payload.aiMode, true, 'script_ready がこの回のモードを伝えていない')
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('枠を使い切ったら aiMode=false で開始し、台本は出る', async () => {
  process.env.DAILY_GAME_LIMIT = '0' // 最初から枠なし
  const server = await startTestServer({ plays: noPlays() })
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once<{ script: { roles: unknown[] }; aiMode: boolean }>(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    const payload = await readyGuest
    await readyHost
    // 簡易モードでもゲームは成立する＝台本が届き、役が人数分ある
    assert.equal(payload.script.roles.length, 2)
    // 配役・結果画面が「簡易モードです」と出せるように、この回のモードが payload に載る。
    // ロビーの aiAvailable は他の部屋が枠を取ると古くなるので、これが唯一の確実な経路。
    assert.equal(payload.aiMode, false, 'script_ready が簡易モードであることを伝えていない')
    const room = server.rooms.findBySocket(r.host.id!)
    assert.equal(room?.aiMode, false)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('AI_ENABLED=false なら枠が残っていても aiMode=false', async () => {
  process.env.DAILY_GAME_LIMIT = '10'
  process.env.AI_ENABLED = 'false'
  const server = await startTestServer({ plays: noPlays() })
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    await readyGuest
    await readyHost
    const room = server.rooms.findBySocket(r.host.id!)
    assert.equal(room?.aiMode, false)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('AI_ENABLED=false のときは枠を消費しない', async () => {
  process.env.DAILY_GAME_LIMIT = '1'
  process.env.AI_ENABLED = 'false'
  const server = await startTestServer({ plays: noPlays() })
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    await readyGuest
    await readyHost
    // AI を呼んでいないので枠は減っていない
    assert.equal(server.quota.getState(new Date()).used, 0)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('簡易モードのゲームは evaluatePerformance を呼ばずにスコアを返す', async () => {
  process.env.DAILY_GAME_LIMIT = '0'
  let evaluatorCalled = false
  const server = await startTestServer({
    plays: noPlays(),
    limits: { uploadTimeoutMs: 100 }, // アップロードを待たずタイムアウトで確定させる
    ai: {
      evaluate: async () => {
        evaluatorCalled = true
        return []
      },
    },
  })
  try {
    const { makeRecordingRoom } = await import('./testUtils')
    const r = await makeRecordingRoom(server.port)
    const doneGuest = once<{ scores: unknown[] }>(r.guest, 'evaluation_complete', 5000)
    const doneHost = once(r.host, 'evaluation_complete', 5000)
    r.host.emit('stop_recording')
    const payload = await doneGuest
    await doneHost
    assert.equal(evaluatorCalled, false, '簡易モードなのに実評価が呼ばれている')
    assert.equal(payload.scores.length, 2, 'スタブ採点で2人分のスコアが出るべき')
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('PUBLIC_ENABLED=false なら新規ルームを作れない', async () => {
  process.env.PUBLIC_ENABLED = 'false'
  const server = await startTestServer({ plays: noPlays() })
  try {
    const { connectClient } = await import('./testUtils')
    const sock = connectClient(server.port)
    sock.emit('create_room', { playerName: 'たろう' })
    const err = await once<{ message: string }>(sock, 'error')
    assert.match(err.message, /停止/)
    sock.disconnect()
  } finally {
    await server.close()
  }
})

test('PUBLIC_ENABLED=false でも進行中のゲームは壊れない（join は従来どおり動く）', async () => {
  const server = await startTestServer({ plays: noPlays() })
  try {
    const r = await makeRoom(server.port) // 有効なうちに部屋を作る
    process.env.PUBLIC_ENABLED = 'false'
    const { connectClient } = await import('./testUtils')
    const late = connectClient(server.port)
    late.emit('join_room', { roomCode: r.roomCode, playerName: 'じろう' })
    const joined = await once<{ room: { players: unknown[] } }>(late, 'room_joined')
    assert.equal(joined.room.players.length, 3)
    late.disconnect()
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('同一IPから短時間に作りすぎるとレート制限で断られる', async () => {
  // このテストだけ本番値(5)で実際の上限を検証する。他の統合テストは
  // testUtils.ts が上限を 100000 に引き上げているのでここで明示的に絞る。
  const server = await startTestServer({ plays: noPlays(), limits: { roomCreateMax: 5 } })
  try {
    const { connectClient } = await import('./testUtils')
    const socks = []
    // 上限は 60 秒に 5 回。6 個目は断られる。
    for (let i = 0; i < 5; i++) {
      const s = connectClient(server.port)
      s.emit('create_room', { playerName: `p${i}` })
      await once(s, 'room_created')
      socks.push(s)
    }
    const over = connectClient(server.port)
    over.emit('create_room', { playerName: 'over' })
    const err = await once<{ message: string }>(over, 'error')
    assert.match(err.message, /作りすぎ/)
    over.disconnect()
    for (const s of socks) s.disconnect()
  } finally {
    await server.close()
  }
})
