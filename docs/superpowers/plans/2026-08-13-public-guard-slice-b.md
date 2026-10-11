# 公開ガード（スライスB）＋手書き台本ライブラリ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** URL を広く配れる状態にするため、AI課金を止める歯止め（日次上限・キルスイッチ・レート制限）と、上限到達後も遊べる手書き台本ライブラリを入れる。

**Architecture:** 課金は Socket.io イベント2箇所（`start_game` の台本生成、`finalizeEvaluation` の文字起こし＋採点）でしか発生しない。`start_game` の入口で日次枠を1回だけ判定して `Room.aiMode` を固定し、以降そのゲームは一貫して実AIか簡易モードのどちらかで通す。レート制限は `express-rate-limit` を使わず自前の1モジュールを HTTP と Socket.io の両方から使う。

**Tech Stack:** TypeScript / Node 20 / tsx / node:test / Express / Socket.io

**Spec:** [docs/superpowers/specs/2026-08-13-public-guard-slice-b-design.md](../specs/2026-08-13-public-guard-slice-b-design.md)

## Global Constraints

- **TDD 厳守**：先に失敗するテストを書き、RED を実際に目で確認してから実装する。
- **`server` は `tsx` が型チェックをしない。** 型の網羅は `cd server && npx tsc --noEmit` が唯一のゲート。各タスクの最後に必ず走らせる。
- **新しいテストファイルは `server/package.json` の `test` スクリプトに追記しないと実行されない。** ファイルが明示列挙されているため、追記漏れは「テストが無いのに green」になる。
- **統合テストで `io.to` の同時配信を待つときは、両方のリスナを登録してから `emit` する。** 逐次 `await` はホスト側を取りこぼす（Windows で再現性100%）。
- 環境変数は**呼び出し時に読む**（モジュール読み込み時にキャッシュしない）。テストで `process.env` を差し替えられるようにするため。
- コミットメッセージは日本語。末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。
- 既定値：`DAILY_GAME_LIMIT=5` / `AI_ENABLED=true` / `PUBLIC_ENABLED=true`
- レート制限：`create_room` は同一IP 60秒に5回、`POST /upload` は同一IP 60秒に30回。

## File Structure

| ファイル | 責務 |
|---|---|
| `server/src/config.ts`（新規） | 環境変数の解釈のみ。不正値は既定へ |
| `server/src/quota.ts`（新規） | 日次カウンタ。JST日付で自動リセット |
| `server/src/rateLimit.ts`（新規） | 固定ウィンドウのレート制限。HTTP/Socket.io 共用 |
| `server/src/clientIp.ts`（新規） | プロキシ経由のクライアントIP抽出 |
| `server/src/ai/scriptLibrary.ts`（新規） | `plays/` の読み込み・検証・選択・人数スライス |
| `plays/*.json`（新規） | 台本データ |
| `server/src/roomStore.ts` | `Room.aiMode` と `RoomSnapshot.aiAvailable` |
| `server/src/handlers.ts` | ガードの配線（`create_room` / `start_game` / `finalizeEvaluation`） |
| `server/src/server.ts` / `uploadRoute.ts` | `trust proxy` と `/upload` レート制限 |
| `shared/types.ts` | `RoomSnapshot.aiAvailable` |
| `client/src/App.tsx` / `useGameSocket.ts` / `LobbyScreen.tsx` | 簡易モードの表示 |

**設計からの逸脱1点：`server/src/ai/evaluate.ts` は変更しない。** 設計書§8では「`aiMode` を受けてスタブ経路へ分岐」としていたが、`handlers.ts` 側で分岐したほうが `evaluatePerformance` のシグネチャを変えずに済み、既存テストへの影響もない。

**スナップショットのフィールド名について：** 設計書§6では `RoomSnapshot.aiMode` としていたが、実装は **`aiAvailable`** にする。`Room.aiMode` は「いま進行中のゲームがAIか」（`start_game` で確定）、クライアントがロビーで知りたいのは「いま始めたらAIが使えるか」で、両者は別物。前者をそのまま送るとロビー表示が古い値のままになる。`aiAvailable` はスナップショット生成時に毎回計算するので常に正確。

---

### Task 1: 環境変数の解釈（config.ts）

**Files:**
- Create: `server/src/config.ts`
- Test: `server/src/config.test.ts`
- Modify: `server/package.json`（`test` スクリプトに追記）

**Interfaces:**
- Consumes: なし
- Produces: `dailyGameLimit(): number` / `aiEnabled(): boolean` / `publicEnabled(): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`server/src/config.test.ts`:

```typescript
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { dailyGameLimit, aiEnabled, publicEnabled } from './config'

const KEYS = ['DAILY_GAME_LIMIT', 'AI_ENABLED', 'PUBLIC_ENABLED'] as const

afterEach(() => {
  for (const k of KEYS) delete process.env[k]
})

test('dailyGameLimit は未設定なら既定 5', () => {
  assert.equal(dailyGameLimit(), 5)
})

test('dailyGameLimit は整数文字列を数値にする', () => {
  process.env.DAILY_GAME_LIMIT = '20'
  assert.equal(dailyGameLimit(), 20)
})

test('dailyGameLimit は 0 を許可する（全ゲームを簡易モードにできる）', () => {
  process.env.DAILY_GAME_LIMIT = '0'
  assert.equal(dailyGameLimit(), 0)
})

test('dailyGameLimit は不正値・負数・小数を既定へフォールバックする', () => {
  for (const bad of ['abc', '-1', '1.5', '']) {
    process.env.DAILY_GAME_LIMIT = bad
    assert.equal(dailyGameLimit(), 5, `"${bad}" は既定に落ちるべき`)
  }
})

test('aiEnabled / publicEnabled は未設定なら true', () => {
  assert.equal(aiEnabled(), true)
  assert.equal(publicEnabled(), true)
})

test('aiEnabled は false / FALSE を false と解釈する', () => {
  process.env.AI_ENABLED = 'false'
  assert.equal(aiEnabled(), false)
  process.env.AI_ENABLED = 'FALSE'
  assert.equal(aiEnabled(), false)
})

test('publicEnabled は不正値なら既定 true（設定ミスでサービスを止めない）', () => {
  process.env.PUBLIC_ENABLED = 'yes'
  assert.equal(publicEnabled(), true)
})

test('環境変数は呼び出しごとに読む（差し替えが即反映される）', () => {
  assert.equal(dailyGameLimit(), 5)
  process.env.DAILY_GAME_LIMIT = '99'
  assert.equal(dailyGameLimit(), 99)
})
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/config.test.ts`
Expected: FAIL（`Cannot find module './config'`）

- [ ] **Step 3: 最小の実装を書く**

`server/src/config.ts`:

```typescript
// 環境変数の解釈はここ1箇所に閉じ込める。
// 値は「呼び出しごとに読む」：モジュール読み込み時にキャッシュすると
// テストで process.env を差し替えても効かなくなる。
// 不正値は必ず既定へフォールバックする（設定ミスでサーバーを落とさない）。

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return fallback
  return n
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const v = raw.trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** 1日にAIを使えるゲーム数。0 なら常に簡易モード。 */
export function dailyGameLimit(): number {
  return envInt('DAILY_GAME_LIMIT', 5)
}

/** false で枠に関係なく全ゲームを簡易モードにするキルスイッチ。 */
export function aiEnabled(): boolean {
  return envBool('AI_ENABLED', true)
}

/** false で新規ルーム作成を拒否するキルスイッチ（進行中のゲームは継続）。 */
export function publicEnabled(): boolean {
  return envBool('PUBLIC_ENABLED', true)
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/config.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: テストスクリプトに追記して型チェック**

`server/package.json` の `test` の末尾（`src/server.production.test.ts` の後ろ）に ` src/config.test.ts` を追記する。

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 6: コミット**

```bash
git add server/src/config.ts server/src/config.test.ts server/package.json
git commit -m "feat: 環境変数の解釈を config.ts に集約（不正値は既定へフォールバック）"
```

---

### Task 2: 日次ゲーム数カウンタ（quota.ts）

**Files:**
- Create: `server/src/quota.ts`
- Test: `server/src/quota.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `dailyGameLimit()` / `aiEnabled()`（Task 1）
- Produces:
  - `jstDateString(now: Date): string`
  - `tryConsumeGame(now: Date): boolean`
  - `getQuotaState(now: Date): { date: string; used: number; limit: number }`
  - `isAiAvailable(now: Date): boolean`
  - `__resetQuotaForTest(): void`

- [ ] **Step 1: 失敗するテストを書く**

`server/src/quota.test.ts`:

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { jstDateString, tryConsumeGame, getQuotaState, isAiAvailable, __resetQuotaForTest } from './quota'

beforeEach(() => {
  __resetQuotaForTest()
  process.env.DAILY_GAME_LIMIT = '2'
})

afterEach(() => {
  delete process.env.DAILY_GAME_LIMIT
  delete process.env.AI_ENABLED
  __resetQuotaForTest()
})

test('jstDateString は UTC を JST の日付に直す', () => {
  // UTC 15:30 は JST では翌日 00:30
  assert.equal(jstDateString(new Date('2026-08-13T15:30:00Z')), '2026-08-14')
  assert.equal(jstDateString(new Date('2026-08-13T14:59:00Z')), '2026-08-13')
})

test('tryConsumeGame は上限まで true、超えたら false', () => {
  const now = new Date('2026-08-13T01:00:00Z')
  assert.equal(tryConsumeGame(now), true)
  assert.equal(tryConsumeGame(now), true)
  assert.equal(tryConsumeGame(now), false)
})

test('上限に達しても used は増えない（false のとき消費しない）', () => {
  const now = new Date('2026-08-13T01:00:00Z')
  tryConsumeGame(now)
  tryConsumeGame(now)
  tryConsumeGame(now)
  tryConsumeGame(now)
  assert.equal(getQuotaState(now).used, 2)
})

test('JST の日付が変わると枠がリセットされる', () => {
  const day1 = new Date('2026-08-13T01:00:00Z')
  tryConsumeGame(day1)
  tryConsumeGame(day1)
  assert.equal(tryConsumeGame(day1), false)
  const day2 = new Date('2026-08-13T15:30:00Z') // JST で翌日
  assert.equal(tryConsumeGame(day2), true)
  assert.equal(getQuotaState(day2).used, 1)
})

test('DAILY_GAME_LIMIT=0 なら一度も消費できない', () => {
  process.env.DAILY_GAME_LIMIT = '0'
  assert.equal(tryConsumeGame(new Date('2026-08-13T01:00:00Z')), false)
})

test('getQuotaState は日付が変わっていれば used=0 を返す（副作用なし）', () => {
  const day1 = new Date('2026-08-13T01:00:00Z')
  tryConsumeGame(day1)
  const day2 = new Date('2026-08-13T15:30:00Z')
  assert.equal(getQuotaState(day2).used, 0)
  // 覗いただけでは消費していない
  assert.equal(tryConsumeGame(day1), true)
})

test('isAiAvailable は残枠があれば true', () => {
  const now = new Date('2026-08-13T01:00:00Z')
  assert.equal(isAiAvailable(now), true)
  tryConsumeGame(now)
  tryConsumeGame(now)
  assert.equal(isAiAvailable(now), false)
})

test('isAiAvailable は AI_ENABLED=false なら枠が残っていても false', () => {
  process.env.AI_ENABLED = 'false'
  assert.equal(isAiAvailable(new Date('2026-08-13T01:00:00Z')), false)
})
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/quota.test.ts`
Expected: FAIL（`Cannot find module './quota'`）

- [ ] **Step 3: 最小の実装を書く**

`server/src/quota.ts`:

```typescript
import { dailyGameLimit, aiEnabled } from './config'

// カウンタはメモリ上のみ。Railway のコンテナはファイルシステムが揮発するため
// ファイルに書いても再デプロイで消え、外部ストアはこの規模に見合わない。
// ＝再デプロイ・クラッシュ再起動で枠は戻る。最後の砦は各コンソールの支払上限。
let currentDate = ''
let used = 0

/** JST の YYYY-MM-DD。Railway のコンテナは UTC なので固定オフセットで足す。 */
export function jstDateString(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 10)
}

/** 枠が残っていれば1つ消費して true。残っていなければ何もせず false。 */
export function tryConsumeGame(now: Date): boolean {
  const date = jstDateString(now)
  if (date !== currentDate) {
    currentDate = date
    used = 0
  }
  if (used >= dailyGameLimit()) return false
  used++
  return true
}

/** 表示・ログ用。覗くだけで消費しない（日付が変わっていれば used=0 を返すが状態は変えない）。 */
export function getQuotaState(now: Date): { date: string; used: number; limit: number } {
  const date = jstDateString(now)
  const limit = dailyGameLimit()
  if (date !== currentDate) return { date, used: 0, limit }
  return { date, used, limit }
}

/** 「いまゲームを始めたら実AIが使えるか」。ロビー表示用。 */
export function isAiAvailable(now: Date): boolean {
  if (!aiEnabled()) return false
  const { used: u, limit } = getQuotaState(now)
  return u < limit
}

export function __resetQuotaForTest(): void {
  currentDate = ''
  used = 0
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/quota.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: テストスクリプトに追記して型チェック**

`server/package.json` の `test` に ` src/quota.test.ts` を追記。

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 6: コミット**

```bash
git add server/src/quota.ts server/src/quota.test.ts server/package.json
git commit -m "feat: 日次ゲーム数カウンタ（JST日付でリセット・メモリ保持）"
```

---

### Task 3: レート制限基盤（rateLimit.ts + clientIp.ts）

2つとも単独では意味を持たず、必ず組で使うため1タスクにまとめる。

**Files:**
- Create: `server/src/rateLimit.ts`, `server/src/clientIp.ts`
- Test: `server/src/rateLimit.test.ts`, `server/src/clientIp.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: なし
- Produces:
  - `createRateLimiter(windowMs: number, max: number): { allow(key: string, now: number): boolean }`
  - `extractIp(forwardedFor: unknown, fallback: string | undefined): string`

- [ ] **Step 1: 失敗するテストを2本書く**

`server/src/rateLimit.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from './rateLimit'

test('max 回までは true、超えたら false', () => {
  const limiter = createRateLimiter(1000, 2)
  assert.equal(limiter.allow('a', 0), true)
  assert.equal(limiter.allow('a', 100), true)
  assert.equal(limiter.allow('a', 200), false)
})

test('窓が過ぎたらまた通る', () => {
  const limiter = createRateLimiter(1000, 2)
  limiter.allow('a', 0)
  limiter.allow('a', 0)
  assert.equal(limiter.allow('a', 999), false)
  assert.equal(limiter.allow('a', 1000), true)
})

test('キーごとに独立して数える', () => {
  const limiter = createRateLimiter(1000, 1)
  assert.equal(limiter.allow('a', 0), true)
  assert.equal(limiter.allow('b', 0), true)
  assert.equal(limiter.allow('a', 0), false)
})

test('古いエントリは掃除される（IPごとに溜め続けない）', () => {
  const limiter = createRateLimiter(1000, 1)
  for (let i = 0; i < 10_050; i++) limiter.allow(`ip-${i}`, 0)
  // 窓を抜けた時刻で新規キーを通すと、その際に古いエントリが掃除される
  limiter.allow('trigger', 5000)
  assert.equal(limiter.size(), 1, '古いキーが残っている')
})
```

`server/src/clientIp.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractIp } from './clientIp'

test('x-forwarded-for の先頭を実クライアントとして採る', () => {
  assert.equal(extractIp('203.0.113.7, 10.0.0.1, 10.0.0.2', '10.0.0.9'), '203.0.113.7')
})

test('前後の空白を落とす', () => {
  assert.equal(extractIp('  203.0.113.7 , 10.0.0.1', undefined), '203.0.113.7')
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
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/rateLimit.test.ts src/clientIp.test.ts`
Expected: FAIL（両方 `Cannot find module`）

- [ ] **Step 3: 実装を2本書く**

`server/src/rateLimit.ts`:

```typescript
export interface RateLimiter {
  allow(key: string, now: number): boolean
  /** テスト・診断用。保持しているキー数。 */
  size(): number
}

// 掃除を始めるキー数。これを超えたら窓を抜けたエントリを一掃する。
// レート制限モジュール自身がメモリを食い潰しては本末転倒なので必ず入れる。
const PRUNE_THRESHOLD = 10_000

/**
 * 固定ウィンドウ方式のレート制限。
 * スライディングウィンドウより粗い（窓の境界で最大2倍通る）が、
 * 荒らし抑制という目的には十分で、状態が「窓の開始時刻＋回数」だけで済む。
 * 時刻は引数で受け取る＝テストが時計に依存しない。
 */
export function createRateLimiter(windowMs: number, max: number): RateLimiter {
  const hits = new Map<string, { windowStart: number; count: number }>()

  function prune(now: number): void {
    for (const [k, v] of hits) {
      if (now - v.windowStart >= windowMs) hits.delete(k)
    }
  }

  return {
    allow(key, now) {
      if (hits.size > PRUNE_THRESHOLD) prune(now)
      const entry = hits.get(key)
      if (!entry || now - entry.windowStart >= windowMs) {
        hits.set(key, { windowStart: now, count: 1 })
        return true
      }
      if (entry.count >= max) return false
      entry.count++
      return true
    },
    size() {
      return hits.size
    },
  }
}
```

`server/src/clientIp.ts`:

```typescript
// Railway/Render はプロキシ経由で到達するため、ソケットの接続元アドレスは
// プロキシのものになる。実クライアントは x-forwarded-for の先頭。
//
// ⚠️ Express の `trust proxy` は Socket.IO には効かない。だから HTTP 側も
// Socket.IO 側もこの関数を通して同じ規則で取り出す。
export function extractIp(forwardedFor: unknown, fallback: string | undefined): string {
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return first
  }
  return fallback ?? 'unknown'
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/rateLimit.test.ts src/clientIp.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: テストスクリプトに追記して型チェック**

`server/package.json` の `test` に ` src/rateLimit.test.ts src/clientIp.test.ts` を追記。

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 6: コミット**

```bash
git add server/src/rateLimit.ts server/src/rateLimit.test.ts server/src/clientIp.ts server/src/clientIp.test.ts server/package.json
git commit -m "feat: 自前レート制限とプロキシ経由IP抽出（HTTP/Socket.io 共用）"
```

---

### Task 4: 手書き台本ライブラリ（scriptLibrary.ts + plays/）

**Files:**
- Create: `server/src/ai/scriptLibrary.ts`, `plays/comedy-konbini.json`, `plays/horror-gakkou.json`
- Test: `server/src/ai/scriptLibrary.test.ts`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `generateStubScript`（既存 `./scriptStub`）、`GENRE_IDS`/`MAX_PLAYERS`（`@shared/constants`）
- Produces:
  - `parsePlay(raw: unknown): Play | null`
  - `loadPlays(dir: string): Play[]`
  - `selectPlay(plays: Play[], genre: string, playerCount: number, pick?: (xs: Play[]) => Play): Play | null`
  - `toScriptData(play: Play, playerNames: string[]): ScriptData`
  - `generateLibraryScript(genre: string, playerNames: string[]): ScriptData`
  - `__setPlaysForTest(plays: Play[]): void` / `__resetPlaysForTest(): void`
  - `interface Play { id, genre, title, minPlayers, maxPlayers, worldSetting, roles: {role,description}[], entries: {roleIndex,action?,line}[] }`

- [ ] **Step 1: 台本ファイルを2本作る**

`plays/comedy-konbini.json`:

```json
{
  "id": "comedy-konbini",
  "genre": "comedy",
  "title": "深夜のコンビニ",
  "minPlayers": 2,
  "maxPlayers": 4,
  "worldSetting": "深夜2時のコンビニ。客はほとんど来ない。今夜だけ、何かがおかしい。",
  "roles": [
    { "role": "新人店員", "description": "働き始めて3日目。マニュアルだけが頼り。" },
    { "role": "常連客", "description": "毎晩おでんを買いに来る。今夜は妙にそわそわしている。" },
    { "role": "店長", "description": "休みのはずなのに来てしまった。そういう人。" },
    { "role": "宅配ドライバー", "description": "荷物を届けに来たが、伝票の宛先がこの店ではない。" }
  ],
  "entries": [
    { "roleIndex": 0, "action": "レジで大きくあくびをする", "line": "……いらっしゃいませー。あ、すみません、寝てました。" },
    { "roleIndex": 1, "line": "いつもの。おでん、玉子とちくわ。……あとひとつ、聞いてもいい？" },
    { "roleIndex": 0, "line": "はい、なんでしょう。おでんのことなら3日目なりに答えます。" },
    { "roleIndex": 1, "action": "声をひそめる", "line": "この店、去年の12月に一度つぶれてるって、知ってた？" },
    { "roleIndex": 0, "action": "手が止まる", "line": "……え。じゃあ僕、なんの面接を受けたんですか。" },
    { "roleIndex": 2, "action": "自動ドアから入ってくる", "line": "おつかれさま！ いや、休みなんだけどね、なんか呼ばれた気がして。" },
    { "roleIndex": 1, "line": "ほら来た。この人、去年もこう言って来たのよ。" },
    { "roleIndex": 2, "line": "去年？ 去年のことは、ちょっと、思い出せないな。" },
    { "roleIndex": 3, "action": "台車を押して現れる", "line": "お届けものでーす。宛先……『深夜のコンビニ様』。住所、書いてないんですけど。" },
    { "roleIndex": 0, "line": "受け取りません。僕はまだ3日目なので、受け取る権限がありません。" },
    { "roleIndex": 3, "line": "困りますね。じゃあ誰が受け取るんですか、これ。" },
    { "roleIndex": 2, "action": "満面の笑みで", "line": "私が受け取ろう。店長だからね。……で、何の店だったっけ、ここ。" }
  ]
}
```

`plays/horror-gakkou.json`:

```json
{
  "id": "horror-gakkou",
  "genre": "horror",
  "title": "七不思議のはずが",
  "minPlayers": 2,
  "maxPlayers": 3,
  "worldSetting": "放課後の旧校舎。七不思議を確かめに来たが、数え上げると八つある。",
  "roles": [
    { "role": "言い出しっぺ", "description": "肝試しを提案した本人。今いちばん帰りたがっている。" },
    { "role": "冷静な人", "description": "怖がらない。ただし理屈が合わないことにだけは怯える。" },
    { "role": "先に来ていた人", "description": "呼んでいないのに、なぜかもう中にいる。" }
  ],
  "entries": [
    { "roleIndex": 0, "action": "懐中電灯であちこち照らす", "line": "な、七不思議って言っても、どうせ全部ウソだって。ぜんぶ。うん。" },
    { "roleIndex": 1, "line": "数えたよ。八つある。" },
    { "roleIndex": 0, "line": "……は？ 七不思議だろ。七つじゃないの。" },
    { "roleIndex": 1, "action": "指を折って数え直す", "line": "音楽室、理科室、階段、鏡、トイレ……いや、八つ。何度数えても八つ。" },
    { "roleIndex": 0, "action": "後ずさる", "line": "今なんて言った？ 途中、聞いたことない言葉が混ざってた。" },
    { "roleIndex": 1, "line": "言ってない。わたしは、七不思議のうち八つ目を、数えただけ。" },
    { "roleIndex": 2, "action": "暗がりから声だけ", "line": "おそいよ。ずっと待ってた。" },
    { "roleIndex": 0, "action": "叫ぶ", "line": "誰！？ 誰か呼んだ！？ 俺、二人でって言ったよな！？" },
    { "roleIndex": 2, "line": "呼ばれたよ。八つ目に。" },
    { "roleIndex": 1, "action": "懐中電灯を向ける。誰もいない", "line": "……声はする。でも、いない。これは、理屈が合わない。" }
  ]
}
```

- [ ] **Step 2: 失敗するテストを書く**

`server/src/ai/scriptLibrary.test.ts`:

```typescript
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePlay, loadPlays, selectPlay, toScriptData, generateLibraryScript,
  __setPlaysForTest, __resetPlaysForTest, type Play,
} from './scriptLibrary'

afterEach(() => __resetPlaysForTest())

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

test('parsePlay は minPlayers < 2 を弾く', () => {
  assert.equal(parsePlay(makePlay({ minPlayers: 1 })), null)
})

test('parsePlay は maxPlayers < minPlayers を弾く', () => {
  assert.equal(parsePlay(makePlay({ minPlayers: 3, maxPlayers: 2 })), null)
})

test('parsePlay は JSON でない値を弾く', () => {
  assert.equal(parsePlay(null), null)
  assert.equal(parsePlay('文字列'), null)
  assert.equal(parsePlay(42), null)
})

test('loadPlays は壊れたファイルをスキップして残りを読む', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plays-'))
  try {
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(makePlay({ id: 'ok' })))
    writeFileSync(join(dir, 'broken.json'), '{ これはJSONではない')
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify(makePlay({ genre: 'nope' })))
    writeFileSync(join(dir, 'notjson.txt'), 'ignored')
    const plays = loadPlays(dir)
    assert.equal(plays.length, 1)
    assert.equal(plays[0]?.id, 'ok')
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
  __setPlaysForTest([])
  const s = generateLibraryScript('comedy', ['たろう', 'はなこ'])
  assert.equal(s.roles.length, 2)
  assert.ok(s.worldSetting.length > 0)
})

test('generateLibraryScript は台本があればそれを使う', () => {
  __setPlaysForTest([makePlay({ worldSetting: 'ライブラリの世界' })])
  const s = generateLibraryScript('comedy', ['たろう', 'はなこ'])
  assert.equal(s.worldSetting, 'ライブラリの世界')
})

test('同梱の plays/ が実際に読めて検証を通る', () => {
  const plays = loadPlays(new URL('../../../plays', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  assert.ok(plays.length >= 2, `plays/ から台本が読めていない（${plays.length}件）`)
})
```

- [ ] **Step 3: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/ai/scriptLibrary.test.ts`
Expected: FAIL（`Cannot find module './scriptLibrary'`）

- [ ] **Step 4: 実装を書く**

`server/src/ai/scriptLibrary.ts`:

```typescript
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { ScriptData, RoleInfo, ScriptEntry } from '@shared/types'
import { GENRE_IDS, MAX_PLAYERS } from '@shared/constants'
import { generateStubScript } from './scriptStub'

export interface PlayRole {
  role: string
  description: string
}

export interface PlayEntry {
  roleIndex: number
  action?: string
  line: string
}

export interface Play {
  id: string
  genre: string
  title: string
  minPlayers: number
  maxPlayers: number
  worldSetting: string
  roles: PlayRole[]
  entries: PlayEntry[]
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** 不正なら null を返す（throw しない）。呼び出し側は1本落として先へ進む。 */
export function parsePlay(raw: unknown): Play | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>

  if (!isNonEmptyString(p.id)) return null
  if (!isNonEmptyString(p.genre) || !GENRE_IDS.includes(p.genre)) return null
  if (!isNonEmptyString(p.title)) return null
  if (!isNonEmptyString(p.worldSetting)) return null

  const min = p.minPlayers
  const max = p.maxPlayers
  if (!Number.isInteger(min) || (min as number) < 2) return null
  if (!Number.isInteger(max) || (max as number) < (min as number)) return null
  if ((max as number) > MAX_PLAYERS) return null

  if (!Array.isArray(p.roles)) return null
  const roles: PlayRole[] = []
  for (const r of p.roles) {
    if (typeof r !== 'object' || r === null) return null
    const rr = r as Record<string, unknown>
    if (!isNonEmptyString(rr.role) || !isNonEmptyString(rr.description)) return null
    roles.push({ role: rr.role, description: rr.description })
  }
  // 最大人数ぶんの役が無いと、その人数で選ばれたときに割り当てられない
  if (roles.length < (max as number)) return null

  if (!Array.isArray(p.entries) || p.entries.length === 0) return null
  const entries: PlayEntry[] = []
  for (const e of p.entries) {
    if (typeof e !== 'object' || e === null) return null
    const ee = e as Record<string, unknown>
    if (!Number.isInteger(ee.roleIndex)) return null
    const idx = ee.roleIndex as number
    if (idx < 0 || idx >= roles.length) return null
    if (!isNonEmptyString(ee.line)) return null
    if (ee.action !== undefined && !isNonEmptyString(ee.action)) return null
    entries.push({ roleIndex: idx, action: ee.action as string | undefined, line: ee.line })
  }

  return {
    id: p.id,
    genre: p.genre,
    title: p.title,
    minPlayers: min as number,
    maxPlayers: max as number,
    worldSetting: p.worldSetting,
    roles,
    entries,
  }
}

/** ディレクトリ内の *.json を読む。壊れた1本でサーバーを落とさない。 */
export function loadPlays(dir: string): Play[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    console.warn(`[server] 台本ディレクトリを読めません: ${dir}`)
    return []
  }
  const plays: Play[] = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      const play = parsePlay(JSON.parse(readFileSync(path, 'utf-8')))
      if (play) plays.push(play)
      else console.warn(`[server] 台本の形式が不正なのでスキップ: ${file}`)
    } catch (err) {
      console.warn(`[server] 台本を読めないのでスキップ: ${file}`, err)
    }
  }
  return plays
}

function randomPick(xs: Play[]): Play {
  return xs[Math.floor(Math.random() * xs.length)]!
}

/**
 * ①ジャンル一致かつ人数が合う → ②ジャンル不問で人数が合う → ③null。
 * ②があるので「そのジャンルの台本がまだ無い」組み合わせでも穴が空かない。
 */
export function selectPlay(
  plays: Play[],
  genre: string,
  playerCount: number,
  pick: (xs: Play[]) => Play = randomPick,
): Play | null {
  const fits = (p: Play) => playerCount >= p.minPlayers && playerCount <= p.maxPlayers
  const sameGenre = plays.filter(p => p.genre === genre && fits(p))
  if (sameGenre.length > 0) return pick(sameGenre)
  const anyGenre = plays.filter(fits)
  if (anyGenre.length > 0) return pick(anyGenre)
  return null
}

/**
 * 参加人数 N で ScriptData に変換する。
 * 役は先頭から N 件、セリフは roleIndex < N のものだけを順序を保って残す。
 * ＝台本作者は「先頭 minPlayers 役だけでも成立する」ように書く必要がある。
 */
export function toScriptData(play: Play, playerNames: string[]): ScriptData {
  const n = playerNames.length
  const roles: RoleInfo[] = playerNames.map((player, i) => ({
    player,
    role: play.roles[i]!.role,
    description: play.roles[i]!.description,
  }))
  const entries: ScriptEntry[] = play.entries
    .filter(e => e.roleIndex < n)
    .map(e => ({
      player: playerNames[e.roleIndex]!,
      character: play.roles[e.roleIndex]!.role,
      action: e.action,
      line: e.line,
    }))
  return { worldSetting: play.worldSetting, roles, entries }
}

/** リポジトリ直下 plays/。cwd 基準にすると起動ディレクトリ次第で取りこぼす。 */
export function playsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // server/src/ai
  return resolve(here, '../../../plays')
}

let cache: Play[] | null = null

/** 起動時に呼んで件数をログに出す用。読み込み済みの件数を返す。 */
export function initPlayLibrary(dir: string = playsDir()): number {
  cache = loadPlays(dir)
  return cache.length
}

/** 上限到達時の台本生成。generateStubScript と同じシグネチャで差し替えられる。 */
export function generateLibraryScript(genre: string, playerNames: string[]): ScriptData {
  if (cache === null) cache = loadPlays(playsDir())
  const play = selectPlay(cache, genre, playerNames.length)
  if (!play) return generateStubScript(genre, playerNames)
  return toScriptData(play, playerNames)
}

export function __setPlaysForTest(plays: Play[]): void {
  cache = plays
}
export function __resetPlaysForTest(): void {
  cache = null
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server && npx tsx --test src/ai/scriptLibrary.test.ts`
Expected: PASS（18 tests）

最後の「同梱の plays/ が実際に読めて検証を通る」が落ちる場合、`plays/*.json` の内容が `parsePlay` を通っていない。`loadPlays` の警告ログにどのファイルが落ちたか出るので、それを見て JSON を直す。

- [ ] **Step 6: 起動時にログを出す**

`server/src/index.ts` の `httpServer.listen` コールバック内、`console.log('[server] mode: ...')` の直後に追加:

```typescript
  const playCount = initPlayLibrary()
  console.log(`[server] 手書き台本: ${playCount} 本`)
```

ファイル冒頭の import 群に追加:

```typescript
import { initPlayLibrary } from './ai/scriptLibrary'
```

- [ ] **Step 7: テストスクリプトに追記して型チェック**

`server/package.json` の `test` に ` src/ai/scriptLibrary.test.ts` を追記。

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 8: コミット**

```bash
git add plays server/src/ai/scriptLibrary.ts server/src/ai/scriptLibrary.test.ts server/src/index.ts server/package.json
git commit -m "feat: 手書き台本ライブラリ（plays/ から読み込み・人数で役をスライス）"
```

---

### Task 5: Room.aiMode と RoomSnapshot.aiAvailable

**Files:**
- Modify: `shared/types.ts`, `server/src/roomStore.ts`, `server/src/roomStore.test.ts`
- Modify: `client/src/App.tsx`, `client/src/useGameSocket.ts`

**Interfaces:**
- Consumes: `isAiAvailable(now)`（Task 2）
- Produces: `Room.aiMode: boolean`（サーバー内部）／`RoomSnapshot.aiAvailable: boolean`（クライアントへ）

- [ ] **Step 1: 失敗するテストを書く**

`server/src/roomStore.test.ts` の末尾に追記:

```typescript
test('createRoom は aiMode を true で初期化する（start_game で確定するまでの既定）', () => {
  const room = createRoom('s1', 'たろう')
  assert.equal(room.aiMode, true)
})

test('toSnapshot は aiAvailable を毎回その場で計算する', () => {
  process.env.DAILY_GAME_LIMIT = '1'
  __resetQuotaForTest()
  const room = createRoom('s1', 'たろう')
  assert.equal(toSnapshot(room).aiAvailable, true)
  tryConsumeGame(new Date())
  // room は何も変えていないが、枠を使い切ったので false になる
  assert.equal(toSnapshot(room).aiAvailable, false)
  delete process.env.DAILY_GAME_LIMIT
  __resetQuotaForTest()
})
```

`server/src/roomStore.test.ts` の import 群に追記:

```typescript
import { tryConsumeGame, __resetQuotaForTest } from './quota'
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/roomStore.test.ts`
Expected: FAIL（`aiMode` / `aiAvailable` が存在しない）

- [ ] **Step 3: 型に追加する**

`shared/types.ts` の `RoomSnapshot` に1行追加:

```typescript
export interface RoomSnapshot {
  code: string
  status: RoomStatus
  genre: string
  players: PlayerSnapshot[]
  script: ScriptData | null
  scores: PlayerScore[]
  bgm: string | null // 再接続時に録音中のBGMも復元できるようにする
  aiAvailable: boolean // 「いまゲームを始めたら実AIが使えるか」。表示用で、進行中のゲームのモードとは別物
}
```

- [ ] **Step 4: roomStore を変更する**

`server/src/roomStore.ts` の import に追加:

```typescript
import { isAiAvailable } from './quota'
```

`Room` インターフェースに1行追加（`generatingScript: boolean` の直後）:

```typescript
  // このゲームが実AIで進むか（start_game で確定し、そのゲームの間は変えない）
  aiMode: boolean
```

`createRoom` の初期化に追加（`generatingScript: false,` の直後）:

```typescript
    aiMode: true,
```

`toSnapshot` に1行追加:

```typescript
export function toSnapshot(room: Room): RoomSnapshot {
  return {
    code: room.code,
    status: room.status,
    genre: room.genre,
    players: [...room.players.values()].map(p => ({
      name: p.name,
      isHost: p.isHost,
      isReady: p.isReady,
      connected: p.disconnectedAt == null,
    })),
    script: room.script,
    scores: room.scores,
    bgm: room.bgm,
    // room.aiMode（進行中ゲームの確定値）ではなく毎回その場で計算する。
    // ロビーに出す「いま始めたらAIか」は他の部屋が枠を使えば変わるため。
    aiAvailable: isAiAvailable(new Date()),
  }
}
```

`resetRoom` に1行追加（`room.generatingScript = false` の直後）:

```typescript
  room.aiMode = true // 次のゲームの start_game で改めて確定する
```

- [ ] **Step 5: クライアント側の型を通す**

`client/src/App.tsx` の `GameContext` に `aiAvailable: boolean` を追加し、初期値を `true` にする。

`client/src/useGameSocket.ts` で room スナップショットを ctx に展開している **6箇所すべて**（`onRoomCreated` / `onRoomJoined` / `onRoomReset` / `onGameAborted` / `onEvaluationFailed` / `onRejoined`）に `aiAvailable: room.aiAvailable,` を追加する。`genre: room.genre,` を書いている行の並びに足せばよい。

- [ ] **Step 6: テストと型チェック**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

Run: `npm --prefix client run build`
Expected: tsc / vite build 成功

> 型エラーが出たら、それは `RoomSnapshot` を組み立てている箇所の漏れ。`tsx` は型を見ないので `npm test` だけでは検出できない。必ず `tsc --noEmit` を通すこと。

- [ ] **Step 7: コミット**

```bash
git add shared/types.ts server/src/roomStore.ts server/src/roomStore.test.ts client/src/App.tsx client/src/useGameSocket.ts
git commit -m "feat: Room.aiMode と RoomSnapshot.aiAvailable を追加"
```

---

### Task 6: start_game に枠消費と台本の分岐を配線

**Files:**
- Modify: `server/src/handlers.ts:224-259`
- Test: `server/src/handlers.guard.test.ts`（新規）
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `tryConsumeGame`（Task 2）、`aiEnabled`（Task 1）、`generateLibraryScript`（Task 4）、`Room.aiMode`（Task 5）
- Produces: `start_game` 実行後に `room.aiMode` が確定していること

- [ ] **Step 1: 失敗するテストを書く**

`server/src/handlers.guard.test.ts`:

```typescript
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeRoom, once } from './testUtils'
import { _clearAllRooms, findRoomBySocket } from './roomStore'
import { __resetQuotaForTest } from './quota'
import { __setPlaysForTest, __resetPlaysForTest } from './ai/scriptLibrary'

beforeEach(() => {
  _clearAllRooms()
  __resetQuotaForTest()
  __setPlaysForTest([]) // 台本ゼロ＝スタブに落ちる。台本の中身に依存しないテストにする
})

afterEach(() => {
  delete process.env.DAILY_GAME_LIMIT
  delete process.env.AI_ENABLED
  delete process.env.PUBLIC_ENABLED
  __resetQuotaForTest()
  __resetPlaysForTest()
  _clearAllRooms()
})

test('枠が残っていれば aiMode=true で開始する', async () => {
  process.env.DAILY_GAME_LIMIT = '1'
  const server = await startTestServer()
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    await readyGuest
    await readyHost
    const room = findRoomBySocket(r.host.id!)
    assert.equal(room?.aiMode, true)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('枠を使い切ったら aiMode=false で開始し、台本は出る', async () => {
  process.env.DAILY_GAME_LIMIT = '0' // 最初から枠なし
  const server = await startTestServer()
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once<{ script: { roles: unknown[] } }>(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    const payload = await readyGuest
    await readyHost
    // 簡易モードでもゲームは成立する＝台本が届き、役が人数分ある
    assert.equal(payload.script.roles.length, 2)
    const room = findRoomBySocket(r.host.id!)
    assert.equal(room?.aiMode, false)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('AI_ENABLED=false なら枠が残っていても aiMode=false', async () => {
  process.env.DAILY_GAME_LIMIT = '10'
  process.env.AI_ENABLED = 'false'
  const server = await startTestServer()
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    await readyGuest
    await readyHost
    const room = findRoomBySocket(r.host.id!)
    assert.equal(room?.aiMode, false)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('AI_ENABLED=false のときは枠を消費しない', async () => {
  process.env.DAILY_GAME_LIMIT = '1'
  process.env.AI_ENABLED = 'false'
  const server = await startTestServer()
  try {
    const r = await makeRoom(server.port)
    r.host.emit('set_genre', { genre: 'comedy' })
    await once(r.guest, 'genre_changed')
    const readyGuest = once(r.guest, 'script_ready')
    const readyHost = once(r.host, 'script_ready')
    r.host.emit('start_game')
    await readyGuest
    await readyHost
    // AI を呼んでいないので枠は減っていない
    const { getQuotaState } = await import('./quota')
    assert.equal(getQuotaState(new Date()).used, 0)
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/handlers.guard.test.ts`
Expected: FAIL（1本目以外が落ちる。枠を見ずに常に実AI経路へ行くため）

- [ ] **Step 3: handlers を変更する**

`server/src/handlers.ts` の import に追加:

```typescript
import { aiEnabled, publicEnabled } from './config'
import { tryConsumeGame } from './quota'
import { generateLibraryScript } from './ai/scriptLibrary'
```

（`publicEnabled` は Task 8 で使う。ここで一緒に import しておく。）

`socket.on('start_game', ...)` の `room.generatingScript = true` の**直前**に1行追加し、`generateScript` の呼び出しを分岐させる:

```typescript
    const code = room.code
    const names = [...room.players.values()].map(p => p.name)
    // 課金の判定はここ1箇所だけ。以降このゲームは aiMode で一貫させる。
    // AI_ENABLED=false のときは短絡して枠を消費しない（AIを呼ばないので当然）。
    room.aiMode = aiEnabled() && tryConsumeGame(new Date())
    room.generatingScript = true
    touch(room)
    io.to(code).emit('script_generating')
    try {
      const script = room.aiMode
        ? await generateScript(room.genre, names)
        : generateLibraryScript(room.genre, names)
      if (getRoom(code) !== room) return // 生成中にホスト切断→解散したケース
      room.generatingScript = false
      room.script = script
      room.status = 'casting'
      touch(room)
      io.to(code).emit('script_ready', { script })
    } catch {
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.guard.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: テストスクリプトに追記して全体を確認**

`server/package.json` の `test` に ` src/handlers.guard.test.ts` を追記。

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 6: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.guard.test.ts server/package.json
git commit -m "feat: start_game で日次枠を消費し aiMode を確定（簡易モードは手書き台本）"
```

---

### Task 7: finalizeEvaluation を aiMode で分岐

**Files:**
- Modify: `server/src/handlers.ts:78-115`
- Test: `server/src/handlers.guard.test.ts`（追記）

**Interfaces:**
- Consumes: `Room.aiMode`（Task 5）、`generateStubScores`（既存 `./ai/scoreStub`）
- Produces: 簡易モードのゲームが実APIを一切呼ばずに `evaluation_complete` まで到達すること

- [ ] **Step 1: 失敗するテストを追記**

`server/src/handlers.guard.test.ts` の末尾に追記:

```typescript
test('簡易モードのゲームは evaluatePerformance を呼ばずにスコアを返す', async () => {
  process.env.DAILY_GAME_LIMIT = '0'
  const { __setEvaluatorForTest, __resetEvaluatorForTest } = await import('./ai/evaluate')
  let evaluatorCalled = false
  __setEvaluatorForTest(async () => {
    evaluatorCalled = true
    return []
  })
  const { __setUploadTimeoutForTest, __resetUploadTimeoutForTest } = await import('./handlers')
  __setUploadTimeoutForTest(100) // アップロードを待たずタイムアウトで確定させる
  const server = await startTestServer()
  try {
    const { makeRecordingRoom } = await import('./testUtils')
    const r = await makeRecordingRoom(server.port)
    const doneGuest = once<{ scores: unknown[] }>(r.guest, 'evaluation_complete', 5000)
    const doneHost = once(r.host, 'evaluation_complete', 5000)
    r.host.emit('stop_recording')
    const payload = await doneGuest
    await doneHost
    assert.equal(evaluatorCalled, false, '簡易モードなのに実評価が呼ばれている')
    assert.equal(payload.scores.length, 2, 'スタブ採点で2人分のスコアが出るべき')
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    __resetEvaluatorForTest()
    __resetUploadTimeoutForTest()
    await server.close()
  }
})
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/handlers.guard.test.ts`
Expected: FAIL（`evaluatorCalled` が true。`aiMode` を見ずに常に `evaluatePerformance` を呼ぶため）

- [ ] **Step 3: handlers を変更する**

`server/src/handlers.ts` の import に追加:

```typescript
import { generateStubScores } from './ai/scoreStub'
```

`finalizeEvaluation` の `try` ブロック冒頭を差し替える:

```typescript
  try {
    // 簡易モードのゲームは実APIを一切呼ばない（課金しない）。
    // 分岐を evaluate.ts ではなくここに置くのは、evaluatePerformance の
    // シグネチャを変えずに済み既存テストへの影響が無いため。
    const scores = room.aiMode
      ? await evaluatePerformance(script, performers, audioByName)
      : generateStubScores(performers)
    if (getRoom(code) !== room || room.evaluationSeq !== myEval) return // 解散/リセット/再ゲームで無効化
    room.scores = scores
    touch(room)
    io.to(code).emit('evaluation_complete', { scores, leftPlayers })
  } catch (err) {
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.guard.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 全体を確認**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 6: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.guard.test.ts
git commit -m "feat: 簡易モードのゲームはスタブ採点にして実APIを呼ばない"
```

---

### Task 8: PUBLIC_ENABLED と create_room のレート制限

**Files:**
- Modify: `server/src/handlers.ts:146-156`
- Test: `server/src/handlers.guard.test.ts`（追記）

**Interfaces:**
- Consumes: `publicEnabled()`（Task 1）、`createRateLimiter`（Task 3）、`extractIp`（Task 3）
- Produces: `create_room` が停止中／過剰時に `error` を返して部屋を作らないこと

- [ ] **Step 1: 失敗するテストを追記**

`server/src/handlers.guard.test.ts` の末尾に追記:

```typescript
test('PUBLIC_ENABLED=false なら新規ルームを作れない', async () => {
  process.env.PUBLIC_ENABLED = 'false'
  const server = await startTestServer()
  try {
    const { connectClient } = await import('./testUtils')
    const sock = connectClient(server.port)
    sock.emit('create_room', { playerName: 'たろう' })
    const err = await once<{ message: string }>(sock, 'error')
    assert.match(err.message, /停止/)
    sock.disconnect()
  } finally {
    await server.close()
  }
})

test('PUBLIC_ENABLED=false でも進行中のゲームは壊れない（join は従来どおり動く）', async () => {
  const server = await startTestServer()
  try {
    const r = await makeRoom(server.port) // 有効なうちに部屋を作る
    process.env.PUBLIC_ENABLED = 'false'
    const { connectClient } = await import('./testUtils')
    const late = connectClient(server.port)
    late.emit('join_room', { roomCode: r.roomCode, playerName: 'じろう' })
    const joined = await once<{ room: { players: unknown[] } }>(late, 'room_joined')
    assert.equal(joined.room.players.length, 3)
    late.disconnect()
    r.host.disconnect()
    r.guest.disconnect()
  } finally {
    await server.close()
  }
})

test('同一IPから短時間に作りすぎるとレート制限で断られる', async () => {
  const server = await startTestServer()
  try {
    const { connectClient } = await import('./testUtils')
    const socks = []
    // 上限は 60 秒に 5 回。6 個目は断られる。
    for (let i = 0; i < 5; i++) {
      const s = connectClient(server.port)
      s.emit('create_room', { playerName: `p${i}` })
      await once(s, 'room_created')
      socks.push(s)
    }
    const over = connectClient(server.port)
    over.emit('create_room', { playerName: 'over' })
    const err = await once<{ message: string }>(over, 'error')
    assert.match(err.message, /作りすぎ/)
    over.disconnect()
    for (const s of socks) s.disconnect()
  } finally {
    await server.close()
  }
})
```

> ⚠️ このレート制限テストはモジュールスコープの limiter を共有するため、**同ファイル内の他のテストに影響する**。`create_room` を使うテスト（`makeRoom`）が5回を超えると誤って断られる。実装では limiter をテストからリセットできるようにし、`beforeEach` で呼ぶこと（Step 3・Step 4 で対応）。

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/handlers.guard.test.ts`
Expected: FAIL（`PUBLIC_ENABLED` もレート制限も未実装なので、期待した `error` が来ずタイムアウト）

- [ ] **Step 3: handlers を変更する**

`server/src/handlers.ts` の import に追加:

```typescript
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'
```

定数と limiter をモジュールスコープに追加（`const VOLUME_BROADCAST_MS = 200` の下）:

```typescript
// ルーム乱造の抑制。課金の歯止めは日次上限が担うので、ここは荒らし対策の粗い網でよい。
const ROOM_CREATE_WINDOW_MS = 60_000
const ROOM_CREATE_MAX = 5
let roomCreateLimiter = createRateLimiter(ROOM_CREATE_WINDOW_MS, ROOM_CREATE_MAX)

export function __resetRateLimitForTest(): void {
  roomCreateLimiter = createRateLimiter(ROOM_CREATE_WINDOW_MS, ROOM_CREATE_MAX)
}

function socketIp(socket: Sock): string {
  return extractIp(socket.handshake.headers['x-forwarded-for'], socket.handshake.address)
}
```

`socket.on('create_room', ...)` の冒頭に2つのガードを追加:

```typescript
  socket.on('create_room', ({ playerName }) => {
    if (!publicEnabled()) {
      socket.emit('error', { message: 'ただいま新規ルームの作成を停止しています' })
      return
    }
    if (!roomCreateLimiter.allow(socketIp(socket), Date.now())) {
      socket.emit('error', { message: 'ルームを作りすぎです。少し待ってからお試しください' })
      return
    }
    const name = sanitizeName(playerName ?? '')
    // …以下は既存のまま
```

- [ ] **Step 4: テストの beforeEach に limiter リセットを足す**

`server/src/handlers.guard.test.ts` の import に追加:

```typescript
import { __resetRateLimitForTest } from './handlers'
```

`beforeEach` に1行追加:

```typescript
beforeEach(() => {
  _clearAllRooms()
  __resetQuotaForTest()
  __resetRateLimitForTest() // limiter はモジュールスコープ＝テスト間で持ち越さない
  __setPlaysForTest([])
})
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.guard.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 6: 全体を確認**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

> 既存の統合テストが落ちる場合、`create_room` の5回制限に引っかかっている可能性がある。その場合は落ちたテストファイルにも `__resetRateLimitForTest()` を `beforeEach` で入れる。

- [ ] **Step 7: コミット**

```bash
git add server/src/handlers.ts server/src/handlers.guard.test.ts
git commit -m "feat: PUBLIC_ENABLED キルスイッチと create_room のレート制限"
```

---

### Task 9: trust proxy と /upload のレート制限

**Files:**
- Modify: `server/src/server.ts`, `server/src/uploadRoute.ts`
- Test: `server/src/handlers.upload.test.ts`（追記）

**Interfaces:**
- Consumes: `createRateLimiter` / `extractIp`（Task 3）
- Produces: `/upload` が過剰時に 429 を返すこと

- [ ] **Step 1: 失敗するテストを追記**

`server/src/handlers.upload.test.ts` の末尾に追記:

```typescript
test('POST /upload は同一IPから短時間に叩きすぎると 429 を返す', async () => {
  const { __resetUploadRateLimitForTest } = await import('./uploadRoute')
  __resetUploadRateLimitForTest()
  const server = await startTestServer()
  try {
    // 上限は 60 秒に 30 回。socketId 無しの 400 でもレート制限は数える。
    let last = 0
    for (let i = 0; i < 31; i++) {
      const res = await fetch(`http://localhost:${server.port}/upload`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.1' },
        body: new FormData(),
      })
      last = res.status
    }
    assert.equal(last, 429)
  } finally {
    __resetUploadRateLimitForTest()
    await server.close()
  }
})
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `cd server && npx tsx --test src/handlers.upload.test.ts`
Expected: FAIL（`Cannot find module` もしくは最後のステータスが 400 のまま）

- [ ] **Step 3: server.ts に trust proxy を足す**

`server/src/server.ts` の `const app = express()` の直後に追加:

```typescript
  // Railway/Render はプロキシ経由。設定しないと req.ip が全員同じになり、
  // レート制限が全ユーザーをまとめて1人として扱ってしまう。
  // ⚠️ この設定は Socket.IO には効かない（そちらは clientIp.ts で個別に取る）。
  app.set('trust proxy', 1)
```

- [ ] **Step 4: uploadRoute にレート制限を足す**

`server/src/uploadRoute.ts` の import に追加:

```typescript
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'
```

定数と limiter を追加（`const upload = multer({...})` の下）:

```typescript
// 最大10人 × 複数ゲームを想定した緩めの値。正常なプレイを止めないことを優先し、
// 絞るのは日次上限の役目とする。ここはメモリ枯渇を防ぐための粗い網。
const UPLOAD_WINDOW_MS = 60_000
const UPLOAD_MAX = 30
let uploadLimiter = createRateLimiter(UPLOAD_WINDOW_MS, UPLOAD_MAX)

export function __resetUploadRateLimitForTest(): void {
  uploadLimiter = createRateLimiter(UPLOAD_WINDOW_MS, UPLOAD_MAX)
}
```

`app.post('/upload', ...)` の**第2引数として、`upload.single('audio')` より前に**ミドルウェアを挿す:

```typescript
  app.post(
    '/upload',
    // multer より前に置くのが肝。後ろだと最大25MBをRAMに展開してから弾くことになり、
    // メモリ枯渇を防ぐという目的を果たさない。
    (req: Request, res: Response, next: NextFunction) => {
      const ip = extractIp(req.headers['x-forwarded-for'], req.ip)
      if (!uploadLimiter.allow(ip, Date.now())) {
        res.status(429).json({ ok: false })
        return
      }
      next()
    },
    upload.single('audio'),
    (req: Request, res: Response) => {
      // …以下は既存のまま
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd server && npx tsx --test src/handlers.upload.test.ts`
Expected: PASS

- [ ] **Step 6: 全体を確認**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: 型エラー0・全テスト green

- [ ] **Step 7: コミット**

```bash
git add server/src/server.ts server/src/uploadRoute.ts server/src/handlers.upload.test.ts
git commit -m "feat: trust proxy と /upload のレート制限（multer より前で弾く）"
```

---

### Task 10: 簡易モードの表示・ドキュメント・最終検証

**Files:**
- Modify: `client/src/screens/LobbyScreen.tsx`, `.env.example`, `doc/仕様書.md`

**Interfaces:**
- Consumes: `ctx.aiAvailable`（Task 5）
- Produces: なし（最終タスク）

- [ ] **Step 1: ロビーに簡易モードの表示を足す**

`client/src/screens/LobbyScreen.tsx` のジャンル選択セクションの直前に追加する。既存の Tailwind の書き方（`rounded-2xl` / `text-sm` / 淡色背景）に合わせること:

```tsx
      {!ctx.aiAvailable && (
        <div className="mb-4 px-4 py-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          本日のAI枠は終了しました。用意された台本で遊べます（採点は簡易版になります）。
        </div>
      )}
```

- [ ] **Step 2: クライアントをビルドして確認**

Run: `npm --prefix client run build`
Expected: tsc / vite build 成功

- [ ] **Step 3: .env.example に新変数を追記**

`.env.example` の `PORT=` の下に追記:

```
# --- 公開ガード（スライスB）---
# 1日にAIを使えるゲーム数。既定 5。0 にすると常に簡易モード。
# ⚠️ カウンタはメモリ上にしか無いので、再デプロイ・再起動で枠は戻る。
#    本当の最後の砦は Anthropic / Groq コンソール側の支払上限。
DAILY_GAME_LIMIT=

# false で枠に関係なく全ゲームを簡易モード（手書き台本＋スタブ採点）にする。
AI_ENABLED=

# false で新規ルーム作成を拒否する。進行中のゲームは継続する。
PUBLIC_ENABLED=
```

- [ ] **Step 4: 仕様書に公開ガードの節を追記**

`doc/仕様書.md` の末尾に追加:

```markdown
---

## 9. 公開ガード

URLを配って運用するための歯止め。詳細は `docs/superpowers/specs/2026-08-13-public-guard-slice-b-design.md`。

| 環境変数 | 既定 | 効果 |
|---|---|---|
| `DAILY_GAME_LIMIT` | 5 | 1日にAIを使えるゲーム数 |
| `AI_ENABLED` | true | false で全ゲームを簡易モードに |
| `PUBLIC_ENABLED` | true | false で新規ルーム作成を拒否 |

- 枠の判定は `start_game` の入口で1回だけ行い、そのゲームは最後まで同じモードで進む（1ゲーム＝1消費・中断しても返さない）。
- 枠を使い切ったゲームは `plays/` の手書き台本＋スタブ採点で進む。AI は一切呼ばない。
- レート制限は `create_room` が同一IP 60秒に5回、`POST /upload` が同一IP 60秒に30回。
- カウンタはメモリ上のみ。再デプロイ・再起動でリセットされる。
```

- [ ] **Step 5: 全体の最終検証**

Run: `cd server && npx tsc --noEmit`
Expected: 0 errors

Run: `cd server && npm test`
Expected: 全テスト green・fail 0

Run: `npm --prefix client run build`
Expected: 成功

- [ ] **Step 6: コミット**

```bash
git add client/src/screens/LobbyScreen.tsx .env.example doc/仕様書.md
git commit -m "feat: 簡易モードのロビー表示・環境変数と仕様書の記載"
```

- [ ] **Step 7: 実キーでの動作確認（ユーザー実施）**

ローカルで `.env` に `DAILY_GAME_LIMIT=1` を設定し、server(3001)/client(5173) を起動して2タブで確認する。

確認項目:
1. 1ゲーム目：ロビーに警告バッジが**出ない**。AI生成の台本が出る
2. 1ゲーム目の結果まで進み、ロビーに戻る
3. 2ゲーム目：ロビーに「本日のAI枠は終了しました」が**出る**
4. 2ゲーム目を開始 → `plays/` の台本（深夜のコンビニ／七不思議のはずが）が出る
5. 録音・採点まで進み、スコアと講評が出る（スタブ採点）
6. サーバーログに `[server] 手書き台本: 2 本` が出ている

---

## Self-Review

**1. 仕様カバレッジ**

| 設計書の項目 | 実装タスク |
|---|---|
| §2 ゲート位置（start_game で1回・aiMode 固定） | Task 6 |
| §2 1ゲーム＝1消費・中断しても返さない | Task 6（`resetRoom` は枠に触れない＝返さない） |
| §3 日次カウンタ・JSTリセット・メモリのみ | Task 2 |
| §4 環境変数3つ・不正値フォールバック | Task 1 |
| §4 レート制限（自前・HTTP/Socket.io 共用） | Task 3・8・9 |
| §4 trust proxy と Socket.io の別扱い | Task 3（`clientIp.ts`）・Task 9 |
| §5 `plays/` JSON・起動時読み込み・壊れたらスキップ | Task 4 |
| §5 台本ごとの人数レンジ・先頭N役・3段フォールバック | Task 4 |
| §5 スタブ採点 | Task 7 |
| §6 プレイヤーへの表示 | Task 5（型）・Task 10（UI） |
| §7 テスト方針・既知の罠2つ | Global Constraints・各タスクの検証ステップ |
| §9 完了条件 | Task 10 Step 5・Step 7 |

**2. プレースホルダ走査**

「TBD」「後で実装」「適切にエラー処理」の類は無し。全コードステップに実物のコードを記載済み。

初稿の `horror-gakkou.json` にキリル文字の打ち間違いが混入していたので修正済み。**台本ファイルは `parsePlay` の検証を通っても中身の誤字までは検出できない**ため、Task 4 Step 5 で `plays/` の実読み込みテストを通したあと、Task 10 Step 7 の実プレイで台本の文面を目視すること。

**3. 型・名前の一貫性**

- `tryConsumeGame` / `getQuotaState` / `isAiAvailable` / `__resetQuotaForTest`：Task 2 で定義、Task 5・6 で使用。一致。
- `createRateLimiter(windowMs, max)` → `{ allow, size }`：Task 3 で定義、Task 8・9 で使用。一致。
- `extractIp(forwardedFor, fallback)`：Task 3 で定義、Task 8（`socketIp`）・Task 9 で使用。一致。
- `generateLibraryScript(genre, playerNames)`：Task 4 で定義、Task 6 で使用。`generateStubScript` と同シグネチャ。一致。
- `Room.aiMode` / `RoomSnapshot.aiAvailable`：Task 5 で定義、Task 6・7（`aiMode`）・Task 10（`aiAvailable`）で使用。**設計書§6の `aiMode` から名前を変えた理由は File Structure 節に明記済み。**
- `__resetRateLimitForTest`（handlers）と `__resetUploadRateLimitForTest`（uploadRoute）：別モジュールの別 limiter なので名前を分けている。意図的。

**4. 発見して埋めた漏れ**

- `server/package.json` の `test` は**ファイルを明示列挙**しているため、新規テストファイルの追記漏れが「テストが無いのに green」になる。全タスクの検証ステップに追記手順を入れた。
- `roomCreateLimiter` がモジュールスコープのため、既存の統合テストが5回制限に引っかかる可能性がある。Task 8 Step 4・Step 6 に対処を明記した。
- `/upload` のレート制限を multer の**前**に置く必要がある（後ろだと25MB展開後に弾くことになり目的を果たさない）。Task 9 Step 4 のコメントに明記した。
