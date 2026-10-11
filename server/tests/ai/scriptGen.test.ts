import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScriptGenerator, parseScript, buildUserPrompt, buildScriptRequest } from '../../src/ai/scriptGen'
import { createPrompts } from '../../src/ai/prompts'
import { createScriptLibrary, loadPlays, playsDir } from '../../src/ai/scriptLibrary'

const prompts = createPrompts()
const plays = createScriptLibrary(loadPlays(playsDir()))

// 行数は人数に比例させる。一律「8〜16行」だと2人なら1人8行、10人なら1人1.6行になり、
// 同じ指示なのに体験が全く別物になる。
test('buildUserPrompt は人数に応じて行数の目安を変える', () => {
  const few = buildUserPrompt(prompts, 'comedy', ['A', 'B'])
  const many = buildUserPrompt(prompts, 'comedy', Array.from({ length: 10 }, (_, i) => `P${i}`))
  assert.match(few, /8〜12 行/)
  assert.match(many, /30〜40 行/)
})

test('buildUserPrompt はプレイヤー名と人数を埋め込む', () => {
  const p = buildUserPrompt(prompts, 'comedy', ['たろう', 'はなこ'])
  assert.match(p, /たろう、はなこ/)
  assert.match(p, /2人/)
  assert.match(p, /ちょうど 2 役/)
})

// 仕様書§2 はカオスモードを「設定・役割・世界観をおかしくする」と定義している。
// ラベルだけ渡しても伝わらないので、作風の本文がプロンプトに載ることを担保する。
test('buildUserPrompt はカオスモードに専用の作風指示を載せる', () => {
  const p = buildUserPrompt(prompts, 'chaos', ['A', 'B'])
  assert.match(p, /破綻/)
})

test('buildUserPrompt はジャンルごとに違う作風を載せる', () => {
  const horror = buildUserPrompt(prompts, 'horror', ['A', 'B'])
  const comedy = buildUserPrompt(prompts, 'comedy', ['A', 'B'])
  assert.notEqual(horror, comedy)
})

test('buildUserPrompt は差し替え漏れを残さない', () => {
  assert.doesNotMatch(buildUserPrompt(prompts, 'comedy', ['A', 'B']), /\{\{/)
})

// キー未設定は本番の設定ミスでも起こる。開発用スタブ（「本番では Claude API が生成します」）
// ではなく、簡易モードと同じ手書き台本にフォールバックすること。
test('API キー未設定なら全員分の role を持つ手書き台本を返す', async () => {
  delete process.env.ANTHROPIC_API_KEY
  const generateScript = createScriptGenerator(prompts, plays)
  const script = await generateScript('comedy', ['たろう', 'はなこ'])
  assert.equal(script.roles.length, 2)
  assert.deepEqual(script.roles.map(r => r.player).sort(), ['たろう', 'はなこ'].sort())
  assert.equal(typeof script.worldSetting, 'string')
  assert.ok(script.entries.length > 0)
  assert.ok(!/スタブ/.test(script.worldSetting), `スタブ台本が返っている: ${script.worldSetting}`)
  for (const e of script.entries) {
    assert.ok(!/スタブ/.test(e.line), `スタブのセリフが返っている: ${e.line}`)
  }
})

test('parseScript は正しい JSON を ScriptData に変換', () => {
  const text = JSON.stringify({
    worldSetting: 'ある町',
    roles: [{ player: 'A', role: '主役', description: '説明' }],
    entries: [{ player: 'A', character: '主役', action: '', line: 'セリフ' }],
  })
  const s = parseScript(text, ['A'])
  assert.equal(s.worldSetting, 'ある町')
  assert.equal(s.entries[0].action, undefined) // '' は undefined に正規化
  assert.equal(s.entries[0].line, 'セリフ')
})

test('parseScript は不正 JSON で throw', () => {
  assert.throws(() => parseScript('not json', ['A']))
})

test('parseScript は role に居ないプレイヤーがいると throw', () => {
  const text = JSON.stringify({
    worldSetting: 'x',
    roles: [{ player: 'A', role: 'r', description: 'd' }],
    entries: [{ player: 'A', character: 'r', action: '', line: 'l' }],
  })
  assert.throws(() => parseScript(text, ['A', 'B'])) // B が居ない
})

// ソロ用プロンプトは一人芝居を求めるが、モデルが架空の2役目（サポート窓口など）を
// 足して対話劇を書いてしまう方向に寄りうる。それを検出できないと「相手の台詞は
// 書かない」という執筆規約が実行時に破られ、準備画面・録音画面に相手の台詞が出る。
test('parseScript はソロなのに2役返ってきたら throw', () => {
  const text = JSON.stringify({
    worldSetting: 'x',
    roles: [
      { player: 'A', role: '客', description: 'd' },
      { player: 'A', role: 'サポート窓口', description: 'd2' },
    ],
    entries: [{ player: 'A', character: '客', action: '', line: 'l' }],
  })
  assert.throws(() => parseScript(text, ['A']))
})

test('parseScript はソロなのに他プレイヤー名の entries が混じっていたら throw', () => {
  const text = JSON.stringify({
    worldSetting: 'x',
    roles: [{ player: 'A', role: '客', description: 'd' }],
    entries: [
      { player: 'A', character: '客', action: '', line: 'l1' },
      { player: 'サポート窓口', character: 'サポート窓口', action: '', line: 'l2' },
    ],
  })
  assert.throws(() => parseScript(text, ['A']))
})

test('parseScript は複数人のときは entries が全員分揃っていれば従来どおり通る', () => {
  const text = JSON.stringify({
    worldSetting: 'x',
    roles: [
      { player: 'A', role: '客', description: 'd' },
      { player: 'B', role: '店員', description: 'd2' },
    ],
    entries: [
      { player: 'A', character: '客', action: '', line: 'l1' },
      { player: 'B', character: '店員', action: '', line: 'l2' },
    ],
  })
  const s = parseScript(text, ['A', 'B'])
  assert.equal(s.roles.length, 2)
  assert.equal(s.entries.length, 2)
})

test('buildUserPrompt は1人のときソロ用テンプレートを使う', () => {
  const solo = buildUserPrompt(prompts, 'comedy', ['たろう'])
  assert.match(solo, /相手の台詞は書かない/, 'ソロ用の指示が入っていない')
  assert.doesNotMatch(solo, /各プレイヤーに/, '複数人用の指示が混ざっている')
})

test('buildUserPrompt は2人以上のとき従来のテンプレートを使う', () => {
  const duo = buildUserPrompt(prompts, 'comedy', ['たろう', 'はなこ'])
  assert.match(duo, /各プレイヤーに/, '複数人用の指示が入っていない')
})

// 2026-10-10 に計測: Haiku 5.5 は考える処理（thinking）を有効にするとオチの質が上がるが、
// 台本生成が約40〜50秒かかる（無効なら約11秒）。待ち時間を優先して無効にすると決めた。
// うっかり有効に戻すとロビーの待ちが4倍になるので、ここで固定する。
test('buildScriptRequest は Haiku 5.5 を考える処理なしで呼び、非対応のサンプリング設定を送らない', () => {
  const req = buildScriptRequest(prompts, 'comedy', ['たろう', 'はなこ']) as Record<string, unknown>
  assert.equal(req.model, 'claude-haiku-5-5')
  assert.deepEqual(req.thinking, { type: 'disabled' })
  // Haiku 5.5 は temperature/top_p/top_k の既定値以外を 400 で弾く
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in req), `${k} を送っている`)
})

// thinking を無効にしたまま effort を xhigh/max にすると 400 になる
test('buildScriptRequest は考える処理なしと両立する effort を指定する', () => {
  const req = buildScriptRequest(prompts, 'comedy', ['たろう', 'はなこ'])
  assert.ok(['low', 'medium', 'high'].includes(req.output_config.effort))
  assert.equal(req.output_config.format.type, 'json_schema')
})

// Haiku 5.5 は同じ文章でも Haiku 4.5 より約3割多くトークンを数える。
// 4.5 時代の 8000 のままだと10人ぶんの台本が途中で切れうる（非ストリーミングなので気づきにくい）。
test('buildScriptRequest は10人ぶんの台本が収まる出力上限を取る', () => {
  const req = buildScriptRequest(prompts, 'comedy', ['たろう', 'はなこ'])
  assert.ok(req.max_tokens >= 16000)
})

test('buildScriptRequest は system と user にそれぞれの指示文を載せる', () => {
  const req = buildScriptRequest(prompts, 'comedy', ['たろう', 'はなこ'])
  assert.equal(req.system, prompts.scriptSystem())
  assert.deepEqual(req.messages, [{ role: 'user', content: buildUserPrompt(prompts, 'comedy', ['たろう', 'はなこ']) }])
})
