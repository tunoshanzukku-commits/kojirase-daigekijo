# テスト専用フックの除去（依存注入への移行） 設計書

作成日: 2026-08-23

## 背景

本番モジュールから **25個のテスト専用フックが export されている**（`server/src` の12ファイル）。

| 分類 | 個数 | 対象 |
|---|---|---|
| 実装の差し替え | 10 | `ai/evaluate` `ai/scoreGen` `ai/scriptGen` `transcribe` `feedback` |
| モジュール状態のリセット | 5 | `ai/prompts` `ai/scriptLibrary` `quota` `roomStore` |
| 定数・上限の差し替え | 10 | `handlers`(8) `uploadRoute`(1) `feedbackRoute`(1) |

これらは本番実行時には一度も呼ばれない。テストコードを `tests/` へ切り分けた（HEAD `fec3514`）あとも、**本番とテストの関心が最も深く混ざっているのはここ**である。

### 25個は3種類に見えて根っこは1つ

どれも実装の形が同じである。

```ts
let uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS   // モジュールレベルの可変状態
export function __setUploadTimeoutForTest(ms: number): void { uploadTimeoutMs = ms }
```

**モジュールが直接状態を持っているため、外から書き換える口が必要になっている。** `roomStore` の `Map`、レート制限器のインスタンス、`prompts` のキャッシュ、`quota` のカウンタ、すべて同じ構造である。

したがって「フックを削る」ことは単独では成立しない。削ればテスト同士が状態を共有して総崩れになる。**実体は「モジュールレベルのシングルトンをやめ、状態をサーバーインスタンスに持たせる」改修**である。

## 決定事項

| # | 決定 | 理由 |
|---|------|------|
| 1 | **モジュールごとにファクトリ関数化する**（`createX(deps)` が関数群を返す） | ユーザー判断。設計として正統で、状態がインスタンスに閉じる |
| 2 | 組み立ては `buildServer` が一手に引き受ける | 依存の解決順序を1箇所で見切れる。`index.ts` は受け取って使うだけになる |
| 3 | **関数の中身は一字も変えない** | 差分を「インデント＋呼び出し名の置換」に閉じ込め、レビュー可能に保つ |
| 4 | **モジュール単位でコミットを分ける** | 1コミットの diff を読める大きさに保つ |
| 5 | 上限値は `limits` オブジェクトで注入する（環境変数化はしない） | 環境変数にすると本番の設定面が増える。テストのためだけに運用面を広げない |

### 案1（`ServerDeps` を登録関数の引数で通す）を採らなかった経緯

当初は案1を推奨した。差分が「引数追加＋呼び出し置換」に収まり、`handlers.ts` 533行が全面書き換えにならないためである。

ユーザーの判断で**案2（ファクトリ化）を採用**した。案2は設計として正統だが、`handlers.ts` をクロージャで包むため diff が全面的になる。**この設計書の「リスクと手当て」節は、その代償を打ち消すために存在する。**

## スコープ

**含む**
- `roomStore` `quota` `prompts` `scriptLibrary` のファクトリ化
- AI アダプタ（`scriptGen` `scoreGen` `transcribe` `evaluate`）と `feedback` のファクトリ化
- `handlers` `uploadRoute` `feedbackRoute` のファクトリ化
- `buildServer` による組み立てと `index.ts` の追随
- テスト30本の差し替え方法の移行（`startTestServer` のオプション化）
- **テスト専用 export 25個の削除**

**含まない**
- 機能の追加・変更（ユーザーに見える挙動は一切変えない）
- `config.ts` の環境変数（`DAILY_GAME_LIMIT` 等）の扱い変更
- クライアント側（`client/` は無改造）
- 演技時間の設定画面（本改修は下地になるが、別スライス）

## 構成

```
index.ts
  └ buildServer()  →  { httpServer, io, rooms }
        ├ rooms      = createRoomStore()
        ├ prompts    = createPrompts(promptsDir())
        ├ plays      = createScriptLibrary(playsDir())
        ├ quota      = createQuota()
        ├ ai         = createAi({ prompts, plays })
        │                → { generateScript, generateScores, transcribe, evaluate }
        ├ handlers   = createHandlers({ rooms, quota, ai, limits })
        │                → { registerHandlers, finalizeEvaluation }
        ├ createUploadRoute({ rooms, finalizeEvaluation, limits })
        └ createFeedbackRoute({ sendFeedback, limits })
```

`index.ts` の `cleanupRooms(Date.now(), ONE_HOUR)` は `rooms.cleanup(Date.now(), ONE_HOUR)` になる。`initPrompts()` の起動時ログ（プロンプト数・ジャンル数）は `createPrompts` の戻り値から取る。

### `buildServer` のオプション

```ts
buildServer({
  distDir?: string,          // 既存
  rooms?: RoomStore,
  ai?: Partial<Ai>,          // evaluate だけ差し替える等を許す
  sendFeedback?: FeedbackSender,
  limits?: Partial<Limits>,
})
```

省略されたものは本番の実装を組み立てる。**本番の呼び出し `buildServer()` は引数なしのまま変わらない。**

### `Limits` の内容

`handlers` の4つ（`roomCreateMax` `uploadTimeoutMs` `recordingLimitMs` `graceMs`）と、`uploadRoute` `feedbackRoute` のレート制限値。既定値は現在の定数をそのまま使う。

**レート制限器はインスタンスごとに作られる**ため、`__resetRateLimitForTest` 系は不要になる（サーバーを作り直せばカウンタは空になる）。

## 副産物：循環依存が消える

現在 `uploadRoute.ts` は `handlers.ts` から `finalizeEvaluation` を import している。ファクトリ化すると **`buildServer` が handlers を先に作って uploadRoute に渡す**ため、モジュール間の相互参照がなくなる。

## テスト側の移行

```ts
const server = await startTestServer({
  ai: { evaluate: async () => fakeScores },
  limits: { graceMs: 100, uploadTimeoutMs: 5000 },
})
```

- `beforeEach` の `_clearAllRooms()` は **`startTestServer()` を呼ぶこと自体**に置き換わる（インスタンスが新しいので状態は空）
- `__setEvaluatorForTest` 等は `startTestServer` のオプションに移る
- `afterEach` の `__reset*` は不要になり、`server.close()` だけが残る
- `testUtils.ts` がオプションを受け取って `buildServer` に渡す唯一の窓口になる

純粋関数のテスト（`validation` `roomCode` `volume` `clientIp` `rateLimit` `feedback` の検証部分など）は**サーバーを起動しないため無改造**で通る見込み。

## リスクと手当て

**最大のリスクは、全面書き換えの diff に紛れて繊細な箇所が壊れ、それに気づかないこと。** 過去に実際バグを出した箇所が3つある。

1. **猶予タイマーを `clearRoomTimers` に入れてはいけない**（`resetRoom` 経由で消え、切断中プレイヤーが永久ゴースト化して `start_game` の人数に混じる）
2. **`finalizeEvaluation` の入口の同期的な冪等ガードと `evaluationSeq`**（await 中の reset/delete による stale emit を防いでいる）
3. **`reattachPlayer` のアップロード済み音声の再マップ**（落とすと収集中リロードで無音採点になる）

手当てを4つ入れる。

| # | 手当て | 合格条件 |
|---|--------|----------|
| 1 | 関数の中身を一字も変えない | **`git diff -w` で意味のある差分が呼び出し名の置換だけ**に収まっている |
| 2 | モジュール単位でコミットを分ける | 1コミットの diff がレビューできる大きさ |
| 3 | 各コミットでテスト件数を確認 | **server 281 / client 10 が毎回一致**（「緑」ではなく「件数一致」を見る） |
| 4 | 上記3箇所を個別に目視 | 移行前後で当該ロジックが等価であることを確認した記録を残す |

**⚠️ 件数一致を合格条件にする理由**：`tests/` 移動のとき、`await import('./x')` の動的 import を書き換え漏れし、3件が静かに落ちた。ファイル・モジュール構成の変更は「エラーではなくテストが減る」形で失敗する。

## 検証

- `npm test`：server **281/281**・client **10/10**（件数一致）
- `npx tsc --noEmit`：server / client ともに clean
- `npm run build`（client）：clean。**バンドルのハッシュが不変**であること（client 無改造の裏取り）
- **`grep -rn "export function __\|export function _clear" server/src` が0件**（本改修の完了条件そのもの）
- 起動確認：`npm start` でサーバーが立ち上がり、`/health` が `{"ok":true}` を返す

## 実装順序

依存の浅い順に進める。各ステップでテスト件数一致を確認する。

1. `roomStore` → `createRoomStore()`（`_clearAllRooms` が消える）
2. `quota` `prompts` `scriptLibrary` → ファクトリ化（4個消える）
3. AI アダプタ（`scriptGen` `scoreGen` `transcribe` `evaluate`）と `feedback` → `createAi` に集約（10個消える）
4. `handlers` → `createHandlers({ ... })`（8個消える）
5. `uploadRoute` `feedbackRoute` → ファクトリ化（2個消える）
6. `buildServer` / `index.ts` / `testUtils` の最終配線

## 既知の相互作用

- **保留中の「演技時間の設定画面」**：`RECORDING_LIMIT_SEC` を固定値からユーザー設定値に変える課題は、本改修の `limits` 注入がそのまま下地になる
- **`shared/constants.ts`**：`RECORDING_LIMIT_SEC` などの既定値の置き場は変えない。`limits` の既定値がそこを参照する
- **B6 ホスト移譲**：`handlers.ts` を大きく触るため、本改修と同時に進めると衝突する。**順番に行うこと**
