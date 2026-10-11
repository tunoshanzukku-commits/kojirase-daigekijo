import { useEffect, useState } from 'react'
import type { GameContext, NavigateFn } from '../App'

interface Props {
  ctx: GameContext
  onNavigate: NavigateFn
}

const STEPS = [
  '音声を受信中...',
  '文字起こし処理中（Whisper API）...',
  'AIが台本と照合中...',
  'スコアを計算中...',
  '総評コメントを生成中...',
]

export default function EvaluatingScreen({ ctx, onNavigate }: Props) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (step < STEPS.length - 1) {
      const t = setTimeout(() => setStep(s => s + 1), 1200)
      return () => clearTimeout(t)
    }
    // 最終ステップ：スコア到着後に結果へ（未着なら待機）
    if (ctx.scores.length === 0) return
    const t = setTimeout(() => onNavigate('result'), 1500)
    return () => clearTimeout(t)
  }, [step, ctx.scores, onNavigate])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="text-center max-w-xs w-full">
        <div className="seal mx-auto h-20 w-20 text-4xl mb-4" style={{ animation: 'bounce 1s infinite' }}>採</div>
        <h1 className="font-display text-2xl font-bold mb-1 text-sumi">AI採点中...</h1>
        <p className="text-usuzumi text-sm mb-10">しばらくお待ちください</p>

        <div className="space-y-3 text-left">
          {STEPS.map((s, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 transition-opacity duration-500 ${i <= step ? 'opacity-100' : 'opacity-30'}`}
            >
              {i < step ? (
                <div className="seal h-5 w-5 text-xs flex-shrink-0">✓</div>
              ) : (
                <div
                  className={`w-5 h-5 flex-shrink-0 ${i === step ? '' : 'bg-kinari border border-kei'}`}
                  style={i === step ? { background: 'var(--genre)', animation: 'pulse 1s infinite' } : undefined}
                />
              )}
              <span className="text-sm text-sumi">{s}</span>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(-14px); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.25; }
        }
      `}</style>
    </div>
  )
}
