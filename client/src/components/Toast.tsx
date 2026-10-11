import { useEffect } from 'react'

export interface ToastMessage {
  id: number
  text: string
  tone?: 'error' | 'info'
}

interface ItemProps {
  toast: ToastMessage
  onDismiss: (id: number) => void
}

function ToastItem({ toast, onDismiss }: ItemProps) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(toast.id), 4000)
    return () => clearTimeout(t)
  }, [toast.id, onDismiss])

  const tone = toast.tone ?? 'info'
  return (
    <div
      className={`px-4 py-3 border text-sm font-medium ${
        tone === 'error'
          ? 'bg-kinari border-shu text-shu'
          : 'bg-kinari border-sumi text-sumi'
      }`}
      onClick={() => onDismiss(toast.id)}
    >
      {toast.text}
    </div>
  )
}

interface StackProps {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}

export default function ToastStack({ toasts, onDismiss }: StackProps) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 space-y-2 w-full max-w-sm px-4">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
