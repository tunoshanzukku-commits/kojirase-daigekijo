import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldCreateOffer, peerDeviceIds, deviceCount, liveAudioToggleState,
  remoteStreamFrom,
} from '../src/liveAudioPure'
import type { PlayerSnapshot } from '../src/types'
import { MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'

const P = (name: string, deviceId: string): PlayerSnapshot => ({
  id: name, deviceId, name, isHost: false, isReady: false, connected: true,
})

test('offer を出すのは deviceId が辞書順で小さいほう', () => {
  assert.equal(shouldCreateOffer('aaa', 'bbb'), true)
  assert.equal(shouldCreateOffer('bbb', 'aaa'), false)
})

test('同じ deviceId には offer を出さない（自分自身との接続を作らない）', () => {
  assert.equal(shouldCreateOffer('aaa', 'aaa'), false)
})

test('両側で判定が必ず食い違う（glare が起きない）', () => {
  const ids = ['d1', 'd2', 'd3', 'zz', 'a']
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue
      assert.notEqual(shouldCreateOffer(a, b), shouldCreateOffer(b, a))
    }
  }
})

test('peerDeviceIds は自分以外の端末を重複なく参加順で返す', () => {
  const players = [P('ミチ', 'd1'), P('タロウ', 'd1'), P('ジロウ', 'd2'), P('ハナコ', 'd3')]
  assert.deepEqual(peerDeviceIds(players, 'd1'), ['d2', 'd3'])
  assert.deepEqual(peerDeviceIds(players, 'd2'), ['d1', 'd3'])
})

test('peerDeviceIds は deviceId が空なら空配列', () => {
  assert.deepEqual(peerDeviceIds([P('ミチ', 'd1')], ''), [])
})

test('deviceCount は端末の数を数える（人数ではない）', () => {
  assert.equal(deviceCount([P('ミチ', 'd1'), P('タロウ', 'd1'), P('ジロウ', 'd2')]), 2)
  assert.equal(deviceCount([]), 0)
})

test('トグルの状態は端末数で決まる', () => {
  assert.equal(liveAudioToggleState(1), 'alone')
  assert.equal(liveAudioToggleState(2), 'available')
  assert.equal(liveAudioToggleState(MAX_LIVE_AUDIO_DEVICES), 'available')
  assert.equal(liveAudioToggleState(MAX_LIVE_AUDIO_DEVICES + 1), 'too-many')
})

test('端末が0台でも落ちない（トップ画面など未参加の状態）', () => {
  assert.equal(liveAudioToggleState(0), 'alone')
})

// 実機で「接続は ✓ なのに無音」が起きた根本原因の回帰テスト。
// 送信側は addTransceiver + replaceTrack でマイクを差し込む（getUserMedia を
// 増やさないため）。この経路はトラックを MediaStream に紐づけないので SDP に
// msid が乗らず、受信側の ontrack で e.streams が空になる。
// 空のときに諦めると <audio> が作られず永久に無音になる。track から作り直すこと。
test('remoteStreamFrom は streams があればそれを使う', () => {
  const s = { id: 'given' } as unknown as MediaStream
  const t = { id: 'track' } as unknown as MediaStreamTrack
  const made: MediaStreamTrack[] = []
  const got = remoteStreamFrom([s], t, tr => { made.push(tr); return { id: 'made' } as unknown as MediaStream })
  assert.equal(got, s)
  assert.equal(made.length, 0) // 余計に作らない
})

test('remoteStreamFrom は streams が空なら track から作る', () => {
  const t = { id: 'track' } as unknown as MediaStreamTrack
  const made: MediaStreamTrack[] = []
  const got = remoteStreamFrom([], t, tr => { made.push(tr); return { id: 'made' } as unknown as MediaStream })
  assert.equal((got as unknown as { id: string }).id, 'made')
  assert.deepEqual(made, [t]) // 受け取った track そのものから作る
})

test('remoteStreamFrom は streams も track も無ければ null', () => {
  const got = remoteStreamFrom([], undefined, () => { throw new Error('作ってはいけない') })
  assert.equal(got, null)
})
