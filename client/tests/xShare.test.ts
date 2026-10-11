import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoomShareText, buildMyShareText, buildTakeShareText, buildWorkShareText, buildIntentUrl, buildAppSchemeUrl, isMobileUserAgent } from '../src/xShare'
import type { PlayerScore } from '../src/types'

function score(name: string, acting: number, emotion: number, kojirase: number, title: string): PlayerScore {
  return { playerName: name, acting, emotion, kojirase, comment: '講評', title }
}

test('みんなの結果は上位3人までしか載せない', () => {
  // 10人ゲームの投稿文が X の文字数上限を超えないための制限。
  const ranked = ['あ', 'い', 'う', 'え', 'お'].map((n, i) => score(n, 5, 5, 5 - i, `称号${n}`))
  const text = buildRoomShareText('ミステリー', ranked)
  assert.ok(text.includes('あ'), '1位が載っていない')
  assert.ok(text.includes('う'), '3位が載っていない')
  assert.ok(!text.includes('え'), '4位以降が載っている')
})

test('みんなの結果にジャンル名とハッシュタグが入る', () => {
  const text = buildRoomShareText('ミステリー', [score('たろう', 4, 5, 4, '沈黙の名探偵')])
  assert.ok(text.includes('ミステリー'), 'ジャンル名が無い')
  assert.ok(text.includes('#こじらせ大劇場'), 'ハッシュタグが無い')
})

test('自分の結果に称号・合計点・順位が入る', () => {
  const text = buildMyShareText('ミステリー', score('たろう', 4, 5, 4, '沈黙の名探偵'), 2)
  assert.ok(text.includes('沈黙の名探偵'), '称号が無い')
  assert.ok(text.includes('13'), '合計点(4+5+4)が無い')
  assert.ok(text.includes('2位'), '順位が無い')
})

test('自分の結果は rank が null なら順位を出さない（ソロプレイ向け）', () => {
  const text = buildMyShareText('ミステリー', score('たろう', 4, 5, 4, '沈黙の名探偵'), null)
  assert.ok(!text.includes('位'), `順位が出てはいけない: ${text}`)
})

test('合計点は満点が分かる形で書く', () => {
  // 結果画面を見ていない X のフォロワーには、素の「13点」では高低が伝わらない。
  const s = score('たろう', 4, 5, 4, '沈黙の名探偵')
  assert.ok(buildRoomShareText('ミステリー', [s]).includes('13/15点'), 'みんなの結果に満点が無い')
  assert.ok(buildMyShareText('ミステリー', s, 2).includes('13/15点'), '自分の結果に満点が無い')
})

test('intent URL は text と url をエンコードして載せる', () => {
  const url = buildIntentUrl('あ い #タグ', 'https://example.com/')
  assert.ok(url.startsWith('https://x.com/intent/post?'), `intent の宛先が違う: ${url}`)
  const q = new URL(url).searchParams
  assert.equal(q.get('text'), 'あ い #タグ')
  assert.equal(q.get('url'), 'https://example.com/')
})

test('どちらの投稿文にも誘い文句が入る', () => {
  // 投稿で一番引きが強いのは称号。読み手が知りたくなるのは「自分なら何になるか」なので、
  // 点数ではなく称号に寄せて誘う。
  const s = score('たろう', 4, 5, 4, '沈黙の名探偵')
  assert.ok(buildRoomShareText('ミステリー', [s]).includes('君はどんな称号がつく？'), 'みんなの結果に誘い文句が無い')
  assert.ok(buildMyShareText('ミステリー', s, 2).includes('君はどんな称号がつく？'), '自分の結果に誘い文句が無い')
})

// --- テイク（自分の演技）の共有文 ---
// 端末に複数人いると「誰の演技か」が決まらないので、個人名ではなくジャンル名を主語にする。

test('テイクの共有文は端末が1人ならプレイヤー名が主語になる', () => {
  const text = buildTakeShareText(true, 'たろう', 'ミステリー')
  assert.ok(text.includes('たろう'), 'プレイヤー名が無い')
  assert.ok(!text.includes('ミステリー'), 'ジャンル名が入ってはいけない')
  assert.ok(text.includes('#こじらせ大劇場'), 'ハッシュタグが無い')
})

test('テイクの共有文は端末に複数人いるとジャンル名が主語になる', () => {
  const text = buildTakeShareText(false, 'たろう', 'ミステリー')
  assert.ok(!text.includes('たろう'), 'プレイヤー名が入ってはいけない（誰の演技か決まらないため）')
  assert.ok(text.includes('ミステリー'), 'ジャンル名が無い')
  assert.ok(text.includes('#こじらせ大劇場'), 'ハッシュタグが無い')
})

// --- アプリ独自スキーム（X アプリのネイティブ投稿画面を直接開く） ---

// X アプリは x.com/twitter.com の全パスを catch-all で Universal Links に登録しており、
// Web Intent は必ずアプリに奪われ、アプリ内ブラウザ（ログアウト状態）で開かれる。
// ネイティブの投稿画面を直接呼べばアプリのアカウントで開くので、そこを迂回できる。
test('アプリスキームは message ひとつに本文とURLをまとめる', () => {
  // twitter://post は message しか受け取れない＝url を別パラメータで渡せない。
  const url = buildAppSchemeUrl('あ い #タグ', 'https://example.com/')
  assert.ok(url.startsWith('twitter://post?message='), `スキームの宛先が違う: ${url}`)
  const message = decodeURIComponent(url.slice('twitter://post?message='.length))
  assert.equal(message, 'あ い #タグ\nhttps://example.com/')
})

// '#' が生のまま残るとフラグメント扱いになり、ハッシュタグ以降が投稿文から消える。
test('アプリスキームは # をエンコードする', () => {
  const url = buildAppSchemeUrl('#タグ', 'https://example.com/')
  assert.ok(url.includes('%23'), `エンコード済みの # が無い: ${url}`)
  assert.ok(!url.includes('#'), 'ハッシュが生のまま残っている')
})

// PC でスキームを試すとブラウザが「このリンクは開けません」を出すので、
// アプリが入りうる端末でだけ試す。
test('isMobileUserAgent はスマホの UA だけ true', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  assert.equal(isMobileUserAgent(iphone), true, 'iPhone が false')
  assert.equal(isMobileUserAgent(android), true, 'Android が false')
  assert.equal(isMobileUserAgent(ipad), true, 'iPad が false')
  assert.equal(isMobileUserAgent(windows), false, 'Windows が true')
  assert.equal(isMobileUserAgent(mac), false, 'Mac が true')
})

// --- 作品（全員の声を合わせた決定版）の共有文 ---

test('作品の共有文は「みんなで作った一本」であることを言う', () => {
  const text = buildWorkShareText(false, 'たろう', 'ホラー')
  assert.match(text, /ホラー/)
  assert.match(text, /#こじらせ大劇場/)
})

test('1人の部屋なら作品も本人の名前で呼ぶ', () => {
  const text = buildWorkShareText(true, 'たろう', 'ホラー')
  assert.match(text, /たろう/)
  assert.match(text, /#こじらせ大劇場/)
})
