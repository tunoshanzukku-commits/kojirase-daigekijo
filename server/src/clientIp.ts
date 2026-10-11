// Railway/Render はプロキシ経由で到達するため、ソケットの接続元アドレスは
// プロキシのものになる。x-forwarded-for は各ホップが「自分から見た直前の相手」の
// アドレスを末尾に追記していく方式なので、信頼できるプロキシが1段だけの構成では
// 末尾の値がそのプロキシ自身が観測したアドレス＝偽装できないもの。
//
// 先頭は逆にクライアントが自由に書き込める値（例: `X-Forwarded-For: 1.2.3.4` を
// 自分で送ると、プロキシが実アドレスを追記して `1.2.3.4, <実アドレス>` になる）。
// 先頭を採ると、このヘッダをローテートするだけで create_room / upload の
// レート制限を丸ごと回避できてしまうため、必ず末尾を採る。
//
// ⚠️ Express の `trust proxy` は Socket.IO には効かない。だから HTTP 側も
// Socket.IO 側もこの関数を通して同じ規則で取り出す。
export function extractIp(forwardedFor: unknown, fallback: string | undefined): string {
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    const parts = forwardedFor.split(',')
    const last = parts[parts.length - 1]?.trim()
    if (last) return last
  }
  return fallback ?? 'unknown'
}
