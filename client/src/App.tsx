import { useState, useCallback } from 'react'
import type { CSSProperties } from 'react'
import TopScreen from './screens/TopScreen'
import LobbyScreen from './screens/LobbyScreen'
import CastingScreen from './screens/CastingScreen'
import PrepareScreen from './screens/PrepareScreen'
import RecordingScreen from './screens/RecordingScreen'
import EvaluatingScreen from './screens/EvaluatingScreen'
import ResultScreen from './screens/ResultScreen'
import ToastStack, { type ToastMessage } from './components/Toast'
import { GENRE_ACCENT, DEFAULT_ACCENT } from './genreStyles'
import { useGameSocket, TOKEN_KEY } from './useGameSocket'
import { socket } from './socket'
import type { ScriptData, PlayerScore, PlayerSnapshot } from './types'
import type { PeerState } from './liveAudio'

export type Screen =
  | 'top'
  | 'lobby'
  | 'casting'
  | 'prepare'
  | 'recording'
  | 'evaluating'
  | 'result'

export interface GameContext {
  playerName: string      // この端末の代表プレイヤー名（トップの入力保持と1人時のシェア文言）
  deviceId: string        // この端末のID。players の deviceId と突き合わせて「この端末の人」を出す
  isHost: boolean
  roomCode: string
  genre: string
  liveAudio: boolean                       // ホストが決めた「声の配信」の ON/OFF
  peerStates: Record<string, PeerState>    // deviceId → 接続状態（録音画面の表示用）
  players: PlayerSnapshot[]
  readyMap: Record<string, boolean>
  bgm: string | null
  script: ScriptData | null
  scores: PlayerScore[]
  leftPlayers: string[]
  returnedPlayers: string[]
  generating: boolean
  rejoinedNoRecord: boolean // 録音中に再接続で戻った＝この回は自分の録音が記録されない
  aiAvailable: boolean // 「いまゲームを始めたら実AIが使えるか」（ロビー表示用）
  aiMode: boolean // 「いま進行中のこの回が実AIか」（script_ready で確定。配役/結果画面の表示用）
  // 合成済みの「作品」。url は取得可能な完全URL。合成が終わるまで workState は 'pending'
  workUrl: string | null
  workState: 'pending' | 'ready' | 'failed'
}

export type NavigateFn = (screen: Screen, updates?: Partial<GameContext>) => void

const INITIAL_CTX: GameContext = {
  playerName: '',
  deviceId: '',
  isHost: false,
  roomCode: '',
  genre: '',
  liveAudio: false,
  peerStates: {},
  players: [],
  readyMap: {},
  bgm: null,
  script: null,
  scores: [],
  leftPlayers: [],
  returnedPlayers: [],
  generating: false,
  rejoinedNoRecord: false,
  aiAvailable: true,
  aiMode: true,
  workUrl: null,
  workState: 'pending',
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('top')
  const [ctx, setCtx] = useState<GameContext>(INITIAL_CTX)
  const [error, setError] = useState('')
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [dissolved, setDissolved] = useState(false)
  const [disconnected, setDisconnected] = useState(false)

  const pushToast = useCallback((text: string, tone: 'error' | 'info' = 'info') => {
    setToasts(prev => [...prev, { id: Date.now() + Math.random(), text, tone }])
  }, [])
  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  // 画面と ctx をトップ状態へ戻す（ソケットは触らない）
  const clearToTop = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY) // もう戻らない＝再接続トークンを捨てる
    setCtx(INITIAL_CTX)
    setError('')
    setDissolved(false)
    setDisconnected(false)
    setScreen('top')
  }, [])

  // useGameSocket に渡すので宣言はフックより上。参照が毎レンダー変わると
  // リスナ登録の effect が張り直されるため useCallback で固定する。
  const resetToTop = useCallback(() => {
    if (socket.connected) socket.disconnect()
    clearToTop()
  }, [clearToTop])

  const actions = useGameSocket({
    setCtx, setScreen, setError, pushToast, setDissolved, setDisconnected, resetToTop,
  })

  const navigate: NavigateFn = (nextScreen, updates) => {
    if (updates) setCtx(prev => ({ ...prev, ...updates }))
    setScreen(nextScreen)
  }

  // 退出/解散ボタン。ただ切断すると事故切断扱いで60秒の猶予スロットが残り、
  // 他の人の画面に「復帰待ち…」のゴーストが居座るので明示的に leave_room を送る。
  // ここでは切断しない（emit が飛ぶ前に閉じると leave_room が届かない）。
  const leaveAndReset = () => {
    actions.leaveRoom()
    clearToTop()
  }

  // 地は全画面わら半紙で統一。ジャンルは差し色として --genre に流し、
  // 各画面は var(--genre) を見るだけでジャンルを知らなくてよい。
  const accent = ctx.genre ? (GENRE_ACCENT[ctx.genre] ?? DEFAULT_ACCENT) : DEFAULT_ACCENT

  return (
    <div
      className="min-h-screen bg-washi text-sumi"
      style={{ '--genre': accent } as CSSProperties}
    >
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {dissolved && (
        <div className="fixed inset-0 z-[60] bg-sumi/60 flex items-center justify-center p-4">
          <div className="washi-panel text-center max-w-xs w-full">
            <p className="font-display font-bold text-sumi mb-4">ホストが退出したためルームが解散されました</p>
            <button onClick={resetToTop} className="btn-sumi">
              OK
            </button>
          </div>
        </div>
      )}

      {disconnected && (
        <div className="fixed inset-0 z-[65] bg-sumi/60 flex items-center justify-center p-4">
          <div className="washi-panel text-center max-w-xs w-full">
            <p className="font-display font-bold text-sumi mb-1">接続が切れました</p>
            <p className="text-usuzumi text-sm animate-pulse">再接続中…</p>
            <p className="text-usuzumi text-xs mt-2">
              {ctx.isHost ? 'ホストは復帰できません。トップ画面に戻ります' : 'しばらく待つと同じ画面に戻ります'}
            </p>
          </div>
        </div>
      )}

      {screen === 'top'        && <TopScreen actions={actions} error={error} onClearError={() => setError('')} />}
      {screen === 'lobby'      && <LobbyScreen ctx={ctx} actions={actions} onLeave={leaveAndReset} />}
      {screen === 'casting'    && <CastingScreen ctx={ctx} actions={actions} onNavigate={navigate} />}
      {screen === 'prepare'    && <PrepareScreen ctx={ctx} actions={actions} />}
      {screen === 'recording'  && <RecordingScreen ctx={ctx} actions={actions} />}
      {screen === 'evaluating' && <EvaluatingScreen ctx={ctx} onNavigate={navigate} />}
      {screen === 'result'     && <ResultScreen ctx={ctx} actions={actions} />}
    </div>
  )
}
