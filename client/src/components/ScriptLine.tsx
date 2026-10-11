import type { ScriptEntry } from '../types'

/**
 * 台本の1行。この端末のプレイヤーの台詞だけ「プレイヤー色の太罫 ＋ 名前バッジ」に、
 * 他端末は灰の細罫にする。全員に色を付けると「この端末の誰が言う番か」が埋もれるため、
 * 局所/遠隔の区別は色ではなく罫の太さで出す。
 *
 * 名前バッジは1台を囲んで読むときに必須。キャラ名だけでは誰の番か分からない。
 */
export default function ScriptLine({
  entry, local, color,
}: {
  entry: ScriptEntry
  local: boolean
  color?: string
}) {
  return (
    <div
      className={`bg-kinari px-4 py-3 ${local ? 'border-l-4' : 'border-l-2 border-kei'}`}
      style={local ? { borderLeftColor: color } : undefined}
    >
      <p className="text-xs font-bold mb-1 flex items-center gap-2">
        <span style={local ? { color } : undefined} className={local ? '' : 'text-usuzumi'}>
          {entry.character}
        </span>
        {local && (
          <span
            className="text-[10px] text-kinari px-1.5 py-0.5 font-bold"
            style={{ background: color }}
          >
            {entry.player}
          </span>
        )}
      </p>
      {entry.action && <p className="text-usuzumi text-xs italic mb-1.5">〔{entry.action}〕</p>}
      <p className={`text-sm leading-relaxed ${local ? 'text-sumi font-bold' : 'text-usuzumi'}`}>
        「{entry.line}」
      </p>
    </div>
  )
}
