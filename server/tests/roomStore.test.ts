import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRoomStore, addDevice, addPlayerToDevice, hasPlayerName, toSnapshot,
  removeDevice,
  setReady, allReady, resetRoom, allReturned,
  reattachDevice, deviceBySocket, orderedPlayers, playerNames,
} from '../src/roomStore'
import type { RoomStore } from '../src/roomStore'
import { createQuota } from '../src/quota'
import type { Quota } from '../src/quota'

let store: RoomStore
let quota: Quota

beforeEach(() => {
  store = createRoomStore()
  quota = createQuota()
})

test('createRoom はホストを先頭プレイヤーにした waiting ルームを登録', () => {
  const room = store.create('sock-host', 'たろう')
  assert.equal(room.status, 'waiting')
  const device = deviceBySocket(room, 'sock-host')!
  assert.equal(room.hostDeviceId, device.id)
  assert.ok(store.exists(room.code))
  const snap = toSnapshot(room, quota)
  assert.equal(snap.players.length, 1)
  assert.deepEqual(snap.players[0], {
    id: orderedPlayers(room)[0]!.id,
    deviceId: device.id,
    name: 'たろう',
    isHost: true,
    isReady: false,
    connected: true,
  })
})

test('addDevice / hasPlayerName でゲストを追跡', () => {
  const room = store.create('sock-host', 'たろう')
  addDevice(room, 'sock-g1', 'はなこ', false)
  assert.equal(hasPlayerName(room, 'はなこ'), true)
  assert.equal(hasPlayerName(room, 'けんじ'), false)
  assert.equal(toSnapshot(room, quota).players.length, 2)
})

test('removeDevice は端末ごと削除し findRoomBySocket は部屋を特定', () => {
  const room = store.create('sock-host', 'たろう')
  const guest = addDevice(room, 'sock-g1', 'はなこ', false)
  assert.equal(store.findBySocket('sock-g1')?.code, room.code)
  const removed = removeDevice(room, guest.id)
  assert.deepEqual(removed.map(p => p.name), ['はなこ'])
  assert.equal(store.findBySocket('sock-g1'), undefined)
})

test('cleanupRooms は空ルーム・アイドルルームを削除', () => {
  const empty = store.create('sock-a', 'A')
  removeDevice(empty, empty.hostDeviceId)
  const idle = store.create('sock-b', 'B')
  idle.lastActivityAt = Date.now() - 2 * 60 * 60 * 1000
  const fresh = store.create('sock-c', 'C')
  const deleted = store.cleanup(Date.now(), 60 * 60 * 1000)
  assert.ok(deleted.includes(empty.code))
  assert.ok(deleted.includes(idle.code))
  assert.ok(!deleted.includes(fresh.code))
  assert.ok(store.exists(fresh.code))
})

test('setReady は指定端末を更新し allReady に反映される', () => {
  const room = store.create('h', 'たろう')
  addDevice(room, 'g1', 'はなこ', false)
  assert.equal(allReady(room), false)
  setReady(room, 'h', true)
  assert.equal(allReady(room), false) // はなこ未完了
  setReady(room, 'g1', true)
  assert.equal(allReady(room), true)  // 全員完了
  setReady(room, 'g1', false)
  assert.equal(allReady(room), false)
})

test('setReady は未知の socket では undefined を返し何も変えない', () => {
  const room = store.create('h', 'たろう')
  assert.equal(setReady(room, 'nope', true), undefined)
  assert.equal(allReady(room), false) // host は未完了のまま
})

test('createRoom は bgm=null・volumes 空・lastVolumeBroadcast=0 で初期化', () => {
  const room = store.create('sock-h', 'ホスト')
  assert.equal(room.bgm, null)
  assert.equal(room.volumes.size, 0)
  assert.equal(room.lastVolumeBroadcast, 0)
})

test('removeDevice は volumes からも該当 deviceId を削除', () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  room.volumes.set(guest.id, { level: 0.5, ts: Date.now() })
  removeDevice(room, guest.id)
  assert.equal(room.volumes.has(guest.id), false)
})

test('createRoom は recordingRoster 空・returned 空で初期化', () => {
  const room = store.create('sock-h', 'ホスト')
  assert.deepEqual(room.recordingRoster, [])
  assert.equal(room.returned.size, 0)
})

test('removeDevice は returned からも削除', () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  room.returned.add(guest.id)
  removeDevice(room, guest.id)
  assert.equal(room.returned.has(guest.id), false)
})

test('allReturned は在室者全員が returned のとき true', () => {
  const room = store.create('sock-h', 'ホスト')
  const host = deviceBySocket(room, 'sock-h')!
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  room.returned.add(host.id)
  assert.equal(allReturned(room), false)
  room.returned.add(guest.id)
  assert.equal(allReturned(room), true)
})

test('resetRoom は進行状態をクリアし genre を保持、isReady を false に', () => {
  const room = store.create('sock-h', 'ホスト')
  const host = deviceBySocket(room, 'sock-h')!
  addDevice(room, 'sock-g', 'ゲスト', false)
  room.genre = 'comedy'
  room.status = 'evaluating'
  room.scores = [{ playerName: 'ホスト', acting: 3, emotion: 3, kojirase: 3, comment: 'x', title: '称号' }]
  room.bgm = 'dramatic'
  room.recordingRoster = ['ホスト', 'ゲスト']
  room.returned.add(host.id)
  room.volumes.set(host.id, { level: 0.5, ts: Date.now() })
  room.lastVolumeBroadcast = 123
  for (const d of room.devices.values()) d.isReady = true

  resetRoom(room)

  assert.equal(room.status, 'waiting')
  assert.equal(room.script, null)
  assert.deepEqual(room.scores, [])
  assert.equal(room.bgm, null)
  assert.deepEqual(room.recordingRoster, [])
  assert.equal(room.returned.size, 0)
  assert.equal(room.volumes.size, 0)
  assert.equal(room.lastVolumeBroadcast, 0)
  assert.equal(room.genre, 'comedy') // 保持
  assert.ok([...room.devices.values()].every(d => !d.isReady))
})

test('createRoom は generatingScript=false で初期化', () => {
  const room = store.create('sock-h', 'ホスト')
  assert.equal(room.generatingScript, false)
})

test('resetRoom は generatingScript を false に戻す', () => {
  const room = store.create('sock-h', 'ホスト')
  room.generatingScript = true
  resetRoom(room)
  assert.equal(room.generatingScript, false)
})

test('createRoom は収集ゲートの初期値を設定する', () => {
  const room = store.create('sock-host', 'たろう')
  assert.equal(room.collectingAudio, false)
  assert.equal(room.audio.size, 0)
  assert.equal(room.uploadExpected.size, 0)
  assert.equal(room.uploadTimer, null)
})

test('removeDevice は audio と uploadExpected からも取り除く', () => {
  const room = store.create('h', 'たろう')
  const guest = addDevice(room, 'g1', 'はなこ', false)
  room.audio.set(guest.id, { buffer: Buffer.from([1, 2, 3]), mime: 'audio/webm', delayMs: 0 })
  room.uploadExpected.add(guest.id)
  removeDevice(room, guest.id)
  assert.equal(room.audio.has(guest.id), false)
  assert.equal(room.uploadExpected.has(guest.id), false)
})

test('resetRoom は収集ゲートをクリアする', () => {
  const room = store.create('h', 'たろう')
  const host = deviceBySocket(room, 'h')!
  room.collectingAudio = true
  room.audio.set(host.id, { buffer: Buffer.from([1]), mime: 'audio/webm', delayMs: 0 })
  room.uploadExpected.add(host.id)
  room.uploadTimer = setTimeout(() => {}, 10_000)
  resetRoom(room)
  assert.equal(room.collectingAudio, false)
  assert.equal(room.audio.size, 0)
  assert.equal(room.uploadExpected.size, 0)
  assert.equal(room.uploadTimer, null)
})

test('deleteRoom は保留中の uploadTimer をクリアする', async () => {
  const room = store.create('h', 'たろう')
  let fired = false
  room.uploadTimer = setTimeout(() => { fired = true }, 20)
  store.delete(room.code)
  assert.equal(room.uploadTimer, null)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(fired, false)
})

// --- 再接続（B5）---

test('addDevice は一意な token と disconnectedAt=null を持つ', () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  const host = deviceBySocket(room, 'sock-h')!
  assert.equal(typeof guest.token, 'string')
  assert.ok(guest.token.length > 0)
  assert.notEqual(guest.token, host.token)
  assert.equal(guest.disconnectedAt, null)
})

test('findByToken は token から room と device を引ける', () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  const found = store.findByToken(guest.token)
  assert.equal(found?.room.code, room.code)
  assert.equal(found?.device.id, guest.id)
  assert.equal(room.players.get(found!.device.playerIds[0]!)?.name, 'ゲスト')
  assert.equal(store.findByToken('nope'), undefined)
})

test('reattachDevice は socketId を付け替え disconnectedAt を消す', () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'old-sock', 'ゲスト', false)
  guest.disconnectedAt = Date.now()
  reattachDevice(room, guest, 'new-sock')
  assert.equal(deviceBySocket(room, 'old-sock'), undefined)
  assert.equal(room.players.get(deviceBySocket(room, 'new-sock')!.playerIds[0]!)?.name, 'ゲスト')
  assert.equal(guest.socketId, 'new-sock')
  assert.equal(guest.disconnectedAt, null)
})

// 旧 socketId が残す唯一の痕跡は socketIndex の1件だけになった。
// audio/uploadExpected/volumes/returned は deviceId キーで動かない（下の分割テストが固定）。
test('reattachDevice は旧 socketId の索引と猶予タイマーを掃除する', async () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'old-sock', 'ゲスト', false)
  let fired = false
  room.graceTimers.set(guest.id, setTimeout(() => { fired = true }, 20))
  reattachDevice(room, guest, 'new-sock')
  assert.equal(room.socketIndex.has('old-sock'), false)
  assert.equal(room.graceTimers.size, 0)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(fired, false, '復帰したので猶予満了は発火してはいけない')
})

test('allReady は切断中の端末を除外して判定', () => {
  const room = store.create('sock-h', 'ホスト')
  const g = addDevice(room, 'sock-g', 'ゲスト', false)
  setReady(room, 'sock-h', true) // ホストだけ ready
  assert.equal(allReady(room), false)
  g.disconnectedAt = Date.now() // ゲスト切断中 → 除外
  assert.equal(allReady(room), true)
})

test('allReturned は切断中の端末を除外して判定', () => {
  const room = store.create('sock-h', 'ホスト')
  const host = deviceBySocket(room, 'sock-h')!
  const g = addDevice(room, 'sock-g', 'ゲスト', false)
  room.returned.add(host.id)
  assert.equal(allReturned(room), false)
  g.disconnectedAt = Date.now()
  assert.equal(allReturned(room), true)
})

test('toSnapshot は bgm を含む（録音中に再接続した人へ復元するため）', () => {
  const room = store.create('sock-h', 'ホスト')
  assert.equal(toSnapshot(room, quota).bgm, null)
  room.bgm = 'dramatic'
  assert.equal(toSnapshot(room, quota).bgm, 'dramatic')
})

test('toSnapshot は connected を含む', () => {
  const room = store.create('sock-h', 'ホスト')
  const g = addDevice(room, 'sock-g', 'ゲスト', false)
  g.disconnectedAt = Date.now()
  const snap = toSnapshot(room, quota)
  const gs = snap.players.find(p => p.name === 'ゲスト')!
  assert.equal(gs.connected, false)
  assert.equal(snap.players.find(p => p.name === 'ホスト')!.connected, true)
})

test('removeDevice は猶予タイマーも解除する', async () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  let fired = false
  room.graceTimers.set(guest.id, setTimeout(() => { fired = true }, 20))
  removeDevice(room, guest.id)
  assert.equal(room.graceTimers.size, 0)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(fired, false)
})

// 猶予タイマーは resetRoom（中断/room_reset/評価失敗）を跨いで生き残らせる。
// ここで消すと切断中の端末が誰にも削除されず「復帰待ち…」のゴーストとして
// 永久に room.devices に残る（start_game の人数カウントにも混じる）。
test('resetRoom は猶予タイマーを保持し deleteRoom は解除する', async () => {
  const room = store.create('sock-h', 'ホスト')
  const guest = addDevice(room, 'sock-g', 'ゲスト', false)
  let firedAfterReset = false
  room.graceTimers.set(guest.id, setTimeout(() => { firedAfterReset = true }, 20))
  resetRoom(room)
  assert.equal(room.graceTimers.size, 1)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(firedAfterReset, true, 'reset 後も猶予満了は発火しなければならない')

  const room2 = store.create('sock-h2', 'ホスト2')
  let firedAfterDelete = false
  room2.graceTimers.set('dev-x', setTimeout(() => { firedAfterDelete = true }, 20))
  store.delete(room2.code)
  assert.equal(room2.graceTimers.size, 0)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(firedAfterDelete, false)
})

test('createRoom は aiMode を true で初期化する（start_game で確定するまでの既定）', () => {
  const room = store.create('s1', 'たろう')
  assert.equal(room.aiMode, true)
})

test('toSnapshot は aiAvailable を毎回その場で計算する', () => {
  process.env.DAILY_GAME_LIMIT = '1'
  const room = store.create('s1', 'たろう')
  assert.equal(toSnapshot(room, quota).aiAvailable, true)
  quota.tryConsumeGame(new Date())
  // room は何も変えていないが、枠を使い切ったので false になる
  assert.equal(toSnapshot(room, quota).aiAvailable, false)
  delete process.env.DAILY_GAME_LIMIT
})

// --- Device / Player の分割 ---

test('reattachDevice は audio / uploadExpected / volumes / returned を再キーしない', () => {
  const rooms = createRoomStore()
  const room = rooms.create('sock-1', 'たろう')
  const device = deviceBySocket(room, 'sock-1')!

  // 収集ウィンドウ中を模した状態を作る
  room.audio.set(device.id, { buffer: Buffer.from('a'), mime: 'audio/webm', delayMs: 0 })
  room.uploadExpected.add(device.id)
  room.volumes.set(device.id, { level: 0.5, ts: 123 })
  room.returned.add(device.id)

  reattachDevice(room, device, 'sock-2')

  // socketId だけが動く
  assert.equal(device.socketId, 'sock-2')
  assert.equal(deviceBySocket(room, 'sock-2')?.id, device.id)
  assert.equal(deviceBySocket(room, 'sock-1'), undefined)
  assert.equal(device.disconnectedAt, null)

  // deviceId キーのコレクションは一切動かない
  assert.equal(room.audio.get(device.id)?.mime, 'audio/webm')
  assert.equal(room.audio.size, 1)
  assert.ok(room.uploadExpected.has(device.id))
  assert.equal(room.volumes.get(device.id)?.level, 0.5)
  assert.ok(room.returned.has(device.id))
})

test('orderedPlayers は端末の参加順 → 端末内の追加順を返す', () => {
  const rooms = createRoomStore()
  const room = rooms.create('sock-1', 'たろう')
  const d1 = deviceBySocket(room, 'sock-1')!
  addPlayerToDevice(room, d1, 'じろう')
  const d2 = addDevice(room, 'sock-2', 'はなこ', false)
  addPlayerToDevice(room, d2, 'さぶろう')
  assert.deepEqual(playerNames(room), ['たろう', 'じろう', 'はなこ', 'さぶろう'])
})
