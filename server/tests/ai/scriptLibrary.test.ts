import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GENRE_IDS, MAX_PLAYERS, MIN_PLAYERS } from '@shared/constants'
import {
  parsePlay, loadPlays, selectPlay, toScriptData, createScriptLibrary, playsDir, type Play,
} from '../../src/ai/scriptLibrary'

function makePlay(over: Partial<Play> = {}): Play {
  return {
    id: 'p1',
    genre: 'comedy',
    title: 'テスト台本',
    minPlayers: 2,
    maxPlayers: 3,
    worldSetting: 'せかい',
    roles: [
      { role: '役A', description: 'せつめいA' },
      { role: '役B', description: 'せつめいB' },
      { role: '役C', description: 'せつめいC' },
    ],
    entries: [
      { roleIndex: 0, action: 'うごく', line: 'せりふ0' },
      { roleIndex: 1, line: 'せりふ1' },
      { roleIndex: 2, line: 'せりふ2' },
    ],
    ...over,
  }
}

test('parsePlay は正しい台本を通す', () => {
  assert.notEqual(parsePlay(makePlay()), null)
})

test('parsePlay は未知のジャンルを弾く', () => {
  assert.equal(parsePlay(makePlay({ genre: 'nonexistent' })), null)
})

test('parsePlay は roles が maxPlayers に足りない台本を弾く', () => {
  const p = makePlay({ maxPlayers: 5 }) // roles は3件しかない
  assert.equal(parsePlay(p), null)
})

test('parsePlay は範囲外の roleIndex を弾く', () => {
  const p = makePlay({ entries: [{ roleIndex: 9, line: 'x' }] })
  assert.equal(parsePlay(p), null)
})

test('parsePlay は minPlayers < 1 を弾く', () => {
  assert.equal(parsePlay(makePlay({ minPlayers: 0, maxPlayers: 3 })), null)
})

test('parsePlay は minPlayers 1 のソロ台本を受け入れる', () => {
  const p = parsePlay(makePlay({
    minPlayers: 1,
    maxPlayers: 1,
    roles: [{ role: 'ひとり', description: 'せつめい' }],
    entries: [{ roleIndex: 0, action: 'うごく', line: 'せりふ0' }],
  }))
  assert.equal(p?.minPlayers, 1)
  assert.equal(p?.maxPlayers, 1)
  assert.equal(p?.roles.length, 1)
})

test('selectPlay は1人ならソロ台本を選び、2人以上では選ばない', () => {
  const solo = makePlay({ id: 'solo', genre: 'comedy', minPlayers: 1, maxPlayers: 1, roles: [{ role: 'ひとり', description: 'せつめい' }], entries: [{ roleIndex: 0, action: 'うごく', line: 'せりふ0' }] })
  const duo = makePlay({ id: 'duo', genre: 'comedy', minPlayers: 2, maxPlayers: 3 })
  assert.equal(selectPlay([solo, duo], 'comedy', 1, xs => xs[0]!)?.id, 'solo')
  assert.equal(selectPlay([solo, duo], 'comedy', 2, xs => xs[0]!)?.id, 'duo')
})

test('parsePlay は maxPlayers < minPlayers を弾く', () => {
  assert.equal(parsePlay(makePlay({ minPlayers: 3, maxPlayers: 2 })), null)
})

test('parsePlay は maxPlayers が MAX_PLAYERS を超える台本を弾く', () => {
  // 役は 11 件そろえる＝落ちる理由を「maxPlayers > MAX_PLAYERS」だけに絞る
  const roles = Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => ({
    role: `役${i}`, description: `せつめい${i}`,
  }))
  assert.equal(parsePlay(makePlay({ maxPlayers: MAX_PLAYERS + 1, roles })), null)
  // 同じ台本でも maxPlayers が MAX_PLAYERS ちょうどなら通る（境界の確認）
  assert.notEqual(parsePlay(makePlay({ maxPlayers: MAX_PLAYERS, roles })), null)
})

test('parsePlay は JSON でない値を弾く', () => {
  assert.equal(parsePlay(null), null)
  assert.equal(parsePlay('文字列'), null)
  assert.equal(parsePlay(42), null)
})

/** ジャンルごとのサブディレクトリを持つ一時的な plays/ を作る。 */
function makePlaysDir(files: { genre: string; name: string; body: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'plays-'))
  for (const f of files) {
    mkdirSync(join(dir, f.genre), { recursive: true })
    writeFileSync(join(dir, f.genre, f.name), f.body)
  }
  return dir
}

test('loadPlays はジャンルのサブディレクトリから読む', () => {
  const dir = makePlaysDir([
    { genre: 'comedy', name: 'a.json', body: JSON.stringify(makePlay({ id: 'a', genre: 'comedy' })) },
    { genre: 'horror', name: 'b.json', body: JSON.stringify(makePlay({ id: 'b', genre: 'horror' })) },
  ])
  try {
    const ids = loadPlays(dir).map(p => p.id).sort()
    assert.deepEqual(ids, ['a', 'b'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlays は壊れたファイルをスキップして残りを読む', () => {
  const dir = makePlaysDir([
    { genre: 'comedy', name: 'ok.json', body: JSON.stringify(makePlay({ id: 'ok' })) },
    { genre: 'comedy', name: 'broken.json', body: '{ これはJSONではない' },
    { genre: 'comedy', name: 'notjson.txt', body: 'ignored' },
  ])
  try {
    const plays = loadPlays(dir)
    assert.equal(plays.length, 1)
    assert.equal(plays[0]?.id, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlays は genre がディレクトリ名と食い違う台本を捨てる', () => {
  // 置き間違いを検出するための検証。ディレクトリ名を正とする。
  const dir = makePlaysDir([
    { genre: 'horror', name: 'misfiled.json', body: JSON.stringify(makePlay({ id: 'misfiled', genre: 'comedy' })) },
  ])
  try {
    assert.deepEqual(loadPlays(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlays は直下に置かれた .json を読まない', () => {
  // 移行後にうっかり直下へ置いても黙って無視されないよう、警告つきでスキップする。
  const dir = makePlaysDir([
    { genre: 'comedy', name: 'ok.json', body: JSON.stringify(makePlay({ id: 'ok' })) },
  ])
  try {
    writeFileSync(join(dir, 'loose.json'), JSON.stringify(makePlay({ id: 'loose' })))
    const ids = loadPlays(dir).map(p => p.id)
    assert.deepEqual(ids, ['ok'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlays はジャンル名でないディレクトリを無視する', () => {
  const dir = makePlaysDir([
    { genre: 'comedy', name: 'ok.json', body: JSON.stringify(makePlay({ id: 'ok' })) },
    { genre: 'notagenre', name: 'x.json', body: JSON.stringify(makePlay({ id: 'x', genre: 'comedy' })) },
  ])
  try {
    const ids = loadPlays(dir).map(p => p.id)
    assert.deepEqual(ids, ['ok'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadPlays は存在しないディレクトリで空配列を返す（起動を止めない）', () => {
  assert.deepEqual(loadPlays(join(tmpdir(), 'no-such-dir-xyz')), [])
})

test('selectPlay はジャンル一致かつ人数が合うものを選ぶ', () => {
  const a = makePlay({ id: 'a', genre: 'comedy', minPlayers: 2, maxPlayers: 3 })
  const b = makePlay({ id: 'b', genre: 'horror', minPlayers: 2, maxPlayers: 3 })
  assert.equal(selectPlay([a, b], 'horror', 2, xs => xs[0]!)?.id, 'b')
})

test('selectPlay は人数が合わない台本を除外する', () => {
  const a = makePlay({ id: 'a', genre: 'comedy', minPlayers: 2, maxPlayers: 3 })
  assert.equal(selectPlay([a], 'comedy', 4, xs => xs[0]!), null)
})

test('selectPlay はジャンル一致が無ければ他ジャンルで人数が合うものに落ちる', () => {
  const b = makePlay({ id: 'b', genre: 'horror', minPlayers: 2, maxPlayers: 3 })
  assert.equal(selectPlay([b], 'comedy', 2, xs => xs[0]!)?.id, 'b')
})

test('selectPlay はどれも合わなければ null', () => {
  assert.equal(selectPlay([], 'comedy', 2, xs => xs[0]!), null)
})

test('toScriptData は先頭からN役だけ使う', () => {
  const s = toScriptData(makePlay(), ['たろう', 'はなこ'])
  assert.equal(s.roles.length, 2)
  assert.deepEqual(s.roles.map(r => r.player), ['たろう', 'はなこ'])
  assert.deepEqual(s.roles.map(r => r.role), ['役A', '役B'])
})

test('toScriptData は使わない役のセリフを落とす', () => {
  const s = toScriptData(makePlay(), ['たろう', 'はなこ'])
  assert.equal(s.entries.length, 2) // roleIndex 2 のセリフは落ちる
  assert.deepEqual(s.entries.map(e => e.player), ['たろう', 'はなこ'])
  assert.deepEqual(s.entries.map(e => e.character), ['役A', '役B'])
  assert.equal(s.entries[0]?.action, 'うごく')
  assert.equal(s.entries[1]?.action, undefined)
})

test('toScriptData は worldSetting をそのまま渡す', () => {
  assert.equal(toScriptData(makePlay(), ['たろう', 'はなこ']).worldSetting, 'せかい')
})

test('generateLibraryScript は台本が無ければスタブに落ちる', () => {
  const plays = createScriptLibrary([])
  const s = plays.generate('comedy', ['たろう', 'はなこ'])
  assert.equal(s.roles.length, 2)
  assert.ok(s.worldSetting.length > 0)
})

test('generateLibraryScript は台本があればそれを使う', () => {
  const plays = createScriptLibrary([makePlay({ worldSetting: 'ライブラリの世界' })])
  const s = plays.generate('comedy', ['たろう', 'はなこ'])
  assert.equal(s.worldSetting, 'ライブラリの世界')
})

test('同梱の plays/ が実際に読めて検証を通る', () => {
  const plays = loadPlays(playsDir())
  assert.ok(plays.length >= 2, `plays/ から台本が読めていない（${plays.length}件）`)
})

// スタブ台本は「本番では Claude API が生成します」等の開発者向け文言を出す。
// 実プレイヤーに見せてはいけないので、全ジャンル × 全人数で必ず手書き台本が選ばれること。
test('同梱の plays/ は全ジャンル × MIN_PLAYERS〜MAX_PLAYERS人でスタブに落ちない', () => {
  const plays = loadPlays(playsDir())
  for (const genre of GENRE_IDS) {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      assert.notEqual(
        selectPlay(plays, genre, n, xs => xs[0]!), null,
        `ジャンル ${genre} / ${n}人 で台本が選ばれずスタブに落ちる`,
      )
    }
  }
})

test('同梱の plays/ は 10 人でも全員に役とセリフが割り当たる', () => {
  const plays = createScriptLibrary(loadPlays(playsDir()))
  const names = Array.from({ length: MAX_PLAYERS }, (_, i) => `p${i}`)
  const s = plays.generate('comedy', names)
  assert.equal(s.roles.length, MAX_PLAYERS)
  assert.ok(!/スタブ/.test(s.worldSetting), `スタブ台本が返っている: ${s.worldSetting}`)
  for (const n of names) {
    assert.ok(s.entries.some(e => e.player === n), `${n} にセリフが1つも無い`)
  }
})

test('実 plays/ には1人で選べるコメディのソロ台本がある', () => {
  const plays = loadPlays(playsDir())
  const picked = selectPlay(plays, 'comedy', 1)
  assert.ok(picked, '1人で選べる台本が無い')
  assert.equal(picked.maxPlayers, 1, 'ソロ台本ではない台本が選ばれている')
  assert.equal(picked.genre, 'comedy')
})
