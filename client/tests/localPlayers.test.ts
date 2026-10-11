import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localPlayers, isLocalPlayer, insertPlayer } from '../src/localPlayers'
import type { PlayerSnapshot } from '../src/types'

const P = (name: string, deviceId: string, id = name): PlayerSnapshot => ({
  id, deviceId, name, isHost: false, isReady: false, connected: true,
})

const PLAYERS = [P('ミチ', 'd1'), P('タロウ', 'd1'), P('ジロウ', 'd2')]

test('localPlayers は同じ deviceId の人だけを参加順で返す', () => {
  assert.deepEqual(localPlayers(PLAYERS, 'd1').map(p => p.name), ['ミチ', 'タロウ'])
  assert.deepEqual(localPlayers(PLAYERS, 'd2').map(p => p.name), ['ジロウ'])
})

test('deviceId が空なら空配列（トップ画面など未参加の状態）', () => {
  assert.deepEqual(localPlayers(PLAYERS, ''), [])
})

test('isLocalPlayer はこの端末の人にだけ true', () => {
  assert.equal(isLocalPlayer(PLAYERS, 'd1', 'タロウ'), true)
  assert.equal(isLocalPlayer(PLAYERS, 'd1', 'ジロウ'), false)
  assert.equal(isLocalPlayer(PLAYERS, '', 'ミチ'), false)
})

// insertPlayer: player_joined を受けるたびの挿入位置を、サーバーの orderedPlayers
// （端末の参加順 → 端末内の追加順）と一致させる。末尾に単純 append すると、
// 「先にいる端末に後から追加された人」がサーバー上の位置より後ろにずれ、
// playerColorMap の index がサーバーとクライアントで食い違う（＝色が人によって違って見える）。

test('insertPlayer: 空配列への追加', () => {
  const next = insertPlayer([], P('ミチ', 'd1'))
  assert.deepEqual(next.map(p => p.name), ['ミチ'])
})

test('insertPlayer: 新しい端末の人は末尾に入る', () => {
  const players = [P('ミチ', 'd1'), P('タロウ', 'd1')]
  const next = insertPlayer(players, P('ジロウ', 'd2'))
  assert.deepEqual(next.map(p => p.name), ['ミチ', 'タロウ', 'ジロウ'])
})

test('insertPlayer: 既存端末への追加は、その端末の最後の人の直後に入る（末尾ではない場合）', () => {
  // d1 の最後の人（ジロウ）は配列の末尾ではない。単純 append ならハナコが末尾（d2の後）に
  // 来てしまうが、正しくは d1 側の直後（d2 の前）に入る。
  const players = [P('ミチ', 'd1'), P('タロウ', 'd2'), P('ジロウ', 'd1'), P('サブロウ', 'd2')]
  const next = insertPlayer(players, P('ハナコ', 'd1'))
  assert.deepEqual(next.map(p => p.name), ['ミチ', 'タロウ', 'ジロウ', 'ハナコ', 'サブロウ'])
})

test('insertPlayer: 端末内に既に複数人いる場合も最後の人の直後に入る', () => {
  const players = [P('A', 'D1'), P('B', 'D2'), P('C', 'D1'), P('D', 'D1')]
  const next = insertPlayer(players, P('E', 'D1'))
  assert.deepEqual(next.map(p => p.name), ['A', 'B', 'C', 'D', 'E'])
})

test('insertPlayer: 3人が絡む再現シナリオ（ホスト作成→ゲスト参加→ホストが自端末に追加）', () => {
  // ①ホストがルーム作成（端末D1にプレイヤーA）
  // ②ゲストが参加（端末D2にプレイヤーB）
  // ③ホストが自分の端末にCを追加（D1）
  // サーバーの orderedPlayers（端末の参加順→端末内の追加順）は [A, C, B]。
  // 末尾 append だと [A, B, C] になってしまい、C の色が画面によってズレる。
  let players: PlayerSnapshot[] = []
  players = insertPlayer(players, P('A', 'D1'))
  players = insertPlayer(players, P('B', 'D2'))
  players = insertPlayer(players, P('C', 'D1'))
  assert.deepEqual(players.map(p => p.name), ['A', 'C', 'B'])
})
