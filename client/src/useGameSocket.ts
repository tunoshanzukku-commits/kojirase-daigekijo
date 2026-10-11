import { useEffect } from 'react'
import { socket } from './socket'
import { startUploadRecorder, stopAndUpload, cancelRecording, clearLastTake } from './recorder'
import { insertPlayer } from './localPlayers'
import { syncClock, resetTimeSync } from './timeSync'
import { startLiveAudio, enableLiveAudio, stopLiveAudio, handleSignal } from './liveAudio'
import { peerDeviceIds } from './liveAudioPure'
import { SERVER_URL } from './config'
import type { Screen, GameContext } from './App'
import type { RoomSnapshot, PlayerSnapshot, ScriptData, RoomStatus } from './types'

// 再接続クレデンシャル。事故切断・リロードのどちらでも同じ部屋へ戻すために保存する。
// localStorage ではなく sessionStorage：localStorage は同一ブラウザの全タブで共有され、
// 2タブ（ホスト＋ゲスト）だと後から参加した側のトークンで上書きされ、
// 先のタブがリロードすると他人として復帰してしまう。sessionStorage はタブ単位で、
// リロードは跨ぐのでこの用途にちょうど合う（タブを閉じたら復帰しない＝それが正しい）。
export const TOKEN_KEY = 'aishibai:reconnectToken'

interface Params {
  setCtx: React.Dispatch<React.SetStateAction<GameContext>>
  setScreen: (s: Screen) => void
  setError: (msg: string) => void
  pushToast: (text: string, tone?: 'error' | 'info') => void
  setDissolved: (v: boolean) => void
  setDisconnected: (v: boolean) => void
  resetToTop: () => void
}

export interface GameActions {
  createRoom: (playerName: string) => void
  joinRoom: (roomCode: string, playerName: string) => void
  /** 接続待ちで溜まっている作成/参加の送信を捨てる（送信済みのものは取り消せない） */
  cancelRoomRequest: () => void
  setGenre: (genre: string) => void
  startGame: () => void
  setReady: (isReady: boolean) => void
  startRecording: () => void
  sendBgm: (bgmId: string | null) => void
  stopRecording: () => void
  returnToLobby: () => void
  abortGame: () => void
  addLocalPlayer: (playerName: string) => void
  removeLocalPlayer: (playerId: string) => void
  kickDevice: (deviceId: string) => void
  leaveRoom: () => void
  setLiveAudio: (enabled: boolean) => void
  startLiveAudioIfEnabled: (liveAudio: boolean, players: PlayerSnapshot[], selfDeviceId: string) => void
}

export function useGameSocket({
  setCtx, setScreen, setError, pushToast, setDissolved, setDisconnected, resetToTop,
}: Params): GameActions {
  useEffect(() => {
    function onRoomCreated(
      { roomCode, room, token, deviceId }:
        { roomCode: string; room: RoomSnapshot; token: string; deviceId: string },
    ) {
      sessionStorage.setItem(TOKEN_KEY, token)
      syncClock()
      setError('')
      setCtx(prev => ({
        ...prev, roomCode, deviceId, isHost: true,
        genre: room.genre, liveAudio: room.liveAudio, players: room.players, script: room.script, scores: room.scores,
        aiAvailable: room.aiAvailable,
      }))
      setScreen('lobby')
    }
    function onRoomJoined(
      { room, token, deviceId }: { room: RoomSnapshot; token: string; deviceId: string },
    ) {
      sessionStorage.setItem(TOKEN_KEY, token)
      syncClock()
      setError('')
      setCtx(prev => ({
        ...prev, roomCode: room.code, deviceId, isHost: false,
        genre: room.genre, liveAudio: room.liveAudio, players: room.players, script: room.script, scores: room.scores,
        aiAvailable: room.aiAvailable,
      }))
      setScreen('lobby')
    }
    function onPlayerJoined({ player }: { player: PlayerSnapshot }) {
      // 単純な末尾 append にしない：サーバーの正準順（端末の参加順→端末内の追加順）と
      // ズレると、playerColorMap の index が画面ごとに食い違い、同じ人が違う色に見える。
      setCtx(prev => ({ ...prev, players: insertPlayer(prev.players, player) }))
    }
    function onPlayerLeft({ playerName }: { playerName: string }) {
      setCtx(prev => ({
        ...prev,
        players: prev.players.filter(p => p.name !== playerName),
        returnedPlayers: prev.returnedPlayers.filter(n => n !== playerName),
      }))
      pushToast(`${playerName} が退出しました`, 'info')
    }
    function onGenreChanged({ genre }: { genre: string }) {
      setCtx(prev => ({ ...prev, genre }))
    }
    // aiMode はこの回の確定値。ロビーの aiAvailable は他の部屋が枠を取ると古くなるため、
    // 配役・結果画面はこちらを見る（＝開始した瞬間に枠が尽きても表示が嘘にならない）。
    function onScriptReady({ script, aiMode }: { script: ScriptData; aiMode: boolean }) {
      syncClock()
      setCtx(prev => ({ ...prev, script, generating: false, aiMode }))
      setScreen('casting')
    }
    function onScriptGenerating() {
      setCtx(prev => ({ ...prev, generating: true }))
    }
    function onScriptFailed({ message }: { message: string }) {
      setCtx(prev => ({ ...prev, generating: false }))
      pushToast(message, 'error')
    }
    function onReadyUpdated({ playerName, isReady }: { playerName: string; isReady: boolean; allReady: boolean }) {
      setCtx(prev => ({ ...prev, readyMap: { ...prev.readyMap, [playerName]: isReady } }))
    }
    function onRecordingStarted() {
      // 正規の録音開始＝この回は記録される。前回の「復帰したので録音なし」を必ず解除する。
      setCtx(prev => ({ ...prev, rejoinedNoRecord: false }))
      setScreen('recording')
      // マイクを取得できたらライブ音声へ渡す。ライブ音声のために getUserMedia を
      // 増やさないための経路（recorder が取った1本を借りる）。
      startUploadRecorder(stream => enableLiveAudio(stream)) // 画面ではなく socket レイヤで録音を開始・停止する
    }
    function onBgmChanged({ bgmId }: { bgmId: string | null; playerName: string }) {
      setCtx(prev => ({ ...prev, bgm: bgmId }))
    }
    function onRecordingStopped() {
      setScreen('evaluating')
      void stopAndUpload(socket.id!) // 先にレコーダーを止める（stop() は同期的に呼ばれる）
      stopLiveAudio()                // そのあとで音声グラフを外す（先に外すとテイクの末尾が相手の声を失う）
    }
    function onEvaluationComplete({ scores, leftPlayers }: { scores: GameContext['scores']; leftPlayers: string[] }) {
      setCtx(prev => ({ ...prev, scores, leftPlayers }))
    }
    // サーバーはパスだけを返す。同居デプロイでは SERVER_URL が空文字になり、
    // そのまま同一オリジンの絶対パスとして解決される。
    function onWorkReady({ url }: { url: string }) {
      setCtx(prev => ({ ...prev, workUrl: `${SERVER_URL}${url}`, workState: 'ready' }))
    }
    function onWorkFailed() {
      setCtx(prev => ({ ...prev, workUrl: null, workState: 'failed' }))
    }
    function onPlayerReturned({ playerName }: { playerName: string }) {
      setCtx(prev => ({ ...prev, returnedPlayers: [...new Set([...prev.returnedPlayers, playerName])] }))
    }
    function onRoomReset({ room }: { room: RoomSnapshot }) {
      clearLastTake() // 次のゲームへ：前回のテイクは捨てる
      setCtx(prev => ({
        ...prev,
        genre: room.genre,
        liveAudio: room.liveAudio,
        peerStates: {}, // 前回のゲームの接続状態（特に failed）を次回へ持ち越さない
        players: room.players,
        script: null,
        scores: [],
        readyMap: {},
        bgm: null,
        leftPlayers: [],
        returnedPlayers: [],
        rejoinedNoRecord: false,
        workUrl: null,
        workState: 'pending',
        aiAvailable: room.aiAvailable,
      }))
      setScreen('lobby')
    }
    function onGameAborted({ room }: { room: RoomSnapshot }) {
      stopLiveAudio() // ライブ音声中の中断でも接続とマイク送信を確実に閉じる
      cancelRecording() // 録音中でも安全にマイク/レコーダーを解放（未録音時も無害）
      clearLastTake() // 次のゲームへ：前回のテイクは捨てる
      setCtx(prev => ({
        ...prev,
        genre: room.genre,
        liveAudio: room.liveAudio,
        peerStates: {}, // 前回のゲームの接続状態（特に failed）を次回へ持ち越さない
        players: room.players,
        script: null,
        scores: [],
        readyMap: {},
        bgm: null,
        leftPlayers: [],
        returnedPlayers: [],
        rejoinedNoRecord: false,
        workUrl: null,
        workState: 'pending',
        aiAvailable: room.aiAvailable,
      }))
      pushToast('ゲームを中断してロビーに戻りました', 'info')
      setScreen('lobby')
    }
    function onEvaluationFailed({ room, message }: { room: RoomSnapshot; message: string }) {
      stopLiveAudio() // 採点失敗でロビーへ戻るときも接続とマイク送信を確実に閉じる
      clearLastTake() // 次のゲームへ：前回のテイクは捨てる
      setCtx(prev => ({
        ...prev,
        genre: room.genre,
        liveAudio: room.liveAudio,
        peerStates: {}, // 前回のゲームの接続状態（特に failed）を次回へ持ち越さない
        players: room.players,
        script: null,
        scores: [],
        readyMap: {},
        bgm: null,
        leftPlayers: [],
        returnedPlayers: [],
        rejoinedNoRecord: false,
        workUrl: null,
        workState: 'pending',
        aiAvailable: room.aiAvailable,
      }))
      pushToast(message, 'error')
      setScreen('lobby')
    }
    function onDissolved() {
      stopLiveAudio() // 部屋が消える以上、接続とマイク送信を確実に閉じる
      cancelRecording() // 解散ダイアログの間もマイクが生きたままにならないようにする
      clearLastTake()
      // 部屋はもう無い＝トークンは死んでいる。残すと解散ダイアログの上に
      // 「再接続中…」が重なって OK ボタンを塞ぐ。
      sessionStorage.removeItem(TOKEN_KEY)
      resetTimeSync()
      setDisconnected(false)
      setDissolved(true)
    }
    function onError({ message }: { message: string }) {
      setError(message)      // Top画面のフォーム直下インライン表示用
      pushToast(message, 'error') // Top以外の画面でも握り潰されないようトースト表示
    }
    function onDisconnect() {
      stopLiveAudio() // 切断で相手にはもう届かない。接続とマイク送信を確実に閉じる
      cancelRecording() // 切断時にマイクとレコーダーを確実に解放する
      // トークンがあるなら猶予内に戻れる見込み＝「再接続中…」を出して自動再接続を待つ。
      // 退出/解散でトークンを消している場合は通常の切断なので何も出さない。
      if (sessionStorage.getItem(TOKEN_KEY)) setDisconnected(true)
    }

    // 再接続・リロード後の最初の connect でトークンを提示して同じ部屋へ戻る
    function onConnect() {
      const token = sessionStorage.getItem(TOKEN_KEY)
      if (token) socket.emit('rejoin', { token })
    }
    function onRejoined(
      { room, status, deviceId, selfPlayerNames }:
        { room: RoomSnapshot; status: RoomStatus; deviceId: string; selfPlayerNames: string[] },
    ) {
      setDisconnected(false)
      syncClock()
      // 代表プレイヤー名（playerName）はトップの入力保持と1人時のシェア文言に使うだけ。
      // 「この端末の人」の一覧は players と deviceId から localPlayers() で毎回導出する。
      const selfName = selfPlayerNames[0] ?? ''
      const me = room.players.find(p => p.name === selfName)
      const readyMap: Record<string, boolean> = {}
      room.players.forEach(p => { readyMap[p.name] = p.isReady })
      setCtx(prev => ({
        ...prev,
        playerName: selfName,
        deviceId,
        isHost: me?.isHost ?? false,
        roomCode: room.code,
        genre: room.genre,
        liveAudio: room.liveAudio,
        peerStates: {}, // 再接続した端末はこの回のライブ音声に戻らない仕様＝古い状態を残さない
        players: room.players,
        script: room.script,
        scores: room.scores,
        bgm: room.bgm,
        readyMap,
        leftPlayers: [],
        returnedPlayers: [],
        generating: false,
        // 再接続した端末は、すでに飛んだ work_ready を受け取れない。
        // 'pending' のままだと「仕上げています…」が永久に残るので、
        // 今日と同じ画面（＝合成なし）へ倒す。まだ合成中だったなら、
        // この端末は部屋に戻っているので後から届く work_ready が 'ready' に上書きする。
        workUrl: null,
        workState: 'failed',
        // 録音中に戻った本人は MediaRecorder を起動していない＝この回は記録されない
        rejoinedNoRecord: status === 'recording',
        aiAvailable: room.aiAvailable,
      }))
      // サーバーの status が真実源。結果閲覧中は status='evaluating' のままなので
      // scores の有無で evaluating（採点中）と result（結果表示）を判別する。
      if (status === 'casting') setScreen('casting')
      else if (status === 'recording') setScreen('recording')
      else if (status === 'evaluating') setScreen(room.scores.length > 0 ? 'result' : 'evaluating')
      else setScreen('lobby')
    }
    function onRejoinFailed({ message }: { message: string }) {
      sessionStorage.removeItem(TOKEN_KEY)
      setDisconnected(false)
      resetToTop()
      pushToast(message, 'error')
    }
    function onPlayerDisconnected({ playerName }: { playerName: string }) {
      setCtx(prev => ({
        ...prev,
        players: prev.players.map(p => (p.name === playerName ? { ...p, connected: false } : p)),
      }))
      pushToast(`${playerName} の接続が切れました（復帰待ち…）`, 'info')
    }
    function onPlayerReconnected({ playerName }: { playerName: string }) {
      setCtx(prev => ({
        ...prev,
        players: prev.players.map(p => (p.name === playerName ? { ...p, connected: true } : p)),
      }))
      pushToast(`${playerName} が復帰しました`, 'info')
    }
    // 自動再接続の試行が尽きた（サーバー停止・長時間の圏外）→ 復帰は望めないのでトップへ
    function onReconnectFailed() {
      sessionStorage.removeItem(TOKEN_KEY)
      setDisconnected(false)
      resetToTop()
      pushToast('サーバーに再接続できませんでした', 'error')
    }
    function onLiveAudioChanged({ enabled }: { enabled: boolean }) {
      setCtx(prev => ({ ...prev, liveAudio: enabled }))
    }
    function onRtcSignal({ fromDeviceId, data }: { fromDeviceId: string; data: unknown }) {
      handleSignal(fromDeviceId, data)
    }

    socket.on('room_created', onRoomCreated)
    socket.on('room_joined', onRoomJoined)
    socket.on('player_joined', onPlayerJoined)
    socket.on('player_left', onPlayerLeft)
    socket.on('genre_changed', onGenreChanged)
    socket.on('script_ready', onScriptReady)
    socket.on('script_generating', onScriptGenerating)
    socket.on('script_failed', onScriptFailed)
    socket.on('ready_updated', onReadyUpdated)
    socket.on('recording_started', onRecordingStarted)
    socket.on('bgm_changed', onBgmChanged)
    socket.on('recording_stopped', onRecordingStopped)
    socket.on('evaluation_complete', onEvaluationComplete)
    socket.on('work_ready', onWorkReady)
    socket.on('work_failed', onWorkFailed)
    socket.on('player_returned', onPlayerReturned)
    socket.on('room_reset', onRoomReset)
    socket.on('game_aborted', onGameAborted)
    socket.on('evaluation_failed', onEvaluationFailed)
    socket.on('room_dissolved', onDissolved)
    socket.on('error', onError)
    socket.on('disconnect', onDisconnect)
    socket.on('connect', onConnect)
    socket.on('rejoined', onRejoined)
    socket.on('rejoin_failed', onRejoinFailed)
    socket.on('player_disconnected', onPlayerDisconnected)
    socket.on('player_reconnected', onPlayerReconnected)
    socket.io.on('reconnect_failed', onReconnectFailed)
    socket.on('live_audio_changed', onLiveAudioChanged)
    socket.on('rtc_signal', onRtcSignal)

    // リロード復帰：トークンが残っていれば自分で繋ぎ直し、connect で rejoin する
    if (sessionStorage.getItem(TOKEN_KEY) && !socket.connected) socket.connect()

    return () => {
      socket.off('room_created', onRoomCreated)
      socket.off('room_joined', onRoomJoined)
      socket.off('player_joined', onPlayerJoined)
      socket.off('player_left', onPlayerLeft)
      socket.off('genre_changed', onGenreChanged)
      socket.off('script_ready', onScriptReady)
      socket.off('script_generating', onScriptGenerating)
      socket.off('script_failed', onScriptFailed)
      socket.off('ready_updated', onReadyUpdated)
      socket.off('recording_started', onRecordingStarted)
      socket.off('bgm_changed', onBgmChanged)
      socket.off('recording_stopped', onRecordingStopped)
      socket.off('evaluation_complete', onEvaluationComplete)
      socket.off('work_ready', onWorkReady)
      socket.off('work_failed', onWorkFailed)
      socket.off('player_returned', onPlayerReturned)
      socket.off('room_reset', onRoomReset)
      socket.off('game_aborted', onGameAborted)
      socket.off('evaluation_failed', onEvaluationFailed)
      socket.off('room_dissolved', onDissolved)
      socket.off('error', onError)
      socket.off('disconnect', onDisconnect)
      socket.off('connect', onConnect)
      socket.off('rejoined', onRejoined)
      socket.off('rejoin_failed', onRejoinFailed)
      socket.off('player_disconnected', onPlayerDisconnected)
      socket.off('player_reconnected', onPlayerReconnected)
      socket.io.off('reconnect_failed', onReconnectFailed)
      socket.off('live_audio_changed', onLiveAudioChanged)
      socket.off('rtc_signal', onRtcSignal)
    }
  }, [setCtx, setScreen, setError, pushToast, setDissolved, setDisconnected, resetToTop])

  return {
    createRoom(playerName) {
      sessionStorage.removeItem(TOKEN_KEY) // 古い部屋のトークンで rejoin しないように
      if (!socket.connected) socket.connect()
      setCtx(prev => ({ ...prev, playerName })) // 自分の名前を保持（配役画面の自己判定・ロビーの「あなた」表示に必要）
      socket.emit('create_room', { playerName })
    },
    joinRoom(roomCode, playerName) {
      sessionStorage.removeItem(TOKEN_KEY)
      if (!socket.connected) socket.connect()
      setCtx(prev => ({ ...prev, playerName }))
      socket.emit('join_room', { roomCode, playerName })
    },
    cancelRoomRequest() {
      // 未接続の間の emit は socket.io が sendBuffer に溜め、繋がった瞬間に送る。
      // 待っている間に「戻る」を押した人が、後から勝手にロビーへ飛ばされないよう捨てる。
      // 送信済みなら部屋はもうできているので、その返事（room_created）は素直に受けてロビーへ進む
      // （無視するとサーバーは部屋に入れたまま＝以後の作成が黙って捨てられて詰む）。
      socket.sendBuffer = []
    },
    setGenre(genre) {
      socket.emit('set_genre', { genre })
    },
    startGame() {
      socket.emit('start_game')
    },
    setReady(isReady) {
      socket.emit('set_ready', { isReady })
    },
    startRecording() {
      socket.emit('start_recording')
    },
    sendBgm(bgmId) {
      socket.emit('send_bgm', { bgmId })
    },
    stopRecording() {
      socket.emit('stop_recording')
    },
    returnToLobby() {
      socket.emit('return_to_lobby')
      // 他プレイヤーを待たず自分だけ即ロビーへ。全員が戻ると room_reset が届き、
      // ctx がクリアされてホストが再スタートできる（それまでは start_game をサーバーが拒否）。
      setScreen('lobby')
    },
    abortGame() {
      socket.emit('abort_game')
    },
    addLocalPlayer(playerName) {
      // 一覧への反映は player_joined 受信で行う（楽観的更新にしない＝
      // サーバーが満員/重複で弾いたときに表示がズレない）
      socket.emit('add_local_player', { playerName })
    },
    removeLocalPlayer(playerId) {
      socket.emit('remove_local_player', { playerId })
    },
    kickDevice(deviceId) {
      // 一覧からの削除は player_left 受信で行う（楽観的更新にしない＝
      // サーバーが条件を満たさず弾いた場合に表示がズレない）
      socket.emit('kick_device', { deviceId })
    },
    leaveRoom() {
      // 意図的な退出はサーバーに即削除させる（猶予を与えない）。
      // ここで socket.disconnect() してはいけない：emit がフラッシュされる前に
      // トランスポートが閉じて leave_room が届かず、事故切断扱いで60秒間
      // 「復帰待ち…」のゴーストが残る（統合テストで実測）。
      // サーバーが player を消すので、あとから切れても no-op。
      stopLiveAudio() // 退出する以上、接続とマイク送信を確実に閉じる
      clearLastTake()
      socket.emit('leave_room')
      sessionStorage.removeItem(TOKEN_KEY)
    },
    setLiveAudio(enabled) {
      socket.emit('set_live_audio', { enabled })
    },
    startLiveAudioIfEnabled(liveAudio, players, selfDeviceId) {
      if (!liveAudio) return
      const peerIds = peerDeviceIds(players, selfDeviceId)
      if (peerIds.length === 0) return
      startLiveAudio({
        selfDeviceId,
        peerDeviceIds: peerIds,
        onPeerState: (deviceId, state) => {
          setCtx(prev => ({ ...prev, peerStates: { ...prev.peerStates, [deviceId]: state } }))
        },
      })
    },
  }
}
