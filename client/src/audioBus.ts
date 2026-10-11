import { BGM_IDS, SFX_IDS } from '@shared/constants'

// BGM/SE の再生と「録音用ミックス出力」を、アプリ唯一の AudioContext で受け持つ。
// DOM 非依存（xShare.ts と同じ方針）。
//
// 配線:
//   BGM/SE --> master --> ctx.destination（スピーカー）
//                    \--> mixDest（鑑賞用トラックの録音先）
//   マイク --------------> mixDest のみ
// マイクを master/スピーカー側へ繋ぐとハウリングするので、絶対に繋がない。

let ctx: AudioContext | null = null
let master: GainNode | null = null
let mixDest: MediaStreamAudioDestinationNode | null = null
let micNode: MediaStreamAudioSourceNode | null = null

const buffers = new Map<string, AudioBuffer>() // key: `${kind}/${id}`
let bgmSource: AudioBufferSourceNode | null = null
let bgmGain: GainNode | null = null
let desiredBgmId: string | null = null // 鳴らしたいBGM（共有状態そのまま）
let currentBgmId: string | null = null // 実際に鳴っているBGM。未デコードで開始できなければ null のまま
let preloaded = false

const FADE_SEC = 0.1 // BGM 切替のプツ切れ防止

// AudioContext は遅延生成する。非セキュアオリジンや未対応環境では作れないので、
// その場合は null を返して「音なしで動く」に倒す。
function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  // Chrome のコンテキスト上限超過や旧 iOS Safari では生成自体が例外を投げうる。
  // 準備完了ボタンの onClick から呼ばれるため、ここで拾わないと操作不能になる。
  let created: AudioContext
  try {
    created = new Ctor()
  } catch (err) {
    console.warn('[audioBus] AudioContext を生成できませんでした（無音で継続します）', err)
    return null
  }
  ctx = created
  master = ctx.createGain()
  mixDest = ctx.createMediaStreamDestination()
  master.connect(ctx.destination)
  master.connect(mixDest)
  return ctx
}

// 自動再生ポリシー対策。ユーザー操作起点（準備完了ボタン）と、
// 再生の直前（保険）の両方から呼ぶ。
export function resumeAudio(): void {
  const c = getCtx()
  if (c && c.state === 'suspended') void c.resume()
}

function srcPath(kind: 'bgm' | 'sfx', id: string): string {
  return `${import.meta.env.BASE_URL}audio/${kind}/${id}.mp3`
}

// 音源を先読みしてデコードする。欠損・デコード失敗はその音だけ無音として握り潰す
// （音源未配置でもゲームは最後まで通常どおり動く）。冪等。
export function preloadAudio(): void {
  if (preloaded) return
  preloaded = true
  const c = getCtx()
  if (!c) return
  const load = (kind: 'bgm' | 'sfx', id: string) => {
    fetch(srcPath(kind, id))
      .then(res => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(buf => c.decodeAudioData(buf))
      .then(decoded => {
        buffers.set(`${kind}/${id}`, decoded)
        // デコード待ちの間に選ばれていたBGMなら、ここで改めて再生を試みる
        // （playBgm は未ロード時に何もせず戻るだけなので、他に再試行の起点がない）
        if (kind === 'bgm') startDesiredBgmIfReady()
      })
      .catch(err => {
        console.warn(`[audioBus] ${kind}/${id} を読み込めませんでした（無音で継続します）`, err)
      })
  }
  for (const id of BGM_IDS) load('bgm', id)
  for (const id of SFX_IDS) load('sfx', id)
}

function stopBgm(): void {
  const c = ctx
  const src = bgmSource
  const gain = bgmGain
  bgmSource = null
  bgmGain = null
  if (!c || !src || !gain) return
  // フェードアウトしてから停止（プツ切れ防止）
  gain.gain.cancelScheduledValues(c.currentTime)
  gain.gain.setValueAtTime(gain.gain.value, c.currentTime)
  gain.gain.linearRampToValueAtTime(0, c.currentTime + FADE_SEC)
  src.stop(c.currentTime + FADE_SEC)
}

// desiredBgmId に対応するバッファが揃っていれば再生を開始する。
// 未ロードならまだ開始しない（preloadAudio 側でデコードが終わった時点で再試行される）。
// 既に何か鳴っている場合も何もしない（呼び出し元が必要なら先に stopBgm 済みのはず）。
function startDesiredBgmIfReady(): void {
  const c = ctx
  if (!c || !master || !desiredBgmId || currentBgmId !== null) return
  const buf = buffers.get(`bgm/${desiredBgmId}`)
  if (!buf) return // 未ロード＝無音のまま待つ
  const gain = c.createGain()
  gain.gain.setValueAtTime(0, c.currentTime)
  gain.gain.linearRampToValueAtTime(1, c.currentTime + FADE_SEC)
  const src = c.createBufferSource()
  src.buffer = buf
  src.loop = true
  src.connect(gain)
  gain.connect(master)
  src.start()
  bgmSource = src
  bgmGain = gain
  currentBgmId = desiredBgmId
}

// 共有BGM状態に追従する。同じIDの再指定は無視（useEffect の再実行で鳴り直さない）。
// 「鳴らしたいBGM」(desiredBgmId) と「実際に鳴っているBGM」(currentBgmId) を分けて持つ。
// デコード未完了で開始できなかった場合は currentBgmId を null のままにしておき、
// preloadAudio 側のデコード完了時に startDesiredBgmIfReady が拾えるようにする。
// これが無いと、低速回線でデコードが録音開始に間に合わなかったプレイヤーは
// そのラウンド中ずっと無音のままになる（再試行の起点が無いため）。
export function playBgm(id: string | null): void {
  const c = getCtx()
  if (!c) return
  resumeAudio()
  if (id === desiredBgmId) return
  desiredBgmId = id
  stopBgm()
  currentBgmId = null
  startDesiredBgmIfReady()
}

// ワンショット。重ねて鳴ってよい。
export function playSfx(id: string): void {
  const c = getCtx()
  if (!c || !master) return
  resumeAudio()
  const buf = buffers.get(`sfx/${id}`)
  if (!buf) return // 未ロード＝無音
  const src = c.createBufferSource()
  src.buffer = buf
  src.connect(master)
  src.start()
}

export function stopAll(): void {
  stopBgm()
  desiredBgmId = null
  currentBgmId = null
}

// 鑑賞用トラックの録音先（Task 2 の recorder が使う）
export function getMixDestination(): MediaStreamAudioDestinationNode | null {
  getCtx()
  return mixDest
}

// マイクは録音用ミックスにだけ繋ぐ。スピーカー側へ繋ぐとハウリングする。
export function connectMic(stream: MediaStream): void {
  const c = getCtx()
  if (!c || !mixDest) return
  disconnectMic()
  micNode = c.createMediaStreamSource(stream)
  micNode.connect(mixDest)
}

export function disconnectMic(): void {
  micNode?.disconnect()
  micNode = null
}

// リモート音声（他端末の声）。マイクと同じく mixDest にだけ繋ぐ。
// スピーカー側へは繋がない：再生は liveAudio.ts の <audio> 要素が担当しており、
// ここで ctx.destination にも繋ぐと二重に鳴る。
// 分けている理由はもう1つある。ブラウザのエコーキャンセラは「スピーカーに出た音」を
// 参照して打ち消すが、Web Audio 経由で鳴らすとその参照から外れることがあり
// AEC が効かなくなる。<audio> 要素は AEC が想定している経路。
const remoteNodes = new Map<string, MediaStreamAudioSourceNode>()

export function connectRemote(deviceId: string, stream: MediaStream): void {
  const c = getCtx()
  if (!c || !mixDest) return
  disconnectRemote(deviceId)
  const node = c.createMediaStreamSource(stream)
  node.connect(mixDest)
  remoteNodes.set(deviceId, node)
}

export function disconnectRemote(deviceId: string): void {
  const node = remoteNodes.get(deviceId)
  if (!node) return
  node.disconnect()
  remoteNodes.delete(deviceId)
}

export function disconnectAllRemote(): void {
  for (const id of [...remoteNodes.keys()]) disconnectRemote(id)
}
