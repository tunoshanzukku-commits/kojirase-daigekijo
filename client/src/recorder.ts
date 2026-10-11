import { SERVER_URL } from './config'
import { getMixDestination, connectMic, disconnectMic, resumeAudio } from './audioBus'
import { serverNow } from './timeSync'

// MediaRecorder は画面コンポーネントの外（モジュールスコープ）で持つ。
// recording_stopped で RecordingScreen はアンマウントされるため、
// 画面に持たせると停止前にストリームが切れて blob を取り逃す。
let mediaRecorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let starting = false

// stopAndUpload / 再開始で世代を進め、遅れて解決した getUserMedia を無効化する。
// これが無いと、許可応答が遅れた回のストリームが停止されないまま次の回に居座り、
// 次回の録音開始をブロックしたうえ前の回の音声を送ってしまう。
let generation = 0

// 鑑賞用トラック（マイク＋BGM/SE のミックス）。アップロードせずローカルに保持する。
let mixRecorder: MediaRecorder | null = null
let mixChunks: Blob[] = []
let lastTake: Blob | null = null
// このテイクの収録開始（サーバー時計）。合成時に全端末の頭を揃えるために申告する。
// 同期できていなければ端末の時計そのままで、サーバー側が安全側へ倒す。
let takeStartedAt = 0

// 録音開始。冪等（多重呼び出しは無視）。マイク拒否時は録音なしのまま進み、
// 停止時に skip マーカーを送ってサーバーの待機を解く。
//
// onMicStream: マイクを取得できたときに1回だけ呼ぶ。ライブ音声がこのストリームを
// 借りて WebRTC の送信トラックに差し込む。ここで渡すのは「録音用に取った1本」で、
// ライブ音声のために新たに getUserMedia を呼ばないための口（このアプリは既に
// recorder と音量メーターで2本並行しており、3本目を増やしたくない）。
export function startUploadRecorder(onMicStream?: (stream: MediaStream) => void): void {
  if (mediaRecorder || starting) return
  // このテイクが「最新の録音」の唯一の所有者になる。前回のテイクが室内切断などで
  // 未クリアのまま残っていても、ここで無条件に破棄する（結果画面に前回分を出さないため）。
  lastTake = null
  takeStartedAt = 0
  const myGeneration = ++generation
  starting = true
  chunks = []
  try {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(s => {
        if (myGeneration !== generation) {
          // すでに停止済み/次の回が始まっている：受け取ったストリームは即解放する
          s.getTracks().forEach(t => t.stop())
          return
        }
        starting = false
        stream = s
        const rec = new MediaRecorder(s)
        rec.ondataavailable = e => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        rec.start()
        takeStartedAt = serverNow() // 収録が始まったこの瞬間を控える
        mediaRecorder = rec
        startMixRecorder(s)
        onMicStream?.(s) // ライブ音声へ受け渡す（失敗しても録音は続く）
      })
      .catch(() => {
        if (myGeneration === generation) starting = false // マイク不許可：blob なし扱い
      })
  } catch {
    // 非セキュアオリジンでは navigator.mediaDevices 自体が存在せず同期例外になる。
    // 録音なし扱いにして、停止時に skip マーカーを送る経路へ倒す。
    if (myGeneration === generation) starting = false
  }
}

// 鑑賞用（マイク＋BGM/SE）を別トラックで録る。
// ここで失敗しても採点用トラックには一切影響させない（聞き返しが無くなるだけ）。
function startMixRecorder(micStream: MediaStream): void {
  // ホストに強制開始されたゲストは準備完了ボタンを押していない＝ context が
  // suspended のままのことがある。resume しないと mixDest が数秒間フレームを出さない。
  resumeAudio()
  const dest = getMixDestination()
  if (!dest) return // AudioContext が使えない環境＝鑑賞用は諦める
  try {
    connectMic(micStream) // マイクはミックス出力にだけ繋ぐ（スピーカーへ繋ぐとハウリング）
    mixChunks = []
    const rec = new MediaRecorder(dest.stream)
    rec.ondataavailable = e => {
      if (e.data.size > 0) mixChunks.push(e.data)
    }
    rec.start()
    mixRecorder = rec
  } catch (err) {
    console.warn('[recorder] 鑑賞用トラックを開始できませんでした', err)
    disconnectMic()
  }
}

// keep=true なら停止後の blob を「最後のテイク」として保持する。
// keep=false（解散・退出・切断）は破棄する。
function stopMixRecorder(keep: boolean): void {
  const rec = mixRecorder
  mixRecorder = null
  disconnectMic()
  if (!rec || rec.state === 'inactive') {
    mixChunks = []
    return
  }
  rec.onstop = () => {
    if (keep && mixChunks.length > 0) {
      lastTake = new Blob(mixChunks, { type: rec.mimeType || 'audio/webm' })
    }
    mixChunks = []
  }
  rec.onerror = () => { mixChunks = [] }
  rec.stop()
}

export function getLastTake(): Blob | null {
  return lastTake
}

export function clearLastTake(): void {
  lastTake = null
}

function stopAndGetBlob(): Promise<Blob | null> {
  const rec = mediaRecorder
  mediaRecorder = null
  if (!rec || rec.state === 'inactive') return Promise.resolve(null)
  return new Promise<Blob | null>(resolve => {
    rec.onstop = () => {
      const blob = chunks.length > 0 ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null
      chunks = []
      resolve(blob)
    }
    // MediaRecorder が error を発火して stop が来ない場合に備え、null で解決して
    // 呼び出し元を skip マーカー送信へ倒す（アップロードが永久に止まるのを防ぐ）。
    rec.onerror = () => {
      chunks = []
      resolve(null)
    }
    rec.stop()
  })
}

function releaseStream(): void {
  stream?.getTracks().forEach(t => t.stop())
  stream = null
}

// 録音を確定してサーバーへ送る。失敗しても UI は壊さない
// （サーバー側の収集タイムアウトで評価は必ず進む）。
export async function stopAndUpload(socketId: string): Promise<void> {
  generation++ // 進行中の getUserMedia を無効化する
  // 鑑賞用トラックの停止は採点用アップロードから完全に切り離す。万一ここで例外が
  // 出ても skip マーカー送信・releaseStream() を止めてマイクを握ったままにはしない。
  try {
    stopMixRecorder(true) // 鑑賞用は残す
  } catch (err) {
    console.warn('[recorder] 鑑賞用トラックの停止に失敗しました（採点には影響しません）', err)
  }
  starting = false
  let blob: Blob | null = null
  try {
    blob = await stopAndGetBlob()
  } catch {
    blob = null
  }
  releaseStream()

  const form = new FormData()
  form.append('socketId', socketId)
  // startedAt は audio より前に積む（multer はフィールドを到着順にパースするため、
  // 25MB 超過で弾かれたときも socketId と一緒に読めている可能性が上がる）。
  if (takeStartedAt > 0) form.append('startedAt', String(takeStartedAt))
  if (blob) form.append('audio', blob, 'take.webm')
  else form.append('skip', '1')

  try {
    await fetch(`${SERVER_URL}/upload`, { method: 'POST', body: form })
  } catch (e) {
    console.warn('[recorder] アップロードに失敗しました', e)
  }
}

// 録音をアップロードせずに破棄する（ルーム解散・退出・切断時）。
// stopAndUpload と違い skip も送らない：その部屋の収集ゲートはもう存在しないため、
// 送る先がない。マイクを確実に解放し、次の回が新しく録音を開始できる状態に戻す。
export function cancelRecording(): void {
  generation++ // 進行中の getUserMedia を無効化する
  stopMixRecorder(false) // 解散・退出・切断：鑑賞用は破棄
  starting = false
  const rec = mediaRecorder
  mediaRecorder = null
  chunks = []
  takeStartedAt = 0
  if (rec && rec.state !== 'inactive') {
    rec.onstop = null
    rec.onerror = null
    rec.stop()
  }
  releaseStream()
}
