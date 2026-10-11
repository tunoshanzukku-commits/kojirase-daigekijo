# 昭和レトロUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ロビー以降の6画面と共通部品2つを、仕様を一切変えずに昭和レトロの見た目へ載せ替える。

**Architecture:** 色と部品を `tailwind.config.js` と `index.css` に集約してから各画面を載せ替える。ジャンルの差し色は `App.tsx` が CSS変数 `--genre` に流し、各画面は `var(--genre)` を見るだけでジャンルを知らない。地は全画面 `bg-washi` で統一し、`GENRE_BG`（8つのグラデ）は `GENRE_ACCENT`（8つの差し色）に置き換える。

**Tech Stack:** React 18 / TypeScript / Vite / Tailwind CSS 3

**Spec:** `docs/superpowers/specs/2026-08-22-showa-retro-ui-design.md`

## Global Constraints

- **仕様を変えない。** 画面遷移・イベント契約・状態管理・条件分岐には一切触らない。
- **`rounded-*` は使わない。** 角丸は全廃。例外は検印（`rounded-full`）のみ。
- **リアクション（👏😂🔥😍💪）とBGM/SE（🎻👻🎵⚔️🥁💥🎉😱🤣🔔）の絵文字は残す。** 前者は `shared/constants.ts` の `EMOJIS` で定義された仕様、後者は操作ラベル。
- **`★` は残す。** 5段階評価の表示で、昭和の印刷物にも存在する記号。
- 検証は `client/` で `npm run build`（`tsc && vite build`）と `npm test`（xShare の6件）。
- コミットメッセージは日本語。末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

### 置換対応表（全タスク共通）

この表が置換の正である。画面ごとに判断せず、必ずこの表に従う。

| 置換前 | 置換後 |
|---|---|
| `bg-white/80 backdrop-blur rounded-2xl shadow-sm border border-sky-100`（および類似のカード） | `washi-panel` |
| `bg-white rounded-2xl shadow-lg border border-sky-100` | `washi-panel` |
| `bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-*`（主操作） | `btn-sumi` |
| `bg-white hover:bg-sky-50 text-slate-700 font-bold rounded-* border border-sky-200`（副操作） | `btn-outline` |
| `bg-red-500 hover:bg-red-400 text-white ...` / `text-red-400`（破壊的操作） | `btn-shu` |
| `bg-sky-50 ... rounded-xl focus:ring-purple-400`（入力欄） | `field` |
| `border-t border-sky-100` / `border-sky-200`（区切り） | `rule` |
| `text-slate-900` / `text-slate-700` | `text-sumi` |
| `text-slate-500` / `text-slate-400` | `text-usuzumi` |
| `text-red-500` / `text-red-600`（エラー文言） | `text-shu` |
| `text-sky-600` / `text-purple-500`（強調文言） | `text-[color:var(--genre)]` |
| `bg-sky-50` / `bg-slate-100`（淡い地） | `bg-kinari` |
| `text-amber-600`（ト書き） | `text-usuzumi` |

---

### Task 1: トークン・共通クラス・差し色の土台

**Files:**
- Modify: `client/tailwind.config.js`
- Modify: `client/src/index.css`
- Modify: `client/src/genreStyles.ts`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Produces: Tailwind の色 `sumi` `usuzumi` `shu` `kinari` `kei` `washi`／共通クラス `.washi-panel` `.washi-band` `.btn-sumi` `.btn-outline` `.btn-shu` `.field` `.rule` `.seal`／`GENRE_ACCENT: Record<string, string>`／CSS変数 `--genre`
- Consumes: 既存の `.bg-washi`（トップ画面で導入済み）

- [ ] **Step 1: トークンを足す**

`client/tailwind.config.js` の `colors` を差し替える。`sumi` `shu` `kinari` は既にあるので、`usuzumi` `kei` `washi` を追加する。

```js
      colors: {
        sumi: '#241c17',
        usuzumi: '#6b5f52',
        shu: '#b8352c',
        kinari: '#f7f1e3',
        kei: '#cdbfa4',
        washi: '#f0e7d2',
      },
```

- [ ] **Step 2: 共通クラスを足す**

`client/src/index.css` の末尾に追加する。`@layer components` に置くことで Tailwind のユーティリティが後から上書きできる。

```css
@layer components {
  /* 昭和の印刷物に丸角は無い。角丸は全廃し、枠と帯で構造を作る。 */
  .washi-panel {
    @apply bg-kinari border border-sumi p-4;
  }
  /* 見出しの帯。地はジャンルの差し色（App が --genre に流す）。 */
  .washi-band {
    @apply inline-block px-4 py-1 text-kinari font-bold tracking-[0.18em];
    background: var(--genre, #241c17);
  }
  .btn-sumi {
    @apply w-full bg-sumi py-3 font-bold tracking-[0.12em] text-kinari
           transition-opacity hover:opacity-85 disabled:opacity-30;
  }
  .btn-outline {
    @apply w-full border-2 border-sumi py-3 font-bold tracking-[0.12em] text-sumi
           transition-colors hover:bg-sumi/5 disabled:opacity-30;
  }
  .btn-shu {
    @apply w-full bg-shu py-3 font-bold tracking-[0.12em] text-kinari
           transition-opacity hover:opacity-85 disabled:opacity-30;
  }
  .field {
    @apply w-full border border-sumi bg-kinari p-3 text-sumi outline-none
           placeholder-[#9a8a76] focus:ring-2 focus:ring-shu;
  }
  .rule {
    @apply border-t border-kei;
  }
  /* 検印。真円はここだけの例外。 */
  .seal {
    @apply grid place-items-center rounded-full border-2 border-shu
           font-display font-bold text-shu -rotate-[8deg];
  }
}
```

- [ ] **Step 3: ジャンルを差し色に置き換える**

`client/src/genreStyles.ts` を丸ごと差し替える。**8色とも生成り（`#f7f1e3`）の文字を載せてコントラスト比 4.5:1 以上を確保できる明度に採ってある。色を変えるときはこの下限を必ず確認すること。**

```ts
// ジャンルの差し色。帯・罫・強調文字の色として使う。
// 昭和の印刷物は紙が地で、色は差し色。全面グラデは当時の印刷では刷れない。
// 生成り(#f7f1e3)の文字を載せる前提なので、コントラスト比 4.5:1 を切る明るい色は選べない。
export const GENRE_ACCENT: Record<string, string> = {
  romance: '#9d4448', // 紅梅
  horror:  '#2f4550', // 藍鉄
  comedy:  '#8a6519', // 山吹
  jidai:   '#46603f', // 深緑
  sf:      '#3a4f7a', // 群青
  mystery: '#5f4c6b', // 葡萄鼠
  emotion: '#3f6b67', // 錆浅葱
  chaos:   '#b8352c', // 朱
}

/** ジャンル未選択（トップ・ロビー）では墨。 */
export const DEFAULT_ACCENT = '#241c17'
```

- [ ] **Step 4: App から差し色を流す**

`client/src/App.tsx` の `bg` 算出（`const bg = screen === 'top' ? ...` の行）とラッパーを差し替える。import も `GENRE_BG, DEFAULT_BG` から `GENRE_ACCENT, DEFAULT_ACCENT` に変える。

```tsx
  // 地は全画面わら半紙で統一。ジャンルは差し色として --genre に流し、
  // 各画面は var(--genre) を見るだけでジャンルを知らなくてよい。
  const accent = ctx.genre ? (GENRE_ACCENT[ctx.genre] ?? DEFAULT_ACCENT) : DEFAULT_ACCENT

  return (
    <div
      className="min-h-screen bg-washi text-sumi transition-colors duration-700"
      style={{ '--genre': accent } as React.CSSProperties}
    >
```

`React` の型が未 import なら `import type { CSSProperties } from 'react'` を足して `as CSSProperties` にする。

- [ ] **Step 5: App の解散ダイアログを載せ替える**

同じ `App.tsx` の `{dissolved && (` ブロックを差し替える。🚪 は外す（文言が既に説明している）。

```tsx
        <div className="fixed inset-0 z-[60] bg-sumi/60 flex items-center justify-center p-4">
          <div className="washi-panel text-center max-w-xs w-full">
            <p className="font-display font-bold text-sumi mb-4">ホストが退出したためルームが解散されました</p>
            <button onClick={resetToTop} className="btn-sumi">
              OK
            </button>
          </div>
        </div>
```

- [ ] **Step 6: ビルドとテストを通す**

Run: `cd client && npm run build`
Expected: exit 0。

Run: `cd client && npm test`
Expected: 6/6 pass。

- [ ] **Step 7: コミット**

```bash
git add client/tailwind.config.js client/src/index.css client/src/genreStyles.ts client/src/App.tsx
git commit -m "feat: 昭和レトロUIのトークンと共通クラスを用意する

色が各画面に直書きされているせいで、色を一つ変えるのに1,400行を触る
状態になっていた。墨・薄墨・朱・生成り・罫・わら半紙をトークンにし、
パネル・帯・ボタン・入力欄・罫・検印を共通クラスに集約する。

ジャンルは背景ではなく差し色で示す。App が --genre に流すので、
各画面は var(--genre) を見るだけでジャンルを知らなくてよい。
差し色8色は生成りの文字を載せてコントラスト比4.5:1以上を確保できる
明度に採ってある。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 共通部品（ConfirmDialog と Toast）

全画面に重なって出るので、画面本体より先に揃える。

**Files:**
- Modify: `client/src/components/ConfirmDialog.tsx`
- Modify: `client/src/components/Toast.tsx`

**Interfaces:**
- Consumes: Task 1 の `.washi-panel` `.btn-outline` `.btn-shu`、色 `sumi` `usuzumi` `shu` `kinari` `kei`
- Produces: なし（props も表示の条件も変えない）

- [ ] **Step 1: ConfirmDialog を載せ替える**

`return` の中身を差し替える。**props・`if (!open) return null`・`onConfirm`/`onCancel` の配線には触らない。**

```tsx
    <div className="fixed inset-0 z-[70] bg-sumi/60 flex items-center justify-center p-4">
      <div className="washi-panel text-center max-w-xs w-full">
        <p className="font-display font-bold text-sumi mb-2">{title}</p>
        <p className="text-usuzumi text-sm mb-5">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="btn-outline">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className="btn-shu">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
```

`btn-outline` と `btn-shu` は `w-full` を含むので、`flex gap-3` の中では両方が等幅に伸びる（従来の `flex-1` と同じ見え方になる）。

- [ ] **Step 2: Toast を載せ替える**

`ToastItem` の `className` だけ差し替える。`useEffect` のタイマー・`onDismiss` の配線には触らない。

```tsx
    <div
      className={`px-4 py-3 border text-sm font-medium ${
        tone === 'error'
          ? 'bg-kinari border-shu text-shu'
          : 'bg-kinari border-sumi text-sumi'
      }`}
      onClick={() => onDismiss(toast.id)}
    >
```

- [ ] **Step 3: ビルドとテストを通す**

Run: `cd client && npm run build`
Expected: exit 0。

Run: `cd client && npm test`
Expected: 6/6 pass。

- [ ] **Step 4: diff を自分で確認する**

Run: `git diff --stat client/src/components/`
Expected: 2ファイルのみ。`git diff client/src/components/` を読み、変更が `className` と JSX の見た目だけに収まっていることを確認する。ロジック行が変わっていたら戻す。

- [ ] **Step 5: コミット**

```bash
git add client/src/components/ConfirmDialog.tsx client/src/components/Toast.tsx
git commit -m "feat: 確認ダイアログとトーストを昭和レトロにする

全画面に重なって出る部品なので、画面本体より先に揃える。
角丸と影を外し、生成り地に墨の枠。破壊的操作は朱ベタにする。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: LobbyScreen

**Files:**
- Modify: `client/src/screens/LobbyScreen.tsx`

**Interfaces:**
- Consumes: Task 1 の全クラスとトークン
- Produces: なし

- [ ] **Step 1: 対応表どおりに載せ替える**

Global Constraints の置換対応表に従って `className` を置き換える。加えてこの画面固有の判断は次の3点。

1. **ルームコードの表示**を「演目札」の見立てにする。`washi-panel` の中に、墨地・生成り抜きでコードを大きく出す。角丸は使わない。
2. **参加者一覧**はカードの積み重ねをやめ、`rule` で区切った一覧にする。
3. **ジャンル選択ボタン**は、選択中だけ差し色ベタ（`style={{ background: 'var(--genre)' }}` と `text-kinari`）、未選択は `btn-outline` 相当の枠のみ。**ジャンルを選ぶと `--genre` が変わるので、選択中のボタンの色が自動で追従する。**

**`ctx` の参照・`actions` の呼び出し・`disabled` の条件式・`waitingForReturns` の算出には触らない。**

- [ ] **Step 2: ビルドとテストを通す**

Run: `cd client && npm run build`
Expected: exit 0。

Run: `cd client && npm test`
Expected: 6/6 pass。

- [ ] **Step 3: diff を自分で確認する**

Run: `git diff client/src/screens/LobbyScreen.tsx`
Expected: 変更が `className`・`style`・装飾JSXだけ。`onClick`・条件式・状態の参照が変わっていたら戻す。

- [ ] **Step 4: コミット**

```bash
git add client/src/screens/LobbyScreen.tsx
git commit -m "feat: ロビー画面を昭和レトロにする

ルームコードを演目札の見立てにし、参加者一覧は罫線区切りに。
ジャンル選択は選択中だけ差し色ベタで、--genre の切り替わりに追従する。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: CastingScreen と PrepareScreen

台本を見せる2画面。ト書きの記号だけ共通の判断が要るので同じタスクにまとめる。

**Files:**
- Modify: `client/src/screens/CastingScreen.tsx`
- Modify: `client/src/screens/PrepareScreen.tsx`

**Interfaces:**
- Consumes: Task 1 の全クラスとトークン
- Produces: なし

- [ ] **Step 1: 装飾絵文字を外す**

次の箇所を置き換える。行番号は着手時にずれている可能性があるので、文字列で探すこと。

| ファイル | 現在 | 置換後 |
|---|---|---|
| `CastingScreen.tsx:32` | `<div className="text-5xl mb-3">🎭</div>` | 削除し、直後の見出しを `washi-band` にする |
| `CastingScreen.tsx:63` | `🎭 {entry.action}` | `〔{entry.action}〕` |
| `CastingScreen.tsx:103` | `⚠️ 中断してロビーへ戻る` | `中断してロビーへ戻る` |
| `PrepareScreen.tsx:79` | `🎭 {entry.action}` | `〔{entry.action}〕` |
| `PrepareScreen.tsx:95` | `🎤 マイクが使えません` | `マイクが使えません` |
| `PrepareScreen.tsx:115` | `'🎤 マイクOK'` / `'🎤 マイクを確認中...'` | `'マイクOK'` / `'マイクを確認中…'` |
| `PrepareScreen.tsx:152` | `🎧 イヤホン推奨：…` | `イヤホン推奨：…`（文言はそのまま） |
| `PrepareScreen.tsx:206` | `'全員準備完了！録音開始 🎬'` | `'全員準備完了！録音開始'` |
| `PrepareScreen.tsx:220` | `⚠️ 中断してロビーへ戻る` | `中断してロビーへ戻る` |

**ト書きを `〔 〕` で囲むのは台本の組版の作法**で、絵文字を外した穴を記号で埋められる。

- [ ] **Step 2: 対応表どおりに載せ替える**

置換対応表に従って `className` を置き換える。加えてこの2画面固有の判断は次の2点。

1. **役名の見出し**（`CastingScreen.tsx:55` の `<h2>`）を `washi-band` にする。
2. **準備完了の状態**（PrepareScreen）は、準備できた人の名前の横に `seal` で朱の丸を出す。`seal` はサイズを持たないので `h-8 w-8 text-sm` のように併記する。

**`micStatus` の判定・`actions` の呼び出し・`allReady` の条件には触らない。**

- [ ] **Step 3: ビルドとテストを通す**

Run: `cd client && npm run build`
Expected: exit 0。

Run: `cd client && npm test`
Expected: 6/6 pass。

- [ ] **Step 4: diff を自分で確認する**

Run: `git diff client/src/screens/CastingScreen.tsx client/src/screens/PrepareScreen.tsx`
Expected: `className`・装飾JSX・上の表の文字列だけ。判定ロジックが変わっていたら戻す。

- [ ] **Step 5: コミット**

```bash
git add client/src/screens/CastingScreen.tsx client/src/screens/PrepareScreen.tsx
git commit -m "feat: 配役画面と準備画面を昭和レトロにする

ト書きを〔〕で囲む台本の組版に変え、装飾絵文字を外す。
役名は差し色の帯、準備完了は朱の検印で示す。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: EvaluatingScreen と ResultScreen

**Files:**
- Modify: `client/src/screens/EvaluatingScreen.tsx`
- Modify: `client/src/screens/ResultScreen.tsx`

**Interfaces:**
- Consumes: Task 1 の全クラスとトークン
- Produces: なし

- [ ] **Step 1: 順位を席の表現に置き換える**

`ResultScreen.tsx:16` の `const MEDALS = ['🥇', '🥈', '🥉']` を削除し、代わりに次を置く。`MAX_PLAYERS` は10なので十席まで用意する。

```tsx
// 「席」は落語や講談の演目を数える語。大劇場・大根役者選手権の見立てに合う。
const KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const seatLabel = (rank: number) => `第${KANJI[rank] ?? String(rank + 1)}席`
```

`ResultScreen.tsx:106` の `<span className="text-2xl">{MEDALS[rank] ?? '🎭'}</span>` を差し替える。

```tsx
                <span className="font-display text-sm font-bold text-kinari px-2 py-0.5" style={{ background: 'var(--genre)' }}>
                  {seatLabel(rank)}
                </span>
```

**`rank` の算出（`sorted.map((r, rank) =>`）には触らない。**

- [ ] **Step 2: 残りの装飾絵文字を外す**

| 現在 | 置換後 |
|---|---|
| `<div className="text-5xl mb-3">🏆</div>` | 削除し、直後の「演技結果発表！」を `washi-band` にする |
| `🥇 最優秀俳優賞` | `最優秀俳優賞`（帯そのものが賞状の見立てになる） |
| `🏅 {r.title}` | `{r.title}`（バッジは朱地・生成り抜きにする） |
| `<span className="text-2xl grayscale">🚪</span>` | 削除（「録音中に退出しました」の文言が既にある） |
| `🎧 自分の演技を聞く` | `自分の演技を聞く` |
| `音声を共有 🔗` | `音声を共有` |

- [ ] **Step 3: 対応表どおりに載せ替える**

置換対応表に従って `className` を置き換える。`★` は残す（5段階評価の表示）。`Stars` の `text-amber-400` は `text-shu`、`text-slate-200` は `text-kei` にする。

**`total` の算出・`sorted` の並べ替え・`hasMyScore` の判定・`shareRoom`/`shareMine`/`shareTake` の中身には触らない。**

- [ ] **Step 4: EvaluatingScreen を載せ替える**

置換対応表に従って `className` を置き換える。**演出（アニメーションと表示の切り替わり）には触らない。**

- [ ] **Step 5: ビルドとテストを通す**

Run: `cd client && npm run build`
Expected: exit 0。

Run: `cd client && npm test`
Expected: 6/6 pass。`xShare` の投稿文は変えていないので6件とも通る。

- [ ] **Step 6: diff を自分で確認する**

Run: `git diff client/src/screens/EvaluatingScreen.tsx client/src/screens/ResultScreen.tsx`
Expected: `className`・装飾JSX・`MEDALS` → `KANJI`/`seatLabel` の置き換えだけ。共有処理や採点の参照が変わっていたら戻す。

- [ ] **Step 7: コミット**

```bash
git add client/src/screens/EvaluatingScreen.tsx client/src/screens/ResultScreen.tsx
git commit -m "feat: 採点中画面と結果画面を昭和レトロにする

順位を🥇🥈🥉から「第一席」に置き換える。「席」は落語や講談の演目を
数える語で、大劇場の見立てに合う。従来は4位以降が🎭にフォールバック
していたので、漢数字で十席まで欠けなく出すようにした。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: RecordingScreen

427行と突出しているので単独。**リアクションとBGM/SEの絵文字は残す**のがこの画面の要点。

**Files:**
- Modify: `client/src/screens/RecordingScreen.tsx`

**Interfaces:**
- Consumes: Task 1 の全クラスとトークン
- Produces: なし

- [ ] **Step 1: 装飾絵文字だけ外す**

| 現在 | 置換後 |
|---|---|
| `⚠️ 接続が切れたため、この録音は記録されません`（`:215` 付近） | `接続が切れたため、この録音は記録されません` |
| `⚠️ 中断してロビーへ戻る`（`:270` 付近） | `中断してロビーへ戻る` |
| `🎤 声量`（`:382` 付近） | `声量` |

**`EMOJIS` を回しているリアクションボタンと、`BGM_IDS`/`SFX_IDS` のラベル（🎻👻🎵⚔️🥁💥🎉😱🤣🔔）は1つも外さない。** これらは仕様と操作ラベルである。

- [ ] **Step 2: 対応表どおりに載せ替える**

置換対応表に従って `className` を置き換える。加えてこの画面固有の判断は次の3点。

1. **RECタイマー**は墨地に生成りの文字。角なし。
2. **声量メーター**は `bg-kei` の溝に `bg-shu` のベタ塗り。角丸は使わない。
3. **リアクション／BGM／SEのボタン**は、絵文字とラベルを保ったまま枠だけ差し替える。未選択は墨の枠、選択中（BGM）は差し色ベタ＋`text-kinari`。

**`useEffect` のタイマー・Web Audio の配線・`actions` の呼び出し・録音状態の判定には一切触らない。** この画面は音声処理と同居しているので、ロジックに触れると採点まで壊れる。

- [ ] **Step 3: ビルドとテストを通す**

Run: `cd client && npm run build`
Expected: exit 0。

Run: `cd client && npm test`
Expected: 6/6 pass。

- [ ] **Step 4: diff を自分で確認する**

Run: `git diff client/src/screens/RecordingScreen.tsx`
Expected: `className`・`style`・上の表の文字列だけ。`useEffect`・`audioBus`・`recorder`・`actions` に関わる行が1行でも変わっていたら戻す。

- [ ] **Step 5: コミット**

```bash
git add client/src/screens/RecordingScreen.tsx
git commit -m "feat: 録音画面を昭和レトロにする

RECタイマーは墨地に生成り、声量メーターは朱のベタ塗り。
リアクションとBGM/SEの絵文字は仕様と操作ラベルなので1つも外さず、
枠と色だけ差し替えた。音声処理には一切触っていない。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 完了後の手動確認（ユーザー実施）

自動テストでは担保できない。実装完了後にユーザーへ依頼する。

1. **通しプレイ**でロビー→配役→準備→録音→採点→結果→ロビー復帰まで、操作が壊れていないこと
2. **昭和で通っていること**（水色や紫が残っている画面が無いか）
3. **ジャンルを2〜3種類試し、差し色の効き方を見る。** 8色すべてを机上で判断するのは無理があるので、実機で気になった色は `genreStyles.ts` の1箇所で調整する
4. **リアクションとBGM/SEが従来どおり動くこと**（絵文字を残した部分）
5. **確認ダイアログとトースト**が昭和になっていること（解散・中断・キックで出る）
