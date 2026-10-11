// X（旧Twitter）への投稿文と Web Intent URL の組み立て。DOM 非依存の純粋関数。
//
// Web Intent は text と url しか受け取れず、画像を添付できない（X の仕様）。
// 投稿の見た目は index.html の OGP タグが生成するリンクカードが担当する。
import type { PlayerScore } from './types'

const HASHTAG = '#こじらせ大劇場'
// 投稿で一番引きが強いのは称号。AIが毎回作るのでこのゲームにしかなく、
// 読み手が知りたくなるのは点数より「自分なら何になるか」。そこへ誘う。
// X が URL を末尾に足すので、この文は本文の最後（ハッシュタグの直前）に置く。
const CTA = '君はどんな称号がつく？'
// 結果画面の順位は昭和レトロ化で「第一席」表記にしたが、投稿文はメダルの絵文字のまま
// 残す（意図的な不一致。揃えないこと）。X のタイムラインは情報が流れていく場所で、
// パッと見で順位が分かる絵文字のほうが機能する。昭和の見立てはアプリの中の話。
const MEDALS = ['🥇', '🥈', '🥉']
// X の投稿欄には上限があるので、10人ゲームでも溢れないよう上位3人までに絞る。
const TOP_N = 3
// 演技力・感情・こじらせ度の3軸 × 各5点。結果画面を見ていない読み手にも
// 点の高低が伝わるよう、投稿文では必ず満点とセットで書く。
const MAX_TOTAL = 15

function total(s: PlayerScore): number {
  return s.acting + s.emotion + s.kojirase
}

function scoreText(s: PlayerScore): string {
  return `${total(s)}/${MAX_TOTAL}点`
}

/** ranked は合計点の降順で渡すこと（並べ替えは呼び出し元の責務）。 */
export function buildRoomShareText(genreLabel: string, ranked: PlayerScore[]): string {
  const lines = ranked
    .slice(0, TOP_N)
    .map((s, i) => `${MEDALS[i]} ${s.playerName} ${scoreText(s)}「${s.title}」`)
  return `「こじらせ大劇場」で${genreLabel}を演じた結果！\n\n${lines.join('\n')}\n\n${CTA}\n${HASHTAG}`
}

/** rank は null を渡すと順位部分を出さない（1人プレイは順位に情報量が無いため）。 */
export function buildMyShareText(genreLabel: string, me: PlayerScore, rank: number | null): string {
  const rankText = rank !== null ? `・${rank}位` : ''
  return (
    `「こじらせ大劇場」で${genreLabel}を演じてきた！\n\n` +
    `称号「${me.title}」\n` +
    `演技力${me.acting} ／ 感情${me.emotion} ／ こじらせ度${me.kojirase}（${scoreText(me)}${rankText}）\n\n` +
    `${CTA}\n${HASHTAG}`
  )
}

/**
 * 自分のテイク（マイク＋BGM/SE）を共有するときの文。端末に1人しかいなければ
 * 個人名を主語にできるが、複数人が同じ端末で演じたテイクを1人の名前で語ると
 * 誰の演技か決まらず不正確になるため、その場合はジャンル名を主語にする。
 */
export function buildTakeShareText(soloDevice: boolean, playerName: string, genreLabel: string): string {
  return soloDevice
    ? `${playerName} の熱演！ ${HASHTAG}`
    : `${genreLabel}を演じてきた！ ${HASHTAG}`
}

/**
 * 合成済みの「作品」の共有文。手元のテイクと違い、これは全員のクリーンな録音を
 * 合わせ直した一本なので、そのことが伝わる言い方にする。
 */
export function buildWorkShareText(soloRoom: boolean, playerName: string, genreLabel: string): string {
  return soloRoom
    ? `${playerName} の熱演、${genreLabel}の一本にまとまりました ${HASHTAG}`
    : `みんなの声を合わせて${genreLabel}の一本にしました ${HASHTAG}`
}

/**
 * URLSearchParams ではなく encodeURIComponent を使う。前者は空白を '+' にするが、
 * %20 のほうが intent の解釈系を選ばない。'#' も必ずエンコードされる必要がある
 * （生のままだとフラグメント扱いになり、ハッシュタグ以降が投稿文から消える）。
 */
export function buildIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
}

/**
 * X アプリのネイティブ投稿画面を直接開くスキーム。
 *
 * Web Intent を素で開くとスマホでは必ずアプリに奪われる（X アプリは x.com と
 * twitter.com の全パスを catch-all で Universal Links に登録しており、
 * twitter.com/intent/tweet も x.com へ 301 されるので逃げ道が無い）。奪われた先は
 * アプリ内ブラウザで、ブラウザ本体ともアプリのアカウントともクッキーが別＝
 * ログアウト状態のため、投稿画面ではなくログイン画面が出る。ネイティブの投稿画面を
 * 直接呼べばアプリのアカウントで開くので、そこを迂回できる。
 *
 * ⚠️ X はこのスキームを公式に文書化もサポートもしていない（リブランド後も
 * twitter:// のまま）。壊されたら buildIntentUrl 側だけに戻せば動く状態を保つこと。
 * message ひとつしか受け取れないので、url は本文の末尾に連結する（Web Intent も
 * X が url を末尾に足すので、出来上がりの投稿文は変わらない）。
 */
export function buildAppSchemeUrl(text: string, url: string): string {
  return `twitter://post?message=${encodeURIComponent(`${text}\n${url}`)}`
}

/**
 * スキームを試すのはアプリが入りうる端末だけにする。PC で試すとブラウザが
 * 「このリンクは開けません」というダイアログを出す。
 */
export function isMobileUserAgent(ua: string): boolean {
  return /iPhone|iPad|iPod|Android/i.test(ua)
}
