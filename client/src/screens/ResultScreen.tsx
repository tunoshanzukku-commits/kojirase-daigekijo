import { useState, useEffect } from 'react'
import type { GameContext } from '../App'
import type { GameActions } from '../useGameSocket'
import type { PlayerScore } from '../types'
import { genreLabel, MAX_FEEDBACK_LENGTH } from '@shared/constants'
import { buildRoomShareText, buildMyShareText, buildTakeShareText, buildWorkShareText, buildIntentUrl, buildAppSchemeUrl, isMobileUserAgent } from '../xShare'
import { shareOrDownload } from '../share'
import { SERVER_URL } from '../config'
import { getLastTake } from '../recorder'
import { playerColorMap, playerColor } from '../playerColors'
import { localPlayers } from '../localPlayers'

interface Props {
  ctx: GameContext
  actions: GameActions
}

const total = (r: PlayerScore) => r.acting + r.emotion + r.kojirase
// 「席」は落語や講談の演目を数える語。大劇場・大根役者選手権の見立てに合う。
const KANJI = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const seatLabel = (rank: number) => `第${KANJI[rank] ?? String(rank + 1)}席`

function Stars({ n }: { n: number }) {
  return (
    <span>
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={i < n ? 'text-shu' : 'text-kei'}>★</span>
      ))}
    </span>
  )
}

export default function ResultScreen({ ctx, actions }: Props) {
  // 自分のテイク（マイク＋BGM/SE）。保存はしないのでリロードで消える。
  const [takeUrl, setTakeUrl] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  useEffect(() => {
    const blob = getLastTake()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setTakeUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [])

  const colors = playerColorMap(ctx.players)
  // player_left は画面に紐づかないグローバルなハンドラで、結果画面を見ている
  // 最中にも届きうる（例: 採点完了後に切断していた端末の猶予タイマー満了）。
  // それが起きると ctx.scores 側は再フィルタされず名前が残るのに、
  // colors（ctx.players 由来）からはそのエントリが消える。undefined のまま
  // 背景・枠線を .seal に渡すと、無条件の text-kinari だけが残って
  // 「生成り地に生成り文字」＝頭文字が読めなくなる（CastingScreen と同じ手当て）。
  const colorFor = (name: string) => colors[name] ?? playerColor(0)
  const mine = localPlayers(ctx.players, ctx.deviceId)
  const soloDevice = mine.length <= 1   // この端末が1人か
  // 「自分の結果」は端末に1人のときだけ意味がある。3人乗っていると
  // 誰の結果を指すか決まらないので、全体シェアに寄せる。
  const hasMyScore = soloDevice && ctx.scores.some(r => r.playerName === ctx.playerName)
  // 配信ONの回は、1人しか乗っていない端末のテイクにも全員の声が入っている。
  // 「自分の演技」ではなく「みんなの熱演」と呼ぶのが正しい。
  const takeIsSolo = soloDevice && !ctx.liveAudio
  // 作品は部屋の全員が入った一本。「ソロかどうか」は端末ではなく部屋で決まる。
  const workIsSolo = ctx.players.length <= 1
  // 3行に分けているのは型のため。三項の中で ctx.workUrl を参照すると
  // string | null のままで、パネルの src に渡せない。
  const workUrl = ctx.workState === 'ready' ? ctx.workUrl : null
  const workReady = workUrl !== null
  const panelSrc = workUrl ?? takeUrl

  async function shareTake() {
    const blob = getLastTake()
    if (!blob) return
    const ext = (blob.type.split('/')[1] ?? 'webm').split(';')[0]
    const text = buildTakeShareText(takeIsSolo, ctx.playerName, genreLabel(ctx.genre))
    await shareOrDownload(blob, `kojirase-take.${ext}`, text)
  }

  // 作品はサーバー上にある。共有シートに渡すため一度だけ取り直す。
  // 失敗しても画面は壊さない（再生はそのまま続けられる）。
  async function shareWork() {
    if (!workUrl) return
    try {
      const res = await fetch(workUrl)
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const text = buildWorkShareText(workIsSolo, ctx.playerName, genreLabel(ctx.genre))
      await shareOrDownload(blob, 'kojirase-work.m4a', text)
    } catch (e) {
      console.warn('[result] 作品を取得できませんでした', e)
    }
  }

  const sorted = [...ctx.scores].sort((a, b) => total(b) - total(a))
  const returnedCount = ctx.returnedPlayers.length
  const totalCount = ctx.players.length

  // X の投稿画面を開く。await を挟まず同期的に開くこと（クリックのユーザー操作が
  // 有効なうちに呼ばないと、iOS Safari がポップアップとして遮断する）。
  //
  // スマホは Web Intent を開くと必ず X アプリに奪われ、ログアウト状態のアプリ内
  // ブラウザでログイン画面が出てしまう（理由は xShare.ts の buildAppSchemeUrl を参照）。
  // そこでアプリのネイティブ投稿画面を直接開き、アプリが無くて何も起きなかったときだけ
  // Web Intent へ落とす。
  function openXIntent(text: string) {
    const web = buildIntentUrl(text, window.location.origin)
    if (!isMobileUserAgent(navigator.userAgent)) {
      window.open(web, '_blank', 'noopener,noreferrer')
      return
    }
    // アプリが起動すればこの画面は隠れる＝その時だけフォールバックを取り消す。
    // フォールバックが同じタブなのは、setTimeout の中の window.open が
    // ユーザー操作の外になりスマホでは必ずポップアップ遮断されるため。
    const timer = window.setTimeout(() => {
      cleanup()
      window.location.href = web
    }, 1200)
    function cleanup() {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onLeave)
      window.removeEventListener('pagehide', onLeave)
    }
    function onLeave() {
      if (document.visibilityState === 'visible') return // 復帰イベントは無視する
      cleanup()
    }
    document.addEventListener('visibilitychange', onLeave)
    window.addEventListener('pagehide', onLeave)
    window.location.href = buildAppSchemeUrl(text, window.location.origin)
  }

  // 感想は任意。送れなくてもゲーム体験に影響しないので、失敗しても深追いしない。
  async function sendFeedback() {
    const text = feedback.trim()
    if (text.length === 0 || feedbackSending) return
    setFeedbackSending(true)
    setFeedbackError(null)
    try {
      const res = await fetch(`${SERVER_URL}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // プレイヤー名は送らない（感想が名前に紐づくことを本人が意識していないため）。
        body: JSON.stringify({
          text,
          genre: genreLabel(ctx.genre),
          playerCount: ctx.players.length,
          aiMode: ctx.aiMode,
        }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setFeedbackSent(true)
    } catch {
      setFeedbackError('送れませんでした')
    } finally {
      setFeedbackSending(false)
    }
  }

  function shareRoom() {
    openXIntent(buildRoomShareText(genreLabel(ctx.genre), sorted))
  }

  function shareMine() {
    const me = ctx.scores.find(r => r.playerName === ctx.playerName)
    if (!me) return
    const rank = sorted.findIndex(r => r.playerName === ctx.playerName) + 1
    openXIntent(buildMyShareText(genreLabel(ctx.genre), me, sorted.length > 1 ? rank : null))
  }

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto pb-10">
      <div className="text-center py-6">
        <h1 className="washi-band font-display text-2xl">演技結果発表！</h1>
      </div>

      {!ctx.aiMode && (
        <div className="washi-panel mb-4 text-sumi text-sm">
          この回は簡易モードです。採点はAIではなく簡易版で出しています。
        </div>
      )}

      {/* Winner banner */}
      {sorted[0] && (
        <div className="washi-panel mb-4 text-center">
          <p className="washi-band font-display text-xs mb-2">最優秀俳優賞</p>
          <p className="text-3xl font-bold text-sumi">{sorted[0].playerName}</p>
          <p className="text-[color:var(--genre)] text-sm mt-1">合計 {total(sorted[0])} 点</p>
        </div>
      )}

      {/* All results */}
      <div className="space-y-4 mb-6">
        {sorted.map((r, rank) => {
          // 「あなた」の強調は端末に1人のときだけ意味がある。3人乗っていると
          // 誰が「me」か決まらないので、複数人の端末では強調自体を出さない。
          const isMe = soloDevice && r.playerName === ctx.playerName
          const role = ctx.script?.roles.find(x => x.player === r.playerName)?.role ?? ''
          return (
            <div
              key={r.playerName}
              className={`washi-panel ${isMe ? 'border-l-4 border-l-[color:var(--genre)]' : ''}`}
            >
              <div className="flex items-center gap-3 mb-3">
                <span className="washi-band font-display text-sm tracking-normal">
                  {seatLabel(rank)}
                </span>
                {/* .seal は既定で朱固定（border-shu/text-shu）＝1P の色と同値なので、
                    背景だけ乗せると頭文字が消える。text-kinari と borderColor で上書きする
                    （Lobby/Casting と同じ手当て） */}
                <div
                  className="seal h-8 w-8 text-sm flex-shrink-0 text-kinari"
                  style={{ background: colorFor(r.playerName), borderColor: colorFor(r.playerName) }}
                >
                  {r.playerName[0]}
                </div>
                <div>
                  <p className="font-bold text-sumi">
                    {r.playerName}
                    {isMe && <span className="text-[color:var(--genre)] text-sm font-normal ml-1">（あなた）</span>}
                  </p>
                  {role && <p className="text-usuzumi text-sm">役：{role}</p>}
                  {r.title && (
                    <span className="inline-block my-1 px-3 py-1 bg-shu text-kinari text-sm font-bold">
                      {r.title}
                    </span>
                  )}
                  <p className="text-usuzumi text-xs">合計 {total(r)} 点</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                {([['演技力', r.acting], ['感情', r.emotion], ['こじらせ度', r.kojirase]] as [string, number][]).map(
                  ([label, score]) => (
                    <div key={label}>
                      <p className="text-usuzumi text-xs mb-1">{label}</p>
                      <Stars n={score} />
                    </div>
                  )
                )}
              </div>

              <div className="bg-kinari border border-kei p-3">
                <p className="text-usuzumi text-xs mb-1">AIコメント</p>
                <p className="text-sumi text-sm leading-relaxed">{r.comment}</p>
              </div>
            </div>
          )
        })}
        {ctx.leftPlayers.map(name => (
          <div key={`left-${name}`} className="washi-panel border-kei opacity-70">
            <div className="flex items-center gap-3">
              <div>
                <p className="font-bold text-usuzumi">{name}</p>
                <p className="text-usuzumi text-xs">録音中に退出しました</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {panelSrc && (
        <div className="washi-panel mb-4">
          <p className="font-bold mb-2 text-usuzumi text-sm">
            {workReady ? '決定版（全員の声）' : takeIsSolo ? '自分の演技を聞く' : 'みんなの熱演を聞く'}
          </p>
          <audio controls src={panelSrc} className="w-full" />
          <button
            onClick={() => { void (workReady ? shareWork() : shareTake()) }}
            className="btn-outline mt-3 text-sm"
          >
            音声を共有
          </button>
          {/* 合成中だけ出す補足。失敗したら黙って消える＝今日と同じ画面に戻る */}
          {ctx.workState === 'pending' && (
            <p className="text-usuzumi text-xs mt-2">
              全員の声を合わせた決定版を仕上げています…
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3">
        {ctx.players.length > 1 && (
          <button
            onClick={shareRoom}
            className="btn-sumi"
          >
            みんなの結果を X でシェア
          </button>
        )}
        {hasMyScore && (
          <button
            onClick={shareMine}
            className="btn-sumi"
          >
            自分の結果を X でシェア
          </button>
        )}
        <button
          onClick={() => actions.returnToLobby()}
          className="btn-outline"
        >
          ロビーへ戻る
        </button>
        {returnedCount > 0 && (
          <p className="text-center text-usuzumi text-xs">
            {returnedCount}/{totalCount} 人がロビーへ戻りました…
          </p>
        )}
      </div>

      {/* 感想（任意）。講評を読んだ余韻が残っているこの位置が一番書いてもらえる。 */}
      <div className="washi-panel mt-6">
        {feedbackSent ? (
          <p className="text-sumi text-sm text-center py-2">
            お便りありがとうございます。ありがたく読ませてもらいます。
          </p>
        ) : (
          <>
            <p className="font-bold text-usuzumi text-sm mb-1">楽屋へのお便り</p>
            <p className="text-usuzumi text-xs mb-2">
              遊んでくれてありがとうございます！遊んだ感想をひとことでも書いてもらえると助かります。
            </p>
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              maxLength={MAX_FEEDBACK_LENGTH}
              rows={3}
              className="field"
              placeholder="なんでもどうぞ"
            />
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={() => { void sendFeedback() }}
                disabled={feedback.trim().length === 0 || feedbackSending}
                className="btn-outline text-sm disabled:opacity-30"
              >
                {feedbackSending ? '送信中…' : '送る'}
              </button>
              {feedbackError && <span className="text-shu text-xs">{feedbackError}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
