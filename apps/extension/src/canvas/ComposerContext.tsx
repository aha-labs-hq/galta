import { Scan } from 'lucide-react'
import type { CanvasScene } from './scene'
import type { SubmittedContext } from './context'
import { useSceneSelection } from './useSceneSelection'
import type { CreativeConversationTurn } from '@galta/storage'

/** Selection is where the user points, not the boundary of the request. */
export function ComposerContext({ scene, submitted, receipt }: { scene: CanvasScene; submitted: SubmittedContext | null; receipt?: CreativeConversationTurn['context'] }) {
  const { selected } = useSceneSelection(scene)
  const count = submitted ? submitted.selection.length : selected.length
  const unavailablePage = submitted ? receipt?.unavailablePage : undefined
  if (!count && !unavailablePage) return null
  return <div className="composer-context mx-3 mb-1 text-xs text-muted-foreground" aria-label={submitted ? 'Submitted context' : 'Message context'}>
    <div className="composer-context-summary flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5">
      {count > 0 && <span className="shrink-0" aria-label={`${count} selected ${count === 1 ? 'object' : 'objects'}`}><Scan className="size-3.5" aria-hidden="true" />{count} selected</span>}
      {unavailablePage && <span title={unavailablePage}>Webpage unavailable</span>}
    </div>
  </div>
}
