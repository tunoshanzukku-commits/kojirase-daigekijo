# Phase D SNSシェア Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ResultScreen の死にボタン「結果をシェアする🔗」を、スコアカード画像（Canvas 生成）を Web Share API で共有／ダウンロードできる本物のシェア機能に置き換える。

**Architecture:** 完全にクライアント内で完結する（`server/` `shared/` 変更なし・追加 npm 依存なし）。描画は `scoreCard.ts`（オフスクリーン Canvas → Blob）に隔離し、共有は `share.ts`（Web Share API＋ダウンロードフォールバック）に分離。ResultScreen は既存の `ctx` からカードデータを組み立ててこの2モジュールを呼ぶだけ。

**Tech Stack:** React 18 + Vite + TypeScript（strict）/ Canvas 2D / Web Share API（いずれもブラウザ標準・依存追加なし）

## Global Constraints

- **完全にクライアント内で完結**。`server/` `shared/` は変更しない。**npm 依存の追加もしない**（Canvas・Web Share・File・Blob・URL は全てブラウザ標準）。
- **カードの「内容と見た目」は暫定**（後日ユーザーが仕様変更予定）。描画ロジックは `scoreCard.ts` に閉じ込め、`ResultScreen`・`share.ts` に内容/レイアウトを漏らさない。共有の仕組み（`share.ts`）は変更対象ではない。
- 画像は **1080×1080 の PNG**（`image/png`）。
- 共有: `navigator.canShare?.({ files: [file] })` が真なら `navigator.share({ files, text })`、それ以外は**ダウンロードにフォールバック**。`navigator.share` の **`AbortError`（ユーザーのキャンセル）は握り潰す**。Web Share は **HTTPS/localhost 専用**（非セキュアコンテキストではダウンロードに落ちる）。
- クライアントは **TS strict ＋ `noUnusedLocals` ＋ `noUnusedParameters` ＋ `noFallthroughCasesInSwitch`**。未使用の変数・引数を残さないこと。`canvas.getContext('2d')` と `canvas.toBlob` の **null を必ずガード**する。
- **クライアントにテストフレームワークは無い**。各タスクの検証は **`cd client && npm run build`（`tsc && vite build`）が clean であること**。DOM/Canvas のユニットテストは足さない。振る舞いは Task 4 の実機/2タブ目視で確認する。
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。作業ブランチ `feature/phase-d-sns-share`（作成済み）。

## File Structure

| ファイル | 責務 |
|---|---|
| `client/src/share.ts` (create) | `shareOrDownload` — Web Share API 優先・非対応/非セキュアはダウンロード・AbortError 握り潰し |
| `client/src/scoreCard.ts` (create) | `renderRoomCard` / `renderPersonalCard`（Canvas 描画）・`canvasToBlob`。**カード内容はここに隔離** |
| `client/src/screens/ResultScreen.tsx` (modify) | 死にボタンを2シェアボタンに置換・`ctx` からカードデータ組み立て・上記2モジュールを呼ぶ |

---

### Task 1: share.ts（Web Share ＋ ダウンロードフォールバック）

**Files:**
- Create: `client/src/share.ts`

**Interfaces:**
- Consumes: なし（ブラウザ標準 `navigator`/`File`/`Blob`/`URL`/`document`）
- Produces: `shareOrDownload(blob: Blob, filename: string, text: string): Promise<void>`

**Note:** クライアントにテストは無い。検証は `npm run build`。

- [ ] **Step 1: Create share.ts**

`client/src/share.ts` を新規作成:

```ts
// クライアント生成画像の共有。Web Share API（画像を OS の共有シートへ渡す）を優先し、
// 非対応ブラウザや非セキュアコンテキスト（HTTPS/localhost 以外）ではダウンロードに
// フォールバックする。Web Share は getUserMedia と同じくセキュアコンテキスト必須。
export async function shareOrDownload(
  blob: Blob,
  filename: string,
  text: string,
): Promise<void> {
  const file = new File([blob], filename, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text })
      return
    } catch (err) {
      // ユーザーがキャンセルした場合は AbortError。エラー表示せず終了する。
      if (err instanceof DOMException && err.name === 'AbortError') return
      // それ以外（共有シート起動失敗など）はダウンロードにフォールバックする。
      console.warn('[share] Web Share に失敗しました。ダウンロードにフォールバックします', err)
    }
  }
  downloadBlob(blob, filename)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 2: Verify the client builds**

Run: `cd client && npm run build`
Expected: PASS — `tsc` 型エラーなし、`vite build` が `✓ built in ...` で完了。

- [ ] **Step 3: Commit**

```bash
git add client/src/share.ts
git commit -m "$(cat <<'EOF'
feat: 画像共有ユーティリティ share.ts（Web Share＋DLフォールバック）

navigator.canShare で feature-detect し、可なら共有シートへ画像を渡す。
非対応/非セキュアコンテキストはダウンロード。キャンセルの AbortError は握り潰す。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: scoreCard.ts（Canvas でスコアカード描画）

**Files:**
- Create: `client/src/scoreCard.ts`

**Interfaces:**
- Consumes: `GENRES` from `@shared/constants`
- Produces:
  - `interface RoomCardData { genre: string; ranked: { name: string; acting: number; emotion: number; kojirase: number; total: number }[]; winner: string | null; leftPlayers: string[] }`
  - `interface PersonalCardData { genre: string; name: string; role: string; rank: number; total: number; acting: number; emotion: number; kojirase: number; comment: string }`
  - `renderRoomCard(data: RoomCardData): HTMLCanvasElement`
  - `renderPersonalCard(data: PersonalCardData): HTMLCanvasElement`
  - `canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob>`

**Note:** カードの見た目は暫定（後日仕様変更）。ここに描画を隔離し、他ファイルに漏らさない。実際の見た目は Task 4 の目視で微調整する前提。テストは無し（`npm run build` で検証）。

- [ ] **Step 1: Create scoreCard.ts**

`client/src/scoreCard.ts` を新規作成:

```ts
import { GENRES } from '@shared/constants'

const SIZE = 1080

// Canvas 用のジャンル別アクセント色（tailwind の GENRE_BG は class 文字列で
// canvas に使えないため、hex を別途持つ）。
const GENRE_ACCENT: Record<string, string> = {
  romance: '#ec4899',
  horror: '#ef4444',
  comedy: '#65a30d',
  jidai: '#f59e0b',
  sf: '#6366f1',
  mystery: '#64748b',
  emotion: '#8b5cf6',
  chaos: '#d946ef',
}
const DEFAULT_ACCENT = '#0ea5e9'

export interface RoomCardData {
  genre: string
  ranked: { name: string; acting: number; emotion: number; kojirase: number; total: number }[]
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
}

function accentFor(genre: string): string {
  return GENRE_ACCENT[genre] ?? DEFAULT_ACCENT
}

function genreMeta(genre: string): { label: string; emoji: string } {
  const g = GENRES.find(x => x.id === genre)
  return { label: g?.label ?? genre, emoji: g?.emoji ?? '🎭' }
}

function createCanvas(): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const g = canvas.getContext('2d')
  if (!g) throw new Error('Canvas 2D コンテキストを取得できませんでした')
  return { canvas, g }
}

// 背景＋ヘッダー（ブランド・見出し・ジャンル）を描き、本文の開始 Y を返す。
function drawFrame(g: CanvasRenderingContext2D, genre: string, heading: string): number {
  const accent = accentFor(genre)
  const { label, emoji } = genreMeta(genre)
  g.fillStyle = '#fdfbf7'
  g.fillRect(0, 0, SIZE, SIZE)
  g.fillStyle = accent
  g.fillRect(0, 0, SIZE, 24)
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#94a3b8'
  g.font = '28px sans-serif'
  g.fillText('AI × 芝居ゲーム', SIZE / 2, 96)
  g.fillStyle = '#0f172a'
  g.font = 'bold 60px sans-serif'
  g.fillText(heading, SIZE / 2, 176)
  g.fillStyle = accent
  g.font = 'bold 40px sans-serif'
  g.fillText(`${emoji} ${label}`, SIZE / 2, 240)
  return 312
}

// 左上 (x,y) から★を5つ。n 個を accent、残りを薄色で描く。
function drawStars(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  n: number,
  starSize: number,
  accent: string,
): void {
  g.font = `${starSize}px sans-serif`
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  for (let i = 0; i < 5; i++) {
    g.fillStyle = i < n ? accent : '#e2e8f0'
    g.fillText('★', x + i * (starSize * 1.05), y)
  }
}

// maxWidth に収まるよう文字単位で折り返す（日本語はスペースが無いため文字単位）。
function wrapText(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line)
      line = ''
      continue
    }
    const test = line + ch
    if (line !== '' && g.measureText(test).width > maxWidth) {
      lines.push(line)
      line = ch
    } else {
      line = test
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

export function renderRoomCard(data: RoomCardData): HTMLCanvasElement {
  const { canvas, g } = createCanvas()
  const accent = accentFor(data.genre)
  let y = drawFrame(g, data.genre, '🏆 演技結果発表！')

  if (data.winner) {
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    g.fillStyle = '#f59e0b'
    g.font = 'bold 34px sans-serif'
    g.fillText(`🥇 最優秀俳優賞  ${data.winner}`, SIZE / 2, y, SIZE - 120)
    y += 64
  }

  const count = data.ranked.length + data.leftPlayers.length
  const bottom = SIZE - 56
  const rowH = count > 0 ? Math.min(104, (bottom - y) / count) : 0

  data.ranked.forEach((r, i) => {
    const cy = y + i * rowH + rowH / 2
    const medal = ['🥇', '🥈', '🥉'][i] ?? '🎭'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = '#0f172a'
    g.font = 'bold 38px sans-serif'
    g.fillText(`${medal} ${r.name}`, 56, cy, 380)
    // 演技/感情/こじらせ を小さな★クラスタで（横並び）
    drawStars(g, 470, cy, r.acting, 26, accent)
    drawStars(g, 640, cy, r.emotion, 26, accent)
    drawStars(g, 810, cy, r.kojirase, 26, accent)
    g.textAlign = 'right'
    g.fillStyle = '#64748b'
    g.font = '30px sans-serif'
    g.fillText(`${r.total}点`, SIZE - 56, cy)
  })

  data.leftPlayers.forEach((name, j) => {
    const cy = y + (data.ranked.length + j) * rowH + rowH / 2
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = '#cbd5e1'
    g.font = 'bold 34px sans-serif'
    g.fillText(`🚪 ${name}（退出）`, 56, cy, SIZE - 112)
  })

  return canvas
}

export function renderPersonalCard(data: PersonalCardData): HTMLCanvasElement {
  const { canvas, g } = createCanvas()
  const accent = accentFor(data.genre)
  const y = drawFrame(g, data.genre, '🎭 わたしの演技結果')

  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  g.fillStyle = '#0f172a'
  g.font = 'bold 56px sans-serif'
  g.fillText(data.name, SIZE / 2, y + 40, SIZE - 120)
  if (data.role) {
    g.fillStyle = accent
    g.font = '32px sans-serif'
    g.fillText(`役：${data.role}`, SIZE / 2, y + 96, SIZE - 120)
  }
  g.fillStyle = '#64748b'
  g.font = 'bold 34px sans-serif'
  g.fillText(`${data.rank}位 ・ 合計 ${data.total}点`, SIZE / 2, y + 156)

  const rows: [string, number][] = [
    ['演技力', data.acting],
    ['感情', data.emotion],
    ['こじらせ度', data.kojirase],
  ]
  let ry = y + 240
  rows.forEach(([label, n]) => {
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = '#334155'
    g.font = '34px sans-serif'
    g.fillText(label, 96, ry)
    drawStars(g, 460, ry, n, 44, accent)
    ry += 86
  })

  // AIコメント（枠内で折り返し）
  const boxX = 80
  const boxW = SIZE - 160
  const boxY = ry + 20
  const boxH = SIZE - 56 - boxY
  g.fillStyle = '#f1f5f9'
  g.fillRect(boxX, boxY, boxW, boxH)
  g.textAlign = 'left'
  g.textBaseline = 'top'
  g.fillStyle = '#94a3b8'
  g.font = '24px sans-serif'
  g.fillText('AIコメント', boxX + 28, boxY + 24)
  g.fillStyle = '#334155'
  g.font = '30px sans-serif'
  const lines = wrapText(g, data.comment, boxW - 56)
  lines.slice(0, 6).forEach((line, i) => {
    g.fillText(line, boxX + 28, boxY + 72 + i * 44)
  })

  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (blob) resolve(blob)
        else reject(new Error('canvas.toBlob が null を返しました'))
      },
      'image/png',
    )
  })
}
```

- [ ] **Step 2: Verify the client builds**

Run: `cd client && npm run build`
Expected: PASS — 型エラーなし、`vite build` 完了。

- [ ] **Step 3: Commit**

```bash
git add client/src/scoreCard.ts
git commit -m "$(cat <<'EOF'
feat: スコアカード描画 scoreCard.ts（ルーム全体/自分の2種）

オフスクリーン Canvas に 1080x1080 で描画し Blob 化。ジャンル別アクセント色・
★クラスタ・コメント折り返しを実装。カード内容はこのモジュールに隔離
（後日の仕様変更を他ファイルに波及させない）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ResultScreen をシェア機能に配線

**Files:**
- Modify: `client/src/screens/ResultScreen.tsx`

**Interfaces:**
- Consumes: Task 1 `shareOrDownload`、Task 2 `renderRoomCard`/`renderPersonalCard`/`canvasToBlob`、`genreLabel` from `@shared/constants`
- Produces: なし

- [ ] **Step 1: Add imports**

`client/src/screens/ResultScreen.tsx` の先頭 import 群に追加:

```ts
import { genreLabel } from '@shared/constants'
import { renderRoomCard, renderPersonalCard, canvasToBlob } from '../scoreCard'
import { shareOrDownload } from '../share'
```

- [ ] **Step 2: Add the share handlers inside the component**

`export default function ResultScreen({ ctx, actions }: Props) {` の直後、既存の

```ts
  const sorted = [...ctx.scores].sort((a, b) => total(b) - total(a))
  const returnedCount = ctx.returnedPlayers.length
  const totalCount = ctx.players.length
```

の下に、ハンドラと自スコア有無を追加する:

```ts
  const hasMyScore = ctx.scores.some(r => r.playerName === ctx.playerName)

  async function shareRoom() {
    const ranked = sorted.map(r => ({
      name: r.playerName,
      acting: r.acting,
      emotion: r.emotion,
      kojirase: r.kojirase,
      total: total(r),
    }))
    const canvas = renderRoomCard({
      genre: ctx.genre,
      ranked,
      winner: sorted[0]?.playerName ?? null,
      leftPlayers: ctx.leftPlayers,
    })
    const blob = await canvasToBlob(canvas)
    await shareOrDownload(blob, 'ai-shibai-result.png', `AI×芝居ゲーム「${genreLabel(ctx.genre)}」の結果！ #AI芝居`)
  }

  async function shareMine() {
    const me = ctx.scores.find(r => r.playerName === ctx.playerName)
    if (!me) return
    const rank = sorted.findIndex(r => r.playerName === ctx.playerName) + 1
    const role = ctx.script?.roles.find(r => r.player === ctx.playerName)?.role ?? ''
    const canvas = renderPersonalCard({
      genre: ctx.genre,
      name: me.playerName,
      role,
      rank,
      total: total(me),
      acting: me.acting,
      emotion: me.emotion,
      kojirase: me.kojirase,
      comment: me.comment,
    })
    const blob = await canvasToBlob(canvas)
    await shareOrDownload(blob, 'ai-shibai-my-result.png', 'AI×芝居ゲームで演じてきた！ #AI芝居')
  }
```

- [ ] **Step 3: Replace the dead share button with two share buttons**

既存の（`{/* Actions */}` 内の）死にボタン:

```tsx
        <button className="w-full py-3 bg-sky-500 hover:bg-sky-400 text-white font-bold rounded-2xl transition-colors shadow-sm">
          結果をシェアする 🔗
        </button>
```

を次に置き換える:

```tsx
        <button
          onClick={() => { void shareRoom() }}
          className="w-full py-3 bg-sky-500 hover:bg-sky-400 text-white font-bold rounded-2xl transition-colors shadow-sm"
        >
          みんなの結果をシェア 🔗
        </button>
        {hasMyScore && (
          <button
            onClick={() => { void shareMine() }}
            className="w-full py-3 bg-purple-500 hover:bg-purple-400 text-white font-bold rounded-2xl transition-colors shadow-sm"
          >
            自分の結果をシェア 🔗
          </button>
        )}
```

- [ ] **Step 4: Verify the client builds**

Run: `cd client && npm run build`
Expected: PASS — 型エラーなし（未使用の変数・引数なし）、`vite build` 完了。

- [ ] **Step 5: Commit**

```bash
git add client/src/screens/ResultScreen.tsx
git commit -m "$(cat <<'EOF'
feat: ResultScreen にシェア機能を配線（みんな/自分の2ボタン）

死にボタンを撤去し、ctx からカードデータを組み立てて scoreCard→share を
呼ぶ「みんなの結果をシェア」「自分の結果をシェア」に置換。自スコアが
無い観戦者では自分ボタンを非表示。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 全体検証と実機/2タブ目視

**Files:** 変更なし（検証のみ。不具合が出た場合のみ該当ファイルを修正）

**Interfaces:**
- Consumes: Task 1〜3 のすべて

- [ ] **Step 1: Run the client build**

Run: `cd client && npm run build`
Expected: PASS — 型エラーなし、`vite build` 完了。

- [ ] **Step 2: Start both servers for manual verification**

```bash
cd server && npm run dev
```

```bash
cd client && npm run dev
```

Expected: server `[server] listening on 3001`、client `http://localhost:5173`。

- [ ] **Step 3: 目視チェックリスト（2タブ＋可能ならスマホ）**

1. 2タブでルーム作成→参加→開始→配役→準備完了→録音→終了 で結果画面まで進む（スタブスコアで可）。
2. **「みんなの結果をシェア 🔗」** を押す → PC（Web Share 非対応/デスクトップ Chrome 等）では `ai-shibai-result.png` がダウンロードされる。開いて **1080×1080 の正方形・ジャンル見出し・最優秀俳優賞・全員のランキング（★と合計点）** が描かれていること。
3. **「自分の結果をシェア 🔗」** を押す → `ai-shibai-my-result.png` がダウンロードされ、**自分の名前・役名・順位・3項目の★・AIコメント（折り返し）** が描かれていること。
4. 観戦者（自スコア無し）タブでは「自分の結果をシェア」ボタンが**非表示**であること。退出者がいる場合、ルームカードにグレーで「退出」表記が出ること。
5. **スマホ（HTTPS or localhost）で開けるなら**、シェア押下で **OS の共有シートが開き画像が渡る**こと。共有を**キャンセルしてもエラー（トースト等）が出ない**こと。
6. カードが極端に崩れないこと（長い名前は `maxWidth` で縮む・10人でも行が収まる）。崩れが目立つ場合のみ `scoreCard.ts` を調整（見た目は暫定仕様）。

- [ ] **Step 4: Stop the background servers**

手動確認後、起動中プロセスを停止する。

- [ ] **Step 5: Commit (only if fixes were needed)**

目視で不具合が出た場合のみ `scoreCard.ts` 等を修正してコミット:

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: 2タブ/実機目視で見つかったスコアカードの不具合を修正

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## 完了後

全タスク build clean かつ目視 OK なら、`superpowers:requesting-code-review` で opus の whole-branch レビューを受け、`superpowers:finishing-a-development-branch` で main へローカルマージ（fast-forward → マージ後 `npm run build` 再確認 → `git branch -d feature/phase-d-sns-share`）。

**注**: カードの内容・見た目は後日ユーザーが仕様変更予定。差し替えは `scoreCard.ts` に閉じる（`share.ts`・`ResultScreen` の配線は再利用できる）。
