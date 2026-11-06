import { useRef, useState } from 'react'
import { ChevronLeft, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PendingQuestion } from './ConversationDock'

type InputQuestion = { id: string; question: string; header?: string; isSecret?: boolean; options?: { label: string; description: string }[] | null }
type AnswerState = { request: string | undefined; index: number; answers: Record<string, string>; pending: boolean; error: string }
const empty = (request: PendingQuestion | null): AnswerState => ({ request: request?.id, index: 0, answers: {}, pending: false, error: '' })

/** One draft and one acknowledgement owner, independent of where the question is shown. */
export function useConversationAnswer(request: PendingQuestion | null) {
  const [stored, setState] = useState(() => empty(request))
  const current = useRef(request?.id), submitted = useRef<string | null>(null)
  current.current = request?.id
  const state = stored.request === request?.id ? stored : empty(request)
  if (stored.request !== request?.id) setState(state)
  const questions = request?.method === 'item/tool/requestUserInput' ? request.params.questions as InputQuestion[] | undefined : undefined
  const question = questions?.[state.index]
  if (!request || !questions?.length || !question) return null
  const value = state.answers[question.id] ?? ''
  const submit = async (answer = value) => {
    if (!answer.trim() || submitted.current === request.id || current.current !== request.id) return
    const answers = { ...state.answers, [question.id]: answer }
    if (state.index < questions.length - 1) {
      setState({ ...state, answers, index: state.index + 1, error: '' }); return
    }
    submitted.current = request.id
    setState({ ...state, answers, pending: true, error: '' })
    try {
      await request.answer({ answers: Object.fromEntries(questions.map(q => [q.id, { answers: [answers[q.id] ?? ''] }])) })
      // Keep the latch until the task host removes this request. An acknowledged
      // answer must never be sent again while its snapshot is still in flight.
    } catch (error) {
      if (current.current !== request.id) return
      submitted.current = null
      setState({ ...state, answers, pending: false, error: error instanceof Error ? error.message : 'Could not send your answer. Try again.' })
    }
  }
  return { question, value, index: state.index, count: questions.length, pending: state.pending, error: state.error,
    setValue: (value: string) => setState({ ...state, answers: { ...state.answers, [question.id]: value }, error: '' }),
    previous: () => setState({ ...state, index: Math.max(0, state.index - 1), error: '' }),
    submit }
}
export type ConversationAnswer = NonNullable<ReturnType<typeof useConversationAnswer>>

export function ConversationChoices({ answer, compact = false }: { answer: ConversationAnswer; compact?: boolean }) {
  return <section className="conversation-question" data-compact={compact} aria-label="Question from the agent" aria-busy={answer.pending}>
    {answer.count > 1 && <div className="conversation-question-progress"><Button type="button" variant="ghost" size="icon-compact" aria-label="Previous question" disabled={!answer.index || answer.pending} onClick={answer.previous}><ChevronLeft /></Button><span>{answer.index + 1} of {answer.count}</span></div>}
    <p className="conversation-question-prompt">{answer.question.question}</p>
    <div className="conversation-question-options">
      {answer.question.options?.map(option => <Button type="button" variant="secondary" className="conversation-question-option" key={option.label} disabled={answer.pending} onClick={() => void answer.submit(option.label)}>
        <span><span>{option.label}</span>{!compact && option.description && <small>{option.description}</small>}</span>{!compact && <ArrowUpRight aria-hidden="true" />}
      </Button>)}
    </div>
  </section>
}

export function ConversationQuestion({ question }: { question: PendingQuestion }) {
  const p = question.params as Record<string, any>
  const pending = useRef(false)
  const [sending, setSending] = useState(false), [error, setError] = useState('')
  const respond = async (value: unknown) => {
    if (pending.current) return
    pending.current = true; setSending(true); setError('')
    try { await question.answer(value) }
    catch (error) { pending.current = false; setSending(false); setError(error instanceof Error ? error.message : 'Could not send your answer. Try again.') }
  }
  const permission = question.method === 'item/permissions/requestApproval'
  const approval = permission || question.method === 'item/commandExecution/requestApproval' || question.method === 'item/fileChange/requestApproval'
  if (approval) return <div className="codex-question mt-4 space-y-3 border-t pt-4 text-sm [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:font-mono [&_pre]:text-xs [&_pre]:whitespace-pre-wrap" role="group" aria-label="Codex approval">
    <p>{String(p.reason ?? (permission ? 'Allow this access for the current task?' : 'Codex needs your approval to continue.'))}</p>
    {p.command && <pre>{String(p.command)}</pre>}
    {permission && <pre>{JSON.stringify(p.permissions, null, 2)}</pre>}
    {error && <p role="alert">{error}</p>}
    <div className="flex justify-end gap-2"><Button variant="ghost" disabled={sending} onClick={() => void respond(permission ? { permissions: {}, scope: 'turn' } : { decision: 'decline' })}>Decline</Button><Button variant="ghost" disabled={sending} onClick={() => void respond(permission ? { permissions: p.permissions, scope: 'turn' } : { decision: 'accept' })}>Allow once</Button></div>
  </div>
  return <div className="codex-question mt-4 space-y-3 border-t pt-4 text-sm">{error && <p role="alert">{error}</p>}<p>This tool needs an interaction that Galta does not support yet.</p><Button variant="ghost" disabled={sending} onClick={() => void respond({ action: 'cancel', content: null })}>Cancel request</Button></div>
}

