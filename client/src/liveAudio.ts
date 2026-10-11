import { socket } from './socket'
import { shouldCreateOffer, remoteStreamFrom } from './liveAudioPure'
import { connectRemote, disconnectRemote, disconnectAllRemote } from './audioBus'

export type PeerState = 'connecting' | 'connected' | 'failed'

// STUN は無料の公開サーバーだけを使う（ベストエフォート）。TURN は導入しない。
// 失敗率が高ければここに TURN の設定を足すだけで済むよう、設定はこの定数1箇所に閉じる。
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

interface Peer {
  pc: RTCPeerConnection
  sender: RTCRtpSender
  audio: HTMLAudioElement | null
}

const peers = new Map<string, Peer>()
let selfId = ''
let notify: (deviceId: string, state: PeerState) => void = () => {}
let unmuted = false // 録音が始まったか（あとから届いたトラックにも同じ状態を適用する）

// 切り分け用ログ。「シグナリングが届いていない」のか「届いたが ICE が
// 越えられない」のかは、どちらも connectionState が connected にも failed にも
// ならない＝画面上は同じ「…」になるため、ログでしか区別できない。
// 特に srflx（STUN が返す反射候補）が取れているかが NAT 越えの分かれ目。
// 原因が確定したら、必要なぶんだけ残して他は消すこと。
function log(msg: string, ...rest: unknown[]): void {
  console.log(`[liveAudio] ${msg}`, ...rest)
}

function send(toDeviceId: string, data: unknown): void {
  const kind = (data as { kind?: string })?.kind ?? '?'
  log(`send ${kind} → ${toDeviceId.slice(0, 8)}`)
  socket.emit('rtc_signal', { toDeviceId, data })
}

/**
 * ピアとの接続を1つ作る。トラックはまだ差し込まない（addTransceiver で
 * 「送る枠」だけ先に用意する）。こうすると ICE / DTLS を録音開始前に
 * 終わらせられて、録音開始時は replaceTrack だけで即座に音が通る。
 * replaceTrack は SDP の再交渉を伴わないので、ここが成立する。
 */
function createPeer(peerId: string): Peer | null {
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection(RTC_CONFIG)
  } catch (err) {
    // 非対応環境・非セキュアオリジン。ライブ音声だけ諦めてゲームは続ける。
    console.warn('[liveAudio] RTCPeerConnection を作れませんでした', err)
    notify(peerId, 'failed')
    return null
  }
  const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })
  const peer: Peer = { pc, sender: transceiver.sender, audio: null }

  pc.onicecandidate = e => {
    if (e.candidate) {
      // candidate.type: host（同一LAN）/ srflx（STUN成功）/ relay（TURN）。
      // srflx が1つも出ないなら STUN に届いていない＝NAT越え以前の問題。
      log(`ice candidate ${e.candidate.type} ${e.candidate.protocol} → ${peerId.slice(0, 8)}`)
      send(peerId, { kind: 'ice', candidate: e.candidate.toJSON() })
    } else {
      log(`ice gathering complete → ${peerId.slice(0, 8)}`)
    }
  }
  pc.oniceconnectionstatechange = () => {
    log(`iceConnectionState=${pc.iceConnectionState} peer=${peerId.slice(0, 8)}`)
  }
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState
    // new / connecting は notify を呼ばない＝画面は「…」のまま。
    // そこに留まったのか一度も動かなかったのかがログでしか分からないので全状態を出す。
    log(`connectionState=${s} peer=${peerId.slice(0, 8)}`)
    if (s === 'connected') notify(peerId, 'connected')
    // 失敗は取り戻さない（再試行は実装しない）。表示だけ更新する。
    else if (s === 'failed' || s === 'closed' || s === 'disconnected') notify(peerId, 'failed')
  }
  pc.ontrack = e => {
    // e.streams は空になりうる。送信側が addTransceiver + replaceTrack で
    // マイクを差し込む（getUserMedia を1本に保つ）経路はトラックを MediaStream に
    // 紐づけないため、SDP に msid が乗らないため。空なら track から作り直す。
    // ここで諦めると <audio> が作られず永久に無音になる（実機で発生した）。
    const stream = remoteStreamFrom(e.streams, e.track, t => new MediaStream([t]))
    log(
      `ontrack peer=${peerId.slice(0, 8)} streams=${e.streams.length} ` +
      `stream=${stream ? (e.streams[0] ? '受信したもの' : 'trackから生成') : 'なし'} unmuted=${unmuted}`,
    )
    if (!stream) return
    // <audio> で鳴らす。muted のうちは自動再生ポリシーに引っかからないので、
    // 準備フェーズで先に再生を始めておき、録音開始で muted を外すだけにする。
    const el = document.createElement('audio')
    el.srcObject = stream
    el.autoplay = true
    el.muted = !unmuted
    el.setAttribute('playsinline', '') // iOS で全画面プレイヤーに乗っ取られないように
    document.body.appendChild(el)
    el.play().catch(err => console.warn('[liveAudio] 再生を開始できませんでした', err))
    peer.audio = el
    // iOS Safari は <audio> に付けないと createMediaStreamSource が無音になる。
    // 上で必ず付けているので、この順序を入れ替えないこと。
    connectRemote(peerId, stream)
  }
  peers.set(peerId, peer)
  return peer
}

async function makeOffer(peerId: string, peer: Peer): Promise<void> {
  try {
    const offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    send(peerId, { kind: 'offer', sdp: peer.pc.localDescription })
  } catch (err) {
    console.warn('[liveAudio] offer を作れませんでした', err)
    notify(peerId, 'failed')
  }
}

/** 準備フェーズで呼ぶ。全ピアと接続を張るが、まだ音は出さない。冪等。 */
export function startLiveAudio(params: {
  selfDeviceId: string
  peerDeviceIds: string[]
  onPeerState: (deviceId: string, state: PeerState) => void
}): void {
  if (peers.size > 0) return // 冪等
  selfId = params.selfDeviceId
  notify = params.onPeerState
  unmuted = false
  log(`start self=${selfId.slice(0, 8)} peers=[${params.peerDeviceIds.map(p => p.slice(0, 8)).join(', ')}]`)
  for (const peerId of params.peerDeviceIds) {
    notify(peerId, 'connecting')
    const peer = createPeer(peerId)
    if (!peer) continue
    // 片側だけが offer を出す。相手は offer が届いてから answer を返す。
    const mine = shouldCreateOffer(selfId, peerId)
    log(`peer=${peerId.slice(0, 8)} offerer=${mine ? '自分' : '相手'}`)
    if (mine) void makeOffer(peerId, peer)
  }
}

/** サーバーから中継されたシグナルを processing する。冪等ではない（順序に意味がある）。 */
export function handleSignal(fromDeviceId: string, data: unknown): void {
  const msg = data as { kind?: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
  log(`recv ${msg.kind ?? '?'} ← ${fromDeviceId.slice(0, 8)}`)
  let peer = peers.get(fromDeviceId)
  // offer が先に届く側は、まだ peer を作っていないことがある
  if (!peer && msg.kind === 'offer') {
    notify(fromDeviceId, 'connecting')
    peer = createPeer(fromDeviceId) ?? undefined
  }
  if (!peer) return
  void (async () => {
    try {
      if (msg.kind === 'offer' && msg.sdp) {
        await peer.pc.setRemoteDescription(msg.sdp)
        const answer = await peer.pc.createAnswer()
        await peer.pc.setLocalDescription(answer)
        send(fromDeviceId, { kind: 'answer', sdp: peer.pc.localDescription })
      } else if (msg.kind === 'answer' && msg.sdp) {
        await peer.pc.setRemoteDescription(msg.sdp)
      } else if (msg.kind === 'ice' && msg.candidate) {
        await peer.pc.addIceCandidate(msg.candidate)
      }
    } catch (err) {
      // 順序の乱れや相手の切断で普通に起きる。そのピアだけ諦める。
      console.warn(`[liveAudio] シグナルを処理できませんでした from=${fromDeviceId}`, err)
      notify(fromDeviceId, 'failed')
    }
  })()
}

/**
 * 録音開始で呼ぶ。録音用に取ったマイクを送信トラックへ差し込み、リモート再生の
 * muted を外す。replaceTrack は再ネゴシエーションを伴わないので即座に通る。
 */
export function enableLiveAudio(micStream: MediaStream): void {
  unmuted = true
  const track = micStream.getAudioTracks()[0] ?? null
  log(`enable peers=${peers.size} micTrack=${track ? 'あり' : 'なし'}`)
  for (const peer of peers.values()) {
    if (track) {
      peer.sender.replaceTrack(track).catch(err => {
        console.warn('[liveAudio] マイクを差し込めませんでした', err)
      })
    }
    if (peer.audio) peer.audio.muted = false
  }
}

/** 録音終了・中断・退出・解散で呼ぶ。冪等。 */
export function stopLiveAudio(): void {
  for (const [id, peer] of peers) {
    peer.pc.onicecandidate = null
    peer.pc.onconnectionstatechange = null
    peer.pc.ontrack = null
    try { peer.pc.close() } catch { /* 既に閉じている */ }
    if (peer.audio) {
      peer.audio.pause()
      peer.audio.srcObject = null
      peer.audio.remove()
    }
    disconnectRemote(id)
  }
  peers.clear()
  disconnectAllRemote() // 取りこぼし防止
  selfId = ''
  unmuted = false
  notify = () => {}
}
