import { useCallback, useEffect, useState } from 'react'
import type { GameActions } from '../useGameSocket'
import CreditsDialog from '../components/CreditsDialog'

interface Props {
  actions: GameActions
  error: string
  onClearError: () => void
}

type Mode = 'select' | 'create' | 'join'

export default function TopScreen({ actions, error, onClearError }: Props) {
  const [mode, setMode] = useState<Mode>('select')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [creditsOpen, setCreditsOpen] = useState(false)
  // CreditsDialog の Esc リスナはこの参照が変わるたびに張り直されるので固定する
  const closeCredits = useCallback(() => setCreditsOpen(false), [])
  // 作成/参加を送ってから返事が来るまで true（成功＝ロビーへ遷移してこの画面ごと消える、失敗＝error）。
  // サーバーの起動待ちなどで繋がっていない間に連打すると、socket.io が溜めた分が
  // 繋がった瞬間にまとめて送られ、部屋が複数できる。返事待ちの間は送らせない。
  const [pending, setPending] = useState(false)

  // 失敗の返事でボタンを戻す。送る直前に error を空にしているので、
  // 同じ文言の失敗が続いても毎回 '' → 文言 と変化してここを通る。
  useEffect(() => {
    if (error) setPending(false)
  }, [error])

  const switchMode = (m: Mode) => {
    if (pending) {
      actions.cancelRoomRequest() // 待っている間に戻ったら、溜まっている送信も捨てる
      setPending(false)
    }
    onClearError()
    setMode(m)
  }

  const handleCreate = () => {
    if (!name.trim() || pending) return
    onClearError()
    setPending(true)
    actions.createRoom(name.trim())
  }

  const handleJoin = () => {
    if (!name.trim() || code.length !== 4 || pending) return
    onClearError()
    setPending(true)
    actions.joinRoom(code, name.trim())
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      {/* 芝居小屋の表構え。枠は本文の列だけを囲み、紙と四隅の焼けは画面いっぱい（bg-washi）。
          こうするとスマホでもPCでも「一枚の立て看板」として同じに見える。 */}
      <div className="w-full max-w-md relative border-[3px] border-sumi px-5 py-7 sm:px-7">
        {/* 二重罫の内側。朱の細線 */}
        <div className="pointer-events-none absolute inset-[5px] border border-shu" />

        {/* 検印 */}
        <div className="seal absolute right-3 top-3 h-11 w-11 text-lg opacity-90">
          演
        </div>

        <div className="relative text-center">
          <span className="inline-block bg-sumi px-4 py-0.5 text-[0.6rem] font-bold tracking-[0.3em] text-kinari">
            本日開演
          </span>
          <h1 className="font-display mt-4 text-4xl font-bold leading-tight text-sumi [text-shadow:3px_3px_0_rgba(184,53,44,0.85)]">
            こじらせ大劇場
          </h1>
          <p className="mt-4 inline-block bg-shu px-4 py-1 text-xs font-bold tracking-[0.22em] text-kinari">
            大根役者選手権
          </p>
          <p className="font-display mt-3 text-sm text-[#4a3a2a]">みんなで即興演劇を楽しもう！</p>
        </div>

        {mode === 'select' && (
          <div className="relative mt-7 space-y-3">
            <button
              onClick={() => switchMode('create')}
              className="w-full bg-sumi py-4 text-lg font-bold tracking-[0.12em] text-kinari transition-opacity hover:opacity-85"
            >
              ルームを作る（ホスト）
            </button>
            <button
              onClick={() => switchMode('join')}
              className="w-full border-2 border-sumi py-4 text-lg font-bold tracking-[0.12em] text-sumi transition-colors hover:bg-sumi/5"
            >
              ルームに参加する
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="relative mt-7 space-y-4">
            <h2 className="font-display text-xl font-bold text-sumi">ルームを作る</h2>
            <input
              type="text"
              placeholder="あなたの名前（10文字まで）"
              maxLength={10}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              className="field"
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || pending}
              className="w-full bg-sumi py-3 font-bold tracking-[0.12em] text-kinari transition-opacity hover:opacity-85 disabled:opacity-30"
            >
              {pending ? '作成中…' : '作成する'}
            </button>
            {error && <p className="text-center text-sm text-shu">{error}</p>}
            <button onClick={() => switchMode('select')} className="w-full py-1 text-sm text-sumi/50">
              ← 戻る
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="relative mt-7 space-y-4">
            <h2 className="font-display text-xl font-bold text-sumi">ルームに参加する</h2>
            <input
              type="text"
              placeholder="あなたの名前（10文字まで）"
              maxLength={10}
              value={name}
              onChange={e => setName(e.target.value)}
              className="field"
            />
            <input
              type="text"
              placeholder="ABCD"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              className="field text-center text-2xl font-bold tracking-[0.4em]"
            />
            <button
              onClick={handleJoin}
              disabled={!name.trim() || code.length !== 4 || pending}
              className="w-full bg-sumi py-3 font-bold tracking-[0.12em] text-kinari transition-opacity hover:opacity-85 disabled:opacity-30"
            >
              {pending ? '参加中…' : '参加する'}
            </button>
            {error && <p className="text-center text-sm text-shu">{error}</p>}
            <button onClick={() => switchMode('select')} className="w-full py-1 text-sm text-sumi/50">
              ← 戻る
            </button>
          </div>
        )}
      </div>

      {/* 立て看板の右下の外。検印のある右上や本文の操作を邪魔しない位置 */}
      <div className="w-full max-w-md mt-2 text-right">
        <button
          onClick={() => setCreditsOpen(true)}
          className="px-1 py-1 text-xs tracking-[0.2em] text-sumi/60 underline-offset-4 hover:text-sumi hover:underline"
        >
          クレジット
        </button>
      </div>

      <CreditsDialog open={creditsOpen} onClose={closeCredits} />
    </div>
  )
}
