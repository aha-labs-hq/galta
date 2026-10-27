import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PendingQuestion } from './ConversationDock'

export function ConversationQuestion({ question }: { question: PendingQuestion }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const p = question.params as Record<string, any>
  if (question.method === 'item/tool/requestUserInput') return <form className="codex-question mt-4 border-t pt-4 text-sm" onSubmit={event => {
    event.preventDefault()
    question.answer({ answers: Object.fromEntries((p.questions ?? []).map((q: any) => [q.id, { answers: [answers[q.id] ?? ''] }])) })
  }}>
    {(p.questions ?? []).map((q: any) => <fieldset className="mb-4" key={q.id}><legend className="mb-3 leading-relaxed">{q.question}</legend>
      {q.options?.map((option: any) => <label className="my-3 flex items-start gap-2" key={option.label}><input className="mt-1 accent-foreground" type="radio" name={q.id} value={option.label} checked={answers[q.id] === option.label} onChange={() => setAnswers(a => ({ ...a, [q.id]: option.label }))} /><span>{option.label}<small className="mt-1 block text-muted-foreground">{option.description}</small></span></label>)}
      <Input className="mt-2" aria-label={q.question} placeholder="Your answer" value={answers[q.id] ?? ''} required onChange={event => setAnswers(a => ({ ...a, [q.id]: event.target.value }))} />
    </fieldset>)}<Button variant="ghost" type="submit">Continue</Button>
  </form>
  const permission = question.method === 'item/permissions/requestApproval'
  const approval = permission || question.method === 'item/commandExecution/requestApproval' || question.method === 'item/fileChange/requestApproval'
  if (approval) return <div className="codex-question mt-4 space-y-3 border-t pt-4 text-sm [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:font-mono [&_pre]:text-xs [&_pre]:whitespace-pre-wrap" role="group" aria-label="Codex approval">
    <p>{String(p.reason ?? (permission ? 'Allow this access for the current task?' : 'Codex needs your approval to continue.'))}</p>
    {p.command && <pre>{String(p.command)}</pre>}
    {permission && <pre>{JSON.stringify(p.permissions, null, 2)}</pre>}
    <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => question.answer(permission ? { permissions: {}, scope: 'turn' } : { decision: 'decline' })}>Decline</Button><Button variant="ghost" onClick={() => question.answer(permission ? { permissions: p.permissions, scope: 'turn' } : { decision: 'accept' })}>Allow once</Button></div>
  </div>
  return <div className="codex-question mt-4 space-y-3 border-t pt-4 text-sm"><p>This tool needs an interaction that Galta does not support yet.</p><Button variant="ghost" onClick={() => question.answer({ action: 'cancel', content: null })}>Cancel request</Button></div>
}

