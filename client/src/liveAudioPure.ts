import type { PlayerSnapshot } from './types'
import { MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'

// ライブ音声の判定のうち、WebRTC に触らない部分だけをここに置く。
// クライアントには React のテスト基盤が無く、RTCPeerConnection も Node に無いので、
// テストできるのは純粋関数だけ。テストできるものをここへ寄せておく。

/**
 * どちらが offer を出すかを deviceId の辞書順で決める（小さいほうが出す）。
 * 双方が同時に offer を出す glare を、追加のやり取り無しで防ぐ。
 * 判定は必ず片側だけ true になる。
 */
export function shouldCreateOffer(selfDeviceId: string, peerDeviceId: string): boolean {
  return selfDeviceId < peerDeviceId
}

/**
 * 接続先の端末ID。自分の端末は除き、参加順（players の並び順）を保つ。
 * 1台に複数人乗っていても端末は1つなので、重複は畳む。
 */
export function peerDeviceIds(players: PlayerSnapshot[], selfDeviceId: string): string[] {
  if (!selfDeviceId) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of players) {
    if (p.deviceId === selfDeviceId || seen.has(p.deviceId)) continue
    seen.add(p.deviceId)
    out.push(p.deviceId)
  }
  return out
}

/** 部屋の端末数（人数ではない）。mesh の規模はこちらで決まる。 */
export function deviceCount(players: PlayerSnapshot[]): number {
  return new Set(players.map(p => p.deviceId)).size
}

/**
 * ロビーのトグルの状態。理由を出し分けるために3値で返す。
 * - alone: 相手がいないので意味が無い
 * - too-many: mesh が保たない
 */
export function liveAudioToggleState(count: number): 'available' | 'alone' | 'too-many' {
  if (count > MAX_LIVE_AUDIO_DEVICES) return 'too-many'
  if (count < 2) return 'alone'
  return 'available'
}

/**
 * ontrack で再生に使う MediaStream を決める。
 *
 * 送信側は addTransceiver で枠だけ先に作り、録音開始で replaceTrack により
 * マイクを差し込む（getUserMedia を1本に保つため）。この経路は**トラックを
 * MediaStream に紐づけない**ので SDP に msid が乗らず、受信側の
 * RTCTrackEvent.streams が空になる。
 *
 * ここで諦めると <audio> が作られず永久に無音になる（実機でそれが起きた）。
 * streams が空なら track から作り直す。受信側で吸収しておけば、msid を
 * 付けない実装が相手でも成立する。
 *
 * createStream を注入するのは、MediaStream が Node に存在せずテストできないため。
 */
export function remoteStreamFrom(
  streams: readonly MediaStream[],
  track: MediaStreamTrack | undefined,
  createStream: (track: MediaStreamTrack) => MediaStream,
): MediaStream | null {
  const given = streams[0]
  if (given) return given
  if (!track) return null
  return createStream(track)
}
