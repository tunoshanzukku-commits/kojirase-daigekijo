# 全員の演技を合体した「作品」設計書

- 日付: 2026-08-28
- 対象: 録音後、全端末のマイク音声と BGM/SE をサーバーで1本に合成し、全員へ配る
- 前提: main HEAD `814b1af`（ライブ音声マージ済み・実機デバッグは別件で継続中）

---

## 1. 目的

**録音が終わったあと、全員のクリーンな録音を合わせ直した「決定版」を1本作り、全員が同じものを聞ける・共有できるようにする。**

現状、結果画面で聞ける「鑑賞用トラック」は端末ごとに別物である。

- ライブ音声 OFF の回：自分の声と BGM/SE しか入っていない
- ライブ音声 ON の回：相手の声は入っているが、**WebRTC 経由で圧縮・欠落したもの**である

一方サーバーは、採点のために**全端末のクリーンなマイク録音**を既に受け取っている。これを捨てずに合成すれば、誰の手元にもない高音質の完成品が作れる。それがこの機能である。

## 2. 決定事項サマリ

| 論点 | 決定 |
|---|---|
| 何を救うか | **ON/OFF を問わず常に高音質版を作る**。ライブ音声の有無で分岐しない |
| BGM/SE | **入れる**。サーバーがタイミングを記録し、合成時に重ね直す |
| 合成の場所 | **サーバー**（ffmpeg）。クライアント合成は採らない |
| 生成のきっかけ | **採点完了後に自動**。ボタンを押させない |
| 頭の揃え方 | **簡易時刻同期**（ping/pong 3往復・最小RTT）で各端末の録音開始を server 時計へ換算 |
| 出力形式 | **m4a (AAC 128k)**。mp3 ではない |
| 失敗時 | **今日の画面へ静かに戻る**。ゲーム体験は一切劣化させない |
| 追加コスト | **AI 課金ゼロ**。Railway の CPU 時間が数秒/ゲーム増えるのみ |

## 3. なぜこの形か

### 3.1 なぜクライアント合成を採らないか

一見、クライアント合成が有利に見える。BGM/SE のバッファは `audioBus.ts` に既にデコード済みで、サーバーの CPU も使わない。しかし2つの理由で不可能に近い。

**Safari が WebM/Opus を `decodeAudioData` できない。** Chrome の `MediaRecorder` は webm/opus を、Safari は mp4/aac を出す。iPhone と PC が混ざる — このアプリで最も多い構成 — で、iPhone 側が相手のトラックをデコードできずに壊れる。

**ブラウザ内に圧縮エンコーダがない。** `OfflineAudioContext` の出力は生の `AudioBuffer` であり、ライブラリを足さずに書き出せるのは WAV だけである。2分半で 13MB になり、モバイルでの共有に耐えない。サーバー合成なら同じ長さが 2〜3MB の m4a で済む。

### 3.2 なぜ ffmpeg か

サーバーは既に `client/dist` を静的配信しており（`server.ts` の `express.static`）、**BGM/SE の mp3 はサーバーのディスク上に存在する**。素材を別途配置する必要がない。

また `finalizeEvaluation` の時点で `room.audio` に全端末の音声が揃っている。**新しいアップロード経路は不要**で、既にあるものを合成するだけで済む。

ffmpeg は形式差（webm/opus と mp4/aac）を透過的に吸収する。これがクライアント合成との決定的な差である。

### 3.3 なぜ mp3 ではなく m4a か

`libmp3lame` は ffmpeg のビルドオプション依存で、入っていない配布物がある。AAC は ffmpeg 内蔵エンコーダなので**どのビルドでも必ず使える**。iOS の共有シートとの相性も m4a のほうが良い。

### 3.4 なぜ時刻同期が要るか

各端末の録音開始は `recording_started` の**到達時刻の差**だけズレる。無対策だと数百 ms〜1秒以上の開きが出る。

**ここを外すと機能の価値が反転する。** ライブ音声 ON で本当に掛け合いをした回ほど、1秒ズレた合成版は手元のテイクより下手に聞こえる。だから頭合わせは省略できない。

## 4. データの流れ

```
recording_started
    ├─ room.recordingStartedAt = Date.now()
    └─ room.audioTimeline = [{ atMs: 0, kind: 'bgm', id: room.bgm }]  ※ room.bgm が非 null のときだけ

send_bgm / send_sfx（status === 'recording' のときだけ）
    └─ audioTimeline に { atMs: Date.now() - recordingStartedAt, kind, id } を追記
       中継（既存の emit）は一切変えない

beginAudioCollection
    └─ room.recordingDurationMs = Date.now() - recordingStartedAt

POST /upload
    └─ room.audio.set(deviceId, { buffer, mime, startedAt })   ← startedAt が新規

finalizeEvaluation
    ├─ 採点 → evaluation_complete            ← ここまで完全に今と同一。合成を待たせない
    └─ 非同期で startMixdown(io, room)
           ├─ 成功 → room.work / room.workToken を立て、work_ready { url } を配信
           └─ 失敗 → work_failed を配信（ログのみ残す）
```

合成は**採点の後に、採点とは独立して**走る。合成が遅くても失敗しても、結果発表は今と同じ速さで出る。

## 5. 時刻同期

### 5.1 プロトコル

```ts
// C2S
time_ping: (payload: { clientSent: number }) => void
// S2C
time_pong: (payload: { clientSent: number; serverNow: number }) => void
```

サーバーは `time_pong({ clientSent, serverNow: Date.now() })` を返すだけ。状態を持たない。

クライアントは 3 往復（間隔 200ms）し、各サンプルについて

```
rtt    = 受信時刻 - clientSent
offset = serverNow - (clientSent + rtt / 2)
```

を計算し、**RTT が最小のサンプルの offset を採用する**。平均ではなく最小 RTT を採るのは、遅延の外れ値（キューイング）が片道遅延の対称性を壊すためで、NTP と同じ考え方である。

### 5.2 いつ同期するか

- socket 接続直後
- `script_ready` 受信時（準備画面。録音開始の直前に間に合う）

**`recording_started` では同期しない。** 録音開始を 600ms 遅らせる価値がない。

### 5.3 濫用の防止

`time_ping` は端末ごとに **1ゲーム 20 回**まで。`Device.signalCount`（WebRTC 用）と同じ持ち方で `Device.timeSyncCount` を足し、`resetRoom` で 0 に戻す。超過分は黙って捨てる。

### 5.4 純粋関数として切り出す部分

```ts
// client/src/timeSync.ts
export interface SyncSample { rtt: number; offset: number }
export function pickBestOffset(samples: SyncSample[]): number  // 空配列なら 0
```

DOM にも socket にも依存しないので単体テストできる。`liveAudioPure.ts` と同じ切り出し方である。

## 6. 録音開始時刻の申告

`startUploadRecorder` が `rec.start()` を呼んだ**その行で** `serverNow()`（= `Date.now() + offset`）を控える。控えるのは**採点用（マイクのみ）のレコーダー**であり、鑑賞用ミックスのほうではない。アップロードされるのは前者だからである。

`stopAndUpload` が FormData に `startedAt` を文字列で載せる。

サーバー側の解釈（`uploadRoute.ts`）:

```
delayMs = clamp(Number(startedAt) - room.recordingStartedAt, 0, 10_000)
```

- パースできない・欠落・NaN → `delayMs = 0`
- 負値 → 0（時刻同期の誤差で起こりうる）
- 10 秒超 → 10 秒（壊れた値で作品の頭に無音が延々入るのを防ぐ）

**`startedAt` の不備でアップロードを失敗させてはならない。** 採点は音声が届くことに依存しており、頭合わせはそれより優先度が低い。

`MediaRecorder` の実際の収録開始は `rec.start()` からわずかに遅れるが、この遅れは端末間でおおむね等しいので相殺される。

## 7. BGM/SE タイムライン

```ts
// roomStore.ts
export interface TimelineEntry {
  atMs: number
  kind: 'bgm' | 'sfx'
  id: string | null   // bgm の停止（null）を表せるようにする
}
```

`send_bgm` / `send_sfx` は既に `status === 'recording'` でガードされているので、既存のバリデーション直後に追記を1行足すだけでよい。

**上限 60 エントリ。** 超えたら追記しない（中継は続ける）。ffmpeg の入力本数が青天井になるのを防ぐための蓋であり、正常なプレイでこの数に届くことはない。

`send_sfx` は `socket.to()` で送信者本人には届かないが、本人はローカルで鳴らしている。サーバーはハンドラ到達時に1回記録するので、どちらの経路でも二重にならない。

タイムラインは `beginAudioCollection` では消さず（合成で使うため）、`resetRoom` と録音開始時にクリアする。

## 8. 合成

### 8.1 モジュール分割

| ファイル | 役割 | テスト |
|---|---|---|
| `server/src/mixdownPlan.ts` | **純粋関数**。トラック＋タイムライン＋尺 → ffmpeg 引数配列 | ここが本体 |
| `server/src/mixdown.ts` | 一時ファイル・プロセス起動・タイムアウト・後始末 | スタブで差し替え |
| `server/src/workRoute.ts` | `GET /work/:code/:token` | ルート単体 |

```ts
// mixdown.ts
export interface MixTrack { buffer: Buffer; mime: string; delayMs: number }
export interface MixInput {
  tracks: MixTrack[]
  timeline: TimelineEntry[]
  durationMs: number
  audioDir: string        // client/dist/audio
}
export type Mixdown = (input: MixInput) => Promise<Buffer>   // m4a
export function createMixdown(): Mixdown
```

`ai` / `limits` と同じく handlers へ注入する。テストはスタブを渡すので ffmpeg を呼ばない。

`audioDir` は `server.ts` の `resolveDistDir()` の結果に `/audio` を足したもので、静的配信が見ているのと**同じディレクトリ**を指す。`distDir` オプションで差し替えられたときも一致させる（2 か所で別々に解決してはならない）。

### 8.2 ffmpeg のグラフ

クライアントの `audioBus.ts` の配線をそのまま再現する。

```
声 i        : [i:a] adelay=Di|Di, aformat=stereo/48k
BGM 区間 k  : -stream_loop -1 -i bgm/<id>.mp3
              [k:a] atrim=0:LEN, asetpts=N/SR/TB,
                    afade=t=in:st=0:d=0.1,
                    afade=t=out:st=LEN-0.1:d=0.1,
                    adelay=Tk|Tk, aformat=stereo/48k
SE   j      : -i sfx/<id>.mp3
              [j:a] adelay=Tj|Tj, aformat=stereo/48k
                          ↓
        amix=inputs=M:normalize=0:dropout_transition=0
                          ↓
              alimiter=level_in=1:limit=0.95
                          ↓
        -c:a aac -b:a 128k -ac 2 -ar 48000 -t <durationMs/1000>
```

**`normalize=0` が要点である。** `amix` の既定は入力数で割るため、そのままだと人数が増えるほど作品が小さくなる。代わりに `alimiter` でクリップだけ止める。これでクライアントで聞いた音量バランス（BGM もマイクもゲイン 1.0）と一致する。

BGM のフェード 0.1 秒は `audioBus.ts` の `FADE_SEC` と同値である。耳で聞いた切り替わりと合成版を揃えるための一致であり、片方だけ変えてはならない。

BGM 区間の終端は「次の bgm エントリの `atMs`」、最後の区間は `durationMs`。`id === null` のエントリは区間を閉じるだけで新しい入力を作らない。

同じ mp3 を複数回 `-i` に並べてよい（ffmpeg は重複入力を問題なく扱う）。`asplit` は使わない — 引数の組み立てが単純なほうがテストしやすい。

### 8.3 実行の安全弁

- **タイムアウト 30 秒**で kill する
- 一時ファイルは `os.tmpdir()` 配下の部屋ごとのディレクトリに置き、`finally` で必ず削除する
- **同時実行はグローバルに 1 本**。小さなキューで直列化する。複数の部屋が同時に終わったときに Railway のメモリと CPU を踏み抜かないため
- 合成が成功したら `room.audio` を破棄する（1部屋あたり 30MB 前後を回収できる）

### 8.4 ffmpeg が無い環境

起動時に一度 `ffmpeg -version` を実行して可用性をログに出す。取れなければ `createMixdown()` は「常に失敗する Mixdown」を返し、合成機能だけが黙って無効になる。ローカル開発でも本番でも、**ffmpeg の不在でサーバーが起動しないことがあってはならない**。

## 9. 配信

```ts
// S2C
work_ready:  (payload: { url: string }) => void
work_failed: () => void
```

`room.workToken`（`randomUUID()`）を発行する。

**`work_ready` が運ぶのはパスであってフル URL ではない**（`/work/<code>/<token>`）。クライアントが `${SERVER_URL}${path}` を組む。同居デプロイでは `SERVER_URL` が空文字になるため、サーバー側でホスト名を組み立てるとリバースプロキシ配下で壊れる。

**トークンが要る理由**: 部屋コードは 4〜6 桁で総当たりできる。コードだけで取れる URL にすると、無関係な第三者が他人の演技音声を引ける。

- `/upload` と同じレート制限を掛ける
- `content-type: audio/mp4`、`cache-control: no-store`
- トークン不一致・部屋なし・作品なし → **404**（403 と撃ち分けない。存在の有無を漏らさない）

`resetRoom` と部屋削除で `work` / `workToken` をクリアする。合成中にリセットが入った回は、`finalizeEvaluation` と同じ `evaluationSeq` のスナップショット比較で `work_ready` を捨てる。

## 10. クライアント UI

`ResultScreen` の既存テイクパネルを拡張する。新しいパネルは足さない。

| 状態 | 表示 |
|---|---|
| 合成中 | 今のローカルテイクを再生可能なまま置き、下に小さく「全員の声を合わせた決定版を仕上げています…」 |
| `work_ready` | プレイヤーを作品に差し替え、見出しを「決定版（全員の声）」に。共有ボタンは URL から blob を取って `shareOrDownload` |
| `work_failed` | 補足行を消すだけ。**今日とまったく同じ画面になる** |

**ローカルテイクを再生している最中に `work_ready` が来ても、そのまま差し替える。** 合成は通常数秒で終わり、プレイヤーがスコアを読んでいる間に完了する。再生の終了を待つ状態機械を足すほどの頻度ではない。

`GameContext` に `workUrl: string | null` と `workState: 'pending' | 'ready' | 'failed'` を足す。`room_reset` / `game_aborted` / `evaluation_failed` で `'pending'` へ戻す。

1人プレイでも動く。トラック1本＋BGM/SE の合成になり、ソロでも「BGM 入りのちゃんとした作品」が手に入る。

**この機能が丸ごとコケても、体験は現状より悪くならない。** これは設計上の要件であり、実装中に崩してはならない。

## 11. テスト

| ファイル | 内容 |
|---|---|
| `client/tests/timeSync.test.ts` | `pickBestOffset` — 最小 RTT の選択、外れ値の無視、空配列で 0 |
| `server/tests/mixdownPlan.test.ts` | `delayMs` の反映、タイムライン→BGM 区間の切り出し（`null` で閉じる／最後は尺で閉じる）、60 件クランプ、`-t` が尺と一致 |
| `server/tests/handlers.work.test.ts` | スタブ注入で `work_ready` が飛ぶ／失敗で `work_failed`／リセット後は飛ばない／成功後に `room.audio` が空 |
| `server/tests/workRoute.test.ts` | トークン不一致で 404、部屋なしで 404、一致で 200 と `content-type` |
| `server/tests/handlers.upload.test.ts`（追記） | `startedAt` 欠落・NaN・負値・過大値がすべて `[0, 10000]` に落ちる |

`tsc --noEmit` がサーバー側の実質的なゲートである（`tsx` は型検査しない）。

## 12. デプロイ

`ffmpeg-static`（npm、5.3.0）を server の依存に足す。`npm --prefix server ci` の postinstall で GitHub からバイナリ（約 80MB）を取得する。

**Railway のビルド環境でこの取得が通るかは、実際にデプロイするまで確定できない。** 通らなかった場合は `RAILPACK_BUILD_APT_PACKAGES=ffmpeg` で apt から入れ、`FFMPEG_BINARY` 環境変数でパスを指すことで回避できる。詰みはしないが、初回デプロイで見る必要がある項目である。

イメージサイズが 80MB 増える点も併せて許容する。

## 13. やらないこと

- **作品の永続化**。`room.work` はメモリ上にだけ持ち、部屋のリセット・解散で消える。外部ストレージは導入しない
- **公開 URL としての共有**。X へは今と同じくファイルとして共有する（`shareOrDownload`）。作品の URL を SNS に貼れるようにはしない
- **編集機能**。トリミング、音量調整、テイクの差し替えは対象外
- **合成のやり直し**。1ゲームにつき1回だけ。失敗したらその回は諦める

## 14. 繰り越し・未確定

- ライブ音声の iPhone Safari 実機デバッグは本設計と独立に継続する
- 録音尺と台本の尺の不整合（既存の保留事項）はここでも解消しない。作品の長さは録音の実尺に従う
