import { useState, useEffect } from 'react'
import type { GameContext, NavigateFn } from '../App'
import type { GameActions } from '../useGameSocket'
import ConfirmDialog from '../components/ConfirmDialog'
import { FULL_SCRIPT, MOCK_ROLES, MOCK_WORLD, getMockPlayer } from '../mockScript'
import { playerColorMap } from '../playerColors'
import { localPlayers } from '../localPlayers'
import { genreLabel } from '../genres'
import { preloadAudio } from '../audioBus'

interface Props {
  ctx: GameContext
  actions: GameActions
  onNavigate: NavigateFn
}

export default function CastingScreen({ ctx, actions, onNavigate }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  // 録音開始までに間に合うよう、配役画面に入った時点で音源を先読みする
  useEffect(() => { preloadAudio() }, [])
  const script = ctx.script
  const world = script?.worldSetting ?? MOCK_WORLD
  const roles = script?.roles ?? MOCK_ROLES
  const entries = script?.entries ?? FULL_SCRIPT
  const colors = playerColorMap(ctx.players)
  const mine = localPlayers(ctx.players, ctx.deviceId)

  // モック台本のときは ctx.players が空なので、従来どおり1人だけをローカル扱いにする（準備画面と同じ方針）
  const mockPlayer = script ? null : getMockPlayer(ctx.isHost, ctx.playerName)
  const mineNames = mockPlayer !== null ? [mockPlayer] : mine.map(p => p.name)
  const colorFor = (name: string) => colors[name] ?? '#b8352c' // モック時は1P色に倒す

  const myRoles = roles.filter(r => mineNames.includes(r.player))
  const otherRoles = roles.filter(r => !mineNames.includes(r.player))

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto pb-10">
      <div className="text-center py-6">
        <h1 className="washi-band font-display text-2xl">配役発表！</h1>
        <p className="text-usuzumi text-sm mt-1">
          ジャンル：{genreLabel(ctx.genre) || '時代劇'}
        </p>
      </div>

      {!ctx.aiMode && (
        <div className="washi-panel mb-4 text-sumi text-sm">
          この回は簡易モードです。台本は用意されたものを使っています。
        </div>
      )}

      {/* World setting */}
      <div className="washi-panel mb-4">
        <p className="text-usuzumi text-xs font-bold tracking-wider mb-2">世界観</p>
        <p className="text-sumi text-sm leading-relaxed">{world}</p>
      </div>

      {/* My role */}
      <div className="washi-panel mb-4">
        <p className="text-usuzumi text-xs font-bold tracking-wider mb-3">
          {mine.length > 1 ? 'この端末の配役' : 'あなたの役'}
        </p>
        {myRoles.map((r, i) => (
          <div key={r.player} className={i > 0 ? 'rule pt-4 mt-4' : ''}>
            <div className="text-center mb-4">
              <p className="text-xs font-bold tracking-wider mb-1" style={{ color: colorFor(r.player) }}>
                {r.player} の役
              </p>
              <h2 className="washi-band font-display text-2xl">{r.role}</h2>
            </div>
            <p className="text-usuzumi text-sm leading-relaxed mb-4">{r.description}</p>
            <p className="text-usuzumi text-xs font-bold mb-2">セリフ</p>
            <div className="space-y-3">
              {entries.filter(e => e.player === r.player).map((entry, j) => (
                <div key={j} className={j > 0 ? 'rule pt-3' : ''}>
                  {entry.action && (
                    <p className="text-usuzumi text-xs italic mb-1">〔{entry.action}〕</p>
                  )}
                  <p className="text-sumi text-sm leading-relaxed">「{entry.line}」</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Other players */}
      <div className="washi-panel mb-6">
        <p className="font-bold mb-3 text-usuzumi text-sm">他のプレイヤーの役</p>
        <div>
          {otherRoles.map((r, i) => (
            <div key={i} className={`flex items-center gap-3 py-2 ${i > 0 ? 'rule' : ''}`}>
              {/* .seal は既定で朱固定（border-shu/text-shu）＝1P の色と同値なので、
                  背景だけ乗せると頭文字が消える。text-kinari と borderColor で上書きする
                  （LobbyScreen と同じ手当て） */}
              <div
                className="seal h-7 w-7 text-xs flex-shrink-0 text-kinari"
                style={{ background: colorFor(r.player), borderColor: colorFor(r.player) }}
              >
                {r.player[0]}
              </div>
              <span className="text-usuzumi text-sm">{r.player}</span>
              <span className="text-usuzumi text-sm">／</span>
              <span className="text-sumi text-sm">{r.role}</span>
              {ctx.players.find(p => p.name === r.player)?.connected === false && (
                <span className="text-xs text-shu font-bold">復帰待ち…</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={() => onNavigate('prepare')}
        className="btn-sumi"
      >
        台本を読む →
      </button>

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
