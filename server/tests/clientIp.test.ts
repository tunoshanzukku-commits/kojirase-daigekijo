import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractIp } from '../src/clientIp'

test('x-forwarded-for の末尾（信頼できるプロキシが直接見たアドレス）を実クライアントとして採る', () => {
  assert.equal(extractIp('203.0.113.7, 10.0.0.1, 10.0.0.2', '10.0.0.9'), '10.0.0.2')
})

test('前後の空白を落とす', () => {
  assert.equal(extractIp('10.0.0.1,  203.0.113.7 ', undefined), '203.0.113.7')
})

test('クライアントが先頭に偽の値を差し込んでも末尾（プロキシが付け足した値）を採る＝なりすまし対策', () => {
  assert.equal(extractIp('1.2.3.4, 203.0.113.7', '10.0.0.9'), '203.0.113.7')
})

test('ヘッダが無ければフォールバックを使う', () => {
  assert.equal(extractIp(undefined, '10.0.0.9'), '10.0.0.9')
  assert.equal(extractIp('', '10.0.0.9'), '10.0.0.9')
})

test('文字列以外のヘッダは無視する', () => {
  assert.equal(extractIp(['a', 'b'], '10.0.0.9'), '10.0.0.9')
})

test('どちらも無ければ unknown', () => {
  assert.equal(extractIp(undefined, undefined), 'unknown')
})
