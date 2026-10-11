// 統合テストは日次上限の影響を受けない。1ファイルで6本以上ゲームを回すテストが複数あり、
// 既定の 5 だと途中から簡易モードに落ちて、注入した評価器が呼ばれなくなる等の形で
// 無関係なテストが壊れる。上限そのものを検証するテストは各自 process.env.DAILY_GAME_LIMIT
// を明示的に設定して上書きする。
process.env.DAILY_GAME_LIMIT ??= '100000'

// ライブ音声の切り分け用ログ（handlers.ts の rtcLog）はテストでは黙らせる。
// rtc_signal を流すテストが十数本あり、有効なままだとテスト出力が埋まる。
process.env.RTC_DEBUG ??= 'off'

import type { AddressInfo } from 'node:net'
import { io as ClientIO, type Socket } from 'socket.io-client'
import { buildServer } from '../src/server'

// 統合テストは同一IP(ループバック)から1ファイルで最大17ルームを作る。本番値の5では
// 無関係なテストが軒並み落ちるため、上限そのものを検証するテストだけ
// startTestServer({ limits: { roomCreateMax: 5 } }) で明示的に絞る運用にする。
const TEST_ROOM_CREATE_MAX = 100_000

// options は buildServer() にそのまま渡す（例: production 分岐を検証するための distDir 差し替え）。
export async function startTestServer(
  options?: Parameters<typeof buildServer>[0],
): Promise<{
  port: number
  rooms: ReturnType<typeof buildServer>['rooms']
  quota: ReturnType<typeof buildServer>['quota']
  prompts: ReturnType<typeof buildServer>['prompts']
  plays: ReturnType<typeof buildServer>['plays']
  ai: ReturnType<typeof buildServer>['ai']
  sendFeedback: ReturnType<typeof buildServer>['sendFeedback']
  close: () => Promise<void>
}> {
  const { httpServer, io, rooms, quota, prompts, plays, ai, sendFeedback } = buildServer({
    // 既定は「決して終わらない合成」。統合テストのたびに ffmpeg が起動すると遅く、
    // ffmpeg の無い環境ではテストが環境依存になる。
    // 投げる実装にすると、採点まで進む既存テスト全部で work_failed と
    // console.error が出て出力が汚れる。解決しないでおけば既存テストの
    // 見え方は今までと1バイトも変わらない。合成を見るテストは自分で渡す。
    mixdown: () => new Promise<Buffer>(() => {}),
    ...options,
    limits: { roomCreateMax: TEST_ROOM_CREATE_MAX, ...options?.limits },
  })
  await new Promise<void>(resolve => httpServer.listen(0, resolve))
  const port = (httpServer.address() as AddressInfo).port
  return {
    port,
    rooms,
    quota,
    prompts,
    plays,
    ai,
    sendFeedback,
    // io.close() disconnects all sockets AND closes the attached httpServer,
    // so teardown can't hang even if a test threw before disconnecting.
    close: () => new Promise<void>(resolve => io.close(() => resolve())),
  }
}

export function connectClient(port: number): Socket {
  return ClientIO(`http://localhost:${port}`, {
    forceNew: true,
    transports: ['websocket'],
    reconnection: false, // a disconnected/failed test client must not auto-reconnect and hang process exit
  })
}

// Resolves with the first payload of `event`, or rejects after timeoutMs so a
// missing/broken emit fails fast with a diagnostic instead of hanging the run.
export function once<T = unknown>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handler = (payload: T) => {
      clearTimeout(timer)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timeout waiting for "${event}"`))
    }, timeoutMs)
    socket.once(event, handler)
  })
}

// `ms` 内に `event` が来なければ解決、来たら reject（「起きないこと」の検証用）。
export function expectNoEvent(socket: Socket, event: string, ms = 250): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handler = () => {
      clearTimeout(timer)
      socket.off(event, handler)
      reject(new Error(`unexpected "${event}"`))
    }
    const timer = setTimeout(() => {
      socket.off(event, handler)
      resolve()
    }, ms)
    socket.once(event, handler)
  })
}

// マイク拒否のクライアントと同じ「音声なし」通知で収集ゲートを満たす（/upload の skip 経路）。
// 複数の統合テストで共用する（重複コピーを増やさない）。
export function uploadSkip(port: number, socketId: string): Promise<Response> {
  const form = new FormData()
  form.append('socketId', socketId)
  form.append('skip', '1')
  return fetch(`http://localhost:${port}/upload`, { method: 'POST', body: form })
}

// waiting のホスト(たろう)＋ゲスト(はなこ) と両者の再接続トークン・端末IDを返す。
// 複数の統合テストで共用する（重複コピーを増やさない）。
export async function makeRoom(port: number): Promise<{
  host: Socket; guest: Socket; roomCode: string
  hostToken: string; guestToken: string
  hostDeviceId: string; guestDeviceId: string
}> {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const hc = await once<{ roomCode: string; token: string; deviceId: string }>(host, 'room_created')
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode: hc.roomCode, playerName: 'はなこ' })
  const gj = await once<{ token: string; deviceId: string }>(guest, 'room_joined')
  await once(host, 'player_joined')
  return {
    host, guest, roomCode: hc.roomCode,
    hostToken: hc.token, guestToken: gj.token,
    hostDeviceId: hc.deviceId, guestDeviceId: gj.deviceId,
  }
}

// status='casting'（配役/準備フェーズ）まで進めた部屋
export async function makeCastingRoom(port: number): Promise<{
  host: Socket; guest: Socket; roomCode: string
  hostToken: string; guestToken: string
  hostDeviceId: string; guestDeviceId: string
}> {
  const r = await makeRoom(port)
  r.host.emit('set_genre', { genre: 'comedy' })
  await once(r.guest, 'genre_changed')
  // script_ready は io.to で送信者含む全員へ同時配信されるため、先に両方 listen してから emit
  const readyGuest = once(r.guest, 'script_ready')
  const readyHost = once(r.host, 'script_ready')
  r.host.emit('start_game')
  await readyGuest
  await readyHost
  return r
}

// status='recording' まで進めた host(たろう)/guest(はなこ) を返す。
// 複数の統合テストで共用する（重複コピーを増やさない）。
export async function makeRecordingRoom(
  port: number,
): Promise<{
  host: Socket; guest: Socket; roomCode: string
  hostDeviceId: string; guestDeviceId: string
}> {
  const host = connectClient(port)
  host.emit('create_room', { playerName: 'たろう' })
  const hc = await once<{ roomCode: string; deviceId: string }>(host, 'room_created')
  const roomCode = hc.roomCode
  const guest = connectClient(port)
  guest.emit('join_room', { roomCode, playerName: 'はなこ' })
  const gj = await once<{ deviceId: string }>(guest, 'room_joined')
  await once(host, 'player_joined')
  host.emit('set_genre', { genre: 'comedy' })
  await once(guest, 'genre_changed')
  // script_ready/recording_started は io.to で送信者含む全員へ同時配信されるため、
  // 逐次 await だと host 側の受信が listener 登録前に届き取りこぼす競合が発生する
  // （Windows で実測・再現性100%）。「先に両方 listen してから emit」で回避する。
  const scriptReadyGuest = once(guest, 'script_ready')
  const scriptReadyHost = once(host, 'script_ready')
  host.emit('start_game')
  await scriptReadyGuest
  await scriptReadyHost
  host.emit('set_ready', { isReady: true })
  await once(guest, 'ready_updated')
  guest.emit('set_ready', { isReady: true })
  await once(host, 'ready_updated')
  const recStartedGuest = once(guest, 'recording_started')
  const recStartedHost = once(host, 'recording_started')
  host.emit('start_recording')
  await recStartedGuest
  await recStartedHost
  return { host, guest, roomCode, hostDeviceId: hc.deviceId, guestDeviceId: gj.deviceId }
}
