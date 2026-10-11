import { useState } from 'react'
import type { GameContext } from '../App'
import type { GameActions } from '../useGameSocket'
import type { PlayerSnapshot } from '../types'
import { GENRES, genreLabel } from '../genres'
import { MIN_PLAYERS, NAME_MAX, MAX_PLAYERS, MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'
import { playerColorMap } from '../playerColors'
import ConfirmDialog from '../components/ConfirmDialog'
import { deviceCount, liveAudioToggleState } from '../liveAudioPure'

interface Props {
  ctx: GameContext
  actions: GameActions
  onLeave: () => void
}

// 参加順を保ったまま端末ごとにまとめる（Map は挿入順を保つ）
function groupByDevice(players: PlayerSnapshot[]): { deviceId: string; members: PlayerSnapshot[] }[] {
  const groups = new Map<string, PlayerSnapshot[]>()
  for (const p of players) {
    const list = groups.get(p.deviceId)
    if (list) list.push(p)
    else groups.set(p.deviceId, [p])
  }
  return [...groups].map(([deviceId, members]) => ({ deviceId, members }))
}

/**
 * この端末にプレイヤーを足すインライン入力。
 * 重複と文字数はここでも弾く：サーバーの error を待つと3人分を続けて
 * 入れるときにテンポが落ちるため（サーバー側の検証は残したまま）。
 */
function AddPlayerRow({
  disabled, onAdd, taken,
}: {
  disabled: boolean
  onAdd: (name: string) => void
  taken: string[]
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [err, setErr] = useState('')

  if (disabled) {
    return <p className="text-usuzumi text-xs mt-2">満員です（{MAX_PLAYERS}人まで）</p>
  }
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-2 py-2 border border-dashed border-sumi text-sumi text-sm font-medium hover:bg-sumi/5 transition-colors"
      >
        ＋ この端末にプレイヤーを追加
      </button>
    )
  }

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    if (trimmed.length > NAME_MAX) {
      setErr(`名前は${NAME_MAX}文字までです`)
      return
    }
    if (taken.includes(trimmed)) {
      setErr('その名前は使われています')
      return
    }
    onAdd(trimmed)
    setName('')
    setErr('')
    // 続けて足せるよう入力欄は開いたままにする
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={e => { setName(e.target.value); setErr('') }}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
          maxLength={NAME_MAX}
          autoFocus
          placeholder="名前"
          className="field flex-1"
        />
        <button onClick={submit} className="btn-outline w-24 text-sm">追加</button>
      </div>
      {err && <p className="text-shu text-xs mt-1">{err}</p>}
      <button
        onClick={() => { setOpen(false); setName(''); setErr('') }}
        className="text-usuzumi text-xs mt-1 hover:text-shu transition-colors"
      >
        閉じる
      </button>
    </div>
  )
}

export default function LobbyScreen({ ctx, actions, onLeave }: Props) {
  const [confirmDisband, setConfirmDisband] = useState(false)
  const [hostOnlyNudge, setHostOnlyNudge] = useState(false) // ゲストがジャンルをタップした時の「ホストのみ選択できます」強調
  // 声の配信用は別state。hostOnlyNudge と共有すると「ジャンルを押したのに
  // 声の配信側も光る」という逆の混乱が起きるため、パネルごとに独立させる。
  const [liveAudioNudge, setLiveAudioNudge] = useState(false)
  // キック確認中の端末ID（キックは端末単位）
  const [kickTarget, setKickTarget] = useState<string | null>(null)

  const colors = playerColorMap(ctx.players)
  const groups = groupByDevice(ctx.players)
  const isFull = ctx.players.length >= MAX_PLAYERS
  const kickGroup = kickTarget ? groups.find(g => g.deviceId === kickTarget) : undefined
  const kickNames = kickGroup?.members.map(m => m.name).join('・') ?? ''
  const toggleState = liveAudioToggleState(deviceCount(ctx.players))

  // 前回の結果からロビーへ戻る途中：まだ結果画面を見ている人がいる状態。
  // 全員が戻ると room_reset で returnedPlayers がクリアされ、ホストが再スタートできる。
  // （サーバーも status!=='waiting' の間は start_game を拒否する）
  const waitingForReturns =
    ctx.returnedPlayers.length > 0 && ctx.returnedPlayers.length < ctx.players.length

  const startGame = () => {
    if (!ctx.genre || waitingForReturns || ctx.players.length < MIN_PLAYERS) return
    actions.startGame() // script_generating/ready/failed で App が制御
  }

  return (
    <div className="min-h-screen p-4 max-w-3xl mx-auto">
      {/* 台本生成中オーバーレイ */}
      {ctx.generating && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-sumi/60 p-4">
          <div className="washi-panel w-full max-w-xs text-center">
            <p className="font-display font-bold text-lg text-sumi mb-1">AIが台本を執筆中...</p>
            <p className="text-usuzumi text-sm mb-6">ジャンル：{genreLabel(ctx.genre)}</p>
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-shu/20 border-t-shu" />
          </div>
        </div>
      )}

      {/* Room code：演目札の見立て。墨地・生成り抜きでコードを大きく出す */}
      <div className="washi-panel text-center mb-4">
        <p className="text-usuzumi text-sm mb-2">ルームコード</p>
        <p className="bg-sumi py-3 text-5xl font-display font-bold tracking-[0.3em] text-kinari">{ctx.roomCode}</p>
        <p className="text-usuzumi text-xs mt-2">このコードを友達に共有しよう</p>
      </div>

      {/* Players：端末ごとにグループ化する。3人乗っていると「あなた」が誰を指すか決まらないため、
          人単位の「（あなた）」表記はやめ「この端末」というグループ見出しにする */}
      <div className="washi-panel mb-4">
        <p className="font-bold mb-3 text-usuzumi text-sm">参加者 {ctx.players.length} / {MAX_PLAYERS}</p>
        <div className="space-y-3">
          {groups.map(g => {
            const isMine = g.deviceId === ctx.deviceId
            const offline = g.members[0]?.connected === false
            return (
              <div key={g.deviceId} className="border border-kei p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-usuzumi text-xs font-bold tracking-wider">
                    {isMine ? 'この端末' : 'オンライン'}
                    {g.members.length > 1 && `（${g.members.length}人）`}
                  </p>
                  {offline && <span className="text-xs text-shu font-bold">復帰待ち…</span>}
                </div>
                {g.members.map((p, i) => (
                  <div key={p.id} className={`flex items-center gap-3 py-2 ${i > 0 ? 'rule' : ''}`}>
                    {/* .seal は既定で朱固定の文字色・枠線（border-shu/text-shu）を持つ。
                        1P の色（朱）がまさに shu と同値なので、背景だけ乗せると頭文字が
                        自分の背景色に埋もれて消える。text-kinari は @layer utilities、
                        .seal の text-shu は @layer components 由来なので、後勝ちで
                        必ず text-kinari が勝つ（Tailwind の layer 順）。枠線も同じ色に
                        揃えて視覚的に一体の丸にする。 */}
                    <div
                      className="seal h-8 w-8 text-sm flex-shrink-0 text-kinari"
                      style={{ background: colors[p.name], borderColor: colors[p.name] }}
                    >
                      {p.name[0]}
                    </div>
                    <span className="text-sumi">{p.name}</span>
                    {p.isHost && (
                      <span className="text-xs bg-sumi text-kinari px-2 py-0.5 font-bold">ホスト</span>
                    )}
                    {isMine && i > 0 && (
                      <button
                        onClick={() => actions.removeLocalPlayer(p.id)}
                        aria-label={`${p.name} を外す`}
                        className="ml-auto text-xs px-2 py-1 border border-kei text-usuzumi hover:text-shu hover:border-shu transition-colors"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {isMine && <AddPlayerRow disabled={isFull} onAdd={actions.addLocalPlayer} taken={ctx.players.map(p => p.name)} />}
                {ctx.isHost && !isMine && offline && (
                  <button
                    onClick={() => setKickTarget(g.deviceId)}
                    className="mt-2 text-xs px-2 py-1 border border-shu text-shu hover:bg-shu/10 font-bold transition-colors"
                  >
                    退出させる
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 前回の結果からの復帰待ち */}
      {waitingForReturns && (
        <div className="washi-panel mb-4 text-center">
          <p className="text-shu text-sm font-bold">他のプレイヤーが結果を見ています…</p>
          <p className="text-usuzumi text-xs mt-1">
            {ctx.returnedPlayers.length}/{ctx.players.length} 人がロビーに戻りました
          </p>
        </div>
      )}

      {!ctx.aiAvailable && (
        <div className="washi-panel mb-4 text-sumi text-sm">
          いまは簡易モードです。用意された台本で遊べます（採点は簡易版になります）。
        </div>
      )}

      {/* Genre：選択中だけ差し色ベタ（--genre に自動追従）、未選択は枠のみ */}
      {ctx.isHost ? (
        <div className="washi-panel mb-4">
          <p className="font-bold mb-3 text-usuzumi text-sm">ジャンルを選ぶ</p>
          <div className="grid grid-cols-2 gap-2">
            {GENRES.map(g => (
              <button
                key={g.id}
                onClick={() => actions.setGenre(g.id)}
                style={ctx.genre === g.id ? { background: 'var(--genre)' } : undefined}
                className={`p-3 text-left transition-colors ${
                  ctx.genre === g.id
                    ? 'text-kinari'
                    : 'border border-sumi text-sumi hover:bg-sumi/5'
                }`}
              >
                <div className="text-xl mb-1">{g.emoji}</div>
                <div className="text-sm font-medium">{g.label}</div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="washi-panel mb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-usuzumi text-sm">ジャンル</p>
            <span className="text-xs bg-sumi text-kinari px-2 py-0.5 font-medium">
              ホストが選択
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {GENRES.map(g => (
              <button
                key={g.id}
                type="button"
                aria-disabled="true"
                onClick={() => {
                  setHostOnlyNudge(true)
                  setTimeout(() => setHostOnlyNudge(false), 1600)
                }}
                style={ctx.genre === g.id ? { background: 'var(--genre)' } : undefined}
                className={`p-3 text-left cursor-not-allowed transition-colors ${
                  ctx.genre === g.id
                    ? 'text-kinari'
                    : 'border border-sumi text-usuzumi'
                }`}
              >
                <div className="text-xl mb-1">{g.emoji}</div>
                <div className="text-sm font-medium">{g.label}</div>
              </button>
            ))}
          </div>
          <p
            className={`text-xs text-center mt-3 transition-colors ${
              hostOnlyNudge ? 'text-shu font-bold' : 'text-usuzumi'
            }`}
          >
            ホストのみ選択できます
          </p>
        </div>
      )}

      {/* 声の配信：ジャンルと同じく「ホストが部屋全体で決める」設定なので、
          操作の作法もジャンル選択に揃える（新しい作法を発明しない）。 */}
      <div className="washi-panel mb-4">
        <div className="flex items-center justify-between mb-3">
          <p className="font-bold text-usuzumi text-sm">声の配信</p>
          {!ctx.isHost && (
            <span className="text-xs bg-sumi text-kinari px-2 py-0.5 font-medium">ホストが選択</span>
          )}
        </div>
        {toggleState === 'available' ? (
          <>
            <div className="flex gap-2">
              {[true, false].map(on => (
                <button
                  key={String(on)}
                  type="button"
                  onClick={() => {
                    if (!ctx.isHost) {
                      setLiveAudioNudge(true)
                      setTimeout(() => setLiveAudioNudge(false), 1600)
                      return
                    }
                    actions.setLiveAudio(on)
                  }}
                  aria-disabled={!ctx.isHost}
                  style={ctx.liveAudio === on ? { background: 'var(--genre)' } : undefined}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${
                    ctx.liveAudio === on
                      ? 'text-kinari'
                      : ctx.isHost
                      ? 'border border-sumi text-sumi hover:bg-sumi/5'
                      : 'border border-sumi text-usuzumi'
                  } ${ctx.isHost ? '' : 'cursor-not-allowed'}`}
                >
                  {on ? 'ON' : 'OFF'}
                </button>
              ))}
            </div>
            {!ctx.isHost && (
              <p
                className={`text-xs text-center mt-3 transition-colors ${
                  liveAudioNudge ? 'text-shu font-bold' : 'text-usuzumi'
                }`}
              >
                ホストのみ選択できます
              </p>
            )}
          </>
        ) : (
          <p className="text-usuzumi text-xs">
            {/* 無効化中でも「いまONかOFFか」が消えないように頭に出す。ONのときだけ
                var(--genre) をテキスト色に使う（PrepareScreen等と同じ用法）。設定は
                サーバー側に残り続ける（ジャンルと同じく再戦のため）ので、台数が
                減って無効化されても値そのものは変わらない。 */}
            <span className={`font-bold ${ctx.liveAudio ? 'text-[color:var(--genre)]' : 'text-sumi'}`}>
              設定：{ctx.liveAudio ? 'ON' : 'OFF'}
            </span>
            ・{toggleState === 'alone'
              ? '他の端末が参加すると使えます'
              : `${MAX_LIVE_AUDIO_DEVICES}台までです（いまは${deviceCount(ctx.players)}台）`}
          </p>
        )}
        <p className="text-usuzumi text-xs mt-2">
          録音中、他の端末の声が聞こえます。離れた場所の人と掛け合うための機能です。
        </p>
      </div>

      {ctx.isHost ? (
        <div className="space-y-3">
          <button
            onClick={startGame}
            disabled={!ctx.genre || ctx.generating || waitingForReturns || ctx.players.length < MIN_PLAYERS}
            className="btn-sumi"
          >
            {waitingForReturns ? '全員のロビー復帰を待っています…' : 'ゲームを開始する'}
          </button>

          {!confirmDisband ? (
            <button
              onClick={() => setConfirmDisband(true)}
              className="w-full py-3 text-usuzumi hover:text-sumi text-sm font-medium transition-colors"
            >
              ルームを解散する
            </button>
          ) : (
            <div className="washi-panel">
              <p className="text-shu text-sm font-bold text-center mb-3">
                本当に解散しますか？<br />
                <span className="font-normal text-xs">参加中の全員がロビーから退出されます</span>
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDisband(false)}
                  className="btn-outline"
                >
                  キャンセル
                </button>
                <button
                  onClick={onLeave}
                  className="btn-shu"
                >
                  解散する
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-center text-usuzumi text-sm py-4">
            ホストがゲームを開始するまで待機中...
          </div>

          {!confirmDisband ? (
            <button
              onClick={() => setConfirmDisband(true)}
              className="w-full py-3 text-usuzumi hover:text-sumi text-sm font-medium transition-colors"
            >
              退出する
            </button>
          ) : (
            <div className="washi-panel">
              <p className="text-shu text-sm font-bold text-center mb-3">
                本当に退出しますか？
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmDisband(false)}
                  className="btn-outline"
                >
                  キャンセル
                </button>
                <button
                  onClick={onLeave}
                  className="btn-shu"
                >
                  退出する
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={kickTarget !== null}
        title="この端末を退出させますか？"
        message={
          kickGroup && kickGroup.members.length > 1
            ? `${kickNames} の${kickGroup.members.length}人が退出します。`
            : `${kickNames} が退出します。`
        }
        confirmLabel="退出させる"
        cancelLabel="やめる"
        onConfirm={() => { if (kickTarget) actions.kickDevice(kickTarget); setKickTarget(null) }}
        onCancel={() => setKickTarget(null)}
      />
    </div>
  )
}
