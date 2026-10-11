// クレジット表記の唯一の置き場。タイトル画面のクレジット画面（CreditsDialog）と
// 作品 m4a のメタデータ（mixdownPlan）の両方がここを読む。
// OtoLogic の素材は CC BY 4.0 で、クレジット表記が利用条件そのもの。
// 文言を変えるときは画面と作品の両方に効くことを忘れないこと。
// なお「協力」「提供」など OtoLogic が関与しているように見える書き方は規約で禁止されている。

export interface CreditLine {
  /** 「台本の執筆・採点」のような見出し。あれば「見出し：」を前に付ける */
  label?: string
  /** 本文。空なら url だけを出す */
  text: string
  /** あれば本文の後ろに（url）としてリンクを出す */
  url?: string
}

export interface CreditSection {
  heading: string
  lines: CreditLine[]
}

export const CREDIT_SECTIONS: CreditSection[] = [
  {
    heading: 'BGM・効果音',
    lines: [
      { text: 'OtoLogic', url: 'https://otologic.jp' },
      { text: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/deed.ja' },
      { text: '※ ループ化・音量調整などの加工をしています' },
      { label: '笑い声', text: '"Small Crowd Laughing" by snakebarney（freesound / CC0）' },
    ],
  },
  {
    heading: 'AI',
    lines: [
      { label: '台本の執筆・採点', text: 'Claude（Anthropic）' },
      { label: '文字起こし', text: 'Whisper（OpenAI）／ Groq で実行' },
    ],
  },
]

/** 作品 m4a のメタデータ（comment）に書き込む1行。BGM・効果音を使った作品にだけ付ける */
export const AUDIO_CREDIT_LINE =
  'BGM・効果音：OtoLogic（https://otologic.jp）CC BY 4.0 ／ 笑い声：snakebarney（freesound）CC0'
