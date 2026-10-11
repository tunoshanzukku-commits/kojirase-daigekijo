import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderTemplate, createPrompts, promptsDir, REQUIRED_FILES } from '../../src/ai/prompts'
import { GENRE_IDS } from '@shared/constants'

function makeDir(opts: { omit?: string; genres?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-'))
  for (const f of REQUIRED_FILES) {
    if (f === opts.omit) continue
    writeFileSync(join(dir, f), `${f} の中身`)
  }
  mkdirSync(join(dir, 'genres'), { recursive: true })
  for (const g of opts.genres ?? []) {
    writeFileSync(join(dir, 'genres', `${g}.md`), `${g} の作風`)
  }
  return dir
}

test('renderTemplate は {{名前}} を差し替える', () => {
  assert.equal(renderTemplate('こんにちは {{name}} さん', { name: 'たろう' }), 'こんにちは たろう さん')
})

test('renderTemplate は同じ placeholder を複数回差し替える', () => {
  assert.equal(renderTemplate('{{n}}人、ちょうど{{n}}役', { n: '3' }), '3人、ちょうど3役')
})

// 差し替え漏れをそのまま送ると、モデルに「{{playerCount}}」という文字列が届く。
// テンプレートの誤字をテスト時点で捕まえるため throw する。
test('renderTemplate は差し替え漏れがあると throw', () => {
  assert.throws(
    () => renderTemplate('{{a}} と {{b}}', { a: '1' }),
    /b/,
    '未置換の placeholder 名がエラーに含まれるべき',
  )
})

test('renderTemplate は空文字での差し替えを許す', () => {
  assert.equal(renderTemplate('前{{x}}後', { x: '' }), '前後')
})

test('createPrompts は必須ファイルを読み、件数を返す', () => {
  const dir = makeDir({ genres: ['comedy', 'horror'] })
  try {
    const prompts = createPrompts(dir)
    assert.equal(prompts.counts.prompts, REQUIRED_FILES.length)
    assert.equal(prompts.counts.genres, 2)
    assert.match(prompts.scriptSystem(), /script-system\.md/)
    assert.match(prompts.scoreUserPlayer(), /score-user-player\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 台本には代替（他の台本）があるが、プロンプトには代替が無い。
// 空のまま動くと「それらしい失敗」を返しながら毎ゲーム課金するので、起動時に倒す。
test('createPrompts は必須ファイルが欠けると throw する', () => {
  const dir = makeDir({ omit: 'score-system.md' })
  try {
    assert.throws(() => createPrompts(dir), /score-system\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createPrompts は必須ファイルが空でも throw する', () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'script-user.md'), '   \n  ')
  try {
    assert.throws(() => createPrompts(dir), /script-user\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createPrompts はディレクトリごと無い場合も throw する', () => {
  assert.throws(() => createPrompts(join(tmpdir(), 'no-such-prompts-dir-xyz')))
})

// ジャンル作風は欠けてもその行を省いて続行する（8ジャンル揃っていなくても劇は成立する）。
test('genreFlavor は未配置のジャンルで空文字を返す', () => {
  const dir = makeDir({ genres: ['comedy'] })
  try {
    const prompts = createPrompts(dir)
    assert.match(prompts.genreFlavor('comedy'), /comedy の作風/)
    assert.equal(prompts.genreFlavor('horror'), '')
    assert.equal(prompts.genreFlavor('nonexistent'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('新しいプロンプトファイルは必須である', () => {
  assert.ok(REQUIRED_FILES.includes('score-system-shared.md'))
  assert.ok(REQUIRED_FILES.includes('score-user-shared-header.md'))
  assert.ok(REQUIRED_FILES.includes('score-user-shared-source.md'))
})

test('同梱の prompts/ が実際に読めて必須ファイルが揃っている', () => {
  const prompts = createPrompts(promptsDir())
  assert.equal(prompts.counts.prompts, REQUIRED_FILES.length)
  assert.ok(prompts.scriptSystem().length > 0)
  assert.ok(prompts.scriptUserTemplate().length > 0)
  assert.ok(prompts.scriptUserSoloTemplate().length > 0)
  assert.ok(prompts.scoreSystem().length > 0)
  assert.ok(prompts.scoreSystemSolo().length > 0)
  assert.ok(prompts.scoreUserHeader().length > 0)
})

test('同梱の prompts/genres に全ジャンルの作風が揃っている', () => {
  const prompts = createPrompts(promptsDir())
  for (const id of GENRE_IDS) {
    assert.ok(prompts.genreFlavor(id).length > 0, `${id} の作風ファイルが無い`)
  }
})

// カオスモードは仕様書§2で「設定・役割・世界観をおかしくする」と定義されている。
// ラベルだけ渡しても伝わらないので、専用の指示が入っていることを担保する。
test('カオスモードの作風には破綻させる指示が入っている', () => {
  const prompts = createPrompts(promptsDir())
  assert.match(prompts.genreFlavor('chaos'), /破綻/)
})
