// 時刻同期の判断だけを持つ純粋モジュール。socket にも DOM にも依存しない
// （config.ts を辿ると import.meta.env に触れてしまい、tsx --test で読めなくなる）。
// liveAudioPure.ts と同じ切り出し方。

export interface SyncSample {
  rtt: number      // 往復にかかったミリ秒
  offset: number   // サーバー時計 - この端末の時計（ミリ秒）
}

/**
 * 採用する offset を1つ選ぶ。
 *
 * 平均ではなく「RTT が最小のサンプル」を採る。offset の計算は
 * 「往路と復路の遅延が等しい」という仮定に乗っており、キューイングで
 * 片道だけが伸びた回はその仮定が崩れる。RTT が小さい回ほど仮定に近い。
 * NTP が同じ理由で最小 RTT を選ぶ。
 *
 * 有効なサンプルが1つも無ければ 0 を返す＝補正しない（今日の挙動のまま）。
 */
export function pickBestOffset(samples: SyncSample[]): number {
  let best: SyncSample | null = null
  for (const s of samples) {
    if (!Number.isFinite(s.rtt) || !Number.isFinite(s.offset)) continue
    if (s.rtt < 0) continue // 計測中に時計が巻き戻った＝信用しない
    if (best === null || s.rtt < best.rtt) best = s
  }
  return best === null ? 0 : best.offset
}
