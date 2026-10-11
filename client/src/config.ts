// socket 接続と音声アップロードで同じサーバーを指すための単一定義。
// 本番はサーバーが client/dist を同一オリジンで配信するので、ビルド時にURLを
// 埋め込む必要がない（埋め込み漏れによる「本番だけ動かない」を構造的に防ぐ）。
// VITE_SERVER_URL は将来分離構成に戻す場合の逃げ道として残す。
export const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin)
