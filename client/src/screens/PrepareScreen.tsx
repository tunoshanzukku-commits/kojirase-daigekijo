import { useState, useEffect, useCallback } from 'react'
import type { GameContext } from '../App'
import type { GameActions } from '../useGameSocket'
import ConfirmDialog from '../components/ConfirmDialog'
import ScriptLine from '../components/ScriptLine'
import { FULL_SCRIPT, getMockPlayer } from '../mockScript'
import { playerColorMap } from '../playerColors'
import { localPlayers, isLocalPlayer } from '../localPlayers'
import { resumeAudio } from '../audioBus'

interface Props {
  ctx: GameContext
  actions: GameActions
}

const SKIP_UNLOCK_SEC = 30

type MicStatus = 'pending' | 'granted' | 'denied'

export default function PrepareScreen({ ctx, actions }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const [micStatus, setMicStatus] = useState<MicStatus>('pending')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const requestMic = useCallback(async () => {
    setMicStatus('pending')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // 許可の確認だけ行い、録音は録音画面で開始するため即停止
      stream.getTracks().forEach(t => t.stop())
      setMicStatus('granted')
    } catch {
      setMicStatus('denied')
    }
  }, [])

  useEffect(() => { requestMic() }, [requestMic])

  useEffect(() => {
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const entries = ctx.script?.entries ?? FULL_SCRIPT
  const colors = playerColorMap(ctx.players)
  const mine = localPlayers(ctx.players, ctx.deviceId)

  // モック台本のときは ctx.players が空なので、従来どおり1人だけをローカル扱いにする
  const mockPlayer = ctx.script ? null : getMockPlayer(ctx.isHost, ctx.playerName)
  const isLocal = (name: string) =>
    mockPlayer !== null ? name === mockPlayer : isLocalPlayer(ctx.players, ctx.deviceId, name)
  const colorFor = (name: string) => colors[name] ?? '#b8352c' // モック時は1P色に倒す
  const mineCount = mine.length

  const isReady = ctx.readyMap[ctx.playerName] === true
  // 切断中（復帰待ち）の人の準備完了は待たない。サーバーの allReady も接続中だけで
  // 判定するので、ここを揃えないとホストがスキップ解禁まで開始できなくなる。
  const activePlayers = ctx.players.filter(p => p.connected !== false)
  const readyCount = activePlayers.filter(p => ctx.readyMap[p.name] === true).length
  const allReady = activePlayers.length > 0 && activePlayers.every(p => ctx.readyMap[p.name] === true)
  const timerExpired = elapsed >= SKIP_UNLOCK_SEC

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto pb-10">
      <div className="text-center py-6">
        <h1 className="font-display text-2xl font-bold text-sumi">準備タイム</h1>
        <p className="text-usuzumi text-sm mt-1">台本をよく読んで準備しよう</p>
      </div>

      {/* Full script */}
      <div className="washi-panel mb-4">
        <p className="text-usuzumi text-xs font-bold tracking-wider mb-3">台本</p>
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <ScriptLine
              key={i}
              entry={entry}
              local={isLocal(entry.player)}
              color={colorFor(entry.player)}
            />
          ))}
        </div>
        {/* 凡例。この端末に2人以上いるときだけ意味がある */}
        {mine.length > 1 ? (
          <div className="flex flex-wrap gap-3 mt-3">
            {mine.map(p => (
              <span key={p.id} className="flex items-center gap-1 text-xs text-usuzumi">
                <span className="inline-block w-3 h-3" style={{ background: colors[p.name] }} />
                {p.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs mt-3" style={{ color: colorFor(mine[0]?.name ?? '') }}>
            ■ の行があなたのセリフです
          </p>
        )}
      </div>

      {ctx.liveAudio && (
        <div className="washi-panel mb-4">
          <p className="text-sumi text-sm">
            この回は<span className="font-bold">声の配信</span>が ON です。準備完了を押すと接続の準備を始め、
            録音が始まると他の端末の声が聞こえます。
          </p>
        </div>
      )}

      {/* マイク許可状態 */}
      {micStatus === 'denied' ? (
        <div className="washi-panel mb-4">
          <p className="text-shu text-sm font-bold mb-1">マイクが使えません</p>
          <p className="text-shu text-xs leading-relaxed mb-3">
            録音にはマイクの許可が必要です。ブラウザのアドレスバーからマイクを許可して、再試行してください。
          </p>
          <button
            onClick={requestMic}
            className="btn-shu text-sm"
          >
            マイク許可を再試行
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-4 px-1">
          <span
            className={`text-xs px-2 py-1 font-medium ${
              micStatus === 'granted'
                ? 'bg-sumi text-kinari'
                : 'bg-kinari text-usuzumi border border-kei'
            }`}
          >
            {micStatus === 'granted' ? 'マイクOK' : 'マイクを確認中…'}
          </span>
        </div>
      )}

      {/* Ready status */}
      <div className="washi-panel mb-6">
        <p className="font-bold mb-3 text-usuzumi text-sm">
          準備状況{' '}
          <span className="text-[color:var(--genre)]">{readyCount}/{activePlayers.length}</span>
        </p>
        <div>
          {ctx.players.map((p, i) => {
            const ready = ctx.readyMap[p.name] === true
            return (
              <div key={i} className={`flex items-center justify-between py-2 ${i > 0 ? 'rule' : ''}`}>
                <span className="text-sumi text-sm">
                  {p.name}
                  {isLocal(p.name) && (
                    <span className="text-usuzumi text-xs ml-1">（この端末）</span>
                  )}
                </span>
                {p.connected === false ? (
                  // 切断中は準備完了を待たない（サーバーの allReady も除外している）
                  <span className="text-sm font-medium text-shu">復帰待ち…</span>
                ) : ready ? (
                  <span className="flex items-center gap-2 text-sm font-medium text-sumi">
                    準備完了
                    <span className="seal h-6 w-6 text-xs">✓</span>
                  </span>
                ) : (
                  <span className="text-sm font-medium text-usuzumi">読み中...</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <p className="text-center text-usuzumi text-xs mb-4">
        イヤホン推奨：スピーカーだとBGMをマイクが拾い、採点用の音声に混ざります
      </p>

      {/* 全員：準備完了トグルボタン */}
      <button
        onClick={() => {
          resumeAudio() // ブラウザの自動再生ポリシー解除はユーザー操作起点でないと効かない
          // ライブ音声の接続もここで張る。理由は resumeAudio と同じで、
          // <audio> の play() がユーザー操作起点でないと弾かれるため。
          // 音が出るのは録音開始から（それまで <audio> は muted）。
          actions.startLiveAudioIfEnabled(ctx.liveAudio, ctx.players, ctx.deviceId)
          actions.setReady(!isReady)
        }}
        disabled={micStatus !== 'granted'}
        className={`text-lg py-4 ${
          isReady
            ? 'btn-outline hover:text-shu hover:border-shu'
            : 'btn-sumi'
        }`}
      >
        {isReady
          ? (mineCount > 1 ? `${mineCount}人とも準備OK` : '準備OK')
          : (mineCount > 1 ? `${mineCount}人とも準備完了にする` : '準備完了')}
      </button>

      {/* ホスト：録音開始ボタン */}
      {ctx.isHost && (
        <div className="mt-4 washi-panel">
          <div className="flex items-center gap-4">
            {/* 円形タイマー */}
            <div className="flex-shrink-0 relative w-14 h-14">
              <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
                <circle cx="28" cy="28" r="24" fill="none" stroke="#cdbfa4" strokeWidth="5" />
                <circle
                  cx="28" cy="28" r="24"
                  fill="none"
                  stroke={allReady ? '#241c17' : timerExpired ? '#b8352c' : '#6b5f52'}
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 24}`}
                  strokeDashoffset={`${2 * Math.PI * 24 * (timerExpired || allReady ? 0 : (SKIP_UNLOCK_SEC - elapsed) / SKIP_UNLOCK_SEC)}`}
                  style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-sumi">
                {allReady || timerExpired ? '✓' : SKIP_UNLOCK_SEC - elapsed}
              </span>
            </div>
            <button
              onClick={() => actions.startRecording()}
              disabled={!allReady && !timerExpired}
              className={`flex-1 text-sm ${timerExpired && !allReady ? 'btn-outline text-shu' : 'btn-sumi'}`}
            >
              {allReady
                ? '全員準備完了！録音開始'
                : timerExpired
                ? `スキップして開始 (${readyCount}/${activePlayers.length} 人完了)`
                : `録音開始 (${readyCount}/${activePlayers.length} 人準備完了)`}
            </button>
          </div>
        </div>
      )}

      {ctx.isHost && (
        <button
          onClick={() => setConfirmOpen(true)}
          className="w-full mt-3 py-2.5 text-usuzumi hover:text-shu text-sm font-medium transition-colors"
        >
          中断してロビーへ戻る
        </button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="ゲームを中断しますか？"
        message="台本と録音は破棄され、全員ロビーに戻ります。"
        confirmLabel="中断する"
        cancelLabel="やめる"
        onConfirm={() => { setConfirmOpen(false); actions.abortGame() }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
