# Phase C1 設計書：Claude 台本生成（本統合）

- 日付: 2026-07-18
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/phase-c1-script-gen`
- 関連: [Phase B3 設計](2026-07-15-backend-phaseB3-evaluation-design.md)

## 1. 背景とスコープ

Phase C は「AI 本統合」で、これまでスタブで動かしてきた 3 つの接続点を実接続化する。依存関係が素直で各回が小さくなるよう **C1 / C2 / C3 の 3 分割**で進める。

- **C1（本設計）**: Claude 台本生成。非同期基盤・API キー・生成中オーバーレイ・課金前ガードを整える最初の足場。
- **C2**: MediaRecorder 録音 → サーバーへアップロードする基盤（AI なし・音声が届くことだけ検証）。
- **C3**: Whisper 文字起こし ＋ Claude 評価（`ai/scoreStub.ts` を差し替え）。C2 の音声が前提。

C1 のスコープは [handlers.ts](../../../server/src/handlers.ts) の `start_game` が呼ぶ同期スタブ `generateStubScript` を、**Claude Haiku 4.5 による非同期生成**に差し替えること。録音・評価は対象外。

### 決定事項（ブレインストーミングで確定）

- **モデル**: `claude-haiku-4-5`（最安・高速）。台本 1 本は数千トークン規模でモデル差はほぼ 1 ゲームあたりのコスト差。スタブと同シグネチャなので後で上位モデルへ差し替え容易。
- **生成失敗時**: サーバー内で 1 回自動リトライ → それでもダメなら全員のオーバーレイを閉じてホストにエラー表示し、`status` は `waiting` のまま（ホストが再度開始できる）。**本番でスタブ台本（「（スタブ）」入り）は出さない。**
- **課金前ガード**: Claude 課金が発生する前に、`start_game` に **genre 必須**と**最小人数 ≥ 2** のガードを入れる。

## 2. 現状の把握（実装前の事実）

- `start_game` は同期で `generateStubScript` を呼び即 `script_ready` を配信。失敗時は `socket.emit('error')` をホストにのみ送り `status` は変えない。サーバー側ガードは「ホスト本人」「`status==='waiting'`」のみ。**genre ガードはクライアントのみ・最小人数ガードは存在しない。**
- クライアントの画面遷移は **status ではなくイベント駆動**（`onScriptReady` → `setScreen('casting')`）。生成中のために新しい `RoomStatus` を足す必要はない。
- [LobbyScreen.tsx](../../../client/src/screens/LobbyScreen.tsx) には既に「AIが台本を執筆中…」オーバーレイがあるが、**ローカル state で押したホストにしか出ず、失敗時に閉じない**（同期のため露呈していないだけ）。C1 でこれをサーバー駆動に置き換える。

## 3. イベント契約の追加（`shared/events.ts`）

C→S は変更なし（`start_game` のまま・引数なし）。S→C に 2 つ追加する。

```ts
// ServerToClientEvents に追加
script_generating: () => void
script_failed: (payload: { message: string }) => void
```

- `script_generating`（`io.to(code)` で全員配信）: 各クライアントが生成中オーバーレイを表示。
- `script_failed`（`io.to(code)` で全員配信）: 各クライアントがオーバーレイを閉じる。ホストはエラートースト＋再開始可能。
- `script_ready`（既存・変更なし）: casting へ遷移しつつオーバーレイ解除。

`script_generating` は payload なし（ゲストも `ctx.genre` を保持しているためオーバーレイのジャンル表示に不足はない）。

## 4. サーバー側フロー

### 4.1 `roomStore` の変更

`Room` に二重押し・生成中 join を制御するフラグを追加する。

```ts
interface Room {
  // ...既存
  generatingScript: boolean   // 台本生成中フラグ（初期 false）
}
```

- `createRoom` で `generatingScript: false` を初期化。
- `resetRoom` で `generatingScript = false` にクリア（再戦時に持ち越さない）。

### 4.2 `start_game`（async 化）

ガードは順に評価し、1 つでも失敗したら **`socket.emit('error')` をホストにのみ送り、生成は一切開始しない**（`script_generating` も出さない＝オーバーレイは出ない）。

1. `room` が存在し `room.hostSocketId === socket.id`（既存）
2. `room.status === 'waiting'`（既存）
3. `!room.generatingScript`（**二重押し防止・新規**）
4. `isValidGenre(room.genre)`（**課金前ガード**）→「ジャンルを選んでください」
5. `room.players.size >= 2`（**課金前ガード**）→「2人以上で開始できます」

通過後:

```
room.generatingScript = true
io.to(code).emit('script_generating')
try {
  const script = await generateScript(room.genre, names)   // 内部で1回リトライ
  // ★ await 後、room がまだ生存しているか再確認（生成中にホスト切断→解散のケース）
  if (getRoom(code) !== room) return
  room.generatingScript = false
  room.script = script
  room.status = 'casting'
  touch(room)
  io.to(code).emit('script_ready', { script })
} catch {
  if (getRoom(code) !== room) return
  room.generatingScript = false
  io.to(code).emit('script_failed', { message: '台本の生成に失敗しました。もう一度お試しください' })
}
```

`names` は生成開始時点の `room.players` からスナップショット。

### 4.3 `join_room` の変更

生成中に参加した人は生成済み台本に役が無く事故になるため、**`room.generatingScript` が true の間は参加拒否**する（「ゲーム進行中のため参加できません」）。既存の `status` 判定に加えるガード。

### 4.4 エッジケース

- **生成中にホストが切断**: 既存の `disconnect` ハンドラが `room_dissolved` ＋ `deleteRoom` する。生成 Promise が後から解決したとき、`getRoom(code) !== room`（別インスタンス or undefined）なら何もせず return（4.2 の再確認）。
- **生成中に非ホストが切断**: ルームは残る。生成完了時に在室者へ `script_ready` が届く（切断者は対象外）。

## 5. AI モジュール（`server/src/ai/scriptGen.ts`）

```ts
export async function generateScript(genre: string, playerNames: string[]): Promise<ScriptData>
```

- **`ANTHROPIC_API_KEY` 未設定なら `generateStubScript(genre, playerNames)` にフォールバック**（キー無しのオフライン開発＆統合テスト用）。起動時に 1 回だけ「AI_STUB モードで動作中」の警告ログを出す。これにより `ai/scriptStub.ts` は死なず、テストは network 無し・決定的に走る。
- キーありなら `@anthropic-ai/sdk` で以下を実行:
  - モデル `claude-haiku-4-5`、非ストリーミング、`max_tokens` は 4000 程度（16K 以下なのでタイムアウトの心配なし）。Haiku 4.5 は `effort`/adaptive thinking 非対応のため `thinking` 設定は付けない。
  - `output_config: { format: { type: 'json_schema', schema: <ScriptData のスキーマ> } }` で構造化出力に固定。
  - 応答テキストを `JSON.parse` → `ScriptData` として形を検証（`worldSetting` が文字列、`roles` が全プレイヤー分あるか、`entries` が非空か）。検証失敗は例外扱い。
  - **1 回リトライ**: API エラー / タイムアウト / パース・検証失敗のいずれでも 1 回だけ再試行。2 回目も失敗なら throw（呼び出し側で `script_failed`）。

### プロンプト方針

- system: 「あなたは即興劇の台本作家。指定ジャンルとプレイヤー名から日本語の短い即興劇台本を作る。各プレイヤーに 1 役、全員に見せ場、こじらせ・大げさな演技が映える展開。出力は与えられた JSON スキーマに厳密に従う。」
- user: ジャンルのラベル（`genreLabel`）＋プレイヤー名一覧＋制約（`roles` は人数ぶん・`entries` は各プレイヤーに台詞が回る短い一幕〜十数行・`worldSetting` は 1〜2 文）。
- 構造化出力は `minItems`/`maxLength` 等の数値・長さ制約を持てないため、**長さ・役割の網羅はプロンプトで誘導**し、`generateScript` 側の検証で最低限を担保する。

### 設定・依存

- `server/package.json` に `@anthropic-ai/sdk` と `dotenv` を追加。
- `server/src/index.ts` の先頭で `import 'dotenv/config'`（`.env` 不在でも no-op）。
- リポジトリ直下 or `server/` に `.env.example`（`ANTHROPIC_API_KEY=`）を追加。`.env` は gitignore 済み。
- クライアントは API キーに触れない（ブラウザに鍵を出さない）。生成は完全にサーバー側。

## 6. クライアント変更

- `App.tsx` の `GameContext` に `generating: boolean` を追加（`INITIAL_CTX` で false）。
- `useGameSocket.ts`:
  - `script_generating` → `setCtx(prev => ({ ...prev, generating: true }))`
  - `script_failed` → `setCtx(prev => ({ ...prev, generating: false }))` ＋ `pushToast(message, 'error')`
  - `script_ready` → 既存の casting 遷移に加え `generating: false`
- `LobbyScreen.tsx`:
  - ローカル `generating` state と `startGame` 内の楽観的 `setGenerating(true)` を撤去。オーバーレイは `ctx.generating` 駆動に（→ ホストもゲストも表示、失敗時に必ず閉じる）。
  - 開始ボタンの無効化条件に `ctx.players.length < 2` を追加（＋「2人以上で開始できます」ヒント）。`ctx.generating` 中も無効。

## 7. テスト戦略（TDD）

先に失敗するテストを書き RED を確認してから実装する。

- **成功パス（統合）**: キー無し＝スタブモードで走らせ、`start_game` → `script_generating` → `script_ready` の非同期イベント列と `status='casting'` を検証。`io.to` 配信は Windows の逐次 await 取りこぼしを避けるため**両リスナ登録後に emit**（既存 `handlers.*.test.ts` のパターン踏襲）。
- **失敗パス（統合）**: `ai/scriptGen.ts` にテスト専用オーバーライド（例: `__setScriptGeneratorForTest(fn)` と `__resetScriptGeneratorForTest()`）を用意し、必ず throw する生成器を差し込んで `script_failed` の配信・`room.generatingScript` のクリア・`status` が `waiting` のままであることを検証（`server.ts`/`buildServer` に DI を通さず、モジュールローカルなフックで完結させる）。
- **ガード（統合）**: genre 未設定での `start_game` 拒否 / 1 人での `start_game` 拒否 / 生成中の二重 `start_game` 無視 / 生成中の `join_room` 拒否 の回帰テスト。
- **純粋関数（単体）**: プロンプト組み立てと「モック Anthropic 応答 → `ScriptData` パース・検証」を network 無しで単体テスト（正常・不正 JSON・role 欠落など）。
- `server/package.json` の `test` スクリプトに新規テストファイルを追加。

## 8. 変更ファイル一覧（見込み）

- `shared/events.ts` — `script_generating` / `script_failed` 追加
- `server/src/roomStore.ts` — `generatingScript` フラグ
- `server/src/handlers.ts` — `start_game` async 化・ガード追加・`join_room` ガード
- `server/src/ai/scriptGen.ts` — 新規（実生成＋スタブフォールバック＋リトライ）
- `server/src/index.ts` — `dotenv/config`、起動時ログ
- `server/package.json` — 依存追加・test スクリプト更新
- `.env.example` — 新規
- `client/src/App.tsx` — `GameContext.generating`
- `client/src/useGameSocket.ts` — 3 リスナ
- `client/src/screens/LobbyScreen.tsx` — オーバーレイのサーバー駆動化・人数ガード
- 各種テストファイル（新規/追記）

## 9. 非スコープ / 繰り越し

- 録音のアップロード（C2）・Whisper/評価（C3）。
- 台本の再生成 UI（今回は失敗時にホストが「開始」を押し直す運用）。
- ストリーミング生成・部分表示（Haiku かつ短文なので非ストリーミングで十分）。
- レート制限・課金上限のアプリ内制御（当面はガードと idle クリーンアップで運用）。
