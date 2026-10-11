# Phase D 設計書：SNSシェア（スコアカード画像生成＋シェア）

- 日付: 2026-07-25
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/phase-d-sns-share`
- 関連: [全体仕様書](../../../doc/仕様書.md)（進行フロー⑩・画面7）/ [Phase C3 設計](2026-07-24-backend-phaseC3-evaluation-design.md)

## 1. 背景とスコープ

Phase A〜C でゲームのコアループ（仕様書の進行フロー①〜⑨）が実キーで一気通貫に動作するようになった。残る未実装は**フロー⑩「SNSシェア」**＝結果のスコアカード画像を生成して X・LINE 等へ共有する機能。現状 [ResultScreen.tsx](../../../client/src/screens/ResultScreen.tsx) の「結果をシェアする🔗」ボタンは **`onClick` の無い死にボタン**。

Phase D のゴールはこの死にボタンを本物のシェア機能にすること。

- **完全にクライアント内で完結する**。`server/` `shared/` の変更なし・追加インフラなし・追加 npm 依存なし。ResultScreen が必要データ（`ctx.scores` / `ctx.script` / `ctx.genre` / `ctx.playerName` / `ctx.leftPlayers`）を既に保持しているため。
- Canvas でクライアント生成する画像には公開 URL が無いため、X/LINE への「テキスト＋画像URL」共有は原理的に不可。**Web Share API（`navigator.share({files})`）で OS のネイティブ共有シートに画像を渡す**方式を採り、非対応/非セキュアコンテキストでは**画像ダウンロード**にフォールバックする。

### 決定事項（ブレインストーミングで確定）

- **共有方式**: **Web Share API ＋ ダウンロードフォールバック**。パーティゲームはスマホ中心なので、ネイティブ共有シート（X/LINE/Instagram 等が並ぶ）に画像を渡すのが最適。
- **カード内容**: **「ルーム全体」と「自分の結果」の2種を選べる**（2ボタン）。
- **描画**: クライアントの Canvas（追加インフラ・依存なし・アーキテクチャに整合）。1080×1080 の正方形 PNG。

## 2. スコアカードの内容と見た目（⚠️ 暫定）

> **重要（ユーザー明示）**: この §2 の「カードの内容と見た目」は**暫定**であり、**後日ユーザーが仕様変更する予定**。現状は「いったんこれで進める」もの。実装では**描画を `scoreCard.ts` に隔離**し、内容・レイアウトを差し替えやすい構造にしておくこと（§3 の共有の仕組みは変更対象ではない）。

1080×1080 の正方形 PNG。[ResultScreen](../../../client/src/screens/ResultScreen.tsx) の既存ビジュアル言語を踏襲する（白カード・アンバーのウィナー強調・★の色分け＝演技/感情/こじらせ）。

- **ルーム全体カード** `renderRoomCard`:
  - ジャンル見出し（`genreLabel(genre)` ＋ 絵文字）
  - 🥇 最優秀俳優賞（合計点トップのプレイヤー名・合計点）
  - 全員のランキング: 名前 ＋ 演技/感情/こじらせの★（各1〜5）＋ 合計点。合計降順。
  - 退出者（`leftPlayers`）はグレー「退出」表記。
  - コメントは載せない（大人数で溢れるため）。
- **自分の結果カード** `renderPersonalCard`:
  - 自分の名前（`ctx.playerName`）・役名（`ctx.script.roles` から `player === playerName` を検索）・順位（合計降順での順位）
  - 演技/感情/こじらせの★
  - **AIコメント**（個人カードにだけ載せる。`scores.find(playerName).comment`）
  - ジャンル見出し。

全ての値は `ctx` から算出（サーバー通信は発生しない）。ジャンル別の色・絵文字は簡易マップに留める（BGM連動等の深いテーマは非目標）。

## 3. 共有の仕組み（`client/src/share.ts`）

```ts
export async function shareOrDownload(
  blob: Blob,
  filename: string,
  text: string,
): Promise<void>
```

- `const file = new File([blob], filename, { type: 'image/png' })`
- **feature-detect**: `navigator.canShare?.({ files: [file] })` が真なら `await navigator.share({ files: [file], text })`（title は付けても可）。
- **フォールバック**: それ以外は `URL.createObjectURL(blob)` → 一時 `<a download=filename>` を生成して `.click()` → `URL.revokeObjectURL`。
- **エラー処理**: `navigator.share` は**ユーザーがキャンセルすると `AbortError` を throw する**。これは握り潰す（トースト等を出さない）。共有シート起動失敗などその他の例外もダウンロードにフォールバックするか、静かにログのみ（UI を壊さない）。
- **セキュアコンテキスト注意**: Web Share API は **HTTPS または localhost でのみ動作**する（`getUserMedia` と同じ制約）。plain-HTTP の LAN IP では `navigator.canShare` が使えずダウンロードに落ちる。この制約は繰り越しの HTTPS 化（別フェーズ）で解消する。localhost 開発では share が効く。

## 4. Canvas 描画モジュール（`client/src/scoreCard.ts`）

DOM に挿入しないオフスクリーン Canvas（`document.createElement('canvas')`）に 2D コンテキストで描画し、`Blob` を返す。

```ts
// 入力は ctx（GameContext）から呼び出し側で組み立てた素の値
export function renderRoomCard(data: RoomCardData): HTMLCanvasElement
export function renderPersonalCard(data: PersonalCardData): HTMLCanvasElement
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob>
```

- `RoomCardData`: `{ genre: string; ranked: { name: string; acting: number; emotion: number; kojirase: number; total: number }[]; winner: string | null; leftPlayers: string[] }`
- `PersonalCardData`: `{ genre: string; name: string; role: string; rank: number; total: number; acting: number; emotion: number; kojirase: number; comment: string }`
- `canvasToBlob` は `canvas.toBlob(cb, 'image/png')` を Promise 化（`null` 時は reject）。
- 描画は純粋（同じ入力→同じ出力）。★は塗り/空きの図形描画。日本語フォントはシステムフォント（Canvas 既定）でよい。**内容・レイアウトはこのモジュール内に閉じ込め、§2 の暫定仕様変更が来ても他ファイルに波及させない。**

## 5. ResultScreen の改修（`client/src/screens/ResultScreen.tsx`）

死にボタン「結果をシェアする 🔗」を **2つのシェアボタン**に置換する（状態を持たない・押下で生成→共有）。

- **「みんなの結果をシェア 🔗」**: `ctx.scores` を合計降順に並べ `RoomCardData` を組み立て → `renderRoomCard` → `canvasToBlob` → `shareOrDownload(blob, 'ai-shibai-result.png', text)`。
- **「自分の結果をシェア 🔗」**: `ctx.playerName` の `PlayerScore` と役名・順位から `PersonalCardData` を組み立て → `renderPersonalCard` → 同上。自分のスコアが無い（観戦者・退出者等で `ctx.scores` に自名が無い）場合は**このボタンを非表示**にする（「みんなの結果」ボタンは常に表示）。
- 共有テキスト `text`: 例「AI×芝居ゲームで演じてきた！ #AI芝居」。ジャンル名を含めてもよい。
- 生成〜共有は async。多重押下防止に押下中は簡易に無効化（任意）。既存の「ロビーへ戻る」ボタン・復帰待ちバナーは不変。

## 6. テスト戦略（クライアント・テストフレームワーク無し）

- **検証は `npm run build`（`tsc && vite build`）が clean であること**＋ 実機/2タブ目視。Canvas 描画は jsdom で意味あるユニットテストが困難なため新規テストは足さない（プロジェクト方針＝クライアントはビルド＋目視で一貫）。
- **目視チェック**: ①両カードが生成される ②スマホで共有シートに画像が渡る（Web Share）③PC/非対応ブラウザで画像がダウンロードされる ④退出者・観戦者など端ケースで崩れない ⑤共有キャンセルでエラーが出ない。

## 7. 変更ファイル一覧（見込み）

- `client/src/scoreCard.ts` — 新規（Canvas 描画・Blob 化。§2 の内容をここに隔離）
- `client/src/share.ts` — 新規（Web Share ＋ DL フォールバック・feature-detect・AbortError 処理）
- `client/src/screens/ResultScreen.tsx` — 死にボタンを2シェアボタンに置換・カードデータ組み立て

## 8. 非スコープ / 繰り越し

- サーバー側の画像ホスティング／OGP リンクカード（X/LINE への画像URL共有）はインフラが必要なため対象外。
- 深いジャンル別テーマ（BGM連動・ジャンル別イラスト等）は対象外（色・絵文字レベルに留める）。
- plain-HTTP の LAN での Web Share 不可は **HTTPS 化（別フェーズ）**で解消。
- **§2 のカード内容・見た目は後日ユーザーが仕様変更予定**（本フェーズは暫定仕様で実装。差し替えは `scoreCard.ts` に閉じる）。
