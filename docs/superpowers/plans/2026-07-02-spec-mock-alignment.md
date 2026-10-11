# 仕様書・モック整合対応 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 評価で見つかった仕様書とモックの不整合を解消し、エラー/マイク許可/生成待ちのUIをモックに実装して動作確認する。

**Architecture:** モックは React + TypeScript (Vite) の7画面構成。App.tsx の useState でグローバル状態(GameContext)を管理し、NavigateFn で画面遷移する。バックエンドはまだ無いため、全データはモック定数。今回はハードコードの共通化(genres.ts / mockScript.ts)と画面修正、および doc/frontend仕様書.md の追記を行う。

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS

## Global Constraints

- 仕様の出典: `docs/superpowers/specs/2026-07-02-spec-mock-alignment-design.md`
- 自動テストは追加しない。各タスクの検証は `cd client && npm run build`(tsc + vite build)が成功すること
- 既存のデザインシステムに従う: カードは `bg-white/80 backdrop-blur rounded-2xl shadow-sm border border-sky-100`、プライマリ `bg-purple-600`、成功 `bg-emerald-600`、危険 `bg-red-500`
- 文言はすべて日本語(既存画面と同じトーン)
- コミットメッセージ末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: GENRES 定数の共通化(genres.ts 新設)

**Files:**
- Create: `client/src/genres.ts`
- Modify: `client/src/screens/LobbyScreen.tsx`(先頭の GENRES 定義を削除して import に置換)

**Interfaces:**
- Produces: `GENRES: Genre[]`(`{ id, label, emoji }`)、`genreLabel(id: string): string`(未知IDは `''` を返す)。Task 3・Task 7 が使用する。

- [ ] **Step 1: genres.ts を作成**

```typescript
// client/src/genres.ts
export interface Genre {
  id: string
  label: string
  emoji: string
}

export const GENRES: Genre[] = [
  { id: 'romance', label: '恋愛ドラマ', emoji: '💕' },
  { id: 'horror',  label: 'ホラー',     emoji: '👻' },
  { id: 'comedy',  label: 'コメディ',   emoji: '😂' },
  { id: 'jidai',   label: '時代劇',     emoji: '⚔️' },
  { id: 'sf',      label: 'SF・未来',   emoji: '🚀' },
  { id: 'mystery', label: 'ミステリー', emoji: '🔍' },
  { id: 'emotion', label: '感動・涙活', emoji: '😢' },
  { id: 'chaos',   label: 'カオスモード', emoji: '🌀' },
]

export function genreLabel(id: string): string {
  return GENRES.find(g => g.id === id)?.label ?? ''
}
```

- [ ] **Step 2: LobbyScreen.tsx のローカル GENRES を import に置換**

LobbyScreen.tsx 9〜18行目のローカル `const GENRES = [...]` ブロックを削除し、import に追加:

```typescript
import { GENRES } from '../genres'
```

- [ ] **Step 3: ビルド確認**

Run: `cd client && npm run build`
Expected: エラーなく完了(`✓ built in ...`)

- [ ] **Step 4: Commit**

```bash
git add client/src/genres.ts client/src/screens/LobbyScreen.tsx
git commit -m "refactor: GENRES定数をgenres.tsに共通化"
```

---

### Task 2: mockScript.ts にロール・世界観モックを追加

**Files:**
- Modify: `client/src/mockScript.ts`

**Interfaces:**
- Produces: `MOCK_WORLD: string`、`MOCK_ROLES: RoleInfo[]`(たろう/はなこ/けんじの3件)。Task 3 が使用する。既存の `FULL_SCRIPT`・`getMockPlayer` は変更しない。

- [ ] **Step 1: mockScript.ts の import を拡張し、定数を追加**

import 行を変更:

```typescript
import type { RoleInfo, ScriptEntry } from './types'
```

`getMockPlayer` の直後に追加:

```typescript
export const MOCK_WORLD =
  '江戸時代の城下町。ある夜、悪名高い盗賊団が宿場町を狙っている。旅人と住人が運命の夜に巻き込まれていく…'

export const MOCK_ROLES: RoleInfo[] = [
  {
    player: 'たろう',
    role: '浪人・孤高の剣士',
    description: '主家を失い流れ者となった侍。無骨だが心根は優しく、弱い者を放っておけない。',
  },
  {
    player: 'はなこ',
    role: '宿場の看板娘',
    description: '宿場町の旅籠で働く気立ての良い娘。芯が強く、いざという時は誰よりも勇敢。',
  },
  {
    player: 'けんじ',
    role: '盗賊団のボス',
    description: '宿場町を狙う盗賊団の頭目。冷酷に見えるが、その裏には哀しい過去を抱えている。',
  },
]
```

- [ ] **Step 2: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add client/src/mockScript.ts
git commit -m "feat: モックのロール情報・世界観をmockScript.tsに追加"
```

---

### Task 3: CastingScreen をモックデータ由来に書き換え

**Files:**
- Modify: `client/src/screens/CastingScreen.tsx`(全面書き換え)

**Interfaces:**
- Consumes: `getMockPlayer(isHost, playerName)`、`MOCK_ROLES`、`MOCK_WORLD`、`FULL_SCRIPT`(mockScript.ts)、`genreLabel(id)`(genres.ts)

- [ ] **Step 1: CastingScreen.tsx を以下の内容に置き換え**

ポイント: ハードコードの `WORLD`/`MY_ROLE`/`OTHER_ROLES` を廃止。自分の役は `getMockPlayer` → `MOCK_ROLES` から、セリフは `FULL_SCRIPT` からフィルタ。ジャンル表示は `genreLabel(ctx.genre)`(空なら「時代劇」にフォールバック — モック台本が時代劇のため)。

```tsx
import type { GameContext, NavigateFn } from '../App'
import { FULL_SCRIPT, MOCK_ROLES, MOCK_WORLD, getMockPlayer } from '../mockScript'
import { genreLabel } from '../genres'

interface Props {
  ctx: GameContext
  onNavigate: NavigateFn
}

export default function CastingScreen({ ctx, onNavigate }: Props) {
  const myPlayer = getMockPlayer(ctx.isHost, ctx.playerName)
  const myRole = MOCK_ROLES.find(r => r.player === myPlayer)
  const otherRoles = MOCK_ROLES.filter(r => r.player !== myPlayer)
  const myEntries = FULL_SCRIPT.filter(e => e.player === myPlayer)

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto pb-10">
      <div className="text-center py-6">
        <div className="text-5xl mb-3">🎭</div>
        <h1 className="text-2xl font-bold text-slate-900">配役発表！</h1>
        <p className="text-slate-500 text-sm mt-1">
          ジャンル：{genreLabel(ctx.genre) || '時代劇'}
        </p>
      </div>

      {/* World setting */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 shadow-sm border border-sky-100">
        <p className="text-amber-600 text-xs font-bold tracking-wider mb-2">世界観</p>
        <p className="text-slate-700 text-sm leading-relaxed">{MOCK_WORLD}</p>
      </div>

      {/* My role */}
      <div className="bg-purple-50 border border-purple-300 rounded-2xl p-5 mb-4">
        <div className="text-center mb-4">
          <p className="text-purple-600 text-xs font-bold tracking-wider mb-1">{ctx.playerName} の役</p>
          <h2 className="text-2xl font-bold text-slate-900">{myRole?.role}</h2>
        </div>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">{myRole?.description}</p>
        <p className="text-amber-600 text-xs font-bold mb-2">あなたのセリフ</p>
        <div className="space-y-2">
          {myEntries.map((entry, i) => (
            <div key={i} className="bg-white rounded-xl p-3 border border-purple-100">
              {entry.action && (
                <p className="text-amber-600 text-xs italic mb-1">🎭 {entry.action}</p>
              )}
              <p className="text-slate-800 text-sm leading-relaxed">「{entry.line}」</p>
            </div>
          ))}
        </div>
      </div>

      {/* Other players */}
      <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-6 shadow-sm border border-sky-100">
        <p className="font-bold mb-3 text-slate-600 text-sm">他のプレイヤーの役</p>
        <div className="space-y-2">
          {otherRoles.map((r, i) => (
            <div key={i} className="flex items-center gap-3 py-1">
              <div className="w-7 h-7 bg-slate-300 rounded-full flex items-center justify-center text-xs font-bold text-slate-700 flex-shrink-0">
                {r.player[0]}
              </div>
              <span className="text-slate-600 text-sm">{r.player}</span>
              <span className="text-slate-300 text-sm">／</span>
              <span className="text-slate-700 text-sm">{r.role}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={() => onNavigate('prepare')}
        className="w-full py-4 bg-purple-600 hover:bg-purple-500 text-white font-bold text-lg rounded-2xl transition-colors shadow-sm"
      >
        台本を読む →
      </button>
    </div>
  )
}
```

- [ ] **Step 2: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/CastingScreen.tsx
git commit -m "fix: 配役画面をモックデータ由来にしてゲスト時の役表示を修正"
```

---

### Task 4: RecordingScreen の START! を0.8秒表示

**Files:**
- Modify: `client/src/screens/RecordingScreen.tsx`(カウントダウン useEffect のみ)

- [ ] **Step 1: カウントダウン useEffect を修正**

現在(48〜53行目):

```tsx
useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown === 0) { setPhase('recording'); return }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown])
```

修正後(0のとき即遷移せず800ms待つ):

```tsx
useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown === 0) {
      const t = setTimeout(() => setPhase('recording'), 800)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown])
```

- [ ] **Step 2: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/RecordingScreen.tsx
git commit -m "fix: カウントダウンのSTART!を0.8秒表示してから録音フェーズへ"
```

---

### Task 5: ResultScreen を PlayerScore 型に統一

**Files:**
- Modify: `client/src/screens/ResultScreen.tsx`

**Interfaces:**
- Consumes: `PlayerScore`(types.ts — `playerName / acting / emotion / kojirase / comment`)

- [ ] **Step 1: 独自 PlayerResult 型を廃止し PlayerScore に置換**

- import に `import type { PlayerScore } from '../types'` を追加
- `interface PlayerResult { ... }`(8〜14行目)を削除
- `const RESULTS: PlayerResult[]` を `const MOCK_SCORES: PlayerScore[]` にリネームし、各要素の `name:` を `playerName:` に変更
- `const total = (r: PlayerResult) => ...` を `const total = (r: PlayerScore) => ...` に変更
- `const sorted = [...RESULTS]` を `const sorted = [...MOCK_SCORES]` に変更
- JSX 内の `sorted[0].name` → `sorted[0].playerName`、`r.name === ctx.playerName` → `r.playerName === ctx.playerName`、`key={r.name}` → `key={r.playerName}`、`{r.name}` → `{r.playerName}` に変更

- [ ] **Step 2: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/ResultScreen.tsx
git commit -m "refactor: 結果画面をtypes.tsのPlayerScore型に統一"
```

---

### Task 6: 共通 Toast コンポーネント新設

**Files:**
- Create: `client/src/components/Toast.tsx`

**Interfaces:**
- Produces: `ToastMessage { id: number; text: string; tone?: 'error' | 'info' }`、`ToastStack({ toasts, onDismiss })`(4秒で自動消滅)。Socket.io統合時にゲーム中の非同期エラー・ゲスト退出通知で使用する部品。

- [ ] **Step 1: Toast.tsx を作成**

```tsx
// client/src/components/Toast.tsx
import { useEffect } from 'react'

export interface ToastMessage {
  id: number
  text: string
  tone?: 'error' | 'info'
}

interface ItemProps {
  toast: ToastMessage
  onDismiss: (id: number) => void
}

function ToastItem({ toast, onDismiss }: ItemProps) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), 4000)
    return () => clearTimeout(t)
  }, [toast.id, onDismiss])

  const tone = toast.tone ?? 'info'
  return (
    <div
      className={`px-4 py-3 rounded-xl shadow-md border text-sm font-medium backdrop-blur ${
        tone === 'error'
          ? 'bg-red-50/95 border-red-200 text-red-600'
          : 'bg-white/95 border-sky-200 text-slate-700'
      }`}
      onClick={() => onDismiss(toast.id)}
    >
      {toast.text}
    </div>
  )
}

interface StackProps {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}

export default function ToastStack({ toasts, onDismiss }: StackProps) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 space-y-2 w-full max-w-sm px-4">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Toast.tsx
git commit -m "feat: 共通トーストコンポーネントを追加"
```

---

### Task 7: LobbyScreen に台本生成オーバーレイを追加

**Files:**
- Modify: `client/src/screens/LobbyScreen.tsx`

**Interfaces:**
- Consumes: `genreLabel(id)`(genres.ts、Task 1)

- [ ] **Step 1: 生成中状態とオーバーレイを追加**

import に `genreLabel` を追加(Task 1 で追加済みの行を拡張):

```typescript
import { GENRES, genreLabel } from '../genres'
```

state 追加(`confirmDisband` の下):

```tsx
const [generating, setGenerating] = useState(false)
```

生成開始ハンドラを追加し、「ゲームを開始する」ボタンの onClick を差し替え(モック: 2.5秒後に配役画面へ):

```tsx
const startGame = () => {
    if (!genre) return
    setGenerating(true)
    setTimeout(() => onNavigate('casting', { genre }), 2500)
  }
```

ボタン(既存の `onClick={() => onNavigate('casting', { genre: genre ?? '' })}`)を:

```tsx
<button
            onClick={startGame}
            disabled={!genre || generating}
            className="w-full py-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-bold text-lg rounded-2xl transition-colors shadow-sm"
          >
            ゲームを開始する
          </button>
```

コンポーネントの return 直下(ルート div の先頭)にオーバーレイ JSX を追加:

```tsx
{generating && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white/95 rounded-2xl p-8 shadow-lg border border-sky-100 text-center max-w-xs w-full">
            <div className="text-5xl mb-4">✍️🤖</div>
            <p className="font-bold text-lg text-slate-900 mb-1">AIが台本を執筆中...</p>
            <p className="text-slate-500 text-sm mb-6">ジャンル：{genreLabel(genre ?? '')}</p>
            <div className="w-8 h-8 mx-auto border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
          </div>
        </div>
      )}
```

注意: ルート div は `min-h-screen p-4 max-w-3xl mx-auto` のままで、オーバーレイはその内側先頭に置く(fixed なので配置上は問題ない)。

- [ ] **Step 2: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add client/src/screens/LobbyScreen.tsx
git commit -m "feat: ロビーに台本生成中オーバーレイを追加"
```

---

### Task 8: PrepareScreen にマイク許可フローを追加

**Files:**
- Modify: `client/src/screens/PrepareScreen.tsx`

- [ ] **Step 1: マイク許可の状態管理と取得処理を追加**

import に `useCallback` を追加:

```typescript
import { useState, useEffect, useCallback } from 'react'
```

コンポーネント内(既存 state の下)に追加:

```tsx
type MicStatus = 'pending' | 'granted' | 'denied'
```

(型はコンポーネント外・ファイル上部の定数群の近くに置く)

```tsx
const [micStatus, setMicStatus] = useState<MicStatus>('pending')

  const requestMic = useCallback(async () => {
    setMicStatus('pending')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
      setMicStatus('granted')
    } catch {
      setMicStatus('denied')
    }
  }, [])

  useEffect(() => { requestMic() }, [requestMic])
```

- [ ] **Step 2: マイク状態UIを追加し、準備完了ボタンを連動**

準備状況パネルの上(台本カードの直後)にマイク状態カードを追加:

```tsx
{/* マイク許可状態 */}
      {micStatus === 'denied' ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 mb-4">
          <p className="text-red-600 text-sm font-bold mb-1">🎤 マイクが使えません</p>
          <p className="text-red-500 text-xs leading-relaxed mb-3">
            録音にはマイクの許可が必要です。ブラウザのアドレスバーからマイクを許可して、再試行してください。
          </p>
          <button
            onClick={requestMic}
            className="w-full py-2 bg-red-500 hover:bg-red-400 text-white font-bold rounded-xl text-sm transition-colors"
          >
            マイク許可を再試行
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-4 px-1">
          <span
            className={`text-xs px-2 py-1 rounded-full font-medium ${
              micStatus === 'granted'
                ? 'bg-emerald-100 text-emerald-600'
                : 'bg-slate-100 text-slate-400'
            }`}
          >
            {micStatus === 'granted' ? '🎤 マイクOK' : '🎤 マイクを確認中...'}
          </span>
        </div>
      )}
```

準備完了トグルボタンを micStatus と連動(granted 以外は無効):

```tsx
<button
        onClick={() => setIsReady(r => !r)}
        disabled={micStatus !== 'granted'}
        className={`w-full py-4 font-bold text-lg rounded-2xl transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${
          isReady
            ? 'bg-emerald-50 border-2 border-emerald-400 text-emerald-700 hover:bg-red-50 hover:border-red-300 hover:text-red-500'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white'
        }`}
      >
        {isReady ? '✓ 準備完了（タップで取り消し）' : '準備完了！'}
      </button>
```

- [ ] **Step 3: ビルド確認**

Run: `cd client && npm run build`
Expected: 成功

- [ ] **Step 4: Commit**

```bash
git add client/src/screens/PrepareScreen.tsx
git commit -m "feat: 準備画面にマイク許可フローを追加"
```

---

### Task 9: frontend仕様書の更新

**Files:**
- Modify: `doc/frontend仕様書.md`

設計書Aの8項目を反映する。主な追記内容:

- [ ] **Step 1: 2章 GameContext を実装に合わせて更新**

GameContext のコード例に2フィールドを追加し、説明文を追記:

```typescript
interface GameContext {
  playerName: string      // プレイヤー名
  isHost: boolean         // ホストかどうか
  roomCode: string        // ルームコード（4文字）
  genre: string           // 選択ジャンルID
  fromResult?: boolean    // 結果画面からロビーに戻ったか
  script: ScriptData | null   // AI生成台本（Socket.io統合時にRoomSnapshotから反映）
  scores: PlayerScore[]       // AI評価結果（同上）
}
```

コード例の下に一文追記: 「`script` / `scores` はSocket.io統合時にサーバーの `RoomSnapshot` を受け取る器。現在のモックでは未使用（各画面はハードコードのモックデータを使用）。」

- [ ] **Step 2: 4-2 ロビーに台本生成オーバーレイを追記**

「**台本生成中オーバーレイ：**」セクションを追加:
- ホストが「ゲームを開始する」を押すと、ロビーの上に半透明オーバーレイ（✍️🤖「AIが台本を執筆中...」＋選択ジャンル名＋スピナー）を全員に表示
- `script_ready` 受信で配役画面へ遷移（モックでは2.5秒後に遷移）
- 生成失敗時はオーバーレイを閉じ、トーストでエラー表示してロビーに留まる

- [ ] **Step 3: 4-4 準備画面にマイク許可フローを追記**

「**マイク許可フロー：**」セクションを追加:
- 画面表示時に `navigator.mediaDevices.getUserMedia({ audio: true })` を実行（許可確認後ストリームは即停止）
- 状態: `pending`（🎤 マイクを確認中...）/ `granted`（🎤 マイクOKバッジ）/ `denied`（赤の案内カード＋「マイク許可を再試行」ボタン）
- `granted` 以外の間は準備完了ボタンを無効化（マイクOKが準備完了の前提条件）

- [ ] **Step 4: 4-5 録音画面に BGM/SFX パネルとカウントダウン明確化を追記**

カウントダウンの記述を「0 になると『START!』（emerald）を**約0.8秒**表示し、録音フェーズへ移行」に変更。

「**BGM/効果音パネル：**」セクションを追加:
- 画面右端の「音」タブで開閉するスライドパネル（誰でも操作可）
- BGM 4種: ドラマチック🎻 / 不気味👻 / コミカル🎵 / バトル⚔️（単一選択、再タップ or 🔇で停止）
- 効果音 6種: ドラムロール🥁 / どーん💥 / ファンファーレ🎉 / 悲鳴😱 / 笑い声🤣 / チーン🔔（タップで単発再生、押下フラッシュ演出）
- backend の `send_bgm` / `send_sfx` / `bgm_changed` / `sfx_played` に対応。実音声の再生は未実装（UI演出のみ）

- [ ] **Step 5: 新章「エラー表示」を追加（4章と5章の間、または5章の後）**

| 種別 | 表示方法 |
|------|---------|
| トップ画面の入室失敗（ルームが見つからない・ゲーム進行中） | フォーム直下に赤文字でインライン表示 |
| ゲーム中の非同期エラー（台本生成失敗・評価失敗等） | 画面上部の共通トースト（`components/Toast.tsx`、4秒で自動消滅、タップで閉じる） |

- [ ] **Step 6: 新章「切断時のUI」を追加**

| ケース | UI |
|--------|-----|
| ホスト切断（`room_dissolved`） | モーダル「ホストが退出したためルームが解散されました」→ OKでトップへ |
| ゲスト切断（`player_left`） | トースト「〇〇が退出しました」＋参加者一覧から削除。ゲームは続行 |
| 切断者の結果表示 | ランキング最下位にグレーの退出カード「🚪 途中退出のため評価なし」（星・コメント非表示） |

※モック実装は見送り（Socket.io統合時に実装）。

- [ ] **Step 7: 5章 モックデータと6章を更新**

- 5章の表に `genres.ts`（ジャンル定数の共通化）、`mockScript.ts` の `MOCK_WORLD` / `MOCK_ROLES` 追加、`components/Toast.tsx` を反映
- 「各画面のハードコード」の記述を更新（配役画面はモックデータ由来になった旨）
- 6章「未実装・今後の対応」に「切断時UI（モーダル・退出カード）」を追加

- [ ] **Step 8: Commit**

```bash
git add "doc/frontend仕様書.md"
git commit -m "docs: frontend仕様書にBGM/SFX・マイク許可・生成待ち・エラー/切断UIを追記"
```

---

### Task 10: 動作確認（ビルド + ブラウザ目視）

**Files:** なし（検証のみ）

- [ ] **Step 1: 最終ビルド**

Run: `cd client && npm run build`
Expected: 型エラーなし・ビルド成功

- [ ] **Step 2: 開発サーバー起動**

Run: `cd client && npm run dev`（バックグラウンド）
Expected: `Local: http://localhost:5173/`

- [ ] **Step 3: ホスト導線をブラウザで確認**

Playwright で以下を確認:
1. トップ → 「ルームを作る」→ 名前「たろう」→ 作成 → ロビー表示（ルームコード4文字）
2. ジャンル「時代劇」選択 → 背景がアンバー系に変化
3. 「ゲームを開始する」→ 生成オーバーレイ（✍️🤖 AIが台本を執筆中...）が約2.5秒表示 → 配役画面へ
4. 配役画面: 役「浪人・孤高の剣士」、ジャンル「時代劇」、セリフがFULL_SCRIPT由来の6件
5. 「台本を読む」→ 準備画面: マイク状態バッジ表示。許可拒否環境なら赤カード＋再試行ボタン、許可済みなら「🎤 マイクOK」＋準備完了ボタン有効
6. 準備完了 → 録音開始 → カウントダウン 3・2・1 → **START! が視認できる**（0.8秒）→ 録音画面
7. 「録音終了」→ 評価中 → 結果画面（playerName表示・メダル・最優秀俳優賞）
8. 「ロビーへ戻る」→ 帰還状況バッジ表示

- [ ] **Step 4: ゲスト導線を確認**

1. トップ → 「ルームに参加する」→ 名前「はなこ」＋コード4文字 → ロビー（ホスト待ち表示）
2. （デモ）次の画面へ → 配役画面: 役が「宿場の看板娘」になっている（従来バグの修正確認）
3. 準備画面で自分のハイライトが看板娘のセリフと一致

- [ ] **Step 5: 確認結果を報告**

スクリーンショットまたは確認結果のサマリをユーザーに報告する。
