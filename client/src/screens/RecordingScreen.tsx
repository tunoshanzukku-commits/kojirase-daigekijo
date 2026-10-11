import { useState, useEffect, useRef } from 'react'
import type { GameContext } from '../App'
import type { GameActions } from '../useGameSocket'
import ConfirmDialog from '../components/ConfirmDialog'
import ScriptLine from '../components/ScriptLine'
import { socket } from '../socket'
import { FULL_SCRIPT, getMockPlayer } from '../mockScript'
import { playerColorMap } from '../playerColors'
import { isLocalPlayer } from '../localPlayers'
import { RECORDING_LIMIT_SEC } from '@shared/constants'
import { playBgm, playSfx, stopAll, preloadAudio } from '../audioBus'
import { peerDeviceIds } from '../liveAudioPure'

interface Props {
  ctx: GameContext
  actions: GameActions
}

interface FloatingReaction {
  id: number
  emoji: string
  x: number
}

const MAX_SEC = RECORDING_LIMIT_SEC
const REACTION_EMOJIS = ['👏', '😂', '🔥', '😍', '💪']
const BAR_COUNT = 12

const BGM_LIST = [
  { id: 'dramatic', label: 'ドラマチック', emoji: '🎻' },
  { id: 'horror',   label: '不気味',       emoji: '👻' },
  { id: 'comedy',   label: 'コミカル',     emoji: '🎵' },
  { id: 'battle',   label: 'バトル',       emoji: '⚔️' },
]
const SFX_LIST = [
  { id: 'drum',    label: 'ドラムロール', emoji: '🥁' },
  { id: 'boom',    label: 'どーん',       emoji: '💥' },
  { id: 'fanfare', label: 'ファンファーレ', emoji: '🎉' },
  { id: 'scream',  label: '悲鳴',         emoji: '😱' },
  { id: 'laugh',   label: '笑い声',       emoji: '🤣' },
  { id: 'bell',    label: 'チーン',       emoji: '🔔' },
]

/**
 * BGM/効果音のボタン群。置き場所を持たない＝親が下部シートにも右サイドパネルにも
 * 差せるように、中身だけを切り出してある。横並びは幅の狭い端末に合わせた寸法で、
 * BGM は4つ横一列、効果音は3列2段。
 */
function SoundControls({
  bgm,
  onBgm,
  onSfx,
  flash,
}: {
  bgm: string | null
  onBgm: (id: string | null) => void
  onSfx: (id: string) => void
  flash: string | null
}) {
  return (
    <>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-usuzumi text-xs font-bold tracking-wider">BGM</p>
        {bgm && (
          <button
            onClick={() => onBgm(null)}
            className="text-xs text-usuzumi hover:text-shu transition-colors"
          >
            停止
          </button>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1 mb-3">
        {BGM_LIST.map(b => (
          <button
            key={b.id}
            onClick={() => onBgm(bgm === b.id ? null : b.id)}
            style={bgm === b.id ? { background: 'var(--genre)' } : undefined}
            className={`flex flex-col items-center py-1.5 text-xs font-medium transition-colors ${
              bgm === b.id ? 'text-kinari' : 'border border-sumi hover:bg-sumi/5 text-sumi'
            }`}
          >
            <span className="text-base">{b.emoji}</span>
            <span className="text-[10px]">{b.label}</span>
          </button>
        ))}
      </div>

      <p className="text-usuzumi text-xs font-bold tracking-wider mb-1.5">効果音</p>
      <div className="grid grid-cols-3 gap-1">
        {SFX_LIST.map(s => (
          <button
            key={s.id}
            onClick={() => onSfx(s.id)}
            className={`flex flex-col items-center py-1.5 text-xs font-medium transition-all border ${
              flash === s.id ? 'border-shu bg-shu/10 scale-95' : 'border-sumi hover:bg-sumi/5 text-sumi'
            }`}
          >
            <span className="text-base">{s.emoji}</span>
            <span className="text-[10px]">{s.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export default function RecordingScreen({ ctx, actions }: Props) {
  const entries = ctx.script?.entries ?? FULL_SCRIPT
  const colors = playerColorMap(ctx.players)

  // モック台本のときは ctx.players が空なので、従来どおり1人だけをローカル扱いにする（Prepare画面と同じ方針）
  const mockPlayer = ctx.script ? null : getMockPlayer(ctx.isHost, ctx.playerName)
  const isLocal = (name: string) =>
    mockPlayer !== null ? name === mockPlayer : isLocalPlayer(ctx.players, ctx.deviceId, name)
  const colorFor = (name: string) => colors[name] ?? '#b8352c' // モック時は1P色に倒す
  // 端末ごとの接続状態。表示名はその端末の代表プレイヤー名を使う。
  const peers = ctx.liveAudio ? peerDeviceIds(ctx.players, ctx.deviceId) : []
  const peerLabel = (deviceId: string) =>
    ctx.players.find(p => p.deviceId === deviceId)?.name ?? '相手'
  const anyFailed = peers.some(id => ctx.peerStates[id] === 'failed')
  // 再接続で録音中に戻った本人はカウントダウンを飛ばして進行中の画面に合流する
  const [phase, setPhase] = useState<'countdown' | 'recording'>(
    ctx.rejoinedNoRecord ? 'recording' : 'countdown',
  )
  const [countdown, setCountdown] = useState(3)
  const [elapsed, setElapsed] = useState(0)
  const [bars, setBars] = useState<number[]>(Array(BAR_COUNT).fill(0.1))
  const [reactions, setReactions] = useState<FloatingReaction[]>([])
  const reactionIdRef = useRef(0)
  const [sfxOpen, setSfxOpen] = useState(false)
  const [sfxFlash, setSfxFlash] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // 再接続でこの画面に直接着地したプレイヤーは CastingScreen を経由しないため、
  // preloadAudio() が一度も呼ばれない（＝そのラウンド中ずっと無音）。冪等なのでここでも呼ぶ。
  useEffect(() => { preloadAudio() }, [])

  // カウントダウン
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown === 0) {
      const t = setTimeout(() => setPhase('recording'), 800)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [phase, countdown])

  // 経過時間はカウントダウン中も進める（サーバーの上限タイマーは recording_started
  // で武装するため、ここを phase で止めると表示と実際の終了時刻がずれる）
  useEffect(() => {
    if (elapsed >= MAX_SEC) return // 上限で停止。遷移はサーバーの録音終了で行う
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [elapsed])

  // 浮遊リアクションを画面に出す（送信・受信 共通）
  const spawnReaction = (emoji: string) => {
    const id = ++reactionIdRef.current
    const x = 10 + Math.random() * 80
    setReactions(prev => [...prev, { id, emoji, x }])
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 2200)
  }

  // 自分の送信：楽観的表示＋サーバー配信
  const handleReaction = (emoji: string) => {
    spawnReaction(emoji)
    socket.emit('send_reaction', { emoji })
  }

  const flashSfx = (sfxId: string) => {
    playSfx(sfxId) // handleSfx（自分）と onSfx（他人）の共通経路
    setSfxFlash(sfxId)
    setTimeout(() => setSfxFlash(null), 400)
  }
  const handleSfx = (sfxId: string) => {
    flashSfx(sfxId)
    socket.emit('send_sfx', { sfxId })
  }

  // 受信リスナ（reaction/sfx/volume）
  useEffect(() => {
    if (phase !== 'recording') return
    function onReaction({ emoji }: { emoji: string; playerName: string }) {
      spawnReaction(emoji)
    }
    function onSfx({ sfxId }: { sfxId: string; playerName: string }) {
      flashSfx(sfxId)
    }
    function onVolume({ level }: { level: number }) {
      setBars(prev => [...prev.slice(1), level]) // ルーム声量のスクロール波形
    }
    socket.on('reaction_received', onReaction)
    socket.on('sfx_played', onSfx)
    socket.on('volume_update', onVolume)
    return () => {
      socket.off('reaction_received', onReaction)
      socket.off('sfx_played', onSfx)
      socket.off('volume_update', onVolume)
    }
  }, [phase])

  // BGM は bgm_changed で全員へ配信される共有状態。ctx.bgm に追従して鳴らす。
  useEffect(() => {
    if (phase !== 'recording') return
    playBgm(ctx.bgm)
  }, [phase, ctx.bgm])

  // 録音終了・中断・解散のいずれでもこの画面はアンマウントされるので、ここで全部止める
  useEffect(() => () => stopAll(), [])

  // マイクを取得し、100ms ごとに声量を実測して送信
  useEffect(() => {
    if (phase !== 'recording') return
    let audioCtx: AudioContext | null = null
    let stream: MediaStream | null = null
    let raf = 0
    let lastSent = 0
    let cancelled = false

    navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
      if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
      stream = s
      audioCtx = new AudioContext()
      audioCtx.resume().catch(() => {})
      const source = audioCtx.createMediaStreamSource(s)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        const level = Math.min(1, rms * 2) // ゲイン補正
        const now = performance.now()
        if (now - lastSent >= 100) {
          lastSent = now
          socket.emit('send_volume', { level })
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }).catch(() => { /* マイク不許可時は声量送信をスキップ */ })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
      audioCtx?.close()
    }
  }, [phase])

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    // 下端は「音シート＋スタンプ/声量バー」の固定コンテナが覆う。シートを開くと
    // その分だけ背が伸びるので、台本の最終行が隠れないよう下余白も一緒に広げる。
    <div className={`min-h-screen flex flex-col items-center p-4 pt-0 ${sfxOpen ? 'pb-80' : 'pb-36'}`}>
      {phase === 'countdown' && (
        <div className="text-center flex-1 flex flex-col items-center justify-center">
          <p className="text-usuzumi text-lg mb-8">録音が始まります</p>
          <div className="text-9xl font-bold text-sumi" style={{ animation: 'fadeScale 0.8s ease-out' }}>
            {countdown > 0 ? countdown : <span className="text-[color:var(--genre)] text-7xl">START!</span>}
          </div>
        </div>
      )}

      {phase === 'recording' && (
        <div className="w-full max-w-3xl">
          {/* タイマー（sticky） */}
          <div className="sticky top-0 z-10 bg-sumi text-center py-3 mb-4 -mx-4 px-4">
            <div className="flex items-center justify-center gap-3 mb-1">
              <div className="w-3 h-3 bg-shu" style={{ animation: 'blink 1s infinite' }} />
              <span className="text-kinari font-bold text-xl tracking-widest">REC</span>
              <span className="text-4xl font-mono font-bold text-kinari">{fmt(elapsed)}</span>
              <span className="text-2xl font-mono font-bold text-kinari/60">/{fmt(MAX_SEC)}</span>
            </div>
            <div className="w-48 mx-auto bg-kei h-1">
              <div
                className="bg-shu h-1 transition-all duration-1000"
                style={{ width: `${(elapsed / MAX_SEC) * 100}%` }}
              />
            </div>
          </div>

          {/* 再接続で戻った本人：MediaRecorder は起動していない＝この回は音声が残らない */}
          {ctx.rejoinedNoRecord && (
            <div className="washi-panel mb-4 text-center">
              <p className="text-shu text-sm font-bold">接続が切れたため、この録音は記録されません</p>
              <p className="text-shu text-xs mt-0.5">演技はそのまま続けてOKです</p>
            </div>
          )}

          {peers.length > 0 && (
            <div className="washi-panel mb-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-usuzumi text-xs font-bold tracking-wider">声の配信</span>
                {peers.map(id => {
                  const state = ctx.peerStates[id] ?? 'connecting'
                  return (
                    <span key={id} className="text-xs">
                      <span className="text-sumi">{peerLabel(id)}</span>
                      <span
                        className={state === 'connected' ? 'text-sumi' : 'text-shu'}
                      >
                        {state === 'connected' ? ' ✓' : state === 'failed' ? ' ✕' : ' …'}
                      </span>
                    </span>
                  )
                })}
              </div>
              {anyFailed && (
                <p className="text-usuzumi text-xs mt-1">
                  ✕ の相手とは声が繋がりませんでした。<span className="font-bold">録音と採点は正常です。</span>
                </p>
              )}
            </div>
          )}

          {/* 台本 */}
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
          </div>

          {ctx.isHost ? (
            <button
              onClick={() => actions.stopRecording()}
              className="btn-shu text-lg mb-4"
            >
              録音終了
            </button>
          ) : (
            <div className="washi-panel text-center mb-4">
              <p className="text-usuzumi text-sm">ホストが終了を押すまで演じ続けてください</p>
            </div>
          )}

          {ctx.isHost && (
            <button
              onClick={() => setConfirmOpen(true)}
              className="w-full py-2.5 text-usuzumi hover:text-shu text-sm font-medium transition-colors mb-4"
            >
              中断してロビーへ戻る
            </button>
          )}
        </div>
      )}


      {/* 浮かび上がるリアクション */}
      {reactions.map(r => (
        <div
          key={r.id}
          className="fixed text-3xl pointer-events-none z-50"
          style={{
            left: `${r.x}%`,
            bottom: '5rem',
            animation: 'floatUp 2.2s ease-out forwards',
          }}
        >
          {r.emoji}
        </div>
      ))}

      {/* 下端の固定コンテナ：音シート（上）＋スタンプ/声量バー（下）を縦に積む。
          別々に fixed すると互いの高さをオフセットで持ち合うことになるので1つにまとめる。 */}
      {phase === 'recording' && (
        <div className="fixed bottom-0 left-0 right-0 z-20">
          {/* 音シート：上辺のハンドルがそのまま開閉ボタン */}
          <div className="bg-kinari border-t border-sumi">
            <div className="max-w-3xl mx-auto px-4">
              <button
                onClick={() => setSfxOpen(o => !o)}
                className="w-full flex items-center justify-center gap-2 py-1.5 text-usuzumi hover:text-sumi transition-colors"
              >
                <span className="text-xs">{sfxOpen ? '▼' : '▲'}</span>
                <span className="text-xs font-bold tracking-wider">音を出す</span>
                {ctx.bgm && !sfxOpen && <span className="text-[color:var(--genre)] text-xs">♪</span>}
              </button>
              {sfxOpen && (
                <div className="pb-3">
                  <SoundControls
                    bgm={ctx.bgm}
                    onBgm={actions.sendBgm}
                    onSfx={handleSfx}
                    flash={sfxFlash}
                  />
                </div>
              )}
            </div>
          </div>

          {/* スタンプ（左）＋声量メーター（右） */}
          <div className="bg-kinari border-t border-sumi py-2 px-4">
            <div className="flex items-center gap-3 max-w-3xl mx-auto">
              {/* スタンプボタン（左） */}
              <div className="flex gap-1.5 flex-shrink-0">
                {REACTION_EMOJIS.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => handleReaction(emoji)}
                    className="text-xl w-11 h-11 border border-sumi hover:bg-sumi/5 active:scale-90 transition-all flex items-center justify-center"
                  >
                    {emoji}
                  </button>
                ))}
              </div>

              {/* 区切り */}
              <div className="w-px h-8 bg-kei flex-shrink-0" />

              {/* 声量メーター（右） */}
              <div className="flex-1 min-w-0">
                <p className="text-usuzumi text-xs mb-1">声量</p>
                <div className="flex items-end gap-0.5 h-8 bg-kei">
                  {bars.map((v, i) => (
                    <div
                      key={i}
                      className="flex-1 bg-shu transition-all duration-100"
                      style={{ height: `${Math.max(8, v * 100)}%` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
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

      <style>{`
        @keyframes fadeScale {
          from { opacity: 0; transform: scale(1.5); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.15; }
        }
        @keyframes floatUp {
          0%   { opacity: 1; transform: translateY(0) scale(1); }
          80%  { opacity: 0.8; }
          100% { opacity: 0; transform: translateY(-160px) scale(1.3); }
        }
      `}</style>
    </div>
  )
}
