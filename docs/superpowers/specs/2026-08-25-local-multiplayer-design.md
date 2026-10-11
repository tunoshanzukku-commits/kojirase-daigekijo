# ローカル複数プレイヤー（携帯回し・オンライン混在）設計書

- 日付: 2026-08-25
- 対象: サブプロジェクト **A+B**（下の「分解」を参照）
- 前提バージョン: v1.0.0（HEAD `1e5f900`）

---

## 1. 目的

1台のスマホに複数のプレイヤーを乗せて遊べるようにする。これにより次の2つが同時に成立する。

- **携帯回しモード**: 全員が1台のスマホで遊ぶ（オンライン参加者ゼロ）
- **混在プレイ**: 1台に数人が乗り、さらに別の端末からオンラインで参加する

この2つは別機能ではなく、**「端末にプレイヤーを追加できる」という1つの仕組みの2つの使われ方**である。排他のモード切り替えは設けない。

## 2. 分解と本書の位置づけ

ユーザーから出た4つの要望を4つのサブプロジェクトに分解した。本書は **A+B** のみを扱う。

| | 内容 | 状態 |
|---|---|---|
| **A** | 1端末に複数プレイヤー（携帯回し・混在の土台） | **本書** |
| **B** | 1本の音声に入った複数人を台本照合で採点する | **本書** |
| **C** | 録音音声を合体して1作品として共有 | 未着手 |
| **D** | リアルタイム演技のブラウザ配信（ON/OFF） | 未着手 |

**依存関係の注意**: D（リアルタイム配信）を先に作ると、各クライアントのミックストラックに全員の声が入るため C がほぼ無償で手に入る。C を単独で作るとサーバー側ミキシング（ffmpeg）が必要になる。C に着手する前に D の順序を再検討すること。

## 3. 決定事項サマリ

| 論点 | 決定 |
|---|---|
| 録音の形 | **1発どり**。全員が1台を囲み、台本の順に自分の台詞を掛け合う。録音を途中で止めない |
| 同じ台詞を全員で言う機能 | **不要**（明示的に却下された） |
| モードの見せ方 | **モードなし**。ロビーの「＋この端末にプレイヤーを追加」だけ |
| 台本確認 | **一括表示・色分け**。スマホを1人ずつ回す専用フローは作らない |
| プレイヤー色 | **参加順で固定（1P〜10P）**。全画面で同じ人が同じ色 |
| 結果の共有 | 端末に2人以上いるときは「自分の結果」を出さず**全体共有のみ** |
| データモデル | **deviceId をキーにする**（socketId キーのままにしない） |
| 採点の帰属 | **1本を丸ごと文字起こしし、台本照合でAIに帰属させる**。話者分離サービスは導入しない |
| ホスト端末の切断 | **今回は触らない**。既存挙動（即解散）のまま繰り越す |

---

## 4. データモデル

### 4.1 中核の分離

現状は `socketId` が「接続」と「プレイヤー」の2つの役割を兼ねている。これを分ける。

- **Device** ＝ 1つのブラウザ接続（1台のスマホ）
- **Player** ＝ 役を持つ1人
- **代表プレイヤー** ＝ `device.playerIds[0]`（その端末に最初に入った人）。ホストバッジ・リアクションの送信者名など、「端末を1人で代表させる」場面でのみ使う

```ts
// server/src/roomStore.ts
export interface Device {
  id: string                       // 安定ID。再接続しても変わらない
  socketId: string                 // 接続のたびに変わる
  token: string                    // 再接続クレデンシャル（端末ごとに1つ）
  isHost: boolean
  isReady: boolean                 // 準備完了は端末単位
  disconnectedAt: number | null
  playerIds: string[]              // この端末が抱える人（追加順）
}

export interface Player {
  id: string
  name: string
  deviceId: string
}

export interface Room {
  devices: Map<string, Device>     // deviceId キー
  players: Map<string, Player>     // playerId キー
  socketIndex: Map<string, string> // socketId → deviceId（接続からの逆引き）
  hostDeviceId: string
  audio: Map<string, { buffer: Buffer; mime: string }>  // deviceId キー ＝ 端末ごとに音声1本
  uploadExpected: Set<string>                           // deviceId
  volumes: Map<string, { level: number; ts: number }>   // deviceId
  returned: Set<string>                                 // deviceId
  graceTimers: Map<string, ReturnType<typeof setTimeout>> // deviceId
  // 以下は変更なし
  // code / status / genre / script / scores / bgm / recordingRoster /
  // generatingScript / aiMode / collectingAudio / uploadTimer /
  // recordingTimer / evaluationSeq / createdAt / lastActivityAt
}
```

### 4.2 なぜ socketId ではなく deviceId をキーにするか

`audio` / `uploadExpected` / `volumes` / `returned` / `graceTimers` は**意味的には元から「端末ごと」で正しい**（音声は端末から来る、切断するのは端末）。しかし socketId は再接続で変わるため、現在の `reattachPlayer` はこれら5種類のエントリを旧 socketId から新 socketId へ付け替えている。「アップロード済み音声を捨てると、本当に演じた人が無音扱いで採点される」というコメントが付いた壊れやすい箇所である。

キーを安定した deviceId にすると、この付け替えが丸ごと不要になる。1端末にN人が乗ると付け替え対象がさらに増えるため、ここで直す。

（代替案: socketId キーのまま `player.deviceSocketId` を足す。触る範囲は狭いが付け替えが残り、そこにN人分の更新が加わる。負債が残るため採らない。）

### 4.3 共有型の変更

```ts
// shared/types.ts
export interface PlayerSnapshot {
  id: string          // 追加
  deviceId: string    // 追加。同じ値の人が同じ端末にいる（クライアントのグループ表示に使う）
  name: string
  isHost: boolean     // 端末の代表プレイヤー（最初に追加した人）に立てる
  isReady: boolean    // 端末の値をそのまま配る
  connected: boolean  // 端末の接続状態
}
```

`deviceId` は資格情報ではなく単なるグルーピングID（`token` とは別物）。クライアントは自分の `deviceId` と突き合わせて「この端末の人」を判定する。

### 4.4 イベントの変更

| イベント | 変更 |
|---|---|
| `add_local_player` | **新規**（C→S）`{ playerName }` |
| `remove_local_player` | **新規**（C→S）`{ playerId }` |
| `room_created` / `room_joined` / `rejoined` | payload に `deviceId` を追加 |
| `rejoined` | `selfName` → `selfPlayerNames: string[]` |
| `kick_player` | → `kick_device: { deviceId }`。切断中の端末を中の全員ごと外す |
| `player_joined` / `player_left` | そのまま流用（ローカル追加も部屋にとっては1人の増減） |
| `player_returned` | 端末単位で処理するが、**その端末の全員ぶん**流す（クライアントの人数表示を嘘にしないため） |

`create_room` / `join_room` の payload は変更しない（`playerName` ＝ その端末の最初の1人）。

---

## 5. ロビーとプレイヤー追加

### 5.1 参加者一覧を端末ごとにグループ表示

```
参加者 4 / 10

┌ この端末 ───────────────────┐
│ ㊞ ミチ    [ホスト]              │
│ ㊞ タロウ                    [×] │
│ ㊞ ハナコ                    [×] │
│ ［＋ この端末にプレイヤーを追加］  │
└─────────────────────────────┘

┌ オンライン ─────────────────┐
│ ㊞ ジロウ                        │
└─────────────────────────────┘
```

- 自分の端末のグループだけ「＋追加」と各人の「×」を出す（判定は `p.deviceId === ctx.deviceId`）
- 人単位の「（あなた）」表記は廃止し、**グループ見出し「この端末」**に置き換える（N人いると「あなた」が意味を失うため）
- ホストバッジは端末の代表プレイヤー（最初に追加した人）に付く
- 他端末も2人以上ならグループで見える（混在時に「あの端末に2人いる」が分かる）

### 5.2 追加・削除のルール

| 項目 | 決定 |
|---|---|
| 追加できる端末 | **全端末**。ゲストの端末に2人いてもよい（混在プレイはこれで成立する） |
| 追加できる時 | `join_room` と**同じ3つのガード**を通す: ① `status` が `waiting` または `evaluating`（復帰待ち中） ② `generatingScript` が false ③ `collectingAudio` が false |
| 名前の検証 | 既存と同じ（`sanitizeName` / 1〜`NAME_MAX`文字 / 部屋内で重複禁止） |
| 上限 | 部屋全体で `MAX_PLAYERS`（10人）。端末ごとの上限は設けない。到達したら追加ボタンを無効化し理由を出す |
| 削除 | 自分の端末の**代表以外**に「×」。代表を消す＝端末ごと抜けることなので既存の「退出」の仕事 |
| 削除できる時 | 追加と同条件 |

### 5.3 入力の形

「＋追加」を押すとその場に入力欄が開き、名前を入れて確定（インライン、画面遷移なし）。連続で足せるよう、確定後は入力欄を空にして開いたままにする。

エラーはサーバーの `error` イベントで返すが、**重複と文字数はクライアント側でも即時に弾いて**その場に赤字で出す。3人分を続けて入れるときのテンポのため。

### 5.4 キックの意味

`kick_device` は**切断中の端末を、中の全員ごと外す**。確認ダイアログでそれを明示する。

> この端末（タロウ・ハナコ の2人）を退出させますか？

対象の判定は現状どおり「切断中かつホストでない端末」のみ。

---

## 6. プレイヤー色（1P〜10P）

参加順に固定色を割り当てる。同じ人が全画面で常に同じ色になる。

```
1P 朱      #b8352c      6P  錆浅葱  #3f6b67
2P 群青    #3a4f7a      7P  海老茶  #6b3f2e
3P 深緑    #46603f      8P  藍鉄    #2f4550
4P 山吹    #7d5b16      9P  鶯茶    #656124
5P 葡萄鼠  #5f4c6b     10P  墨      #241c17
```

- 出どころ: 8色は既存の `GENRE_ACCENT` / `DEFAULT_ACCENT`（client/src/genreStyles.ts）から流用（朱・群青・深緑・山吹・葡萄鼠・錆浅葱・藍鉄・墨）。**7P 海老茶と 9P 鶯茶の2色だけ新規**。`GENRE_ACCENT` の紅梅 `#9d4448` は 1P 朱と近すぎるため採らない
- コントラストは2つの地の**両方**で 4.5:1 を満たすこと（実測値）:

  | 地 | 最小 | 該当色 |
  |---|---|---|
  | 本文地 `#f0e7d2`（body） | **4.76:1** | 1P 朱 |
  | パネル地 `#f7f1e3`（`bg-kinari`＝`.washi-panel` と台本の行） | **5.20:1** | 1P 朱 |

  4P 山吹は `GENRE_ACCENT.comedy` の `#8a6519` だと本文地で **4.31:1** と不足するため、このパレット用に暗くした `#7d5b16`（5.05:1）を使う。9P 鶯茶も初案 `#6e6a2a` が 4.54:1 で余裕がないため `#656124`（5.19:1）とする。**`GENRE_ACCENT` 側の値は変更しない** — あちらは帯の地として `text-kinari`（明色）を載せる用途で、コントラストの要求が逆向きだから。

- 割り当ては**部屋全体の参加順**。端末をまたいで通し番号（1台目に3人なら 1P・2P・3P、次の端末の人が 4P）
- **参加順の定義**: 端末の作成・参加順 → その端末内での追加順。この順序が 1P〜10P の根拠であり、同時に台本生成へ渡す `names` 配列と `recordingRoster` の順序でもある（3箇所で同じ順序を使う）
- 使う場所: ロビーの㊞、配役カード、台本の罫とバッジ、結果一覧の㊞
- ジャンル差し色と偶然かぶるのは許容（帯・見出し＝ジャンル色、罫・㊞＝プレイヤー色、と使う場所が違う）
- 11人目以降は循環（`MAX_PLAYERS` が10なので通常は到達しない）
- 定義は `client/src/playerColors.ts` に1箇所だけ置く

「紙が地で、色は差し色」という既存の設計言語を守り、色を乗せるのは**罫と名前バッジだけ**。地は生成りのまま。

---

## 7. 配役・準備・録音

### 7.1 配役画面

「あなたの役」カードを**この端末の人数分**並べる。他は従来どおり「他のプレイヤーの役」の一覧へ。

### 7.2 台本の色分けと名前バッジ

準備画面・録音画面ともに、**この端末のプレイヤーの台詞だけ**を色分けし、名前バッジを付ける。

```
┃ カイト ‹ミチ›     ← プレイヤー色の太罫 ＋ バッジ（この端末）
┃ 「もう黙ってらんない」
┃ サクラ ‹タロウ›   ← プレイヤー色の太罫 ＋ バッジ（この端末）
┃ 「それは…」
│ 占い師            ← 灰の細罫・バッジなし（他端末）
│ 「運命は変えられる」
```

全員に色が付くと「この端末の誰が言う番か」が埋もれるため、**台本だけは罫の太さで局所/遠隔を描き分ける**。

**名前バッジは新規追加**。1台を囲んで読むとき、キャラ名だけでは誰が言う番か分からないため。

色割り当てのヘルパーは `client/src/playerColors.ts` に切り出し、配役・準備・録音の3画面で共有する。

### 7.3 端末単位になる操作

| 操作 | 単位 | 備考 |
|---|---|---|
| 準備完了 | **端末**（1ボタン） | 3人いれば「3人とも準備OK」と表示。`Device.isReady` を配下全員の `PlayerSnapshot.isReady` に配るので他端末の見え方は従来どおり |
| マイク許可 | **端末**（1回） | 既にそう |
| BGM・効果音・リアクション | **端末** | 送信者名は端末の代表プレイヤー名を載せる |
| 音量バー | **端末** | 既に接続単位。キーが deviceId になるだけ |
| 録音開始・終了 | **ホスト端末** | 変更なし |

### 7.4 録音は1発どり

録音経路（`client/src/recorder.ts`）は**一切変更しない**。1端末＝1マイク＝1本の音声で、中に何人いようとクライアント側の処理は同じ。`recordingRoster` は従来どおり全プレイヤー名の配列。

**`RECORDING_LIMIT_SEC`（150秒）は触らない。** 1端末に何人乗っても台詞の総量は変わらないため。既存の「演技時間と台本の尺の不整合」は別課題として据え置く。

---

## 8. 音声の収集と採点（B）

### 8.1 収集は端末ごとに1本

```
beginAudioCollection:
  uploadExpected = 接続中の端末の deviceId 集合   ← 人数ではなく台数
```

`server/src/uploadRoute.ts` はクライアントから送られた `socketId` で部屋を引く形のまま。`socketIndex` で deviceId に解決してから `audio` / `uploadExpected` を触る。**アップロード経路とクライアントの録音処理は実質無変更**。

### 8.2 Evaluator の入力を「人ごと」から「音声ソースごと」へ

```ts
// server/src/ai/evaluate.ts
export interface AudioSource {
  players: string[]                                // この1本に入っている人（参加順）
  audio: { buffer: Buffer; mime: string } | null   // null = マイク拒否・未着
}

export type Evaluator = (
  script: ScriptData | null,
  performers: string[],       // 採点対象の全員（従来どおり）
  sources: AudioSource[],     // audioByName から差し替え
) => Promise<PlayerScore[]>
```

文字起こしは**ソースごとに1回**。携帯回しで5人なら Groq への呼び出しが 5回 → 1回に減る（費用減）。

### 8.3 プロンプトの組み立て

**全ソースが1人なら、現行とバイト単位で同じプロンプトを出す。** 既存のオンラインプレイの採点品質は調整済みであり、そこに回帰を持ち込まないことを設計制約とする。

共有録音（2人以上が1本）が**1つでもあるときだけ**、録音セクションを差し込み、該当者の「実際の発話」を参照に変える。

```
世界観：エモい失恋話が渦巻く大学のキャンパス

【録音】この回には、複数人が同じマイクの前で演じた録音があります。
▼ 録音A（ミチ・タロウ・ハナコ の3人）
文字起こし：もう黙ってらんない それは… あのさ 待ってよ …

▼ ミチ
役：カイト（失恋したばかりの大学生）
台本の台詞：もう黙ってらんない / …
実際の発話：録音A を参照

▼ ジロウ                        ← 1人しかいない端末は従来どおり
役：占い師（謎めいた老人）
台本の台詞：運命は変えられる / …
実際の発話：運命は変えられる …
```

### 8.4 帰属のルールをどこに書くか

システムプロンプト `prompts/score-system.md` には**すでに**「他人の声が紛れ込む前提で、台本と照合して帰属させよ」「本人の台詞に相当する発話がなければ無音として扱え」という指示がある。今回はこれを偶発から前提へ格上げする。

ファイルは複製しない（複製すると片方だけ直されて必ず食い違う）。共有録音があるときだけ末尾に追記ぶんを連結する。

```
prompts/score-system-shared.md   ← 新規。追記ぶんだけ（全文の複製ではない）
```

```
selectScoreSystem(performerCount, hasShared):
  performerCount === 1  → score-system-solo.md
  hasShared             → score-system.md ＋ score-system-shared.md
  それ以外              → score-system.md   （現行と完全に同じ）
```

追記ぶんに書く内容:

- 文字起こしは話者を区別しないこと
- **台詞の内容と順番だけが手がかり**であること
- 判別できない発話は、どちらの加点にも減点にも使わないこと

### 8.5 変わらない挙動

| ケース | 挙動 |
|---|---|
| マイク拒否の端末 | その端末の**全員**が無音扱い＝最低点。現行と同じ経路（skip マーカー） |
| 端末が切断 | その端末の**全員**が `leftPlayers` に入り採点対象外 |
| 簡易モード | `generateStubScores(performers)` のまま |
| AI枠 | 1ゲーム1枠のまま |

### 8.6 精度の限界（明示）

**帰属の精度は自動テストで担保できない。** テストで守れるのは「プロンプトが正しい形に組み上がるか」「全ソース1人のとき従来と同一文字列になるか」まで。実際の効き目は実機で確認する（11.3節）。

精度が足りない場合の次の手は **タイムスタンプ付き文字起こし**（Groq の `response_format: verbose_json` で segment 単位の時刻を得る）。話者は分からないが、台詞の順番と時系列の対応が帰属のヒントになる。`AudioSource` を通す設計にしてあるため、`transcribe` の戻りを `{ text, segments? }` に広げるだけで足せる。本書の設計はこれを塞がない。

話者分離サービス（AssemblyAI / Deepgram / ElevenLabs 等）への乗り換えは、新プロバイダの追加・日本語精度の検証・コストに見合わないため**採らない**。

---

## 9. 切断・再接続・退出・ホスト

### 9.1 deviceId キー化の効果

```ts
// 現行の reattachPlayer（5種類のエントリを旧→新 socketId へ付け替え）
room.players.delete(old); room.volumes.delete(old); room.returned.delete(old)
const uploaded = room.audio.get(old); if (uploaded) room.audio.set(newId, uploaded)
room.audio.delete(old); room.uploadExpected.delete(old); clearGraceTimer(room, old)
player.socketId = newId; room.players.set(newId, player)

// 新しい reattachDevice
room.socketIndex.delete(device.socketId)
device.socketId = newSocketId
room.socketIndex.set(newSocketId, device.id)
device.disconnectedAt = null
clearGraceTimer(room, device.id)
```

`audio` / `uploadExpected` / `volumes` / `returned` は deviceId キーなので触る必要がない。

### 9.2 端末単位に揃うもの

| 対象 | 挙動 |
|---|---|
| 事故切断 | `device.disconnectedAt` を立てる。**中の全員**が `connected: false`（「復帰待ち…」）で見える |
| 猶予タイマー | `graceTimers` は deviceId キー。満了で端末ごと削除＝中の全員が `player_left` |
| 再接続トークン | **端末ごとに1つ**。`sessionStorage` 保存は変更なし。`rejoin` で端末が戻ると中の全員が一緒に戻る |
| `rejoined` の返り | `selfName` → `selfPlayerNames: string[]` |
| 意図的な退出 | 端末ごと。確認ダイアログに人数を出す（「3人とも退出します」） |
| キック | `kick_device`（5.4節） |
| 収集中の切断 | `uploadExpected` から端末を外す。残り0なら確定。現行と同じ |
| 全員ロビー復帰 | `allReturned` は端末単位（接続中の全端末が `returned` に入ったら） |
| 部屋の消滅 | `players.size === 0` → `devices.size === 0` |

### 9.3 ホスト端末の切断は今回触らない

現状、ホストが切断すると部屋は即解散する（猶予なし。リロードでも消える）。これはオンラインプレイでもソロプレイでも同じで、既に本番で動いている挙動である。

ただし**携帯回しモードでは意味が重くなる**。全員が1台に乗っているため、その1台が iOS Safari にバックグラウンドで落とされたりリロードされたりすると、5人で演じていた回が丸ごと消える。

**判断: 今回は触らない。** この問題は A+B が作り出すものではなく既存のものであり、A+B を先に出したほうが早く遊べるため。繰り越し済みの「B6 ホスト移譲」と同じ枠であつかう。ただし携帯回しモードは構造的に1台への依存が高いため、**この繰り越し課題の優先度は上がった**（13節に記録）。

---

## 10. 結果画面と共有

| 要素 | 変更 |
|---|---|
| スコア一覧 | 各行の㊞をその人の 1P〜10P 色にする。それ以外は変更なし |
| 「自分の結果を X でシェア」 | **この端末が1人のときだけ表示**。2人以上なら出さない |
| 「みんなの結果を X でシェア」 | 変更なし（`ctx.players.length > 1` の条件も維持） |
| 「自分の演技を聞く」 | 2人以上なら見出しを**「みんなの熱演を聞く」**に。共有テキストも個人名からルーム向け文言へ |
| 楽屋へのお便り | 変更なし。端末に1つ。`playerCount` は部屋の人数のままで意味が合う |
| 「n/m 人がロビーへ戻りました」 | `player_returned` をその端末の全員ぶん流すことで、人数単位の表示を維持 |

`ctx.playerName` の残る用途は「トップ画面の名前入力の保持」と「端末が1人のときのシェア文言」だけになる。`ctx.localPlayers: { id, name }[]` を新設し、`playerName` はその先頭を指す薄い別名として残す。

---

## 11. テスト方針

### 11.1 既存テストへの影響

server/tests に30本、client/tests に1本。型が変わるため広く浅く当たる。

- `PlayerSnapshot` に `id` / `deviceId` が増える → スナップショット組み立てのヘルパー
- `rejoined` の `selfName` → `selfPlayerNames`
- `kick_player` → `kick_device`
- `server/tests/testUtils.ts` を device 前提に更新すれば、大半のテストは中身を変えずに通るはず

### 11.2 新規に書くテスト

| ファイル | 検証内容 |
|---|---|
| `roomStore.test.ts` | ローカル追加・削除、端末削除で中の全員が消える、**`reattachDevice` が audio / uploadExpected / volumes / returned を触らない** |
| `handlers.localPlayer.test.ts`（新規） | 進行中は追加を拒否、満員、名前重複、代表プレイヤーは削除不可、ゲスト端末でも追加できる |
| `handlers.evaluation.test.ts` | 1端末3人で `uploadExpected` が1件、`sources` が `players: 3人` で組まれる |
| `scoreGen.test.ts` | **全ソース1人なら従来と同一のプロンプト文字列**（B の回帰防止の要） |
| `scoreGen.test.ts` | 共有ソースがあるとき録音セクションが入り、該当者の発話が参照になる／`score-system-shared.md` が連結される |
| `prompts.test.ts` | `REQUIRED_FILES` に `score-system-shared.md` が入り、欠損で起動時に落ちる |
| `playerColors.test.ts`（新規・client） | 1P〜10P の割り当てと11人目以降の循環 |

進め方は TDD。**`tsc --noEmit` が実質のゲート**（server は tsx 実行のため型チェックが走らない）。

### 11.3 自動化できない確認

実機で1回通す。3人が1台＋オンライン1人の混在で、録音 → 実AI採点 → 結果まで。

1. 共有録音の**帰属精度**（8.6節）
2. 1台を囲んで台本を読むときの**色分けと名前バッジの実用性**（文字サイズ・視認距離）

---

## 12. 変更しないもの

- 録音経路（`client/src/recorder.ts`）
- 台本生成（`ai/scriptGen.ts` / `scriptLibrary.ts` / `prompts/script-*.md`）— N人分の役を作るだけなので影響なし。ただし呼び出し側（`handlers.ts`）が渡す `names` の**組み立て順**は6節の「参加順の定義」に従う
- `ScriptData` / `PlayerScore` の形
- `RECORDING_LIMIT_SEC`（150秒）
- AI枠の消費（1ゲーム1枠）
- レート制限、公開ガード、感想欄の転送
- ホスト切断時の即解散（9.3節）

---

## 13. 繰り越し・未解決

- **B6 ホスト移譲 / ホスト端末の猶予** — 携帯回しモードの登場で優先度が上がった（9.3節）
- **C: 録音音声の合体・共有** — D を先に作ると安く済む（2節）
- **D: リアルタイム演技配信 ON/OFF**
- **演技時間と台本の尺の不整合** — 既存課題。「演技時間の設定画面」を入れるときに一括対応
- **切断中プレイヤーが配役に混じる** — 既存課題
- **ハプニングイベント** — 既存課題
- **PC の SNS 投稿** — 既存課題
