# 設計書：BGM/SEの実再生と「自分のテイク」の聞き返し

- 日付: 2026-08-09
- ステータス: 設計承認済み（実装計画へ）
- ブランチ: `feature/bgm-sfx-playback`
- 関連: [全体仕様書](../../../doc/仕様書.md) §3⑦・§8-2 / [B2 録音中インタラクション同期](2026-07-15-backend-phaseB2-recording-design.md)

## 1. 背景とスコープ

B2 で BGM/SE の**同期**は実装済み（`send_bgm`→`bgm_changed` で共有BGM状態、`send_sfx`→`sfx_played` で送信者以外へ配信、`status==='recording'` 限定）。録音画面のスライドパネルから選択でき、選択中BGMに♪が付き、SEボタンが光る。

**しかし音は一切鳴らない。** クライアントに再生コードが無く（`new Audio()` も `<audio>` も無い。`AudioContext` は声量メーターの `AnalyserNode` 専用）、音源ファイルも1つも無い（`client/public/` が空）。つまり「同期して見える」だけで「聞こえる」部分が丸ごと未実装。

本スライスで ①BGM/SEを実際に鳴らす ②自分のマイクとBGM/SEをミックスして録る ③結果画面で聞き返す・共有する を実装する。

### 決定事項（ブレインストーミングで確定）

- **目的は「あとで聞き返す・シェアする」**。現状の録音は文字起こし専用で採点後に破棄され、ユーザーの耳には一切届かない。BGM入りの録音を「作品」として残せるようにする。
- **今回は「自分の声＋BGM/SE」のみ**。全員の声を合わせた1本の劇は別スライス（サーバー合成＝ffmpeg・録音の時刻同期・保存先・公開URLが要る）。録音パイプラインを先に Web Audio 化しておけば、そちらへ自然に拡張できる。
- **クライアント完結**。サーバー・イベント契約・共有型は一切変更しない。保存もしない（リロードで消える）。
- **音源ファイルはユーザーが用意して配置する**。実装側は**ファイルが無くても無音で落ちない**ようにする。
- **イヤホン推奨になる**ことを受け入れる（§5 参照）。

### 非スコープ

- 全員の声を合成した1本の音声（別スライス）
- 録音の永続化・サーバー保存・公開URL・OGP
- カオスモードの演出差し替え（仕様書§8-2）、ハプニングイベント（§8-5）
- 声量メーターのパイプライン（別 `getUserMedia`・別 AudioContext）は無改造

## 2. アーキテクチャ方針

**録音を2トラックに分ける。**

| トラック | 内容 | 行き先 |
|---|---|---|
| 採点用 | **マイクのみ** | 従来どおり `POST /upload` → Groq Whisper → Claude 採点 |
| 鑑賞用 | **マイク＋BGM/SE のミックス** | アップロードせずブラウザ内に保持し、結果画面で再生・共有 |

採点用にBGMを混ぜない理由：Whisper は音楽が乗ると認識精度が落ち、歌詞を書き起こすなどの挙動が知られている。採点は文字起こしテキストだけを Claude に渡すので、混ぜると**採点が良くなるどころかセリフを取りこぼして悪化する**。

却下案：
- **ミックス1本で兼用** — 実装は最も簡単だが上記の理由で採点が壊れる。
- **鑑賞用もサーバーへ保存** — 保存先・配信・公開URLが必要で、クライアント完結というスコープを超える。全員合成スライスでまとめて扱う。

## 3. 新モジュール `client/src/audioBus.ts`

アプリで**1つの AudioContext** を持ち、BGM/SEの再生と「録音用ミックス出力」を担当する。DOM 非依存（`scoreCard.ts` と同じ方針）。

出力は2系統に接続する：`ctx.destination`（スピーカー）と `MediaStreamAudioDestinationNode`（録音用）。これにより**鳴っている音がそのまま鑑賞用トラックに入る**。

```ts
export function preloadAudio(): void
export function playBgm(id: string | null): void
export function playSfx(id: string): void
export function stopAll(): void
export function getMixDestination(): MediaStreamAudioDestinationNode
export function resumeAudio(): void
```

- `preloadAudio()` — 10ファイルを `fetch` → `decodeAudioData` してメモリに保持。**404・デコード失敗はその音だけ「無音」として握り潰し**、`console.warn` のみ。音源未配置でもゲームは通常どおり動く。冪等（多重呼び出しは無視）。呼び出しは配役画面のマウント時（録音開始までに間に合わせる）。
- `playBgm(id | null)` — 現在のBGMを止めて新しいものをループ再生。`null` で停止。**約100msのゲインフェード**でプツ切れを防ぐ。未ロード/欠損IDは no-op。
- `playSfx(id)` — ワンショット。重ねて鳴ってよい（`AudioBufferSourceNode` を都度生成）。未ロード/欠損IDは no-op。
- `stopAll()` — BGMと鳴っているSEを全停止。
- `resumeAudio()` — `AudioContext` が `suspended` なら `resume()`。**ブラウザの自動再生ポリシー対策**。既存の声量メーターも同じ対策を入れている。呼ぶ場所は2箇所：**①準備画面の「準備完了」ボタン（ユーザー操作を起点にした確実な解除）②`playBgm`/`playSfx` の先頭（保険）**。②だけでは操作起点でないため解除されない環境があり、①だけではホストが強制スキップして準備完了を押さなかったゲストが無音になるため、両方入れる。
- `getMixDestination()` — `recorder.ts` が鑑賞用トラックを録るために使う。

### 音源の配置（ユーザーが用意）

```
client/public/audio/bgm/{dramatic,horror,comedy,battle}.mp3
client/public/audio/sfx/{drum,boom,fanfare,scream,laugh,bell}.mp3
```

ファイル名は `shared/constants.ts` の `BGM_IDS` / `SFX_IDS` と**1対1**にし、ID→ファイル名の変換表を作らない（IDを増やしたらファイルを置くだけで済む）。

## 4. 録音の2トラック化（`client/src/recorder.ts`）

`getUserMedia` は**1回のまま**。取得したマイク stream を2つに分配する。

1. 採点用：`new MediaRecorder(micStream)` → 従来どおり `stopAndUpload()` で `POST /upload`
2. 鑑賞用：`audioBus` の AudioContext で `createMediaStreamSource(micStream)` を作り、`getMixDestination()` へ接続。BGM/SEも同じ destination に流れているので、`new MediaRecorder(mixDest.stream)` がミックスを録る

既存の安全機構は**そのまま両方に適用する**：世代トークン（許可応答が遅れた回の無効化）、`cancelRecording()`（解散・退出・切断でのマイク解放）、マイク拒否時の skip マーカー送信。鑑賞用トラックが取れなかった場合は「聞き返しなし」に劣化するだけで、採点フローは影響を受けない。

追加 API：

```ts
export function getLastTake(): Blob | null
export function clearLastTake(): void
```

鑑賞用 Blob はモジュールスコープに保持し、次の録音開始で差し替える。

## 5. 聞き返しと共有（`client/src/screens/ResultScreen.tsx`）

結果画面に「🎧 自分の演技を聞く」セクションを追加する。

- `<audio controls src={objectURL}>` で再生
- 「音声を共有」ボタン → 既存 `shareOrDownload(blob, 'ai-shibai-take.webm', text)`
- `getLastTake()` が `null`（音源未配置・マイク拒否・鑑賞用トラック取得失敗）のときはセクションごと非表示

**`share.ts` の修正（このスライスに必要な既存コードの手直し）**：`shareOrDownload` は `new File([blob], filename, { type: 'image/png' })` と**画像決め打ち**なので、音声を渡すと共有シートに誤った種別で渡る。`blob.type || 'application/octet-stream'` を使うよう直す。スコアカード側の呼び出しは Blob が `image/png` なので挙動は変わらない。

**ライフサイクル**：次の録音開始で差し替え、`room_reset` / `game_aborted` / 退出 / 解散で破棄（`URL.revokeObjectURL` も行いメモリを解放）。**リロードで消える**（永続化しない＝今回のスコープ）。

## 6. 既存画面への接続（`RecordingScreen.tsx`）

**イベント契約・サーバーは変更しない。** 既存の受信処理に再生を足すだけ。

- **SE**：`flashSfx(sfxId)` が**ローカル発火（`handleSfx`）と受信（`onSfx`）の合流点**なので、ここで `playSfx(sfxId)` を呼ぶ。1箇所で自分の音も他人の音も鳴る。
- **BGM**：`ctx.bgm` を監視する `useEffect` で `playBgm(ctx.bgm)`。BGM状態は `bgm_changed` が `io.to` で全員に配信する共有状態なので、これだけで全員の音が揃う。
- **停止**：録音フェーズの `useEffect` のクリーンアップで `stopAll()`。RecordingScreen は `recording_stopped`・中断・解散のいずれでもアンマウントされるため、これで全経路をカバーできる。

## 7. 受け入れる副作用

**イヤホン推奨になる。** スピーカーでBGMを鳴らすとマイクが音響的にBGMを拾い、**採点用トラック（マイクのみのはず）にも回り込んで**文字起こしが劣化する。これはBGMを鳴らして初めて発生する問題で、現状は存在しない。準備画面に「イヤホン推奨」の一言を添える。

端末負荷：`MediaRecorder` 2本＋デコード済みバッファ（BGM4＋SE6）。150秒の webm/opus は概ね2MB程度でメモリ上は問題ないが、低スペック端末では実機で様子を見る。

## 8. テスト戦略

- **クライアントにテストフレームワークは無い**（既存方針）。検証は `npm run build`（`tsc && vite build`）clean ＋ 2タブ目視。
- 音が絡む部分は自動テストできない。目視項目：BGM選択で全員に同じ曲が鳴る／SEが自分にも他人にも鳴る／録音終了で止まる／結果画面で自分のテイクがBGM込みで聞ける／共有ボタンが動く／**音源ファイルを置かなくてもゲームが最後まで壊れない**。
- サーバーは無改造なので既存 162 テストがそのまま通ること（回帰確認）。

## 9. 変更ファイル一覧（見込み）

- `client/src/audioBus.ts` — 新規。AudioContext・BGM/SE再生・ミックス出力
- `client/src/recorder.ts` — 鑑賞用 MediaRecorder の追加、`getLastTake`/`clearLastTake`
- `client/src/screens/RecordingScreen.tsx` — `flashSfx` に `playSfx`、`ctx.bgm` に `playBgm`、アンマウントで `stopAll`
- `client/src/screens/CastingScreen.tsx` — `preloadAudio()` の呼び出し
- `client/src/screens/PrepareScreen.tsx` — `resumeAudio()`（準備完了ボタン）＋「イヤホン推奨」表記
- `client/src/screens/ResultScreen.tsx` — 「自分の演技を聞く」＋共有ボタン
- `client/src/share.ts` — MIME 決め打ちの修正
- `client/src/useGameSocket.ts` — `room_reset`/`game_aborted`/退出/解散でテイク破棄
- `client/public/audio/**` — 音源（ユーザーが配置）
