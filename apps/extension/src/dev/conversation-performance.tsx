// Isolated performance fixture, excluded from extension entry points.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConversationDock } from '../canvas/ConversationDock'
import { ConversationStore, type DraftCommand } from '../canvas/conversationStore'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CreativeConversationTurn } from '@galta/storage'
import '../styles.css'
import '../canvas/canvas.css'

const query = new URLSearchParams(location.search)
const count = Number(query.get('turns') ?? 8), tools = Number(query.get('tools') ?? 40)
const block = '## Composition and light\n\n保留画面的主要结构，让视线从左侧进入，再落到主体。 Keep the composition calm and the important edges clear.\n\n- Preserve the geometry and material.\n- Keep the image legible at small sizes.\n- Review spacing, contrast, and balance.\n\n| Area | Change | Reason |\n| --- | --- | --- |\n| Title | Reduce size | Clear hierarchy |\n| Body | Increase spacing | Easier reading |\n\n```ts\nconst scene = { width: 1200, height: 800 };\nconst title = "Study of a quiet morning";\n```\n\n[Reference](https://example.com/reference)\n\n'
const history: CreativeConversationTurn[] = Array.from({ length: count }, (_, i) => ({ id: `turn-${i}`, instruction: 'Refine this composition, preserving the original proportions.', status: 'completed', items: [
  ...Array.from({ length: tools }, (_, j) => ({ id: `tool-${i}-${j}`, type: 'mcpToolCall', server: 'galta', tool: 'canvas_inspect', text: 'Canvas result ' + 'detail '.repeat(100), status: 'completed' })),
  { id: `message-${i}`, type: 'agentMessage', phase: 'final_answer', text: block.repeat(2) }
] }))

function Fixture() {
  const [conversation] = useState(() => {
    const store = new ConversationStore()
    store.set({ id: 'active', instruction: 'Continue refining the image.', status: 'streaming', startedAt: Date.now(), items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', status: 'inProgress', text: block.repeat(Number(query.get('liveRepeats') ?? 2)) }] })
    return store
  })
  const [command] = useState<DraftCommand>(() => {
    let value = ''
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, set: next => { value = next; listeners.forEach(fn => fn()) } }
  })
  const [open, setOpen] = useState(true)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined, ticks = 0
    const fixture = (window as any).__galtaPerformance = {
      start() { timer = setInterval(() => {
        ticks++
        const turn = conversation.getSnapshot()!
        // Match the identity loss at the actual cross-window transport boundary.
        conversation.set(structuredClone({ ...turn, items: turn.items.map(item => ({ ...item, text: item.text + ' More light.' })) }))
      }, 50) },
      stop() { clearInterval(timer); return ticks },
      historyCharacters: count * block.length * 2, activeCharacters: block.length * Number(query.get('liveRepeats') ?? 2)
    }
    return () => { fixture.stop(); delete (window as any).__galtaPerformance }
  }, [conversation])
  return <TooltipProvider><main className="galta-shell"><ConversationDock turns={history} conversation={conversation} state="streaming" error="" question={null} command={command} onSubmit={() => {}} onStop={() => {}} open={open} onOpen={setOpen} preview={false} sessionId="performance" /></main></TooltipProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
