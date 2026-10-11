# Phase C3 設計書：Whisper 文字起こし ＋ Claude 評価

- 日付: 2026-07-24
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/phase-c3-evaluation`
- 関連: [Phase C2 設計](2026-07-22-backend-phaseC2-recording-upload-design.md) / [Phase C1 設計](2026-07-18-backend-phaseC1-script-design.md)

## 1. 背景とスコープ

Phase C は「AI 本統合」で、スタブ 3 点を実接続化する（C1 台本 → C2 録音アップロード → C3 評価）。C1・C2 は完了（main）。

C3 のゴールは、[handlers.ts](../../../server/src/handlers.ts) の `finalizeEvaluation` 内 `generateStubScores(present)` を、**各プレイヤーの録音を Groq Whisper で文字起こし → 台本と照合して Claude Haiku 4.5 が採点**する本実装に差し替えること。C2 が `room.audio: Map<socketId, {buffer, mime}>` に集めた音声が前提。

### 決定事項（ブレインストーミングで確定）

- **文字起こし**: **Groq Whisper（`whisper-large-v3-turbo`）**。Claude は音声非対応のため別プロバイダが必須（[[public-launch-cost]]）。OpenAI 互換 API なので、単一関数 `transcribe(audio)` に隔離すれば OpenAI 乗り換えはベースURL・モデルID・キー名の変更のみ。
- **採点**: **Claude Haiku 4.5**（`claude-haiku-4-5`。C1 と同モデル・最安。モデル名定数の差し替えで上位化可）。
- **失敗時（1リトライ後も全体失敗）**: **新イベント `evaluation_failed` でロビーへ戻す**（`resetRoom` 後に配信）。C1 の `script_failed` と同型で「本番でスタブは出さない」方針に一貫。
- **スタブ/オフライン**: `GROQ_API_KEY` か `ANTHROPIC_API_KEY` が未設定なら **C3 全体をスタブ**（`generateStubScores`・ネットワーク無し）。既存テストは鍵なしで走る。

## 2. 現状の把握（実装前の事実）

- [handlers.ts:45-58](../../../server/src/handlers.ts) `finalizeEvaluation(io, room)` は **同期**。入口で `!collectingAudio` を弾き `collectingAudio=false` にして冪等を担保、`present`＝在室者名、`generateStubScores(present)`、`leftPlayers`＝`recordingRoster \ present`、`evaluation_complete{scores, leftPlayers}` を配信。
- `finalizeEvaluation` の**呼び出しは 5 箇所**: [uploadRoute.ts:41,62](../../../server/src/uploadRoute.ts)（アップロード全員到達・413時）、[handlers.ts:78](../../../server/src/handlers.ts)（アップロードタイムアウト）、[handlers.ts:279](../../../server/src/handlers.ts)（`return_to_lobby` の allReturned）、[handlers.ts:304](../../../server/src/handlers.ts)（`disconnect` の allReturned）。いずれも同期の fire-and-forget。
- `room.audio` は socketId キー。`room.players` が socketId→名前を保持。`room.recordingRoster` は録音開始時の名前スナップショット。
- 採点の出力型 [PlayerScore](../../../shared/types.ts)（`playerName, acting, emotion, kojirase, comment`）は不変。[ResultScreen.tsx](../../../client/src/screens/ResultScreen.tsx) は `acting/emotion/kojirase` を星（1〜5前提）、`comment` を表示。**クライアントの結果表示は無改造**。
- [scriptGen.ts](../../../server/src/ai/scriptGen.ts) が C3 が踏襲すべきパターン: `output_config.format` の JSON Schema・`parseX` は不正で throw・`withRetry`（1回）・`ANTHROPIC_API_KEY` 未設定で `generateStub*` にフォールバック・`impl` 差し替えのテストフック `__setXForTest`/`__resetXForTest`。
- [EvaluatingScreen.tsx](../../../client/src/screens/EvaluatingScreen.tsx) は `ctx.scores.length === 0` の間は遷移せず待機。失敗イベントが無く**無期限待ち**になりうる（C3 の `evaluation_failed` で解消）。

## 3. イベント契約の追加（`shared/events.ts`）

C→S は変更なし。S→C に 1 つ追加する。

```ts
// ServerToClientEvents に追加
evaluation_failed: (payload: { room: RoomSnapshot; message: string }) => void
```

- `evaluation_complete`（既存・不変）: 成功時。ペイロードも従来どおり `{ scores, leftPlayers }`。
- `evaluation_failed`（`io.to(code)` で全員配信）: 採点失敗時。`room` は `resetRoom` 後のスナップショット（クライアントがロビー状態を再同期するため。`room_reset` と同じ考え方）。`message` はトースト用。

## 4. サーバー：`finalizeEvaluation` の非同期化

C2 最終レビューで挙げた「`finalizeEvaluation` を async 化すると await 中の `resetRoom`/`deleteRoom` で冪等・整合が崩れる／fire-and-forget が unhandled rejection でプロセス死」を、**入口スナップショット ＋ 世代トークン ＋ finalize は決して reject しない**で封じる。

### 4.1 `roomStore` の変更

```ts
interface Room {
  // ...既存
  evaluationSeq: number  // 進行中評価の世代。初期 0
}
```

- `createRoom` で `evaluationSeq: 0`。
- `resetRoom` で `room.evaluationSeq++`（進行中の評価を無効化して stale emit を防ぐ）。

### 4.2 `finalizeEvaluation`（async・冪等・非 reject）

```
export async function finalizeEvaluation(io, room): Promise<void> {
  if (!room.collectingAudio) return           // 入口の冪等ガード（同期）
  room.collectingAudio = false
  if (room.uploadTimer) { clearTimeout(room.uploadTimer); room.uploadTimer = null }
  const myEval = ++room.evaluationSeq
  const code = room.code

  // ★ 入口スナップショット（同期・以降 room の変化に依存しない）
  const present = [...room.players.values()].map(p => p.name)
  const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
  const performers = room.recordingRoster.filter(n => present.includes(n)) // 採点対象＝録音時ロスター∩在室
  const script = room.script
  const audioByName = new Map<string, { buffer, mime }>()  // 名前→音声（socketId から解決）
  for (const [sid, a] of room.audio) {
    const name = room.players.get(sid)?.name
    if (name) audioByName.set(name, a)
  }

  try {
    const scores = await evaluatePerformance(script, performers, audioByName) // §5
    if (getRoom(code) !== room || room.evaluationSeq !== myEval) return        // ★ 再確認
    room.scores = scores
    touch(room)
    io.to(code).emit('evaluation_complete', { scores, leftPlayers })
  } catch (err) {
    console.error('[server] evaluation failed:', err)
    if (getRoom(code) !== room || room.evaluationSeq !== myEval) return        // ★ 再確認
    resetRoom(room)  // status→waiting・genre 保持・audio/scores クリア（evaluationSeq も++）
    touch(room)
    io.to(code).emit('evaluation_failed', {
      room: toSnapshot(room),
      message: '採点に失敗しました。もう一度お試しください',
    })
  }
}
```

- **finalize は決して reject しない**（全体を try/catch）。よって 5 つの呼び出し箇所は `void finalizeEvaluation(io, room)` のままでよい（unhandled rejection によるプロセス死を回避）。呼び出しを `void` 付きに統一する。
- **`return_to_lobby`/`disconnect` の allReturned 分岐からは finalize 呼び出しを撤去する**。非同期化により「収集中に全員が戻る＝結果を見る人がいない」ケースは、評価を**破棄してリセットのみ**が正しい（同期時代は finalize してから reset していたが、async では実 API 呼び出しを始めた結果を `evaluationSeq` で捨てるだけになり課金が無駄になる）。`disconnect` の「最後の待ち対象が抜けたら finalize」（`collectingAudio && uploadExpected.size === 0`）は残す。なお万一 stale な評価が解決しても `evaluationSeq` 不一致で emit されない安全網は効く。
- スタブモード時も `evaluatePerformance` は `generateStubScores(performers)` を返す（§6）。

## 5. AI パイプライン

### 5.1 `evaluatePerformance`（オーケストレーション）

`server/src/ai/evaluate.ts` に置く（`finalizeEvaluation` から呼ぶ単一入口）。

```ts
export async function evaluatePerformance(
  script: ScriptData | null,
  performers: string[],
  audioByName: Map<string, { buffer: Buffer; mime: string }>,
): Promise<PlayerScore[]>
```

- **スタブ判定**: `GROQ_API_KEY` か `ANTHROPIC_API_KEY` 未設定、または `script` が null なら `generateStubScores(performers)` を返す（ネットワーク無し）。
- 各 performer の音声を **並列で `transcribe`**（音声が無い performer は空文字）。`transcribe` 内で 1 リトライ、**個別失敗は空文字に劣化**（`Promise.allSettled` で全体を落とさない・ログのみ）。
- `generateScores(script, transcripts)` を呼ぶ（transcripts＝`{playerName, text}[]`、performers 全員ぶん）。**ここが失敗（1リトライ後も）したら throw**→ §4 の `evaluation_failed` 経路。
- テスト用フック `__setEvaluatorForTest(fn)`/`__resetEvaluatorForTest()`（`finalizeEvaluation` は `evaluate` モジュールの `impl` を呼ぶ）。

### 5.2 `transcribe`（`server/src/transcribe.ts`）

```ts
export function transcribe(audio: { buffer: Buffer; mime: string }): Promise<string>
```

- プロバイダ定数を先頭に隔離: `BASE_URL='https://api.groq.com/openai/v1'` / `MODEL='whisper-large-v3-turbo'` / キー `GROQ_API_KEY`。
- `POST ${BASE_URL}/audio/transcriptions`、multipart（Node20 の `fetch`＋`FormData`＋`Blob`、依存追加なし）: `file`（`new Blob([buffer], {type: mime})`、ファイル名は mime→拡張子で決定）、`model`、`language=ja`、`response_format=json`。応答 `.text` を返す。
- **mime→拡張子マップ**: `audio/webm→webm`, `audio/mp4→mp4`, `audio/ogg→ogg`, `audio/wav→wav`, `audio/mpeg→mp3`（既定 `webm`）。Whisper 系はファイル名拡張子で入力形式を判定するため必須。
- 1 リトライ。テスト用フック `__setTranscriberForTest`/`__resetTranscriberForTest`。

### 5.3 `generateScores`（`server/src/ai/scoreGen.ts`・scriptGen と同型）

```ts
export function generateScores(
  script: ScriptData,
  transcripts: { playerName: string; text: string }[],
): Promise<PlayerScore[]>
```

- Anthropic SDK・`claude-haiku-4-5`・`output_config.format` の JSON Schema で `PlayerScore[]` の**形**に固定（`playerName` string、`acting`/`emotion`/`kojirase` は integer、`comment` string）。**構造化出力のスキーマは部分集合で `minimum`/`maximum` を受け付けない**（送ると 400）ため、**1〜5 の範囲はスキーマではなく SYSTEM プロンプト＋`parseScores` の検証で担保する**（実キー動作確認で判明）。
- `parseScores(text, expectedNames)`: 不正 JSON・人数欠落・スコア範囲外（1〜5 外）で throw。1〜5 に丸めず**検証で弾く**（プロンプトとスキーマで担保）。
- system: 「即興劇の審査員。各プレイヤーの担当役・台詞（台本）と実際の発話を照合し、演技力・感情表現・こじらせ度を各 1〜5 と短い日本語講評で採点。**発話が空＝聞き取れなかった扱いで最低点＋その旨をコメント**。出力は JSON スキーマに厳密に従う。」
- user: `worldSetting` ＋ 各 performer の役・担当台詞（`script.roles`／`script.entries` から）＋ 各 performer の発話（transcript）。
- `withRetry`（1回）。`impl` 差し替えのテストフック `__setScoreGeneratorForTest`/`__resetScoreGeneratorForTest`。

## 6. スタブ/オフライン ・ join ガード

- スタブモード（鍵未設定）: `evaluatePerformance` が即 `generateStubScores(performers)` を返す。**既存 101 テストは鍵なしで走るため緑のまま**（finalize が stub を返す挙動は不変。async 化で emit は 1 マイクロタスク後になるがテストは `once` で待つので影響なし）。起動時に 1 回「AI 評価はスタブモードで動作」の警告ログ（`index.ts`、`ANTHROPIC_API_KEY` 警告の隣）。
- `join_room` を **`collectingAudio` 中は拒否**（アップロード窓の途中参加を防ぐ・C2 繰り越しの軽い hardening）。既存の status ベース判定に `|| room.collectingAudio` を足す。

## 7. クライアント変更

- `useGameSocket.ts`: `evaluation_failed` リスナ追加 → `onRoomReset` 相当の ctx リセット（`script/scores/readyMap/bgm/leftPlayers/returnedPlayers` クリア・`players/genre` を snapshot で更新）＋ `pushToast(message, 'error')` ＋ `setScreen('lobby')`。
- 他は無改造（ResultScreen・EvaluatingScreen は既存のまま。EvaluatingScreen は成功で `evaluation_complete`→結果へ、失敗で `evaluation_failed`→ロビーへ引かれる）。

## 8. テスト戦略（TDD・Windows / ブラウザなし）

先に失敗するテストを書き RED を確認してから実装する。実 API 呼び出しは 2 タブ＋実キーで手動確認（CI はスタブ／注入モードのみ）。

- **単体**: `transcribe`（mime→拡張子の網羅・`fetch` をモックしてレスポンス `.text` 解析・1リトライ）。`scoreGen.parseScores`（正常・不正JSON・人数欠落・スコア範囲外）。`evaluatePerformance` のオーケストレーション（`__setTranscriberForTest`＋`__setScoreGeneratorForTest` を注入：①1人の transcribe が throw しても空文字に劣化して全員採点が返る ②音声なし performer は空文字で `generateScores` に渡る ③`generateScores` が throw したら `evaluatePerformance` も throw）。
- **統合（`__set...ForTest` 注入で network 無し）**:
  1. 成功: `__setEvaluatorForTest` に決定的スコアを返す実装を注入 → `stop_recording`→アップロード→`evaluation_complete{scores}` を検証（`io.to` は先に両リスナ登録）。
  2. 失敗: `__setEvaluatorForTest` に throw を注入 → `evaluation_failed` 配信・`room.status==='waiting'` に戻る・`evaluation_complete` は来ない を検証。
  3. async 冪等: finalize が二重に走っても `evaluation_complete` は 1 回（アップロード全員到達とタイムアウトの競合など）。
  4. 世代トークン: 遅い評価器を注入し、解決前に全員 `return_to_lobby`→`resetRoom` → 評価解決時に **stale な `evaluation_complete` を emit しない**（`room_reset` が届き、その後 `evaluation_complete` が来ないこと）。
  5. スタブモード（鍵なし・既存踏襲）: 従来どおり `evaluation_complete` が届き `scores` が performers 分。
- **クライアント**: `tsc && vite build` clean。DOM 目視（2タブ＋実 Groq/Anthropic キー：実際に話す→講評が出る／マイク拒否→そのプレイヤーは低評価コメント／採点失敗時はトースト＋ロビー）はユーザー実施。

## 9. 変更ファイル一覧（見込み）

- `shared/events.ts` — `evaluation_failed` 追加
- `server/src/roomStore.ts` — `Room.evaluationSeq`（`createRoom` 初期化・`resetRoom` で ++）
- `server/src/handlers.ts` — `finalizeEvaluation` の async 化・スナップショット・世代再確認・失敗経路、5 呼び出し箇所を `void` 化、`join_room` の `collectingAudio` ガード
- `server/src/transcribe.ts` — 新規（Groq Whisper・mime→拡張子・1リトライ・テストフック）
- `server/src/ai/scoreGen.ts` — 新規（Claude Haiku 4.5 採点・parseScores・テストフック）
- `server/src/ai/evaluate.ts` — 新規（`evaluatePerformance` オーケストレーション・スタブ判定・並列 transcribe・テストフック）
- `server/src/index.ts` — スタブモードの起動時警告
- `server/package.json` — 新規テストファイル追加（依存は追加なし：`fetch`/`FormData` は Node20 標準、`@anthropic-ai/sdk` は既存）
- `.env.example` — `GROQ_API_KEY=` 追加
- `client/src/useGameSocket.ts` — `evaluation_failed` リスナ
- 各種テストファイル（新規/追記）

## 10. 非スコープ / 繰り越し

- **無料枠ハイブリッド**（Gemini/Groq/Cloudflare 段階フォールバック）・アップロードトークン・レート制限・ホスティングは公開時（[[public-launch-cost]]）。**運用注意: Groq / Anthropic とも Console で月次 spend limit を必ず張る**（C3 込みで ~10〜20 円/ゲーム見込み）。
- 話者分離・言語自動判定なし（1 プレイヤー 1 ファイル・`language=ja` 固定）。
- EvaluatingScreen の演出は据え置き（実評価は 30〜60 秒かかるが最終ステップで待機。進捗イベントは今回入れない）。
- 採点の再実行 UI なし（失敗時はホストが再度ゲームを回す運用）。
- Safari(mp4) 実機対応・LAN 実機の HTTPS 化（`getUserMedia` 制約）は C2 からの繰り越しのまま（本番前に対応）。
