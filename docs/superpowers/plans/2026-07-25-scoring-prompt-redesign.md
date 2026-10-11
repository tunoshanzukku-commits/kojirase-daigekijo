# 採点プロンプト刷新（辛口ホスト講評＋称号） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 採点プロンプトを辛口お笑いホストのペルソナ＋3軸1〜5ルーブリックに刷新し、プレイヤーごとの称号（`title`）フィールドを新設して結果画面・スコアカードに表示する。

**Architecture:** 静的なペルソナ/ルーブリック/称号指示は `scoreGen.ts` の SYSTEM に集約、per-game データは既存 `buildScorePrompt` のまま。`PlayerScore` に必須 `title` を追加し、`parseScores` は既存 fail-open を維持したまま title を抽出（欠落時はプレースホルダ）。クライアントは ResultScreen とスコアカードに title を表示。モデルは `claude-haiku-4-5` 維持。

**Tech Stack:** TypeScript / Node20（server: tsx `--test`、型チェックは別途 `tsc --noEmit`）/ React18 + Vite（client: `tsc && vite build`）/ 共有型は `shared/` を `@shared/*` エイリアスで両側から import（`client/src/types.ts` は `export * from '@shared/types'`）。Anthropic SDK 構造化出力（`output_config.format`）。

## Global Constraints

- 設計書: [docs/superpowers/specs/2026-07-25-backend-scoring-prompt-redesign-design.md](../specs/2026-07-25-backend-scoring-prompt-redesign-design.md)。
- **構造化出力の JSON Schema は `minimum`/`maximum`/`maxLength`/`minLength` を非対応**。integer 3軸にも `title`（string）にもこれらを付けない。範囲（1〜5）と長さ（12文字目安）はプロンプト＋`parseScores` で担保。
- **`parseScores` の fail-open を壊さない**：名前一致 → 未使用エントリを順番 → プレースホルダ、範囲外/非整数は `clampScore` で1〜5、真に壊れた出力（不正JSON・scores 非配列）のみ throw。
- **モデルは `claude-haiku-4-5` のまま**（変更しない）。
- **`title` は `PlayerScore` の必須フィールド**。プレースホルダ時は `'—'`。
- **server の検証は2段**：`npm test`（tsx・**型チェックしない**）で挙動を、`npx tsc --noEmit` で型網羅（title を必須にしたため全 `PlayerScore` リテラルに title が要る）を確認する。**両方 green で完了**。
- **client の検証**は `npm run build`（`tsc && vite build`）clean。テストフレームワーク無し＝目視。
- コミットの `Co-Authored-By` は `Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: バックエンド（shared 型＋scoreGen＋scoreStub＋テスト）

**Files:**
- Modify: `shared/types.ts`（`PlayerScore.title` 追加）
- Modify: `server/src/ai/scoreGen.ts`（SCORE_SCHEMA・SYSTEM・RawScore・parseScores）
- Modify: `server/src/ai/scoreStub.ts`（スタブに title）
- Modify: `server/src/ai/scoreGen.test.ts`（title テスト追加・スキーマテスト更新）
- Modify: `server/src/ai/evaluate.test.ts`（テストダブルに title）
- Modify: `server/src/handlers.evaluation.test.ts`（テストダブルに title）
- Modify: `server/src/roomStore.test.ts`（PlayerScore リテラルに title）

**Interfaces:**
- Produces:
  - `PlayerScore` に `title: string`（必須）
  - `parseScores(text: string, expectedNames: string[]): PlayerScore[]` は各要素の `title` を埋める（正常時=モデルの `title` を文字列化、欠落/プレースホルダ時=`'—'` または `''`）
  - `SCORE_SCHEMA` の各 score item に `title: { type: 'string' }`（`required` に `'title'`）

- [ ] **Step 1: 失敗するテストを書く（scoreGen.test.ts）**

`server/src/ai/scoreGen.test.ts` の**既存**スキーマテストを次の内容に置き換える（title を含み、maxLength/minLength も含まないことを追加）:

```ts
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
```

同ファイル末尾に title の抽出／プレースホルダのテストを追加:

```ts
test('parseScores は title を抽出する', () => {
  const text = JSON.stringify({
    scores: [{ playerName: 'A', acting: 5, emotion: 3, kojirase: 4, comment: 'c', title: '激情型アクター' }],
  })
  const s = parseScores(text, ['A'])
  assert.equal(s[0].title, '激情型アクター')
})
```

さらに**既存**の「parseScores は人数分返らなくてもプレースホルダで全員ぶん返す」テスト（`playerName: 'B'` がプレースホルダになるケース）に、プレースホルダの title を検証する1行を追加する（`const b = s.find(x => x.playerName === 'B')!` の直後）:

```ts
  assert.equal(b.title, '—') // プレースホルダの称号は中立表記
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `cd server && npm test`
Expected: 新規/更新した title 系アサーションが FAIL（`title` が未実装で `undefined`／スキーマに `title` が無い）。既存テストは PASS のまま。

- [ ] **Step 3: shared 型に title を追加**

`shared/types.ts` の `PlayerScore` を変更:

```ts
export interface PlayerScore {
  playerName: string
  acting: number
  emotion: number
  kojirase: number
  comment: string
  title: string
}
```

- [ ] **Step 4: SCORE_SCHEMA に title を追加**

`server/src/ai/scoreGen.ts` の `SCORE_SCHEMA` の score item を変更（`properties` に `title`、`required` に `'title'`）:

```ts
        properties: {
          playerName: { type: 'string' },
          acting: { type: 'integer' },
          emotion: { type: 'integer' },
          kojirase: { type: 'integer' },
          comment: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['playerName', 'acting', 'emotion', 'kojirase', 'comment', 'title'],
```

- [ ] **Step 5: SYSTEM プロンプトを刷新**

`server/src/ai/scoreGen.ts` の `const SYSTEM = ...`（現状の文字列連結）を次のテンプレートリテラルで置き換える:

```ts
const SYSTEM = `あなたはバラエティ番組の辛口お笑いホストの審査員です。各プレイヤーの担当役・台本の台詞と、実際の発話（文字起こし）を照合し、テンポよくイジりながら採点します。

【語り口・ガードレール】イジりには愛を込め、各プレイヤーに必ず1つは本気で褒める点を入れてください。イジる対象は「演技の中身」だけにし、声質・容姿・人格そのものへの攻撃や、差別的・下品な表現は禁止です。

【採点】演技力・感情表現・こじらせ度を各1〜5の整数で採点します。1〜5の全域を使い、全員が3〜4に固まる団子採点を避けてください。
- 演技力: 声の張り・キャラの一貫性・台詞の説得力。1=棒読みや聞き取れない、3=普通に演じている、5=引き込まれる名演。
- 感情表現: 喜怒哀楽の起伏・声の抑揚・感情の乗り。1=無感情で平板、3=そこそこ感情が乗る、5=感情が爆発して伝わる。
- こじらせ度（＝恥を捨てた振り切り度）: オーバーさ・本気度・恥のかなぐり捨て具合。1=淡々と棒立ち、3=そこそこノっている、5=完全に振り切って恥を捨てている。

【アドリブ・台本からの逸脱】役や世界観に沿って振り切っているほど加点材料です（特にこじらせ度）。ただし支離滅裂で世界観を壊すものは評価しません。

【発話が空の場合】聞き取れなかった扱いで各項目を最低点(1)にし、辛口ホスト調でその旨をコメントに書いてください。

【comment】2〜3文の日本語。可能な限り実際の発話や場面に具体的に触れてください（例：「あの『諦めないで』の絶叫だけは本物」）。

【title（称号）】その人の演技の特徴を捉えた短い称号（12文字程度まで）を1つ付けてください。アワード風（例：「感情爆発賞」「本日の大根役者」「MVP」）でも、キャラ描写風（例：「激情型アクター」「悲劇の主人公タイプ」「闇落ち演技職人」）でも構いません。全員で重複させないでください。

各プレイヤーの playerName は与えられた名前を一字一句そのまま使い、全プレイヤーをちょうど1件ずつ含めてください。出力は必ず与えられた JSON スキーマに厳密に従ってください。`
```

- [ ] **Step 6: RawScore と parseScores に title を追加**

`server/src/ai/scoreGen.ts` の `RawScore` 型に `title` を追加:

```ts
type RawScore = { playerName?: string; acting?: unknown; emotion?: unknown; kojirase?: unknown; comment?: unknown; title?: unknown }
```

`parseScores` のプレースホルダ return を変更（`title: '—'` 追加）:

```ts
    if (!s) {
      return { playerName: name, acting: 1, emotion: 1, kojirase: 1, comment: 'AIの採点を取得できませんでした。', title: '—' }
    }
```

`parseScores` の正常 return を変更（`title` 追加）:

```ts
    return {
      playerName: name,
      acting: clampScore(s.acting),
      emotion: clampScore(s.emotion),
      kojirase: clampScore(s.kojirase),
      comment: String(s.comment ?? ''),
      title: String(s.title ?? ''),
    }
```

- [ ] **Step 7: スタブに title を追加**

`server/src/ai/scoreStub.ts` の `generateStubScores` の返却リテラルに `title` を追加:

```ts
    comment: `「${name}」の演技をAIが講評しました。（スタブ）`,
    title: '演技派（スタブ）',
```

- [ ] **Step 8: サーバーのテストダブル PlayerScore リテラルに title を追加（tsc 網羅のため）**

いずれも `PlayerScore[]` を返す/代入するテスト用リテラル。`comment: ...` の直後に `title: '...'` を足す。

`server/src/ai/evaluate.test.ts`:
- 該当行（`acting: 3, ... comment: t.text || '（無音）'`）→ 末尾に `, title: 'スタブ称号'`
- 該当行（`acting: 4, ... comment: 'ok'`）→ 末尾に `, title: 'スタブ称号'`

`server/src/handlers.evaluation.test.ts`:
- `comment: \`${name}講評\`` の行 → 末尾に `, title: '称号' `
- `comment: 'x'` の行 → 末尾に `, title: '称号'`
- `comment: 'late'` の行 → 末尾に `, title: '称号'`

`server/src/roomStore.test.ts`:
- `room.scores = [{ playerName: 'ホスト', acting: 3, emotion: 3, kojirase: 3, comment: 'x' }]` → `comment: 'x'` の後に `, title: '称号'`

（注: `scoreGen.test.ts` 内の `JSON.stringify({ scores: [...] })` の中身は「モデルの生出力を模した JSON 文字列」であり `PlayerScore` 型リテラルではないので **title 追加は不要**。parseScores が既定値で埋める。）

- [ ] **Step 9: テストと型チェックを実行して通過を確認**

Run: `cd server && npm test`
Expected: 全テスト PASS（title 系も含む）。

Run: `cd server && npx tsc --noEmit`
Expected: 型エラー無し（全 `PlayerScore` リテラルに title が揃っている）。

- [ ] **Step 10: コミット**

```bash
git add shared/types.ts server/src/ai/scoreGen.ts server/src/ai/scoreStub.ts server/src/ai/scoreGen.test.ts server/src/ai/evaluate.test.ts server/src/handlers.evaluation.test.ts server/src/roomStore.test.ts
git commit -m "feat: 採点プロンプトを辛口ホスト＋3軸ルーブリックに刷新し称号(title)を追加（サーバー）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: フロントエンド（scoreCard＋ResultScreen に称号表示）

**Files:**
- Modify: `client/src/scoreCard.ts`（`RoomCardData`/`PersonalCardData` に title・描画）
- Modify: `client/src/screens/ResultScreen.tsx`（一覧に称号表示・カードデータに title を渡す）

**Interfaces:**
- Consumes: Task 1 の `PlayerScore.title`（`client/src/types.ts` 経由で参照可能）。
- Produces: `RoomCardData.ranked[].title`・`PersonalCardData.title`（描画に使用）。

- [ ] **Step 1: scoreCard のデータ型に title を追加**

`client/src/scoreCard.ts` の `RoomCardData.ranked` と `PersonalCardData` に title を追加:

```ts
export interface RoomCardData {
  genre: string
  ranked: { name: string; acting: number; emotion: number; kojirase: number; total: number; title: string }[]
  winner: string | null
  leftPlayers: string[]
}

export interface PersonalCardData {
  genre: string
  name: string
  role: string
  rank: number
  total: number
  acting: number
  emotion: number
  kojirase: number
  comment: string
  title: string
}
```

- [ ] **Step 2: renderRoomCard に称号を描画**

`client/src/scoreCard.ts` の `renderRoomCard` 内、名前を描く `g.fillText(\`${medal} ${r.name}\`, 56, cy, 380)` の直後に、称号を名前の下に小さく描く（行が詰まる大人数では省略）:

```ts
    g.fillText(`${medal} ${r.name}`, 56, cy, 380)
    if (r.title && rowH >= 84) {
      g.fillStyle = accent
      g.font = '20px sans-serif'
      g.fillText(r.title, 92, cy + 28, 360)
    }
```

- [ ] **Step 3: renderPersonalCard に称号を描画**

`client/src/scoreCard.ts` の `renderPersonalCard` 内、`g.fillText(\`${data.rank}位 ・ 合計 ${data.total}点\`, SIZE / 2, y + 156)` の直後に称号バッジを追加:

```ts
  g.fillText(`${data.rank}位 ・ 合計 ${data.total}点`, SIZE / 2, y + 156)
  if (data.title) {
    g.fillStyle = accent
    g.font = 'bold 40px sans-serif'
    g.fillText(`「${data.title}」`, SIZE / 2, y + 210, SIZE - 120)
  }
```

- [ ] **Step 4: ResultScreen のカードデータに title を渡す**

`client/src/screens/ResultScreen.tsx` の `shareRoom` の `ranked` map に title を追加:

```ts
    const ranked = sorted.map(r => ({
      name: r.playerName,
      acting: r.acting,
      emotion: r.emotion,
      kojirase: r.kojirase,
      total: total(r),
      title: r.title,
    }))
```

`shareMine` の `renderPersonalCard({...})` 呼び出しに title を追加（`comment: me.comment,` の直後）:

```ts
      comment: me.comment,
      title: me.title,
```

- [ ] **Step 5: ResultScreen の一覧に称号を表示**

`client/src/screens/ResultScreen.tsx` の各プレイヤー行、`{r.playerName}...</p>`（合計点の `<p>` の直前）に称号バッジを追加:

```tsx
                  <p className="font-bold text-slate-900">
                    {r.playerName}
                    {isMe && <span className="text-purple-500 text-sm font-normal ml-1">（あなた）</span>}
                  </p>
                  {r.title && <p className="text-amber-600 text-xs font-bold">🏅 {r.title}</p>}
                  <p className="text-slate-400 text-xs">合計 {total(r)} 点</p>
```

- [ ] **Step 6: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` 成功（`RoomCardData.ranked`/`PersonalCardData` に title 必須になったので、渡し漏れがあれば tsc が検出。無ければ clean）。

- [ ] **Step 7: コミット**

```bash
git add client/src/scoreCard.ts client/src/screens/ResultScreen.tsx
git commit -m "feat: 結果画面とスコアカードに称号(title)を表示

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 実キー2タブ目視確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: dev サーバー起動**

server（`npm --prefix server run dev`）と client（`npm --prefix client run dev`）を起動。ブラウザ2タブ（localhost:5173）でホスト＋ゲストを作り、1ゲーム最後まで（録音→評価→結果）進める。実キー（`GROQ_API_KEY`＋`ANTHROPIC_API_KEY`）が必要。

- [ ] **Step 2: 講評の質を確認**

結果画面で各プレイヤーに、辛口お笑いホスト調のコメント（各人1つは本気で褒める）・称号（アワード風/キャラ描写風）が出ること、各軸が1〜5の全域に散り団子採点になっていないことを確認。

- [ ] **Step 3: 称号の表示を確認**

結果一覧に🏅称号が出る／「みんなの結果をシェア」ルームカードと「自分の結果をシェア」個人カードに称号が描画されることを確認（カード見た目は Phase D 合意どおり暫定）。

- [ ] **Step 4: 退出者・空発話の端ケース**

録音中に1人退出／無音のプレイヤーがいる場合でも、結果が必ず全員ぶん出る（fail-open）・空発話は最低点＋ホスト調コメントになることを確認。

---

## 完了条件

- サーバー全テスト PASS ＋ `server` の `npx tsc --noEmit` clean。
- `client` の `npm run build` clean。
- 2タブ実キー目視で辛口ホスト講評＋称号が出て、団子採点でなく、退出/空発話でも全員ぶん結果が出る。
