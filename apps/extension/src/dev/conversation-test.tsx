// Deterministic component test, excluded from extension entry points.
// These task states are fixtures, never evidence of a live Codex turn.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ConversationStore } from '../canvas/conversationStore'
import { createRoot } from 'react-dom/client'
import { ConversationDock } from '../canvas/ConversationDock'
import type { CanvasLocator } from '../canvas/agentFocus'
import { RuntimeMenu, SessionMenu } from '../canvas/RuntimeMenu'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CreativeConversationTurn } from '@galta/storage'
import type { RuntimeContext } from '@galta/domain'
import type { CodexModel } from '../shared/messages'
import { conversationItem } from '@galta/runtime'
import '../styles.css'
import '../canvas/canvas.css'

const menuEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const menuModels: CodexModel[] = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => ({
  id, displayName: id.replace('gpt', 'GPT').replace(/-(astra|sol|luna|terra)$/, (_, name: string) => `-${name.charAt(0).toUpperCase()}${name.slice(1)}`),
  supportedReasoningEfforts: menuEfforts.map(reasoningEffort => ({ reasoningEffort }))
}))

function TestConversation() {
  const query = new URLSearchParams(location.search), long = query.has('long')
  const modelMenu = query.has('model-menu')
  const error = query.get('error') ?? ''
  const [open, setOpen] = useState(modelMenu)
  const [command] = useState(() => {
    let value = ''
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, set: (next: string) => { value = next; listeners.forEach(listener => listener()) } }
  })
  const [artifactDownloads] = useState<string[]>([])
  const [artifactDownloadGrants] = useState<unknown[]>([])
  const failed: CreativeConversationTurn = { id: 'failed', instruction: 'Read the webpage beside this canvas.', status: 'failed', startedAt: 1, items: [{ id: 'error', type: 'error', text: error }] }
  const [conversation] = useState(() => { const store = new ConversationStore(); store.set(error && query.has('live') ? failed : null); return store })
  const turn = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot)
  const setTurn = conversation.set
  const [menu, setMenu] = useState<'Conversation' | 'Model' | null>(modelMenu ? 'Model' : null)
  const [runtime, setRuntime] = useState<RuntimeContext>({ sessionId: 'fixture', sessionLabel: query.has('long-title') ? '帮我在系统性规划一下兰州的玩法，可以先从周末两天开始' : 'Morning light', modelId: modelMenu ? 'gpt-6.1-sol' : 'gpt-5.6-sol', effort: modelMenu ? 'Medium' : 'High', providerId: 'codex' })
  // ?canvas leaves a canvas call running, so the collapsed dock has to name the
  // verb rather than fall back to generic copy.
  const running: CreativeConversationTurn['items'] = query.has('retry')
    ? [{ id: 'retry', type: 'modelRetry', text: 'Waiting for the model to reconnect', status: query.get('retry') || 'inProgress', error: 'Upstream timed out' }, { id: 'finished-tool', type: 'commandExecution', text: 'pwd', status: 'completed' }]
    : query.has('command-exit')
    ? [conversationItem({ id: 'command', type: 'commandExecution', command: 'rg --files', cwd: '/tmp/creative', status: 'failed', exitCode: Number(query.get('command-exit')), aggregatedOutput: query.get('output') ?? '' }, 'completed')!]
    : query.has('canvas')
    ? [conversationItem({ id: 'write', ...(query.has('mcp') ? { type: 'mcpToolCall', server: 'galta' } : { type: 'dynamicToolCall' }), tool: query.get('tool') ?? 'canvas_edit', status: query.get('tool-status') ?? 'inProgress', ...(query.get('tool-status') === 'failed' ? { error: { message: 'Storage unavailable' } } : {}) }, 'inProgress')!]
    : [{ id: 'image', type: 'imageGeneration', text: 'fixture-image-generation', status: 'inProgress' }]
  const history: CreativeConversationTurn[] = query.has('artifact') ? [{
    id: 'artifact-fixture', instruction: '把选中的作品交付给我。', status: 'completed', startedAt: 1, completedAt: 2,
    items: [{ id: 'artifact-answer', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '已准备好选中的作品。\n\n[Download selected image](galta-workspace:/sources/selected.png)\n\n[Reference](https://example.com/reference)\n\n机器路径 `/tmp/creative/sources/selected.png` 只供工具使用。' }]
  }] : long ? [{ id: 'previous', instruction: '保留构图，让入口的光线更柔和。', status: 'stopped', startedAt: 1, items: [{ id: 'previous-answer', type: 'agentMessage', text: '入口的比例可以保留。降低玻璃反光的亮度，让立面的层次更清晰。\n\n## Light and material\n\nKeep the original geometry and the contrast between the glass and the stone.\n\n- Preserve the entrance.\n- Keep the surrounding buildings.\n- Use softer morning light.\n\n[Reference](https://example.com/reference)\n\n' + 'The original proportions and material detail remain visible. '.repeat(20) }] }] : []
  if (query.has('artifact-delivery')) history.push({
    id: 'delivery-fixture', instruction: '把选中的作品下载到当前工作目录。', status: 'completed', startedAt: 1, completedAt: 2,
    items: [{ id: 'delivery-answer', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '已下载到当前工作目录。\n\n[下载选中的图片](</tmp/creative/outputs/selected image.png>)', artifacts: [{ href: '/tmp/creative/outputs/selected image.png', status: 'ready', receipt: { projectId: 'fixture', threadId: '00000000-0000-4000-8000-000000000000', turnId: '00000000-0000-4000-8000-000000000001', messageId: 'delivery-answer', receiptId: '00000000-0000-4000-8000-000000000002', href: '/tmp/creative/outputs/selected image.png', uri: 'galta-workspace:/deliveries/00000000-0000-4000-8000-000000000002/selected%20image.png', name: 'selected image.png', mimeType: 'image/png', size: 4, sha256: '0000000000000000000000000000000000000000000000000000000000000000', version: 'fixture-version' } }] }]
  })
  if (query.has('artifact-delivery-managed')) history.push({
    id: 'managed-delivery-fixture', instruction: '把选中的作品下载到当前工作目录。', status: 'completed', startedAt: 1, completedAt: 2,
    items: [{ id: 'managed-delivery-answer', type: 'agentMessage', phase: 'final_answer', status: 'completed', text: '[第一次 managed](galta-workspace:/outputs/selected%20image.png) [第二次 managed](galta-workspace:/outputs/selected%20image.png) [absolute](</tmp/creative/outputs/selected image.png>)', artifacts: [{ href: '/tmp/creative/outputs/selected image.png', status: 'ready', receipt: { projectId: 'fixture', threadId: '00000000-0000-4000-8000-000000000000', turnId: '00000000-0000-4000-8000-000000000001', messageId: 'managed-delivery-answer', receiptId: '00000000-0000-4000-8000-000000000003', href: '/tmp/creative/outputs/selected image.png', uri: 'galta-workspace:/deliveries/00000000-0000-4000-8000-000000000003/selected%20image.png', artifactUri: 'galta-workspace:/outputs/selected%20image.png', name: 'selected image.png', mimeType: 'image/png', size: 4, sha256: '0000000000000000000000000000000000000000000000000000000000000000', version: 'fixture-version' } }] }]
  })
  for (let i = 0; i < Number(query.get('rounds') ?? 0); i++) history.push({
    id: `history-${i}`, instruction: `${i + 1}. 保留共享轮廓，调整第 ${i + 1} 版 logo 的留白。`, status: 'completed', startedAt: 1, completedAt: 18001,
    items: [{ id: `commentary-${i}`, type: 'agentMessage', phase: 'commentary', text: 'I will inspect the proportions before editing.' },
      ...Array.from({ length: 8 }, (_, j) => ({ id: `tool-${i}-${j}`, type: 'mcpToolCall', server: 'galta', tool: 'canvas_capture', text: 'canvas_capture', details: 'Detailed tool receipt', status: 'completed' })),
      { id: `reply-${i}`, type: 'agentMessage', phase: 'final_answer', status: 'completed', text: `第 ${i + 1} 版已完成。\n\n保留了共享轮廓，同时扩大内部留白，让小尺寸更清晰。\n\n- 主体比例保持一致。\n- 字形结构完整。\n- 已检查窄屏下的辨识度。` }]
  })
  useEffect(() => {
    const fixture = {
      set: conversation.set,
      selectSession(sessionId: string, turn: CreativeConversationTurn | null) {
        setRuntime(runtime => ({ ...runtime, sessionId, sessionLabel: sessionId }))
        conversation.set(turn)
      },
      append(text: string) {
        const turn = conversation.getSnapshot()!
        const item = turn.items.at(-1)!
        conversation.set({ ...turn, items: [...turn.items.slice(0, -1), { ...item, text: item.text + text }] })
      },
      // An explicit elapsed time keeps duration labels independent of how long
      // the browser took to drive the steps before completion.
      finish(elapsed?: number) {
        const turn = conversation.getSnapshot()!
        if (elapsed !== undefined && turn.startedAt === undefined) throw new Error('An elapsed finish needs a started turn.')
        conversation.set({ ...turn, status: 'completed', completedAt: elapsed === undefined ? Date.now() : turn.startedAt! + elapsed, items: turn.items.map(item => ({ ...item, status: 'completed' })) })
      }
    }
    ;(window as any).__conversationTest = fixture
    return () => { delete (window as any).__conversationTest }
  }, [conversation])
  useEffect(() => {
    ;(window as any).__conversationArtifactDownloads = artifactDownloads
    return () => { delete (window as any).__conversationArtifactDownloads }
  }, [artifactDownloads])
  useEffect(() => {
    ;(window as any).__conversationArtifactDownloadGrants = artifactDownloadGrants
    return () => { delete (window as any).__conversationArtifactDownloadGrants }
  }, [artifactDownloadGrants])
  const busy = turn?.status === 'streaming'
  // ?starting holds the turn before its provider boundary, where a follow-up
  // cannot reach the turn yet. The composer must not promise one.
  const task = busy && !query.has('starting') ? { id: 'fixture-task', projectId: 'fixture', runtime, active: true, canSteer: true, conversation: turn!, pressure: null, question: null, error: '', sequence: 1 } : undefined
  if (error && !query.has('live') && !query.has('standalone')) history.push(failed)
  // ?locate=<degrees|here> stands in for a canvas: changes lie that way, or in
  // view. Requests are recorded instead of flying a camera.
  const [locator] = useState(() => {
    const where = query.get('locate')
    if (where === null) return null
    const calls = (window as any).__locatorCalls = { located: [] as unknown[], marked: [] as unknown[] }
    return { subscribe: () => () => {}, getVersion: () => 0, bearing: () => where === 'here' ? null : Number(where),
      locate: async (region: unknown) => { calls.located.push(region) }, mark: (region: unknown) => { calls.marked.push(region) } } as unknown as CanvasLocator
  })
  // ?external=<activity> renders the compact line an external agent's work uses.
  const external = query.get('external') ?? undefined
  return <main className="galta-shell" style={query.has('ink') ? { backgroundColor: 'var(--graphite-base)' } : undefined}><ConversationDock locator={locator} external={Boolean(external)} activity={external} title={runtime.sessionLabel} sessionId={runtime.sessionId} turns={history} conversation={conversation} state={busy ? 'streaming' : error ? 'failed' : turn?.status === 'completed' ? 'completed' : turn ? 'stopped' : 'idle'} error={error} question={null} command={command} task={task}
    actions={<SessionMenu open={menu === 'Conversation'} onOpen={open => setMenu(open ? 'Conversation' : null)} runtime={runtime} sessions={[{ id: runtime.sessionId, label: runtime.sessionLabel, turns: [] }]} busy={false} onSelect={() => {}} onNew={() => { setTurn(null); setMenu(null); setOpen(false) }} />}
    runtime={<RuntimeMenu open={menu === 'Model'} onOpen={open => setMenu(open ? 'Model' : null)} runtime={runtime} models={modelMenu ? menuModels : []} efforts={modelMenu ? menuEfforts : ['low', 'medium', 'high']} status="connected" plan={modelMenu ? 'pro' : ''} usage={modelMenu ? 20 : null} error={null} busy={busy} onChange={(field, value) => setRuntime(r => ({ ...r, [field]: value }))} onConnect={() => {}} />} onArtifactDownload={query.has('artifact') || query.has('artifact-delivery') || query.has('artifact-delivery-managed') ? async (uri, receipt) => { artifactDownloads.push(uri); artifactDownloadGrants.push(receipt ?? null) } : undefined} onSubmit={() => {
    if (busy && turn) {
      setTurn({ ...turn, steering: [...(turn.steering ?? []), { id: `followup-${turn.steering?.length ?? 0}`, text: command.getSnapshot(), createdAt: Date.now(), afterItemId: turn.items.at(-1)!.id }] })
      command.set(''); return
    }
    setTurn({ id: 'component-fixture', instruction: command.getSnapshot(), status: 'streaming', startedAt: Date.now(), items: [{ id: 'read', type: 'dynamicToolCall', tool: 'canvas_inspect', text: 'Canvas: status', status: 'completed' }, { id: 'message', type: 'agentMessage', phase: 'commentary', text: 'I’ll keep the composition and soften the light around the entrance.' }, ...running] })
    command.set('')
  }} onStop={() => setTurn(turn ? { ...turn, status: 'stopped' } : turn)} open={open} onOpen={setOpen} preview={false} /></main>
}
createRoot(document.getElementById('root')!).render(<TooltipProvider><TestConversation /></TooltipProvider>)
