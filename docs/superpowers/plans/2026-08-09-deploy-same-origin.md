# 1サービス同居デプロイ（HTTPS化） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Express がビルド済みクライアントを同一オリジンで配信する1サービス構成にし、HTTPS付きのホスティングへデプロイして実機（スマホ）で録音が動く状態にする。

**Architecture:** サーバーを唯一のオリジンにする。本番のみ `client/dist` を静的配信し、未知のパスは SPA フォールバックで `index.html` を返す（`/health`・`/upload`・`/socket.io` より必ず後ろに登録する）。同一オリジンなので本番では CORS を出さず、クライアントは `window.location.origin` を見るためビルド時のURL埋め込みが不要になる。リポジトリ直下に `package.json` を新設してホスティングサービスにビルド/起動手順を伝える。

**Tech Stack:** Node 20 / Express 4 / Socket.IO / tsx（TypeScript 実行）/ React18 + Vite（静的ビルド）/ ホスティングは Railway 第一候補（`PORT` とビルド・起動コマンドのみに依存し、Render・Fly へも移せる）。

## Global Constraints

- 設計書: [docs/superpowers/specs/2026-08-09-deploy-same-origin-design.md](../specs/2026-08-09-deploy-same-origin-design.md)。
- **SPA フォールバック（`app.get('*')`）は必ずルーティングの最後に登録する。** 先に置くと `/health`・`/upload`・`/socket.io` が `index.html` に飲まれ、ゲームが起動しない。
- **静的配信と SPA フォールバックは `NODE_ENV === 'production'` のときだけ有効にする。** 開発時は Vite dev サーバーがクライアントを配信し、統合テストは `buildServer()` を直接使うため。
- **本番では CORS ヘッダを一切出さない**（`origin: '*'` を公開サーバーに残さない）。開発時のみ有効にする。
- **`tsx` は `server/package.json` の `dependencies` に置く。** `devDependencies` のままだと、本番インストールで dev 依存を省くプラットフォームで `npm start` が起動しない。
- **クライアントのビルドには devDependencies（vite・typescript）が必須。** プラットフォームが `NODE_ENV=production` を設定していると `npm ci` が dev 依存を省くため、**`--include=dev` を明示する**。
- **ルート `package.json` 自身は依存を持たない**（scripts と engines だけ）。実際の依存インストールは `build` スクリプトが `client/` と `server/` に対して行う。
- **サーバーは必ず1インスタンス**（ルームがプロセスのメモリ上にあるため）。再デプロイ・再起動で進行中のルームは全消滅する。
- 既存のサーバーテスト **162 件が引き続き通る**こと。
- Windows/PowerShell 環境。環境変数を1コマンドで渡す構文は `$env:NODE_ENV='production'; <command>`。
- コミットの `Co-Authored-By` は `Claude Opus 5 <noreply@anthropic.com>`。

---

### Task 1: 同一オリジン配信（サーバーの静的配信＋クライアントのURL解決）

**Files:**
- Modify: `server/src/server.ts`（本番のみ静的配信＋SPAフォールバック、CORS を開発時のみに）
- Modify: `client/src/config.ts`（本番は同一オリジンを指す）

**Interfaces:**
- Consumes: 既存の `buildServer()` が返す `{ app, httpServer, io }`。`registerUploadRoute(app, io)` が `POST /upload` を、Socket.IO が `/socket.io/*` を登録する。統合テスト（`server/src/testUtils.ts` の `startTestServer`）は `buildServer()` を直接呼ぶ。
- Produces: 本番起動時に `http://<host>/` でゲーム画面が表示され、`/health`・`/upload`・`/socket.io` が従来どおり動く状態。

- [ ] **Step 1: サーバーを同一オリジン配信に対応させる**

`server/src/server.ts` を以下で置き換える（既存の import に `node:url` と `node:path` を追加している）:

```ts
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import cors from 'cors'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerHandlers } from './handlers'
import { registerUploadRoute } from './uploadRoute'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'

export function buildServer() {
  const isProduction = process.env.NODE_ENV === 'production'
  const app = express()

  // 本番は client と同一オリジンなので CORS は不要（公開サーバーに origin:'*' を残さない）。
  // 開発だけ Vite(5173) → server(3001) の別オリジンになるため許可する。
  if (!isProduction) app.use(cors())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  const httpServer = createServer(app)
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    isProduction ? {} : { cors: { origin: '*' } },
  )

  registerUploadRoute(app, io)
  io.on('connection', socket => registerHandlers(io, socket))

  // 静的配信と SPA フォールバックは必ず最後に登録する。
  // 先に置くと /health・/upload・/socket.io が index.html に飲まれてゲームが起動しない。
  if (isProduction) {
    const here = dirname(fileURLToPath(import.meta.url)) // server/src
    const distDir = resolve(here, '../../client/dist')
    app.use(express.static(distDir))
    app.get('*', (_req, res) => res.sendFile(resolve(distDir, 'index.html')))
  }

  return { app, httpServer, io }
}
```

- [ ] **Step 2: クライアントのサーバーURLを同一オリジンにする**

`client/src/config.ts` を以下で置き換える:

```ts
// socket 接続と音声アップロードで同じサーバーを指すための単一定義。
// 本番はサーバーが client/dist を同一オリジンで配信するので、ビルド時にURLを
// 埋め込む必要がない（埋め込み漏れによる「本番だけ動かない」を構造的に防ぐ）。
// VITE_SERVER_URL は将来分離構成に戻す場合の逃げ道として残す。
export const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin)
```

- [ ] **Step 3: クライアントをビルドする**

Run: `cd client && npm run build`
Expected: `tsc && vite build` clean。`client/dist/index.html` と `client/dist/assets/` が生成される（`dist/` は gitignore 済みなのでコミットされない）。

- [ ] **Step 4: 本番モードで起動して同一オリジン配信を確認する**

PowerShell で、サーバーを本番モードで起動する（**バックグラウンドで起動し、確認後に停止する**）:

Run: `cd server; $env:NODE_ENV='production'; npx tsx src/index.ts`
Expected: `[server] listening on 3001 / genres loaded: 8` が出る。

別のシェルで4つ確認する:

Run: `curl.exe -s http://localhost:3001/health`
Expected: `{"ok":true}`

Run: `curl.exe -s http://localhost:3001/ | Select-String 'id="root"'`
Expected: 1行以上ヒットする（`index.html` が返っている）。

Run: `curl.exe -s http://localhost:3001/lobby | Select-String 'id="root"'`
Expected: 1行以上ヒットする（**SPA フォールバックが効いている**。存在しないパスでも index.html が返る）。

Run: `curl.exe -s -o NUL -w "%{http_code}" "http://localhost:3001/socket.io/?EIO=4&transport=polling"`
Expected: `200`（**Socket.IO が SPA フォールバックに飲まれていない**）。URL は必ず引用符で囲む（PowerShell は裸の `&` を演算子として解釈してエラーになる）。

確認できたらサーバーを停止する。`$env:NODE_ENV` を消す（`Remove-Item Env:NODE_ENV`）のを忘れないこと。以降の手順は開発モードで行う。

- [ ] **Step 5: 既存テストの回帰確認**

Run: `cd server && npm test`
Expected: 162/162 PASS（CORS を条件付きにした変更でテストが壊れていないこと。統合テストは socket.io-client であってブラウザではないため CORS の影響を受けない）。

Run: `cd server && npx tsc --noEmit`
Expected: 型エラー無し。

- [ ] **Step 6: コミット**

```bash
git add server/src/server.ts client/src/config.ts
git commit -m "feat: クライアントを同一オリジンで配信（本番のみ静的配信・CORSは開発時のみ）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: ビルドと起動の足回り（ルート package.json・tsx の依存区分）

**Files:**
- Create: `package.json`（リポジトリ直下）
- Modify: `server/package.json`（`tsx` を `devDependencies` から `dependencies` へ）
- Modify: `.env.example`（デプロイ時に設定する環境変数の一覧に）

**Interfaces:**
- Consumes: Task 1 の同一オリジン配信（`NODE_ENV=production` で有効）。`server/package.json` の既存 `start` スクリプト（`tsx src/index.ts`）。`client/package.json` の既存 `build` スクリプト（`tsc && vite build`）。
- Produces: リポジトリ直下で `npm run build` → `npm start` だけでアプリが起動する状態。ホスティングサービスはこの2コマンドだけを知っていればよい。

- [ ] **Step 1: ルート `package.json` を新規作成**

リポジトリ直下に `package.json` を作る:

```json
{
  "name": "ai-shibai",
  "private": true,
  "version": "0.0.1",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "npm --prefix server ci && npm --prefix client ci --include=dev && npm --prefix client run build",
    "start": "npm --prefix server start"
  }
}
```

> `--include=dev` は必須。クライアントのビルドには vite と typescript（どちらも devDependencies）が要るが、ホスティングサービスが `NODE_ENV=production` を設定していると `npm ci` が dev 依存を省いてビルドが失敗する。
>
> このファイル自身は依存を持たない。ホスティングサービスがルートで `npm install` を実行しても何も起きず、実際のインストールは `build` が行う。

- [ ] **Step 2: `tsx` を dependencies へ移す**

`server/package.json` の `devDependencies` から `"tsx": "^4.7.0",` の行を削除し、`dependencies` に追加する。変更後の2ブロックは次のようになる:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.112.3",
    "cors": "^2.8.5",
    "dotenv": "^17.4.2",
    "express": "^4.19.0",
    "multer": "^2.2.0",
    "socket.io": "^4.7.0",
    "tsx": "^4.7.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.0",
    "@types/express": "^4.17.0",
    "@types/multer": "^2.2.0",
    "@types/node": "^20.0.0",
    "socket.io-client": "^4.7.0",
    "typescript": "^5.0.0"
  }
```

> 理由: `npm start` は `tsx src/index.ts` で起動する。`tsx` が dev 依存のままだと、本番インストールで dev を省くプラットフォームでは起動時に「tsx が見つからない」で落ちる。`tsx` は実行に `typescript` パッケージを必要としない（内部の esbuild で変換する）ため、`typescript` は dev のままでよい。

- [ ] **Step 3: `server/package-lock.json` を同期する**

Run: `cd server && npm install`
Expected: `package-lock.json` が更新される（依存区分の変更が反映される）。新しいパッケージは増えない。

- [ ] **Step 4: `.env.example` をデプロイ用に更新**

`.env.example` を以下で置き換える:

```
# サーバー用。ローカルはリポジトリ直下の .env に実キーを置く（.env は gitignore 済み）。
# デプロイ時はホスティングサービスの環境変数として設定する。
ANTHROPIC_API_KEY=
GROQ_API_KEY=

# 本番デプロイでは production を設定する。
# production のときだけ client/dist の静的配信と SPA フォールバックが有効になり、
# CORS ヘッダを出さなくなる（同一オリジンのため不要）。
NODE_ENV=

# 待ち受けポート。多くのホスティングサービスが自動で渡すので、通常は設定不要（既定 3001）。
PORT=
```

- [ ] **Step 5: ルートのコマンドだけでビルド・起動できることを確認**

Run: `npm run build`（リポジトリ直下で実行）
Expected: server と client の依存インストールが走り、`client/dist` が生成されて終了する。

Run: `$env:NODE_ENV='production'; npm start`（リポジトリ直下・バックグラウンド起動）
Expected: `[server] listening on 3001 / genres loaded: 8`。

別のシェルで確認する:

Run: `curl.exe -s http://localhost:3001/health`
Expected: `{"ok":true}`

Run: `curl.exe -s http://localhost:3001/ | Select-String 'id="root"'`
Expected: 1行以上ヒットする。

確認できたらサーバーを停止し、`Remove-Item Env:NODE_ENV` で環境変数を戻す。

- [ ] **Step 6: 既存テストの回帰確認**

Run: `cd server && npm test`
Expected: 162/162 PASS。

- [ ] **Step 7: コミット**

```bash
git add package.json server/package.json server/package-lock.json .env.example
git commit -m "chore: ルートに build/start を用意し tsx を dependencies へ（デプロイ用）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: デプロイと実機確認

**Files:** なし（ホスティングサービス側の操作とユーザーによる実機確認）

> このタスクはホスティングサービスのアカウント操作を伴うため、**ユーザーが実施する**。エージェントは代行できない。

- [ ] **Step 1: リポジトリをホスティングサービスに接続**

Railway（第一候補）で新規プロジェクトを作り、この GitHub リポジトリを接続する。ビルドコマンドと起動コマンドは自動検出に任せず、明示的に指定する:

- Build Command: `npm run build`
- Start Command: `npm start`

- [ ] **Step 2: 環境変数を設定**

| 変数 | 値 |
|---|---|
| `NODE_ENV` | `production` |
| `ANTHROPIC_API_KEY` | 実キー |
| `GROQ_API_KEY` | 実キー |

`PORT` はプラットフォームが自動で渡すため設定しない。

- [ ] **Step 3: インスタンス数を1に固定**

オートスケール／レプリカ数の設定があれば **1** に固定する。ルーム状態はプロセスのメモリ上にあるため、2以上にすると「部屋が見つからない」「片方にだけイベントが届かない」が発生する。

- [ ] **Step 4: 支払い上限を設定**

デプロイ前に **Anthropic Console と Groq Console で月額の支払い上限（spend limit）を設定する**。アプリ側のレート制限はスライスBで入れるが、コンソール側の上限はアプリに何があっても効く最後の砦になる。

- [ ] **Step 5: デプロイして疎通を確認**

デプロイ完了後、`https://<発行されたドメイン>/health` が `{"ok":true}` を返すこと。次にトップ画面が表示されること。

- [ ] **Step 6: スマホ実機で確認（このスライスの主目的）**

**HTTPS でしか確認できない項目**なので、必ず実機で行う。

1. **マイク録音が動く**（`getUserMedia` はセキュアコンテキスト必須。これが動くことが HTTPS 化の主目的）
2. スマホ2台（または スマホ＋PC）でルーム作成・参加し、配役・準備・録音・結果まで同期する
3. 結果画面の「音声を共有 🔗」で OS の共有シートが開く（Web Share もセキュアコンテキスト必須）
4. 音源ファイルは未配置のままでよい（欠損は無音で継続する。BGM/SE が鳴らないのは想定どおり）

- [ ] **Step 7: URL はまだ配らない**

**レート制限・日次上限・キルスイッチ（スライスB）が入るまで、URL を広く配らないこと。** 現状は URL を知った人が何度でもゲームを回せ、その分だけ Anthropic / Groq の従量課金が発生する。

---

## 完了条件

- `server` の `npm test` 162/162 PASS ＋ `npx tsc --noEmit` clean。
- リポジトリ直下で `npm run build` → `npm start`（`NODE_ENV=production`）だけで、`http://localhost:3001` にゲームが表示され `/health`・`/socket.io` が生きている。
- デプロイ先の HTTPS URL で、**スマホ実機のマイク録音が動く**。2端末で同期し、音声共有が共有シートに出る。
- URL は未配布のまま（スライスB完了まで）。
