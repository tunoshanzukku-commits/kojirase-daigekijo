interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}

// App の解散ダイアログと同じ見た目の軽量モーダル。破壊的操作の確認に使う。
// z-[70] で解散ダイアログ(z-[60])より前面。
export default function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, onConfirm, onCancel,
}: Props) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70] bg-sumi/60 flex items-center justify-center p-4">
      <div className="washi-panel text-center max-w-xs w-full">
        <p className="font-display font-bold text-sumi mb-2">{title}</p>
        <p className="text-usuzumi text-sm mb-5">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="btn-outline">
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className="btn-shu">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
