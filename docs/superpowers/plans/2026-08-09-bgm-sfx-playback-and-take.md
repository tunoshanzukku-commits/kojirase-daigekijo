# BGM/SEの実再生と「自分のテイク」聞き返し Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同期済みで無音のままだった BGM/SE を実際に鳴らし、自分のマイクとミックスした「テイク」を結果画面で聞き返して共有できるようにする。

**Architecture:** 新モジュール `client/src/audioBus.ts` がアプリ唯一の AudioContext を持ち、BGM/SE を「スピーカー」と「録音用ミックス出力」の両方へ流す。マイクは**ミックス出力にだけ**繋ぐ（スピーカーへ繋ぐとハウリングする）。録音は2トラックになり、採点用は従来どおりマイクのみをアップロード、鑑賞用（マイク＋BGM/SE）はアップロードせずブラウザ内に保持して結果画面で再生・共有する。サーバー・共有型・イベント契約は一切変更しない。

**Tech Stack:** React18 + Vite + TypeScript（client のみ）/ Web Audio API（`AudioContext` / `AudioBufferSourceNode` / `MediaStreamAudioDestinationNode`）/ MediaRecorder / 既存 `shareOrDownload`（Web Share API＋DLフォールバック）。

## Global Constraints

- 設計書: [docs/superpowers/specs/2026-08-09-bgm-sfx-playback-and-take-design.md](../specs/2026-08-09-bgm-sfx-playback-and-take-design.md)。
- **サーバー・`shared/`・イベント契約は一切変更しない**（このスライスは client 完結）。
- **音源ファイルが1つも無くても、警告ログだけでゲームは最後まで通常どおり動く**こと。ビルドも通ること。
- **採点用トラックはマイクのみ**。BGM/SE を混ぜない（Whisper の文字起こしが劣化して採点が壊れる）。
- **マイクをスピーカー出力（`ctx.destination`）へ繋がない**。ハウリングする。マイクは録音用 destination にだけ繋ぐ。
- **音源のファイル名は `shared/constants.ts` の `BGM_IDS` / `SFX_IDS` と1対1**（`client/public/audio/bgm/<id>.mp3`、`client/public/audio/sfx/<id>.mp3`）。ID→ファイル名の変換表を作らない。
- **鑑賞用トラックの取得に失敗しても採点フローに影響させない**（聞き返しが無くなるだけに劣化させる）。
- client にテストフレームワークは無い。検証は `cd client && npm run build`（`tsc && vite build`）clean ＋2タブ目視。
- 設計書の `getMixDestination(): MediaStreamAudioDestinationNode` は、AudioContext 非対応環境（非セキュアオリジン等）を無音で通すため **`| null` を返す**ように具体化する。これは設計の意図（音源が無くても壊れない）に沿った詳細化であり、逸脱ではない。
- 設計書 §4 は「`recorder.ts` が audioBus の AudioContext で `createMediaStreamSource` を作る」と書いているが、**AudioContext の所有を audioBus 内に閉じる**ため `connectMic(stream)` / `disconnectMic()` として audioBus 側に置く（設計書 §3「アプリで1つの AudioContext を持ち」に沿った具体化）。`recorder.ts` は AudioContext を直接触らない。
- コミットの `Co-Authored-By` は `Claude Opus 5 <noreply@anthropic.com>`。

---

### Task 1: `audioBus.ts` と画面配線（BGM/SEが鳴る）

**Files:**
- Create: `client/src/audioBus.ts`
- Modify: `client/src/screens/RecordingScreen.tsx`（`flashSfx` に `playSfx`、`ctx.bgm` 追従の `useEffect`、アンマウントで `stopAll`）
- Modify: `client/src/screens/CastingScreen.tsx`（`preloadAudio()`）
- Modify: `client/src/screens/PrepareScreen.tsx`（`resumeAudio()`＋「イヤホン推奨」表記）

**Interfaces:**
- Consumes: `BGM_IDS` / `SFX_IDS`（`shared/constants.ts` の `readonly string[]`。実体は `['dramatic','horror','comedy','battle']` と `['drum','boom','fanfare','scream','laugh','bell']`）。`GameContext.bgm: string | null`（既存。`bgm_changed` を受けて `useGameSocket` が更新する共有状態）。
- Produces:
  - `preloadAudio(): void`
  - `playBgm(id: string | null): void`
  - `playSfx(id: string): void`
  - `stopAll(): void`
  - `resumeAudio(): void`
  - `getMixDestination(): MediaStreamAudioDestinationNode | null`（Task 2 が使う）
  - `connectMic(stream: MediaStream): void`（Task 2 が使う）
  - `disconnectMic(): void`（Task 2 が使う）

- [ ] **Step 1: `client/src/audioBus.ts` を新規作成**

```ts
import { BGM_IDS, SFX_IDS } from '@shared/constants'

// BGM/SE の再生と「録音用ミックス出力」を、アプリ唯一の AudioContext で受け持つ。
// DOM 非依存（scoreCard.ts と同じ方針）。
//
// 配線:
//   BGM/SE --> master --> ctx.destination（スピーカー）
//                    \--> mixDest（鑑賞用トラックの録音先）
//   マイク --------------> mixDest のみ
// マイクを master/スピーカー側へ繋ぐとハウリングするので、絶対に繋がない。

let ctx: AudioContext | null = null
let master: GainNode | null = null
let mixDest: MediaStreamAudioDestinationNode | null = null
let micNode: MediaStreamAudioSourceNode | null = null

const buffers = new Map<string, AudioBuffer>() // key: `${kind}/${id}`
let bgmSource: AudioBufferSourceNode | null = null
let bgmGain: GainNode | null = null
let currentBgmId: string | null = null
let preloaded = false

const FADE_SEC = 0.1 // BGM 切替のプツ切れ防止

// AudioContext は遅延生成する。非セキュアオリジンや未対応環境では作れないので、
// その場合は null を返して「音なしで動く」に倒す。
function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  master = ctx.createGain()
  mixDest = ctx.createMediaStreamDestination()
  master.connect(ctx.destination)
  master.connect(mixDest)
  return ctx
}

// 自動再生ポリシー対策。ユーザー操作起点（準備完了ボタン）と、
// 再生の直前（保険）の両方から呼ぶ。
export function resumeAudio(): void {
  const c = getCtx()
  if (c && c.state === 'suspended') void c.resume()
}

function srcPath(kind: 'bgm' | 'sfx', id: string): string {
  return `${import.meta.env.BASE_URL}audio/${kind}/${id}.mp3`
}

// 音源を先読みしてデコードする。欠損・デコード失敗はその音だけ無音として握り潰す
// （音源未配置でもゲームは最後まで通常どおり動く）。冪等。
export function preloadAudio(): void {
  if (preloaded) return
  preloaded = true
  const c = getCtx()
  if (!c) return
  const load = (kind: 'bgm' | 'sfx', id: string) => {
    fetch(srcPath(kind, id))
      .then(res => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(buf => c.decodeAudioData(buf))
      .then(decoded => { buffers.set(`${kind}/${id}`, decoded) })
      .catch(err => {
        console.warn(`[audioBus] ${kind}/${id} を読み込めませんでした（無音で継続します）`, err)
      })
  }
  for (const id of BGM_IDS) load('bgm', id)
  for (const id of SFX_IDS) load('sfx', id)
}

function stopBgm(): void {
  const c = ctx
  const src = bgmSource
  const gain = bgmGain
  bgmSource = null
  bgmGain = null
  if (!c || !src || !gain) return
  // フェードアウトしてから停止（プツ切れ防止）
  gain.gain.cancelScheduledValues(c.currentTime)
  gain.gain.setValueAtTime(gain.gain.value, c.currentTime)
  gain.gain.linearRampToValueAtTime(0, c.currentTime + FADE_SEC)
  src.stop(c.currentTime + FADE_SEC)
}

// 共有BGM状態に追従する。同じIDの再指定は無視（useEffect の再実行で鳴り直さない）。
export function playBgm(id: string | null): void {
  const c = getCtx()
  if (!c) return
  resumeAudio()
  if (id === currentBgmId) return
  stopBgm()
  currentBgmId = id
  if (!id) return
  const buf = buffers.get(`bgm/${id}`)
  if (!buf || !master) return // 未ロード＝無音
  const gain = c.createGain()
  gain.gain.setValueAtTime(0, c.currentTime)
  gain.gain.linearRampToValueAtTime(1, c.currentTime + FADE_SEC)
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  src.connect(gain)
  gain.connect(master)
  src.start()
  bgmSource = src
  bgmGain = gain
}

// ワンショット。重ねて鳴ってよい。
export function playSfx(id: string): void {
  const c = getCtx()
  if (!c || !master) return
  resumeAudio()
  const buf = buffers.get(`sfx/${id}`)
  if (!buf) return // 未ロード＝無音
  const src = c.createBufferSource()
  src.buffer = buf
  src.connect(master)
  src.start()
}

export function stopAll(): void {
  stopBgm()
  currentBgmId = null
}

// 鑑賞用トラックの録音先（Task 2 の recorder が使う）
export function getMixDestination(): MediaStreamAudioDestinationNode | null {
  getCtx()
  return mixDest
}

// マイクは録音用ミックスにだけ繋ぐ。スピーカー側へ繋ぐとハウリングする。
export function connectMic(stream: MediaStream): void {
  const c = getCtx()
  if (!c || !mixDest) return
  disconnectMic()
  micNode = c.createMediaStreamSource(stream)
  micNode.connect(mixDest)
}

export function disconnectMic(): void {
  micNode?.disconnect()
  micNode = null
}
```

- [ ] **Step 2: RecordingScreen に再生を配線**

`client/src/screens/RecordingScreen.tsx`:

import を追加（`import { RECORDING_LIMIT_SEC } from '@shared/constants'` の下）:

```ts
import { playBgm, playSfx, stopAll } from '../audioBus'
```

`flashSfx` に再生を足す（**ローカル発火 `handleSfx` と受信 `onSfx` の合流点なので、ここ1箇所で自分の音も他人の音も鳴る**）:

```ts
  const flashSfx = (sfxId: string) => {
    playSfx(sfxId) // handleSfx（自分）と onSfx（他人）の共通経路
    setSfxFlash(sfxId)
    setTimeout(() => setSfxFlash(null), 400)
  }
```

受信リスナの `useEffect`（`}, [phase])` で終わるブロック）の**直後**に2つの `useEffect` を追加:

```ts
  // BGM は bgm_changed で全員へ配信される共有状態。ctx.bgm に追従して鳴らす。
  useEffect(() => {
    if (phase !== 'recording') return
    playBgm(ctx.bgm)
  }, [phase, ctx.bgm])

  // 録音終了・中断・解散のいずれでもこの画面はアンマウントされるので、ここで全部止める
  useEffect(() => () => stopAll(), [])
```

- [ ] **Step 3: CastingScreen で先読み**

`client/src/screens/CastingScreen.tsx`:

1行目の import を `import { useState, useEffect } from 'react'` に変更（現在は `useState` のみ）。
import に追加:

```ts
import { preloadAudio } from '../audioBus'
```

コンポーネント本体の先頭（`const [confirmOpen, setConfirmOpen] = useState(false)` の直後）に追加:

```ts
  // 録音開始までに間に合うよう、配役画面に入った時点で音源を先読みする
  useEffect(() => { preloadAudio() }, [])
```

- [ ] **Step 4: PrepareScreen で AudioContext を解除＋イヤホン推奨表記**

`client/src/screens/PrepareScreen.tsx`:

import に追加:

```ts
import { resumeAudio } from '../audioBus'
```

「準備完了」トグルボタンの `onClick` を変更（**ユーザー操作起点での確実な解除**。現在は `onClick={() => actions.setReady(!isReady)}`）:

```tsx
        onClick={() => {
          resumeAudio() // ブラウザの自動再生ポリシー解除はユーザー操作起点でないと効かない
          actions.setReady(!isReady)
        }}
```

準備状況一覧のカード（`準備状況{' '}` を含む `<div className="bg-white/80 ...">` ブロック）の**直後**に注意書きを追加:

```tsx
      <p className="text-center text-slate-400 text-xs mb-4">
        🎧 イヤホン推奨：スピーカーだとBGMをマイクが拾い、採点用の音声に混ざります
      </p>
```

- [ ] **Step 5: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` clean。

- [ ] **Step 6: 音源が無い状態で壊れないことを確認**

Run: `cd client && npm run dev`（別ターミナルで `npm --prefix server run dev`）
ブラウザで1タブだけ開き、ルーム作成 → 配役画面まで進む。
Expected: コンソールに `[audioBus] bgm/dramatic を読み込めませんでした（無音で継続します）` 等の**警告が10件出るだけ**で、画面遷移・操作は一切壊れない。エラー（赤）は出ない。確認したら dev は止めてよい。

- [ ] **Step 7: コミット**

```bash
git add client/src/audioBus.ts client/src/screens/RecordingScreen.tsx \
  client/src/screens/CastingScreen.tsx client/src/screens/PrepareScreen.tsx
git commit -m "feat: BGM/SEを実際に鳴らす（audioBus・欠損音源は無音で継続）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 録音のミックスと聞き返し・共有

**Files:**
- Modify: `client/src/recorder.ts`（鑑賞用 MediaRecorder の追加、`getLastTake`/`clearLastTake`）
- Modify: `client/src/share.ts`（MIME 決め打ちの修正）
- Modify: `client/src/screens/ResultScreen.tsx`（再生プレイヤー＋共有ボタン）
- Modify: `client/src/useGameSocket.ts`（テイクの破棄）

**Interfaces:**
- Consumes: Task 1 の `getMixDestination(): MediaStreamAudioDestinationNode | null` / `connectMic(stream: MediaStream): void` / `disconnectMic(): void`。
- 既存（`recorder.ts`）: `startUploadRecorder()` は `navigator.mediaDevices.getUserMedia({audio:true})` の `.then(s => {...})` の中で世代トークン `myGeneration !== generation` を確認してから `stream = s` と `new MediaRecorder(s)` を行う。`stopAndUpload(socketId)` は `generation++` → `stopAndGetBlob()` → `releaseStream()` → `POST /upload`。`cancelRecording()` は `generation++` → レコーダー停止（`onstop`/`onerror` を null 化）→ `releaseStream()`。
- 既存（`share.ts`）: `shareOrDownload(blob: Blob, filename: string, text: string): Promise<void>`。
- Produces: `getLastTake(): Blob | null` / `clearLastTake(): void`

- [ ] **Step 1: `recorder.ts` に鑑賞用トラックを追加**

`client/src/recorder.ts`:

先頭の import に追加:

```ts
import { getMixDestination, connectMic, disconnectMic } from './audioBus'
```

モジュールスコープの状態（`let generation = 0` の下）に追加:

```ts
// 鑑賞用トラック（マイク＋BGM/SE のミックス）。アップロードせずローカルに保持する。
let mixRecorder: MediaRecorder | null = null
let mixChunks: Blob[] = []
let lastTake: Blob | null = null
```

`startUploadRecorder` の `.then(s => { ... })` の中、`mediaRecorder = rec` の**直後**に追加:

```ts
        mediaRecorder = rec
        startMixRecorder(s)
```

`startUploadRecorder` の下に2つの関数を追加:

```ts
// 鑑賞用（マイク＋BGM/SE）を別トラックで録る。
// ここで失敗しても採点用トラックには一切影響させない（聞き返しが無くなるだけ）。
function startMixRecorder(micStream: MediaStream): void {
  const dest = getMixDestination()
  if (!dest) return // AudioContext が使えない環境＝鑑賞用は諦める
  try {
    connectMic(micStream) // マイクはミックス出力にだけ繋ぐ（スピーカーへ繋ぐとハウリング）
    mixChunks = []
    const rec = new MediaRecorder(dest.stream)
    rec.ondataavailable = e => {
      if (e.data.size > 0) mixChunks.push(e.data)
    }
    rec.start()
    mixRecorder = rec
  } catch (err) {
    console.warn('[recorder] 鑑賞用トラックを開始できませんでした', err)
    disconnectMic()
  }
}

// keep=true なら停止後の blob を「最後のテイク」として保持する。
// keep=false（解散・退出・切断）は破棄する。
function stopMixRecorder(keep: boolean): void {
  const rec = mixRecorder
  mixRecorder = null
  disconnectMic()
  if (!rec || rec.state === 'inactive') {
    mixChunks = []
    return
  }
  rec.onstop = () => {
    if (keep && mixChunks.length > 0) {
      lastTake = new Blob(mixChunks, { type: rec.mimeType || 'audio/webm' })
    }
    mixChunks = []
  }
  rec.onerror = () => { mixChunks = [] }
  rec.stop()
}

export function getLastTake(): Blob | null {
  return lastTake
}

export function clearLastTake(): void {
  lastTake = null
}
```

`stopAndUpload` の先頭（`generation++` の直後）に追加:

```ts
  stopMixRecorder(true) // 鑑賞用は残す
```

`cancelRecording` の先頭（`generation++` の直後）に追加:

```ts
  stopMixRecorder(false) // 解散・退出・切断：鑑賞用は破棄
```

- [ ] **Step 2: `share.ts` の MIME 決め打ちを直す**

`client/src/share.ts` の `shareOrDownload` 冒頭を変更（現在は `type: 'image/png'` 固定で、音声を渡すと共有シートに誤った種別で渡る）:

```ts
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
```

冒頭のコメントも実態に合わせる（1行目「クライアント生成画像の共有。」を「クライアント生成ファイル（スコアカード画像・録音テイク）の共有。」に変更）。

- [ ] **Step 3: ResultScreen に再生プレイヤーと共有ボタンを追加**

`client/src/screens/ResultScreen.tsx`:

import を追加（先頭に `useState`/`useEffect`、および recorder）:

```ts
import { useState, useEffect } from 'react'
import { getLastTake } from '../recorder'
```

`export default function ResultScreen({ ctx, actions }: Props) {` の直後、`const sorted = ...` の**前**に追加:

```tsx
  // 自分のテイク（マイク＋BGM/SE）。保存はしないのでリロードで消える。
  const [takeUrl, setTakeUrl] = useState<string | null>(null)
  useEffect(() => {
    const blob = getLastTake()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setTakeUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [])

  async function shareTake() {
    const blob = getLastTake()
    if (!blob) return
    const ext = (blob.type.split('/')[1] ?? 'webm').split(';')[0]
    await shareOrDownload(blob, `ai-shibai-take.${ext}`, `${ctx.playerName} の熱演！ #AI芝居`)
  }
```

ボタン群（`<div className="space-y-3">` で始まり「みんなの結果をシェア 🔗」を含むブロック）の**直前**に再生セクションを追加:

```tsx
      {takeUrl && (
        <div className="bg-white/80 backdrop-blur rounded-2xl p-4 mb-4 shadow-sm border border-sky-100">
          <p className="font-bold mb-2 text-slate-600 text-sm">🎧 自分の演技を聞く</p>
          <audio controls src={takeUrl} className="w-full" />
          <button
            onClick={() => { void shareTake() }}
            className="w-full mt-3 py-2 bg-white hover:bg-sky-50 text-slate-700 font-bold rounded-xl text-sm transition-colors border border-sky-200"
          >
            音声を共有 🔗
          </button>
        </div>
      )}
```

> `getLastTake()` が `null`（音源未配置でBGMが鳴っていない場合も含め、マイク拒否・鑑賞用トラック取得失敗）のときはセクションごと出ない。

- [ ] **Step 4: テイクの破棄を配線**

`client/src/useGameSocket.ts`:

import を変更（現在は `import { startUploadRecorder, stopAndUpload, cancelRecording } from './recorder'`）:

```ts
import { startUploadRecorder, stopAndUpload, cancelRecording, clearLastTake } from './recorder'
```

`onRoomReset` / `onGameAborted` / `onEvaluationFailed` の3つの関数それぞれの先頭に追加（`onGameAborted` は既存の `cancelRecording()` の直後）:

```ts
      clearLastTake() // 次のゲームへ：前回のテイクは捨てる
```

`onDissolved` の `cancelRecording()` の直後にも追加:

```ts
      clearLastTake()
```

`leaveRoom()` アクションの `socket.emit('leave_room')` の**前**に追加:

```ts
      clearLastTake()
```

- [ ] **Step 5: ビルドで型検証**

Run: `cd client && npm run build`
Expected: `tsc && vite build` clean。

- [ ] **Step 6: サーバー側の回帰確認**

Run: `cd server && npm test`
Expected: 162/162 PASS（このスライスはサーバー無改造なので、変化していないことの確認）。

- [ ] **Step 7: コミット**

```bash
git add client/src/recorder.ts client/src/share.ts \
  client/src/screens/ResultScreen.tsx client/src/useGameSocket.ts
git commit -m "feat: 自分のテイク（マイク＋BGM/SE）を録って結果画面で聞き返す・共有する

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 2タブ目視確認

**Files:** なし（動作確認のみ）

- [ ] **Step 1: dev 起動**

server（`npm --prefix server run dev`）＋client（`npm --prefix client run dev`）を background で起動し、2タブでホスト＋ゲストのルームを作る。**音源ファイルが配置済みかどうかで期待結果が変わる**ので、まず配置状況を確認する（`client/public/audio/bgm/` と `sfx/`）。

- [ ] **Step 2: 音源が無い状態で最後まで通す（必須）**

音源を置かずに1ゲーム最後まで（ロビー→配役→準備→録音→結果）通す。
Expected: 無音のまま**一切壊れない**。コンソールは警告のみでエラー（赤）は出ない。結果画面の「🎧 自分の演技を聞く」は**出る**（BGM/SEが無いだけで鑑賞用トラック自体は録れているため）、再生すると**自分の声だけ**が入っている。

- [ ] **Step 3: BGMとSEが全員に鳴る**

音源を配置して録音フェーズへ。ホストがBGMを選ぶ → **両タブで同じ曲が鳴る**。BGMを切り替える → プツ切れせず切り替わる。もう一度同じものを押す（選択解除）→ 止まる。SEを押す → **押した本人と相手の両方で鳴る**。

- [ ] **Step 4: 録音終了で止まる**

ホストが録音終了 → BGMが止まり、評価画面へ。中断（⚠️ 中断してロビーへ戻る）でも止まることを確認。

- [ ] **Step 5: 自分のテイクを聞き返す**

結果画面の「🎧 自分の演技を聞く」で再生 → **自分の声とBGM/SEが両方入っている**こと。イヤホンをして録音した場合でも、BGMはミックス経路から直接入るので必ず入る。「音声を共有 🔗」で共有シート（HTTPS/localhost）またはダウンロードが動く。

- [ ] **Step 6: テイクが持ち越されない**

「ロビーへ戻る」で全員戻る → 次のゲームを開始 → 前回のテイクが残っていない（結果画面で前のゲームの音声が再生されない）ことを確認。

---

## 完了条件

- `client` の `npm run build`（tsc && vite build）clean。
- `server` の `npm test` 162/162 PASS（無改造の確認）。
- 2タブ目視: 音源なしで壊れない／BGM・SEが全員に鳴る／録音終了と中断で止まる／結果画面で自分のテイク（BGM込み）が聞けて共有できる／次のゲームに持ち越されない。
