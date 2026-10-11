import { io, type Socket } from 'socket.io-client'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import { SERVER_URL } from './config'

// 再接続はトークン方式（rejoin）で本人を同定するので、自動再接続してよい。
// socket.id が変わってもサーバーが旧スロットへ付け替える（B5）。
// 試行回数はサーバーの猶予（60秒）を上回るように取る：
// 0.5→1→2→4→5→5…（reconnectionDelayMax=5s）で20回 ≒ 80秒。
// 尽きたら reconnect_failed でトップへ戻す（「再接続中…」で固まらせない）。
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 20,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
})
