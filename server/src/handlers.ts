import type { Server, Socket } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/events'
import type { ScriptData } from '@shared/types'
import { NAME_MAX, MAX_PLAYERS, MIN_PLAYERS, MAX_LIVE_AUDIO_DEVICES } from '@shared/constants'
import {
  sanitizeName, isValidName, normalizeRoomCode, isValidRoomCode, isValidGenre,
  isValidEmoji, isValidBgmId, isValidSfxId,
} from './validation'
import {
  addDevice, hasPlayerName, toSnapshot, toPlayerSnapshot, touch,
  removeDevice, setReady, allReady, resetRoom, allReturned,
  reattachDevice, deviceBySocket, playerNames,
  activeDevices, activePlayerNames,
  addPlayerToDevice, removePlayerFromDevice,
} from './roomStore'
import type { Room, RoomStore, Device } from './roomStore'
import { MAX_TIMELINE_ENTRIES } from './roomStore'
import { generateStubScores } from './ai/scoreStub'
import type { AudioSource } from './ai/evaluate'
import { combineFreshVolumes } from './volume'
import { aiEnabled, publicEnabled } from './config'
import type { Quota } from './quota'
import type { Ai } from './ai'
import type { ScriptLibrary } from './ai/scriptLibrary'
import { createRateLimiter } from './rateLimit'
import { extractIp } from './clientIp'
import type { Limits } from './limits'
import { randomUUID } from 'node:crypto'
import type { Mixdown } from './mixdown'

type IO = Server<ClientToServerEvents, ServerToClientEvents>
type Sock = Socket<ClientToServerEvents, ServerToClientEvents>

const VOLUME_BROADCAST_MS = 200

// ライブ音声の切り分け用ログ。「シグナリングが届いていない」のか
// 「届いたが ICE が越えられない」のかは、サーバー側で中継の可否が見えないと
// 区別できない（クライアントのコンソールだけでは両者が同じ症状になる）。
// 既定は有効。テストは testUtils が RTC_DEBUG=off にして出力を汚さない。
// 原因が確定したら、必要なぶんだけ残して他は消すこと。
function rtcLog(event: string, detail: Record<string, string | number>): void {
  if (process.env.RTC_DEBUG === 'off') return
  const body = Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`[server] rtc_signal ${event} ${body}`)
}

function socketIp(socket: Sock): string {
  return extractIp(socket.handshake.headers['x-forwarded-for'], socket.handshake.address)
}

export interface Handlers {
  registerHandlers(io: IO, socket: Sock): void
  finalizeEvaluation(io: IO, room: Room): Promise<void>
  beginAudioCollection(io: IO, room: Room): void
}

export function createHandlers(deps: {
  rooms: RoomStore
  quota: Quota
  ai: Ai
  plays: ScriptLibrary
  limits: Limits
  mixdown: Mixdown
  audioDir: string
}): Handlers {
  const { rooms, quota, ai, plays, limits, mixdown, audioDir } = deps

  // ルーム乱造の抑制。課金の歯止めは日次上限が担うので、ここは荒らし対策の粗い網でよい。
  let roomCreateLimiter = createRateLimiter(limits.roomCreateWindowMs, limits.roomCreateMax)

  // ホスト判定は「この接続の端末が部屋のホスト端末か」。socketId 直比較はもう使えない。
  function isHostSocket(room: Room, socketId: string): boolean {
    return deviceBySocket(room, socketId)?.id === room.hostDeviceId
  }

  // 端末に乗っている人の名前（参加順）
  function namesOf(room: Room, device: Device): string[] {
    return device.playerIds.map(pid => room.players.get(pid)?.name).filter((n): n is string => !!n)
  }

  // 端末の代表プレイヤー名（リアクション/BGM/SEの送信者表示に使う）
  function representativeName(room: Room, device: Device): string | undefined {
    const first = device.playerIds[0]
    return first ? room.players.get(first)?.name : undefined
  }

  // BGM/SE を合成用タイムラインに1件積む。上限を超えたら黙って捨てる
  // （中継は呼び出し側で既に済んでおり、作品からその1音が抜けるだけで済む）。
  function recordTimeline(room: Room, kind: 'bgm' | 'sfx', id: string | null): void {
    if (room.audioTimeline.length >= MAX_TIMELINE_ENTRIES) return
    room.audioTimeline.push({ atMs: Date.now() - room.recordingStartedAt, kind, id })
  }

  // 採点とは独立に「作品」を合成する。決して await しない：合成が遅くても
  // 失敗しても、結果発表は今までどおりの速さで出さなければならない。
  // 合成が終わる前にリセット/解散が入った回は evaluationSeq で捨てる
  // （finalizeEvaluation と同じ作法）。
  function startMixdown(io: IO, room: Room): void {
    const code = room.code
    const mySeq = room.evaluationSeq
    const tracks = [...room.audio.values()].map(a => ({
      buffer: a.buffer, mime: a.mime, delayMs: a.delayMs,
    }))
    // 全員マイク拒否＝素材が無い。ffmpeg を起こさずに諦める。
    if (tracks.length === 0) {
      io.to(code).emit('work_failed')
      return
    }
    void mixdown({
      tracks,
      timeline: room.audioTimeline,
      durationMs: room.recordingDurationMs,
      audioDir,
    })
      .then(work => {
        if (rooms.get(code) !== room || room.evaluationSeq !== mySeq) return
        room.work = work
        room.workToken = randomUUID()
        room.audio.clear() // 素材はもう要らない。1部屋あたり数十MBを返す
        touch(room)
        // パスだけを返す。ホスト名を組むとリバースプロキシ配下で壊れる。
        io.to(code).emit('work_ready', { url: `/work/${code}/${room.workToken}` })
      })
      .catch((err: unknown) => {
        console.error('[server] mixdown failed:', err)
        if (rooms.get(code) !== room || room.evaluationSeq !== mySeq) return
        io.to(code).emit('work_failed')
      })
  }

  // evaluation_complete を配信する唯一の関数。全員のアップロード到達・タイムアウト・
  // 収集中の切断のいずれからも呼ばれる。async だが決して reject しない（全体 try/catch）。
  // 入口でスナップショットを取り、evaluationSeq で await 中の reset/delete による stale emit を防ぐ。
  async function finalizeEvaluation(io: IO, room: Room): Promise<void> {
    if (!room.collectingAudio) return // 入口の冪等ガード（同期）
    room.collectingAudio = false
    if (room.uploadTimer) {
      clearTimeout(room.uploadTimer)
      room.uploadTimer = null
    }
    const myEval = ++room.evaluationSeq
    const code = room.code
    // 切断中（猶予スロット保持）のプレイヤーは音声を出せないので在室扱いにしない。
    // ＝採点対象から外し leftPlayers に入れる（無音を実APIで採点しに行かない）。
    // 猶予内に録音画面へ復帰した本人は接続中なので performers に残る＝空発話で最低点。
    const active = activeDevices(room)
    const present = activePlayerNames(room)
    const leftPlayers = room.recordingRoster.filter(n => !present.includes(n))
    const performers = room.recordingRoster.filter(n => present.includes(n))
    const script = room.script
    // 音声ソース＝接続中の端末。その端末に乗っていて、かつ今回の採点対象の人だけを載せる。
    const sources: AudioSource[] = active
      .map(d => ({
        players: namesOf(room, d).filter(n => performers.includes(n)),
        audio: room.audio.get(d.id) ?? null,
      }))
      .filter(s => s.players.length > 0)
    try {
      // 簡易モードのゲームは実APIを一切呼ばない（課金しない）。
      // 分岐を evaluate.ts ではなくここに置くのは、ai.evaluate の
      // シグネチャを変えずに済み既存テストへの影響が無いため。
      const scores = room.aiMode
        ? await ai.evaluate(script, performers, sources)
        : generateStubScores(performers)
      if (rooms.get(code) !== room || room.evaluationSeq !== myEval) return // 解散/リセット/再ゲームで無効化
      room.scores = scores
      touch(room)
      io.to(code).emit('evaluation_complete', { scores, leftPlayers })
      startMixdown(io, room) // 採点を出し切ってから合成を始める
    } catch (err) {
      console.error('[server] evaluation failed:', err)
      if (rooms.get(code) !== room || room.evaluationSeq !== myEval) return
      resetRoom(room) // status→waiting・genre 保持・audio/scores クリア（evaluationSeq も ++）
      touch(room)
      io.to(code).emit('evaluation_failed', {
        room: toSnapshot(room, quota),
        message: '採点に失敗しました。もう一度お試しください',
      })
    }
  }

  // 非ホスト端末をルームから外し、退出を全員へ通知して収集/復帰のデッドロックを解消する。
  // leave_room（即時）と猶予満了の両方から呼ぶ唯一の経路。
  function removeDeviceAndNotify(io: IO, room: Room, deviceId: string): void {
    const removed = removeDevice(room, deviceId)
    if (removed.length === 0) return
    for (const player of removed) {
      io.to(room.code).emit('player_left', { playerName: player.name })
    }
    if (room.devices.size === 0) {
      rooms.delete(room.code)
      return
    }
    touch(room)
    // 収集中に待っている相手が抜けたら、残りだけで確定させる（デッドロック回避）
    if (room.collectingAudio && room.uploadExpected.size === 0) {
      void finalizeEvaluation(io, room)
    }
    if (room.status === 'evaluating' && allReturned(room)) {
      resetRoom(room)
      io.to(room.code).emit('room_reset', { room: toSnapshot(room, quota) })
    }
  }

  // 録音を終了し音声収集ウィンドウを開く。ホストの stop_recording と
  // 録音時間上限のタイマーの両方から呼ばれる唯一の経路。
  function beginAudioCollection(io: IO, room: Room): void {
    if (room.status !== 'recording') return // 二重終了・満了時の空振りを封じる
    const code = room.code
    if (room.recordingTimer) {
      clearTimeout(room.recordingTimer)
      room.recordingTimer = null
    }
    room.recordingDurationMs = Math.max(0, Date.now() - room.recordingStartedAt)
    room.status = 'evaluating'
    room.audio.clear()
    room.collectingAudio = true
    // 切断中の端末は録音していない＝待っても永久に来ないので期待に入れない
    room.uploadExpected = new Set(activeDevices(room).map(d => d.id))
    touch(room)
    // recording_stopped が「録音を確定してアップロードせよ」の合図を兼ねる
    io.to(code).emit('recording_stopped')
    const timer = setTimeout(() => {
      if (rooms.get(code) !== room) return // 解散後の発火は無視
      void finalizeEvaluation(io, room)
    }, limits.uploadTimeoutMs)
    timer.unref()
    room.uploadTimer = timer
    if (room.uploadExpected.size === 0) void finalizeEvaluation(io, room)
  }

  // 1つの接続が入れる部屋は1つまで。接続待ちの間に連打された create_room / join_room は
  // socket.io のクライアントが溜めて、繋がった瞬間にまとめて届く。2回目以降を黙って捨てる
  // （エラーを返すと、成功してロビーにいる人に失敗のトーストが出てしまう）。
  // 退出・キック・解散では socketIndex から外れるので、正規の作り直し・入り直しは妨げない。
  // レート制限より前に置き、重複分で作成枠を消費させない。
  function alreadyInRoom(socket: Sock): boolean {
    return rooms.findBySocket(socket.id) !== undefined
  }

  function registerHandlers(io: IO, socket: Sock): void {
    socket.on('create_room', ({ playerName }) => {
      if (alreadyInRoom(socket)) return
      if (!publicEnabled()) {
        socket.emit('error', { message: 'ただいま新規ルームの作成を停止しています' })
        return
      }
      const ip = socketIp(socket)
      if (!roomCreateLimiter.allow(ip, Date.now())) {
        // 生の x-forwarded-for も並べて出す。Railway が実際に何段プロキシを挟むかは
        // 本番でしか分からず、extractIp が末尾（＝最終ホップが観測した値）を採る前提が
        // 正しいかは未検証。導出キーと生の値を見比べれば、ホップ数の想定をここで確認できる。
        const rawForwardedFor = socket.handshake.headers['x-forwarded-for']
        console.log(
          `[server] rate limited: create_room ip=${ip} x-forwarded-for=${JSON.stringify(rawForwardedFor ?? null)}`,
        )
        socket.emit('error', { message: 'ルームを作りすぎです。少し待ってからお試しください' })
        return
      }
      const name = sanitizeName(playerName ?? '')
      if (!isValidName(name)) {
        socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
        return
      }
      const room = rooms.create(socket.id, name)
      socket.join(room.code)
      const device = deviceBySocket(room, socket.id)!
      socket.emit('room_created', {
        roomCode: room.code, room: toSnapshot(room, quota), token: device.token, deviceId: device.id,
      })
    })

    socket.on('join_room', ({ roomCode, playerName }) => {
      if (alreadyInRoom(socket)) return
      const code = normalizeRoomCode(roomCode ?? '')
      if (!isValidRoomCode(code)) {
        socket.emit('error', { message: 'ルームが見つかりません' })
        return
      }
      const room = rooms.get(code)
      if (!room) {
        socket.emit('error', { message: 'ルームが見つかりません' })
        return
      }
      // 'waiting'（通常のロビー）に加え 'evaluating'（前ゲームの結果を見ている人がいる復帰待ち）も参加可。
      // ホストがロビーで待っている間に後から入れるようにするため。
      // casting/preparing/recording はゲーム進行中なので従来どおり拒否。
      if (room.status !== 'waiting' && room.status !== 'evaluating') {
        socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
        return
      }
      if (room.generatingScript) {
        socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
        return
      }
      if (room.collectingAudio) {
        socket.emit('error', { message: 'ゲーム進行中のため参加できません' })
        return
      }
      if (room.players.size >= MAX_PLAYERS) {
        socket.emit('error', { message: '満員です' })
        return
      }
      const name = sanitizeName(playerName ?? '')
      if (!isValidName(name)) {
        socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
        return
      }
      if (hasPlayerName(room, name)) {
        socket.emit('error', { message: 'その名前は使われています' })
        return
      }
      const device = addDevice(room, socket.id, name, false)
      const player = room.players.get(device.playerIds[0]!)!
      // 復帰待ち中に参加した人は結果を見ていない＝すでにロビーにいる扱い。
      // returned に入れないと allReturned が永久に false になり room_reset が発火せず、
      // ホストが二度と開始できなくなる（デッドロック）。
      if (room.status === 'evaluating') room.returned.add(device.id)
      touch(room)
      socket.join(room.code)
      socket.emit('room_joined', {
        room: toSnapshot(room, quota), token: device.token, deviceId: device.id,
      })
      socket.to(room.code).emit('player_joined', { player: toPlayerSnapshot(room, player) })
    })

    // この端末にもう1人乗せる（携帯回し・混在の入口）。
    // ガードは join_room と揃える：新しい人が部屋に増えるという点で同じ操作だから。
    socket.on('add_local_player', ({ playerName }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      if (room.status !== 'waiting' && room.status !== 'evaluating') {
        socket.emit('error', { message: 'ゲーム進行中は追加できません' })
        return
      }
      if (room.generatingScript || room.collectingAudio) {
        socket.emit('error', { message: 'ゲーム進行中は追加できません' })
        return
      }
      if (room.players.size >= MAX_PLAYERS) {
        socket.emit('error', { message: '満員です' })
        return
      }
      const name = sanitizeName(playerName ?? '')
      if (!isValidName(name)) {
        socket.emit('error', { message: `名前は1〜${NAME_MAX}文字で入力してください` })
        return
      }
      if (hasPlayerName(room, name)) {
        socket.emit('error', { message: 'その名前は使われています' })
        return
      }
      const player = addPlayerToDevice(room, device, name)
      touch(room)
      // 自分にも配る（自端末の一覧にも即座に出す）。join_room と違い
      // 追加した本人が「増えた」ことを知る必要があるため socket.to ではなく io.to。
      io.to(room.code).emit('player_joined', { player: toPlayerSnapshot(room, player) })
    })

    // この端末から1人降ろす。代表プレイヤー（playerIds[0]）は対象外＝
    // 端末ごと抜けるのは leave_room の仕事。
    socket.on('remove_local_player', ({ playerId }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      if (room.status !== 'waiting' && room.status !== 'evaluating') return
      if (room.generatingScript || room.collectingAudio) return
      const player = room.players.get(playerId)
      if (!player || player.deviceId !== device.id) return // 他端末の人は消せない
      if (device.playerIds[0] === playerId) return          // 代表は消せない
      const removed = removePlayerFromDevice(room, playerId)
      if (!removed) return
      touch(room)
      io.to(room.code).emit('player_left', { playerName: removed.name })
    })

    socket.on('set_genre', ({ genre }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (!isValidGenre(genre)) {
        socket.emit('error', { message: '無効なジャンルです' })
        return
      }
      room.genre = genre
      touch(room)
      io.to(room.code).emit('genre_changed', { genre })
    })

    // 声の配信の ON/OFF。ジャンルと同じく「ホストが部屋全体で決める」設定なので、
    // ガードも set_genre に揃える（ホストのみ・waiting のみ）。
    socket.on('set_live_audio', ({ enabled }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (room.status !== 'waiting') return
      room.liveAudio = !!enabled
      touch(room)
      io.to(room.code).emit('live_audio_changed', { enabled: room.liveAudio })
    })

    // 時刻同期。サーバーは状態を持たず、受け取った clientSent をエコーして
    // 自分の現在時刻を添えるだけ。クライアントが RTT と offset を計算する。
    socket.on('time_ping', ({ clientSent }) => {
      if (typeof clientSent !== 'number' || !Number.isFinite(clientSent)) return
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      // 数えるために Device が要る＝入室前の接続からは受けない。
      if (device.timeSyncCount >= limits.timeSyncMaxPerGame) return
      device.timeSyncCount++
      socket.emit('time_pong', { clientSent, serverNow: Date.now() })
    })

    // WebRTC のシグナリング中継。サーバーは SDP も ICE も理解せず、
    // 宛先を検証して素通しするだけ（ブラウザの実装が変わってもここは変わらない）。
    socket.on('rtc_signal', ({ toDeviceId, data }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return rtcLog('no-room', { socketId: socket.id })
      if (!room.liveAudio) return rtcLog('live-audio-off', { room: room.code })
      // 準備フェーズ中のサーバー状態は 'casting' のまま（'preparing' は
      // RoomStatus に宣言はあるが一度も代入されない）。ここに 'preparing' を
      // 足しても意味は無く、逆に 'casting' を外すと接続が一切張れなくなる。
      if (room.status !== 'casting' && room.status !== 'recording') {
        return rtcLog('bad-status', { room: room.code, status: room.status })
      }
      const from = deviceBySocket(room, socket.id)
      if (!from) return rtcLog('no-device', { room: room.code, socketId: socket.id })
      if (from.signalCount >= limits.rtcSignalMaxPerGame) {
        // 大量に飛ぶ経路なのでエラーは返さない（返すと今度はエラーが溢れる）。
        // 正常なプレイでは到達しない値なので、到達したこと自体をログに残す。
        if (from.signalCount === limits.rtcSignalMaxPerGame) {
          console.log(`[server] rtc_signal rate limited: room=${room.code} device=${from.id}`)
          from.signalCount++ // ログを1回だけにするため進めておく
        }
        return
      }
      const target = typeof toDeviceId === 'string' ? room.devices.get(toDeviceId) : undefined
      // 別部屋・不在・切断中は黙って捨てる（送信側にエラーは返さない）
      if (!target) return rtcLog('no-target', { room: room.code, to: String(toDeviceId) })
      if (target.disconnectedAt != null) {
        return rtcLog('target-disconnected', { room: room.code, to: target.id })
      }
      from.signalCount++
      touch(room)
      // fromDeviceId はサーバーが解決した値を使う（クライアントの自己申告は信じない）
      io.to(target.socketId).emit('rtc_signal', { fromDeviceId: from.id, data })
      rtcLog('relayed', { room: room.code, from: from.id, to: target.id, n: from.signalCount })
    })

    socket.on('start_game', async () => {
      // status ガード: 各自が個別にロビーへ戻る仕様のため、まだ結果を見ている人がいる間
      // （status='evaluating'）にホストが開始できてはいけない。全員復帰の room_reset で
      // 'waiting' に戻ってはじめて開始可能になる。
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id) || room.status !== 'waiting') return
      if (room.generatingScript) return
      if (!isValidGenre(room.genre)) {
        socket.emit('error', { message: 'ジャンルを選んでください' })
        return
      }
      // MIN_PLAYERS は現在1なので、ここに到達するのは players.size === 0 のときだけ。
      // 将来 MIN_PLAYERS を上げたときにガードとして効くよう残しておくが、
      // 文言は「1人以上で開始できます」という無意味な表現にしない。
      if (room.players.size < MIN_PLAYERS) {
        socket.emit('error', { message: 'プレイヤーがいません' })
        return
      }
      const code = room.code
      const names = playerNames(room) // 参加順。roomStore が唯一の定義
      // ロビーで ON にしたあとに人が増えて上限を超えることがある。クライアントの
      // 表示だけに頼らず、開始の瞬間にサーバー側で落とす（mesh の接続数を守る唯一の砦）。
      if (room.liveAudio && room.devices.size > MAX_LIVE_AUDIO_DEVICES) {
        room.liveAudio = false
        io.to(code).emit('live_audio_changed', { enabled: false })
      }
      // 課金の判定はここ1箇所だけ。以降このゲームは aiMode で一貫させる。
      // AI_ENABLED=false のときは短絡して枠を消費しない（AIを呼ばないので当然）。
      room.aiMode = aiEnabled() && quota.tryConsumeGame(new Date())
      // 公開後の唯一の可観測点。Anthropic のコンソールを開かずに
      // 「今日の枠をいくつ使ったか」「その回が実AIだったか」をログだけで追えるようにする。
      // 注意: generateScript が失敗しても枠は戻らない（課金済みの応答をパースできなかった
      // ケースと区別できないため）。だから返金ではなくログで見えるようにしている。
      const quotaState = quota.getState(new Date())
      console.log(
        `[server] start_game room=${code} aiMode=${room.aiMode} quota=${quotaState.used}/${quotaState.limit}`,
      )
      room.generatingScript = true
      touch(room)
      io.to(code).emit('script_generating')
      try {
        let script: ScriptData
        try {
          script = room.aiMode
            ? await ai.generateScript(room.genre, names)
            : plays.generate(room.genre, names)
        } catch (err) {
          // 実AI呼び出しの失敗（APIエラー・支払上限・不正応答）。ここでロビーへ戻すと
          // 月額上限に当たった月は「開始しても必ず失敗する」状態になってしまうので、
          // 枠切れと同じ手書き台本へ降格して最後まで通す。
          console.error('[server] script generation failed, falling back to library:', err)
          script = plays.generate(room.genre, names)
          // 台本がAIでない以上、この回は採点も実APIを呼ばない
          // （finalizeEvaluation が room.aiMode を見てスタブ採点に分岐する）。
          room.aiMode = false
        }
        if (rooms.get(code) !== room) return // 生成中にホスト切断→解散したケース
        room.generatingScript = false
        room.script = script
        room.status = 'casting'
        touch(room)
        io.to(code).emit('script_ready', { script, aiMode: room.aiMode })
      } catch {
        if (rooms.get(code) !== room) return
        room.generatingScript = false
        io.to(code).emit('script_failed', {
          message: '台本の生成に失敗しました。もう一度お試しください',
        })
      }
    })

    socket.on('set_ready', ({ isReady }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = setReady(room, socket.id, !!isReady)
      if (!device) return
      touch(room)
      // 端末に乗っている人数分流す。クライアントの readyMap は名前キーなので、
      // 1件だけだと3人乗った端末の残り2人が「未準備」のまま見える。
      const ready = allReady(room)
      for (const playerName of namesOf(room, device)) {
        io.to(room.code).emit('ready_updated', { playerName, isReady: device.isReady, allReady: ready })
      }
    })

    socket.on('start_recording', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (room.status !== 'casting') return
      const code = room.code
      room.status = 'recording'
      room.recordingStartedAt = Date.now()
      room.recordingDurationMs = 0
      room.audioTimeline = []
      // 録音開始の時点で既に鳴っている BGM があれば、0 秒地点から始まる区間として置く
      if (room.bgm) room.audioTimeline.push({ atMs: 0, kind: 'bgm', id: room.bgm })
      room.recordingRoster = playerNames(room)
      touch(room)
      io.to(code).emit('recording_started')
      // 台本想定時間＋1分で自動終了（ホストが押し忘れても録音が終わる）
      const timer = setTimeout(() => {
        if (rooms.get(code) !== room) return
        beginAudioCollection(io, room)
      }, limits.recordingLimitMs)
      timer.unref()
      room.recordingTimer = timer
    })

    socket.on('send_reaction', ({ emoji }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'recording') return
      if (!isValidEmoji(emoji)) return
      const device = deviceBySocket(room, socket.id)
      const playerName = device && representativeName(room, device)
      if (!playerName) return
      socket.to(room.code).emit('reaction_received', { emoji, playerName })
    })

    socket.on('send_sfx', ({ sfxId }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'recording') return
      if (!isValidSfxId(sfxId)) return
      const device = deviceBySocket(room, socket.id)
      const playerName = device && representativeName(room, device)
      if (!playerName) return
      socket.to(room.code).emit('sfx_played', { sfxId, playerName })
      recordTimeline(room, 'sfx', sfxId)
    })

    socket.on('send_bgm', ({ bgmId }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'recording') return
      if (!isValidBgmId(bgmId)) return
      const device = deviceBySocket(room, socket.id)
      const playerName = device && representativeName(room, device)
      if (!playerName) return
      room.bgm = bgmId
      touch(room)
      io.to(room.code).emit('bgm_changed', { bgmId, playerName })
      recordTimeline(room, 'bgm', bgmId)
    })

    socket.on('send_volume', ({ level }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'recording') return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      const now = Date.now()
      room.volumes.set(device.id, { level, ts: now })
      if (now - room.lastVolumeBroadcast < VOLUME_BROADCAST_MS) return
      room.lastVolumeBroadcast = now
      const combined = combineFreshVolumes(room.volumes.values(), now)
      io.to(room.code).emit('volume_update', { level: combined })
    })

    socket.on('stop_recording', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id) || room.status !== 'recording') return
      beginAudioCollection(io, room)
    })

    socket.on('return_to_lobby', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || room.status !== 'evaluating') return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      room.returned.add(device.id)
      touch(room)
      // 端末単位で処理するが通知は人数分（クライアントの「n/m 人」表示を嘘にしない）
      for (const playerName of namesOf(room, device)) {
        io.to(room.code).emit('player_returned', { playerName })
      }
      if (allReturned(room)) {
        resetRoom(room)
        io.to(room.code).emit('room_reset', { room: toSnapshot(room, quota) })
      }
    })

    // 事故切断/リロードからの本人再接続。socketId は変わるのでトークンで同定して付け替える。
    // 猶予満了で削除済み・ホスト切断で解散済みならトークンは引けない＝rejoin_failed。
    socket.on('rejoin', ({ token }) => {
      const found = rooms.findByToken(token ?? '')
      if (!found) {
        socket.emit('rejoin_failed', { message: 'ルームに戻れませんでした' })
        return
      }
      const { room, device } = found
      const selfPlayerNames = namesOf(room, device)
      if (device.socketId === socket.id) {
        // 同一ソケットからの再送。張り替えると自分の returned/audio/uploadExpected を
        // 消しかねないので reattachDevice は呼ばず、現状のスナップショットだけ返す。
        socket.emit('rejoined', {
          room: toSnapshot(room, quota), status: room.status, deviceId: device.id, selfPlayerNames,
        })
        return
      }
      const otherRoom = rooms.findBySocket(socket.id)
      if (otherRoom && otherRoom !== room) return // 既に別ルームに所属＝二重登録になるので無視
      const wasDisconnected = device.disconnectedAt != null // reattachDevice が null に戻す前に控える
      reattachDevice(room, device, socket.id) // socketIndex を張り替え・disconnectedAt=null・猶予解除
      // 復帰した端末はこのテイクを録っていない＝収集ゲートを永久に満たせないので期待から外す。
      // disconnect ハンドラの同じ delete に任せてはいけない：新ソケットの rejoin が先に処理されると
      // 上の reattachDevice が socketIndex から旧 socketId を消すため、後から届く旧ソケットの
      // disconnect は findBySocket で部屋を引けず早期 return する（＝誰もゲートを解放しない）。
      room.uploadExpected.delete(device.id)
      touch(room)
      socket.join(room.code)
      socket.emit('rejoined', {
        room: toSnapshot(room, quota), status: room.status, deviceId: device.id, selfPlayerNames,
      })
      // 実際に切断扱いになっていた場合だけ「復帰しました」を流す
      // （ping タイムアウトより先にリロードが割り込んだだけなら他人には無音のまま）
      if (wasDisconnected) {
        for (const playerName of selfPlayerNames) {
          socket.to(room.code).emit('player_reconnected', { playerName })
        }
      }
      // 待っていた最後の1台だったならその場で確定させる（uploadTimeoutMs まで採点を止めない）。
      // rejoined を送り終えてから呼ぶ＝復帰した本人が evaluation_complete を先に受け取らない。
      if (room.collectingAudio && room.uploadExpected.size === 0) {
        void finalizeEvaluation(io, room)
      }
    })

    // 意図的な退出。事故切断（disconnect）と違い猶予を与えず即削除する。
    socket.on('leave_room', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return
      if (device.isHost) {
        socket.to(room.code).emit('room_dissolved')
        rooms.delete(room.code)
        return
      }
      socket.leave(room.code) // 自分の退出通知を自分で受けない
      removeDeviceAndNotify(io, room, device.id)
    })

    // ロビーで「もう戻ってこない端末」をホストが今すぐ外す。中の全員が抜ける。
    // 猶予満了と同じ経路（removeDeviceAndNotify）を通すので、退出時のガードは共通。
    socket.on('kick_device', ({ deviceId }) => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      // ロビー画面が出ている間だけ（waiting=待機／evaluating=前ゲームの結果待ち）
      if (room.status !== 'waiting' && room.status !== 'evaluating') return
      const target = room.devices.get(deviceId)
      if (!target || target.isHost) return
      // 接続中は対象外。復帰済みならホストの画面が古いだけなので黙って無視する。
      if (target.disconnectedAt == null) return
      removeDeviceAndNotify(io, room, target.id)
    })

    socket.on('abort_game', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room || !isHostSocket(room, socket.id)) return
      if (room.status !== 'casting' && room.status !== 'recording') return // 対象外は無視
      resetRoom(room) // status→waiting・script/audio/scores/timers クリア・genre 保持・evaluationSeq++
      touch(room)
      io.to(room.code).emit('game_aborted', { room: toSnapshot(room, quota) })
    })

    socket.on('disconnect', () => {
      const room = rooms.findBySocket(socket.id)
      if (!room) return
      const device = deviceBySocket(room, socket.id)
      if (!device) return // leave_room 済み（意図的退出）はここに来ない
      if (device.isHost) {
        // ホストは対象外＝従来どおり即解散（ホスト移譲は B6）
        socket.to(room.code).emit('room_dissolved')
        rooms.delete(room.code)
        return
      }
      // 非ホスト端末の事故切断 → スロットを猶予つきで保持し、ゲームは止めない
      device.disconnectedAt = Date.now()
      for (const playerName of namesOf(room, device)) {
        socket.to(room.code).emit('player_disconnected', { playerName })
      }
      // 切断者は録音を送れない＝期待から外す。rejoin が先に処理された場合はここに来ないので、
      // rejoin ハンドラ側でも同じ delete をしている（対になっている）。
      room.uploadExpected.delete(device.id)
      touch(room)
      if (room.collectingAudio && room.uploadExpected.size === 0) {
        void finalizeEvaluation(io, room)
      }
      // 切断中は allReturned の判定から外れるので、残り全員が復帰済みならここでリセット
      if (room.status === 'evaluating' && allReturned(room)) {
        resetRoom(room)
        io.to(room.code).emit('room_reset', { room: toSnapshot(room, quota) })
      }
      const code = room.code
      const deviceId = device.id
      const timer = setTimeout(() => {
        if (rooms.get(code) !== room) return // 解散済み
        const d = room.devices.get(deviceId)
        if (!d || d.disconnectedAt == null) return // 復帰済み or 既に削除済み
        removeDeviceAndNotify(io, room, deviceId)
      }, limits.graceMs)
      timer.unref()
      room.graceTimers.set(deviceId, timer)
    })
  }

  return { registerHandlers, finalizeEvaluation, beginAudioCollection }
}
