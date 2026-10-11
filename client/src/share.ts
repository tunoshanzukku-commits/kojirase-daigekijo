// クライアント生成ファイル（スコアカード画像・録音テイク）の共有。Web Share API（画像を OS の共有シートへ渡す）を優先し、
// 非対応ブラウザや非セキュアコンテキスト（HTTPS/localhost 以外）ではダウンロードに
// フォールバックする。Web Share は getUserMedia と同じくセキュアコンテキスト必須。
export async function shareOrDownload(
  blob: Blob,
  filename: string,
  text: string,
): Promise<void> {
  // blob.type は 'audio/webm;codecs=opus' のように codecs パラメータを含むことがある。
  // File の type にそのまま渡すと Chrome の canShare({files}) が弾き、ダウンロードに
  // フォールバックしてしまうため、';' 以降は落として MIME タイプ本体だけにする。
  const mimeType = blob.type.split(';')[0]
  const file = new File([blob], filename, { type: mimeType || 'application/octet-stream' })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text })
      return
    } catch (err) {
      // ユーザーがキャンセルした場合は AbortError。エラー表示せず終了する。
      if (err instanceof DOMException && err.name === 'AbortError') return
      // それ以外（共有シート起動失敗など）はダウンロードにフォールバックする。
      console.warn('[share] Web Share に失敗しました。ダウンロードにフォールバックします', err)
    }
  }
  downloadBlob(blob, filename)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
