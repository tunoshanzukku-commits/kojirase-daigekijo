import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScores, SCORE_SCHEMA, buildScorePrompt, selectScoreSystem, buildScoreRequest } from '../../src/ai/scoreGen'
import type { TranscribedSource } from '../../src/ai/scoreGen'
import { createPrompts, REQUIRED_FILES, renderTemplate } from '../../src/ai/prompts'
import type { ScriptData } from '@shared/types'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT: ScriptData = {
  worldSetting: '深夜のコンビニ',
  roles: [
    { player: 'たろう', role: '店員', description: '3日目' },
    { player: 'はなこ', role: '常連', description: '毎晩来る' },
  ],
  entries: [
    { player: 'たろう', character: '店員', line: 'いらっしゃいませ' },
    { player: 'はなこ', character: '常連', line: 'いつもの' },
  ],
}

// 「文面がファイルにある」だけでは配線を検証できない（旧実装のハードコードでも
// 同じ出力になる）。テンプレートに目印を入れた一時ディレクトリを読ませ、
// その目印が出力に現れることで「本当にファイル由来か」を判定する。
test('buildScorePrompt は prompts/ のテンプレートから組み立てている', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-score-'))
  try {
    const content: Record<string, string> = {
      'score-user-header.md': '★世界観★{{worldSetting}}',
      'score-user-player.md': '★{{playerName}}★{{role}}/{{roleDescription}}/{{scriptedLines}}/{{actualSpeech}}',
    }
    for (const f of REQUIRED_FILES) {
      writeFileSync(join(dir, f), content[f] ?? 'x')
    }
    const prompts = createPrompts(dir)
    const p = buildScorePrompt(prompts, SCRIPT, [{ players: ['たろう'], text: 'あ' }])
    assert.match(p, /★世界観★深夜のコンビニ/)
    assert.match(p, /★たろう★店員/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildScorePrompt は世界観と全プレイヤーの役・台詞・発話を並べる', () => {
  const prompts = createPrompts()
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう'], text: 'いらっしゃいませー！' },
    { players: ['はなこ'], text: '' },
  ])
  assert.match(p, /深夜のコンビニ/)
  assert.match(p, /たろう/)
  assert.match(p, /店員/)
  assert.match(p, /いらっしゃいませー！/)
  assert.match(p, /はなこ/)
  assert.match(p, /（無音）/) // 空発話は無音と明示する
  assert.doesNotMatch(p, /\{\{/) // 差し替え漏れなし
})

test('全ソースが1人なら現行と同一のプロンプトを出す（回帰防止）', () => {
  const prompts = createPrompts()
  // 「現行と同じ」の基準＝録音セクションが1文字も入らないこと
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう'], text: 'いらっしゃいませー！' },
    { players: ['はなこ'], text: 'いつものー' },
  ])
  assert.doesNotMatch(p, /【録音】/)
  assert.doesNotMatch(p, /録音A/)
  assert.doesNotMatch(p, /を参照/)
  assert.match(p, /いらっしゃいませー！/)
  assert.match(p, /いつものー/)
  // 期待する全体の形：ヘッダ → 空行 → プレイヤーブロックのみ
  const header = renderTemplate(prompts.scoreUserHeader(), { worldSetting: SCRIPT.worldSetting })
  assert.ok(p.startsWith(header + '\n\n'))
})

// marker 不在テスト（上）は「共有録音セクションが漏れない」ことしか見ておらず、
// プレイヤーブロックの区切り方や並べ方が変わっても検知できない（marker 文字列は
// 一切出てこないため）。ここでは prompts/ の実テンプレートと renderTemplate から
// 期待文字列そのものを組み立て、buildScorePrompt の出力とバイト単位で完全一致させる。
// 固定するのは「組み立ての構造」（ヘッダ→空行→プレイヤーブロックを改行で連結）で
// あって、prompts/*.md の文面そのものではない：文面はここでも renderTemplate 経由で
// 実ファイルから取得しているので、.md を書き換えてもこのテストは壊れない。
test('全ソースが1人なら prompt は組み立て構造ごとバイト単位で完全一致する（回帰防止・全文一致）', () => {
  const prompts = createPrompts()
  const sources: TranscribedSource[] = [
    { players: ['たろう'], text: 'いらっしゃいませー！' },
    { players: ['はなこ'], text: 'いつものー' },
  ]
  const p = buildScorePrompt(prompts, SCRIPT, sources)

  const header = renderTemplate(prompts.scoreUserHeader(), { worldSetting: SCRIPT.worldSetting })
  const playerTemplate = prompts.scoreUserPlayer()
  const playerBlocks = sources.map(s => {
    const name = s.players[0]!
    const role = SCRIPT.roles.find(r => r.player === name)
    const scripted = SCRIPT.entries.filter(e => e.player === name).map(e => e.line).join(' / ')
    return renderTemplate(playerTemplate, {
      playerName: name,
      role: role?.role ?? '不明',
      roleDescription: role?.description ?? '',
      scriptedLines: scripted || '（なし）',
      actualSpeech: s.text || '（無音）',
    })
  })
  const expected = [header, '', ...playerBlocks].join('\n')
  assert.equal(p, expected)

  // 対の保証：共有録音が無いときはシステムプロンプトも現行と完全一致する
  const names = sources.flatMap(s => s.players)
  assert.equal(selectScoreSystem(prompts, names.length, false), prompts.scoreSystem())
})

test('共有録音があると録音セクションが入り、該当者の発話は参照になる', () => {
  const prompts = createPrompts()
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう', 'はなこ'], text: 'いらっしゃいませ いつもの' },
  ])
  assert.match(p, /【録音】/)
  assert.match(p, /録音A/)
  assert.match(p, /たろう・はなこ/)
  assert.match(p, /いらっしゃいませ いつもの/)
  // 2人とも「録音A を参照」になり、文字起こし本文は1回しか出ない
  assert.equal((p.match(/録音A を参照/g) ?? []).length, 2)
  assert.equal((p.match(/いらっしゃいませ いつもの/g) ?? []).length, 1)
  assert.doesNotMatch(p, /\{\{/)
})

test('共有録音と単独録音が混在すると単独側は本文がそのまま入る', () => {
  const prompts = createPrompts()
  const p = buildScorePrompt(prompts, SCRIPT, [
    { players: ['たろう', 'はなこ'], text: '共有のはつわ' },
    { players: ['じろう'], text: 'ひとりのはつわ' },
  ])
  assert.match(p, /録音A を参照/)
  assert.match(p, /ひとりのはつわ/)
  assert.doesNotMatch(p, /じろう[\s\S]*?録音A を参照/)
})

// 全員が同時に録音するので、各自の音声に他人の台詞が混入する。
// これを伝えないと、黙っていた人が隣の熱演で採点される。
test('採点プロンプトは他プレイヤーの声の混入と、その場合の無音判定を指示している', () => {
  const prompts = createPrompts()
  const s = prompts.scoreSystem()
  assert.match(s, /同時に録音/)
  assert.match(s, /除外/)
  assert.match(s, /無音/)
})

// 「可能な限り」のような弱い言い方は「触れなくてもよい」と読まれ、講評が一般論になる。
test('採点プロンプトは講評の具体性を必須として指示している', () => {
  const prompts = createPrompts()
  const s = prompts.scoreSystem()
  assert.match(s, /必ず/)
  assert.doesNotMatch(s, /可能な限り実際の発話/)
})

test('採点プロンプトは相対評価を指示している', () => {
  const prompts = createPrompts()
  assert.match(prompts.scoreSystem(), /見比べ/)
})

test('SCORE_SCHEMA は title を含み、構造化出力が非対応の数値/文字列制約を含まない', () => {
  // Anthropic の output_config.format は integer の minimum/maximum も
  // string の maxLength/minLength も非対応（送ると 400）。範囲・長さは
  // SYSTEM プロンプトと parseScores 側で担保する。
  const json = JSON.stringify(SCORE_SCHEMA)
  assert.ok(json.includes('title'), 'title フィールドがスキーマにある')
  assert.ok(!json.includes('minimum'), 'minimum は構造化出力で使えない')
  assert.ok(!json.includes('maximum'), 'maximum は構造化出力で使えない')
  assert.ok(!json.includes('maxLength'), 'maxLength は構造化出力で使えない')
  assert.ok(!json.includes('minLength'), 'minLength は構造化出力で使えない')
})

test('parseScores は正しい JSON を PlayerScore[] に変換', () => {
  const text = JSON.stringify({
    scores: [
      { playerName: 'A', acting: 5, emotion: 3, kojirase: 4, comment: 'よかった' },
      { playerName: 'B', acting: 1, emotion: 2, kojirase: 1, comment: '無音' },
    ],
  })
  const s = parseScores(text, ['A', 'B'])
  assert.equal(s.length, 2)
  assert.deepEqual(s.map(x => x.playerName), ['A', 'B']) // expectedNames の順
  assert.equal(s[0].acting, 5)
  assert.equal(s[1].comment, '無音')
})

test('parseScores は不正 JSON で throw', () => {
  assert.throws(() => parseScores('not json', ['A']))
})

// 頑健化（fail-open）: Claude が名前を取りこぼす/変える/人数分返さない・範囲外スコアを
// 返しても、ゲーム全体の採点を落とさず全員ぶん返す。名前一致→順番対応付け→プレースホルダ。
test('parseScores は Claude が名前を変えても件数一致なら順番で対応付ける', () => {
  const text = JSON.stringify({
    scores: [
      { playerName: 'X', acting: 5, emotion: 4, kojirase: 3, comment: 'a のはず' },
      { playerName: 'Y', acting: 2, emotion: 2, kojirase: 2, comment: 'b のはず' },
    ],
  })
  const s = parseScores(text, ['A', 'B'])
  assert.deepEqual(s.map(x => x.playerName), ['A', 'B'])
  assert.equal(s[0].acting, 5) // A ← X（順番）
  assert.equal(s[1].comment, 'b のはず') // B ← Y（順番）
})

test('parseScores は名前一致を優先し、余りだけ順番で埋める', () => {
  const text = JSON.stringify({
    scores: [
      { playerName: 'Z', acting: 5, emotion: 5, kojirase: 5, comment: 'a?' }, // 別名
      { playerName: 'B', acting: 1, emotion: 1, kojirase: 1, comment: 'b' }, // 一致
    ],
  })
  const s = parseScores(text, ['A', 'B'])
  assert.deepEqual(s.map(x => x.playerName), ['A', 'B'])
  assert.equal(s.find(x => x.playerName === 'B')!.comment, 'b') // 名前一致
  assert.equal(s.find(x => x.playerName === 'A')!.acting, 5) // 余りの Z が A へ
})

test('parseScores は人数分返らなくてもプレースホルダで全員ぶん返す', () => {
  const text = JSON.stringify({ scores: [{ playerName: 'A', acting: 3, emotion: 3, kojirase: 3, comment: 'c' }] })
  const s = parseScores(text, ['A', 'B'])
  assert.equal(s.length, 2)
  assert.deepEqual(s.map(x => x.playerName), ['A', 'B'])
  const b = s.find(x => x.playerName === 'B')!
  assert.equal(b.title, '—') // プレースホルダの称号は中立表記
  assert.equal(b.acting, 1) // プレースホルダは最低点
  assert.match(b.comment, /採点/) // 「採点できませんでした」旨
})

test('parseScores は範囲外・非整数スコアを 1〜5 にクランプする（throw しない）', () => {
  const text = JSON.stringify({
    scores: [{ playerName: 'A', acting: 6, emotion: 0, kojirase: 2.5, comment: 'c' }],
  })
  const s = parseScores(text, ['A'])
  assert.equal(s[0].acting, 5) // 6 → 5
  assert.equal(s[0].emotion, 1) // 0 → 1
  assert.equal(s[0].kojirase, 3) // 2.5 → 3
})

test('parseScores は title を抽出する', () => {
  const text = JSON.stringify({
    scores: [{ playerName: 'A', acting: 5, emotion: 3, kojirase: 4, comment: 'c', title: '激情型アクター' }],
  })
  const s = parseScores(text, ['A'])
  assert.equal(s[0].title, '激情型アクター')
})

// --- ソロ（採点対象が1人）の採点プロンプト ---

// 判定を「台本の役数」でなく「今回採点する人数」にしているのは、2人で始めて
// 1人が収集ウィンドウ中に切断した場合も performers が1人になり、そこでも
// 「全員を見比べて」が成立しないため。
test('selectScoreSystem は採点人数が1人ならソロ用の SYSTEM を返す', () => {
  const prompts = createPrompts()
  assert.equal(selectScoreSystem(prompts, 1, false), prompts.scoreSystemSolo())
  assert.equal(selectScoreSystem(prompts, 2, false), prompts.scoreSystem())
})

test('selectScoreSystem は共有録音があるとき追記ぶんを連結する', () => {
  const prompts = createPrompts()
  const normal = selectScoreSystem(prompts, 3, false)
  const shared = selectScoreSystem(prompts, 3, true)
  const solo = selectScoreSystem(prompts, 1, false)
  assert.equal(normal, prompts.scoreSystem())            // 現行と完全に同じ
  assert.ok(shared.startsWith(prompts.scoreSystem()))     // 全文の複製ではなく追記
  assert.ok(shared.includes(prompts.scoreSystemShared()))
  assert.equal(solo, prompts.scoreSystemSolo())
})

test('1人プレイは共有録音フラグに関係なくソロ用システムを使う', () => {
  const prompts = createPrompts()
  assert.equal(selectScoreSystem(prompts, 1, true), prompts.scoreSystemSolo())
})

// 見比べる相手がいないのに相対評価を指示すると、モデルは存在しない比較対象を
// 捏造するか、指示を無視して全項目3に寄せる。
test('ソロ用の採点プロンプトは相対評価を指示しない', () => {
  const prompts = createPrompts()
  const s = prompts.scoreSystemSolo()
  assert.doesNotMatch(s, /見比べ/)
  assert.doesNotMatch(s, /全員/)
})

// 相対評価を外した穴を埋めるのが絶対アンカー。基準点を置き、上下の材料を
// 発話から挙げさせてから確定させないと、点が3〜4に張り付く。
test('ソロ用の採点プロンプトは基準点3からの絶対評価を指示している', () => {
  const prompts = createPrompts()
  const s = prompts.scoreSystemSolo()
  assert.match(s, /基準点/)
  assert.match(s, /上回る/)
  assert.match(s, /下回る/)
})

// 他人の声は混ざらないが、生活音やテレビの音は入る。無音判定の指示は複数人と同じく要る。
test('ソロ用の採点プロンプトも本人の発話が無い場合の扱いを指示している', () => {
  const prompts = createPrompts()
  assert.match(prompts.scoreSystemSolo(), /無音/)
})

// ソロ台本は action で「相手の返事を聞く」間を作る設計＝そこが演技の山になる。
test('ソロ用の採点プロンプトは「間」を評価材料に挙げている', () => {
  const prompts = createPrompts()
  assert.match(prompts.scoreSystemSolo(), /「間」/)
})

// 2026-10-10 に計測: 考える処理なしの Haiku 5.5 は採点が約3.5秒（Haiku 4.5 は約9秒）で、
// 評価中の演出（最短約6.3秒）の間に届く。有効にすると演出のあとに待ちが戻る。
test('buildScoreRequest は Haiku 5.5 を考える処理なしで呼び、非対応のサンプリング設定を送らない', () => {
  const req = buildScoreRequest(createPrompts(), SCRIPT, [{ players: ['たろう'], text: 'あ' }]) as Record<string, unknown>
  assert.equal(req.model, 'claude-haiku-5-5')
  assert.deepEqual(req.thinking, { type: 'disabled' })
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in req), `${k} を送っている`)
})

// thinking を無効にしたまま effort を xhigh/max にすると 400 になる
test('buildScoreRequest は考える処理なしと両立する effort を指定する', () => {
  const req = buildScoreRequest(createPrompts(), SCRIPT, [{ players: ['たろう'], text: 'あ' }])
  assert.ok(['low', 'medium', 'high'].includes(req.output_config.effort))
  assert.equal(req.output_config.format.schema, SCORE_SCHEMA)
})

// 4.5 時代の 2000 は、Haiku 5.5 のトークン数（約3割増）で10人ぶんの講評を数えると足りない。
test('buildScoreRequest は10人ぶんの講評が収まる出力上限を取る', () => {
  const req = buildScoreRequest(createPrompts(), SCRIPT, [{ players: ['たろう'], text: 'あ' }])
  assert.ok(req.max_tokens >= 16000)
})

test('buildScoreRequest は採点人数と共有録音に応じた system と、組み立てた採点プロンプトを載せる', () => {
  const prompts = createPrompts()
  const sources: TranscribedSource[] = [{ players: ['たろう', 'はなこ'], text: '共有' }]
  const req = buildScoreRequest(prompts, SCRIPT, sources)
  assert.equal(req.system, selectScoreSystem(prompts, 2, true))
  assert.deepEqual(req.messages, [{ role: 'user', content: buildScorePrompt(prompts, SCRIPT, sources) }])
})
