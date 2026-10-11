# 音源ファイルの置き場

ここに置いたファイルはビルド時にそのまま配信されます（Vite の `public/`）。
ファイル名は `shared/constants.ts` の `BGM_IDS` / `SFX_IDS` と**1対1**です。
ID と同じ名前で置けば、コードの変更なしで鳴ります。

## BGM（`bgm/`）— ループ再生

| ファイル名 | 用途 |
|---|---|
| `dramatic.mp3` | ドラマチック |
| `horror.mp3` | ホラー |
| `comedy.mp3` | コメディ |
| `battle.mp3` | バトル |

## SE（`sfx/`）— ワンショット

| ファイル名 | 用途 |
|---|---|
| `drum.mp3` | ドラムロール |
| `boom.mp3` | 爆発・衝撃 |
| `fanfare.mp3` | ファンファーレ |
| `scream.mp3` | 悲鳴 |
| `laugh.mp3` | 笑い声 |
| `bell.mp3` | ベル・チーン |

## 注意

- **形式は mp3 を推奨**（ブラウザ間で最も確実に `decodeAudioData` が通る）。別の拡張子にする場合はコード側の定数を1箇所変えます。
- **ファイルが無くても壊れません。** 置いていない音は「無音」として黙って飛ばし、ゲームは最後まで通常どおり動きます（コンソールに警告が出るだけ）。
- BGM はループ前提なので、**先頭と末尾が自然に繋がる素材**だと綺麗です。
- **長さの目安：BGM は30秒以内のシームレスループ、SE は1〜2秒程度。**
  `decodeAudioData` はデコード後の非圧縮PCMをページが開いている間ずっとメモリに保持するため、
  2分のステレオBGMは1曲でおよそ46MBにもなります。BGMを短いループにするだけで、
  スマホでも複数曲・複数SEを同時に抱えて重くなるのを防げます。
- ライセンスは配布物に含まれるため、**商用利用・再配布可のものを選んでください**。
  リポジトリを公開すると素材ファイル単体を誰でも持ち出せる＝再配布になるので、
  「アプリ内での使用は可・2次配布は禁止」の素材（多くの国内フリー素材サイトがこれ）は使えません。
- **差し替えたら `shared/credits.ts` も直すこと。** タイトル画面のクレジット画面と、
  作品 m4a のメタデータ（`server/src/mixdownPlan.ts`）がそこを読んでいます。

## 出典・ライセンス

素材はすべて**再配布可**のライセンスです。

- **OtoLogic**（<https://otologic.jp>）— [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)。
  クレジット表記が利用条件です（[ライセンス](https://otologic.jp/free/license.html)・[FAQ](https://otologic.jp/free/faq.html)）。
  表記はゲーム内（タイトル画面 →「クレジット」）、作品 m4a のメタデータ、この README の3か所に入れています。
  「協力」「提供」など OtoLogic が関与しているように見える書き方は規約で禁止されています。
- **freesound** — CC0（パブリックドメイン相当・表記不要）。

| ファイル | 元の素材 | 作者 | ライセンス | 掲載ページ |
|---|---|---|---|---|
| `bgm/comedy.mp3` | オチは無い（リコーダー版） | OtoLogic | CC BY 4.0 | [ポップス](https://otologic.jp/free/bgm/pop-music01.html) |
| `bgm/horror.mp3` | 新月の闇 | OtoLogic | CC BY 4.0 | [アンビエント](https://otologic.jp/free/bgm/ambient01.html) |
| `bgm/dramatic.mp3` | 記憶 | OtoLogic | CC BY 4.0 | [オーケストラ](https://otologic.jp/free/bgm/orchestra01.html) |
| `bgm/battle.mp3` | Formidable Enemy | OtoLogic | CC BY 4.0 | [オーケストラ](https://otologic.jp/free/bgm/orchestra01.html) |
| `sfx/drum.mp3` | 結果発表01-1 | OtoLogic | CC BY 4.0 | [クイズ](https://otologic.jp/free/se/quiz01.html) |
| `sfx/boom.mp3` | 爆発02-2（Short） | OtoLogic | CC BY 4.0 | [爆発](https://otologic.jp/free/se/explosion01.html) |
| `sfx/fanfare.mp3` | フレーズ02-1 | OtoLogic | CC BY 4.0 | [フレーズ](https://otologic.jp/free/se/phrase01.html) |
| `sfx/bell.mp3` | オノマトペ チーン03-2（Low-Mid） | OtoLogic | CC BY 4.0 | [チーン](https://otologic.jp/free/se/ding01.html) |
| `sfx/scream.mp3` | ホラー 絶叫03-1（High-Reverb） | OtoLogic | CC BY 4.0 | [ホラー（人の声）](https://otologic.jp/free/se/human-horror01.html) |
| `sfx/laugh.mp3` | Small Crowd Laughing | snakebarney（freesound） | CC0 | [freesound](https://freesound.org/people/snakebarney/sounds/138112/) |

### 加工内容

元の素材から次の加工をしています（CC BY 4.0 は改変した旨の表示を求めるため明記）。

- **BGM：** 曲の途中を 14〜19 秒のループに切り出し（波形の相関でループ点を探索し、継ぎ目をクロスフェード）、
  -23 LUFS に音量を統一。44.1kHz ステレオ 160kbps の mp3。
- **SE：** 頭の無音を除去し、-15.5 LUFS に音量を統一。44.1kHz ステレオ 192kbps の mp3。
