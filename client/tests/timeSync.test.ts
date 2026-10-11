import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickBestOffset } from '../src/timeSyncPure'

test('RTT が最小のサンプルの offset を採る（平均ではない）', () => {
  const samples = [
    { rtt: 300, offset: 5000 },
    { rtt: 40, offset: 120 },
    { rtt: 180, offset: 900 },
  ]
  assert.equal(pickBestOffset(samples), 120)
})

test('同じ RTT が並んだら先に来たほうを採る', () => {
  const samples = [
    { rtt: 50, offset: 10 },
    { rtt: 50, offset: 99 },
  ]
  assert.equal(pickBestOffset(samples), 10)
})

test('空配列は 0（同期できなければ補正しない＝今日の挙動）', () => {
  assert.equal(pickBestOffset([]), 0)
})

test('NaN / Infinity のサンプルは無視する', () => {
  const samples = [
    { rtt: NaN, offset: 1 },
    { rtt: 10, offset: Infinity },
    { rtt: 200, offset: 77 },
  ]
  assert.equal(pickBestOffset(samples), 77)
})

test('壊れたサンプルしかなければ 0 に落ちる', () => {
  assert.equal(pickBestOffset([{ rtt: NaN, offset: NaN }]), 0)
})

test('負の RTT は無視する（時計が巻き戻った端末を採用しない）', () => {
  const samples = [
    { rtt: -5, offset: 12345 },
    { rtt: 90, offset: 42 },
  ]
  assert.equal(pickBestOffset(samples), 42)
})
