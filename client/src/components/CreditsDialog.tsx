import { useEffect, useRef } from 'react'
import { CREDIT_SECTIONS } from '@shared/credits'
import type { CreditLine } from '@shared/credits'

interface Props {
  open: boolean
  onClose: () => void
}

function Line({ line }: { line: CreditLine }) {
  const link = line.url && (
    <a href={line.url} target="_blank" rel="noopener noreferrer" className="text-shu underline underline-offset-2 break-all">
      {line.url}
    </a>
  )
  return (
    <li>
      {line.label && <span className="text-usuzumi">{line.label}：</span>}
      {line.text}
      {link && (line.text ? <>（{link}）</> : link)}
    </li>
  )
}

// タイトル画面の「クレジット」から開く。文言は shared/credits.ts が唯一の置き場
// （作品 m4a のメタデータと共有）。OtoLogic は CC BY 4.0 なのでこの表記が利用条件。
// 見た目は ConfirmDialog と揃え、背景クリックと Esc でも閉じられる。
export default function CreditsDialog({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[70] bg-sumi/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="credits-title"
        className="washi-panel max-w-sm w-full max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="credits-title" className="font-display text-xl font-bold text-sumi text-center mb-4">
          クレジット
        </h2>
        {CREDIT_SECTIONS.map(section => (
          <section key={section.heading} className="mb-4">
            <h3 className="text-xs font-bold tracking-[0.2em] text-shu border-b border-sumi/20 pb-1 mb-2">
              {section.heading}
            </h3>
            <ul className="space-y-1 text-sm text-sumi">
              {section.lines.map((line, i) => <Line key={i} line={line} />)}
            </ul>
          </section>
        ))}
        <button ref={closeRef} onClick={onClose} className="btn-outline mt-2">
          とじる
        </button>
      </div>
    </div>
  )
}
