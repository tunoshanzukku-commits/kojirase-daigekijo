// 環境変数の解釈はここ1箇所に閉じ込める。
// 値は「呼び出しごとに読む」：モジュール読み込み時にキャッシュすると
// テストで process.env を差し替えても効かなくなる。
// 不正値は必ず既定へフォールバックする（設定ミスでサーバーを落とさない）。

function envInt(name: string, fallback: number): number {
  // trim してから判定する。Number('   ') は 0 で整数・非負のチェックを素通りするため、
  // 空白だけの値がサイト全体のAIを黙って止めてしまう（既定へ落ちるべきケース）。
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) return fallback
  return n
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const v = raw.trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

/** 1日にAIを使えるゲーム数。0 なら常に簡易モード。 */
export function dailyGameLimit(): number {
  return envInt('DAILY_GAME_LIMIT', 5)
}

/** false で枠に関係なく全ゲームを簡易モードにするキルスイッチ。 */
export function aiEnabled(): boolean {
  return envBool('AI_ENABLED', true)
}

/** false で新規ルーム作成を拒否するキルスイッチ（進行中のゲームは継続）。 */
export function publicEnabled(): boolean {
  return envBool('PUBLIC_ENABLED', true)
}
