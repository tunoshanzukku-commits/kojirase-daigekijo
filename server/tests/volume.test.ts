import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp01, combineFreshVolumes } from '../src/volume'

test('clamp01 は 0..1 に収め、非有限(NaN/Infinity)は 0', () => {
  assert.equal(clamp01(0.5), 0.5)
  assert.equal(clamp01(-1), 0)
  assert.equal(clamp01(2), 1)
  assert.equal(clamp01(NaN), 0)
  assert.equal(clamp01(Infinity), 0) // 非有限は 0（Number.isFinite で弾く）
})

test('combineFreshVolumes は新鮮なエントリの level を合計し 1 にクランプ', () => {
  const now = 1000
  assert.equal(combineFreshVolumes([], now), 0)
  assert.equal(combineFreshVolumes([{ level: 0.3, ts: 1000 }], now), 0.3)
  assert.equal(combineFreshVolumes([{ level: 0.4, ts: 1000 }, { level: 0.5, ts: 900 }], now), 0.9)
  assert.equal(combineFreshVolumes([{ level: 0.7, ts: 1000 }, { level: 0.8, ts: 1000 }], now), 1)
})

test('combineFreshVolumes は窓外(古い)エントリを除外', () => {
  const now = 2000
  // windowMs=500 → ts<1500 は除外
  assert.equal(combineFreshVolumes([{ level: 0.6, ts: 2000 }, { level: 0.9, ts: 1400 }], now), 0.6)
})

test('combineFreshVolumes は異常な level を 0 として扱う', () => {
  const now = 1000
  assert.equal(combineFreshVolumes([{ level: -5, ts: 1000 }, { level: NaN, ts: 1000 }, { level: 0.2, ts: 1000 }], now), 0.2)
})
