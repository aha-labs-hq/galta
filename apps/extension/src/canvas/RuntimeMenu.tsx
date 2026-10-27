import type { RuntimeContext } from '@galta/domain'
import type { CreativeSession } from '@galta/storage'
import type { CodexModel } from '../shared/messages'
import { Check, ChevronDown, CircleAlert, LoaderCircle, MessagesSquare, SquarePen, Pencil, X, Sparkles } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { MessageDraft } from './messageDrafts'

function effortLabel(value: string) {
  return value.toLowerCase() === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function sessionStatus(session: CreativeSession, running: boolean) {
  if (running) return 'working' as const
  return session.turns.at(-1)?.status === 'failed' ? 'failed' as const : undefined
}

/** Model and account identities share one presentation mapping. */
function agentMarkPath(name: string) {
  const identity = name.toLowerCase()
  if (/\b(gpt|codex|openai)\b/.test(identity) || /\bo[134](?:[-.]|$)/.test(identity)) return '/agent-marks/openai.svg'
  if (/\b(claude|anthropic)\b/.test(identity)) return '/agent-marks/claude.svg'
  return null
}

function AgentMark({ identity, className }: { identity: string; className?: string }) {
  const path = agentMarkPath(identity)
  return path
    ? <span className={cn('runtime-agent-icon runtime-agent-mark', className)} style={{ maskImage: `url("${path}")` }} aria-hidden="true" />
    : <span className={cn('runtime-agent-icon runtime-agent-icon-fallback', className)} aria-hidden="true"><Sparkles /></span>
}

const usagePercent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 })

export function SessionMenu(p: {
  open: boolean; onOpen: (open: boolean) => void; runtime: RuntimeContext
  sessions: readonly CreativeSession[]; busy: boolean; onSelect: (id: string) => void; onNew: () => void
  activeSessionIds?: ReadonlySet<string>
  drafts?: Record<string, MessageDraft>; currentLabel?: string; onRename?: (name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const renameTrigger = useRef<HTMLButtonElement>(null), wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing && document.activeElement === document.body) renameTrigger.current?.focus()
    wasEditing.current = editing
  }, [editing])
  const sessions = (p.sessions.some(s => s.id === p.runtime.sessionId) ? p.sessions : [...p.sessions, { id: p.runtime.sessionId, label: p.currentLabel ?? p.runtime.sessionLabel, turns: [] }])
    .filter(s => s.id === p.runtime.sessionId || s.turns.length || s.threadId || s.labelSource === 'user' || p.drafts?.[s.id]?.command.trim())
  const save = async () => {
    setSaving(true); setError('')
    try { await p.onRename?.(name); setEditing(false) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const activeCount = p.activeSessionIds?.size ?? 0
  const currentLabel = p.currentLabel ?? p.runtime.sessionLabel
  if (editing) return <div className="w-full"><form className="flex min-w-0 items-center gap-1" onSubmit={event => { event.preventDefault(); if (!saving) void save() }}>
    <Input className="h-8 min-w-0 flex-1 text-sm" aria-label="Conversation name" autoFocus value={name} disabled={saving} maxLength={80} onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setEditing(false) } if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} />
    <Button type="submit" variant="ghost" size="icon-compact" aria-label="Save conversation name" title="Save name" disabled={saving || !name.trim()}><Check className="size-4" /></Button>
    <Button type="button" variant="ghost" size="icon-compact" aria-label="Cancel rename" title="Cancel" disabled={saving} onClick={() => setEditing(false)}><X className="size-4" /></Button>
  </form>{error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}</div>
  return <div className="conversation-session-tools flex w-full items-center justify-between gap-3">
    <DropdownMenu open={p.open} onOpenChange={p.onOpen} modal={false}>
      <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="compact" className="conversation-session-trigger min-w-0 max-w-full gap-2 text-muted-foreground" aria-label="Switch conversation"><MessagesSquare className="size-3.5 shrink-0" /><span className="session-current-label min-w-0 truncate">{currentLabel}</span>{activeCount > 0 && <span className="session-active-summary session-count shrink-0"><span className="working-dot size-1.5" aria-hidden="true" />{activeCount} working</span>}<ChevronDown className="size-3 shrink-0" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent className="session-menu w-72 max-w-[calc(100vw_-_40px)]" align="start" side="top" sideOffset={8} collisionPadding={12} aria-label="Conversations">
        <DropdownMenuRadioGroup value={p.runtime.sessionId} onValueChange={p.onSelect}>
          {[...sessions].reverse().map(session => {
            const running = p.activeSessionIds?.has(session.id) ?? false
            const status = sessionStatus(session, running)
            return <DropdownMenuRadioItem key={session.id} value={session.id} title={session.label} textValue={session.label} data-running={running ? 'true' : undefined} data-status={status} className="session-menu-item min-w-0">
              <span className="session-menu-copy min-w-0 flex-1"><span className="session-menu-title block min-w-0 truncate">{session.label}</span>{session.turns.length > 0 && <span className="session-menu-preview mt-0.5 block truncate text-xs text-muted-foreground">{session.turns.at(-1)?.instruction}</span>}{!session.turns.length && p.drafts?.[session.id]?.command.trim() && <span className="session-menu-preview block truncate text-xs text-muted-foreground">Draft: {p.drafts[session.id]!.command}</span>}</span>
              {status === 'working' && <span className="session-menu-meta" title="Working"><LoaderCircle className="session-menu-status-icon motion-safe:animate-spin" role="img" aria-label="Working" /></span>}
              {status === 'failed' && <span className="session-menu-meta session-menu-meta-error" title="Needs attention"><CircleAlert className="session-menu-status-icon" role="img" aria-label="Needs attention" /></span>}
            </DropdownMenuRadioItem>
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <div className="conversation-session-actions flex shrink-0 items-center gap-1">
      {p.onRename && <Tooltip><TooltipTrigger asChild><Button ref={renameTrigger} type="button" variant="ghost" size="icon-compact" onClick={() => { setName(p.currentLabel ?? p.runtime.sessionLabel); setError(''); setEditing(true) }} aria-label="Rename conversation"><Pencil className="size-3.5" /></Button></TooltipTrigger><TooltipContent>Rename conversation</TooltipContent></Tooltip>}
      <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-compact" className="text-muted-foreground" onClick={p.onNew} aria-label="New conversation"><SquarePen className="size-4" /></Button></TooltipTrigger><TooltipContent>New conversation</TooltipContent></Tooltip>
    </div>
  </div>
}

type Props = {
  open: boolean; onOpen: (open: boolean) => void; runtime: RuntimeContext
  models: readonly CodexModel[]; efforts: string[]
  status: string; plan: string; usage: number | null; error: string | null; busy: boolean
  refreshing?: boolean
  onChange: (field: keyof RuntimeContext, value: string) => void; onConnect: () => void
}

export function RuntimeMenu(p: Props) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const selectedModel = p.models.find(m => m.id === p.runtime.modelId)
  const modelLabel = selectedModel?.displayName ?? p.runtime.modelId.replace(/^gpt-/i, 'GPT-').replace(/-([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`)
  const models = p.models.length ? p.models : [{ id: p.runtime.modelId, displayName: modelLabel }]
  const remaining = p.status === 'connected' && p.usage !== null ? 100 - p.usage : null
  const remainingLabel = remaining === null ? '' : usagePercent.format(remaining / 100)
  const planLabel = p.plan.charAt(0).toUpperCase() + p.plan.slice(1)
  const connectionLabel = p.status === 'connected' ? 'Connected to Codex' : p.status === 'connecting' ? 'Connecting to Codex' : p.status === 'sign-in-required' ? 'Sign in to Codex' : 'Codex is not connected'
  return <div className="composer-runtime shrink-0"><Popover open={p.open} onOpenChange={p.onOpen}>
    <PopoverAnchor className="pointer-events-none absolute inset-x-0 top-0 h-0" />
    <div className="runtime-controls flex items-center text-xs text-muted-foreground">
      <Button ref={trigger} type="button" variant="ghost" size="compact" className="runtime-part runtime-model min-w-0 gap-1.5 text-inherit @max-[420px]:w-(--target-compact) group-data-[working=true]/dock:w-(--target-compact)" title={`${modelLabel} · ${effortLabel(p.runtime.effort)} · ${p.status.replaceAll('-', ' ')}`} aria-label={`Model ${modelLabel}, effort ${effortLabel(p.runtime.effort)}`} aria-haspopup="dialog" aria-expanded={p.open} aria-controls={`${id}-panel`} onClick={() => p.onOpen(!p.open)}>
        <AgentMark identity={`${p.runtime.modelId} ${modelLabel}`} className="runtime-trigger-model-icon" />
        <span className="inline-flex shrink-0 items-center gap-1.5 @max-[420px]:hidden group-data-[working=true]/dock:hidden"><span className="runtime-value">{modelLabel}</span><span aria-hidden="true" className="text-muted-foreground/60">/</span><span className="runtime-effort-value">{effortLabel(p.runtime.effort)}</span><ChevronDown className="size-3" /></span><i className={cn('sr-only', p.status === 'connected' ? 'is-connected' : 'is-disconnected')} role="img" aria-label={`Codex ${p.status.replaceAll('-', ' ')}`} />
      </Button>
    </div>
    <PopoverContent id={`${id}-panel`} aria-label="Model settings" side="top" align="end" sideOffset={8.5} collisionPadding={12} className="runtime-menu flex min-h-0 max-h-(--radix-popover-content-available-height) w-(--runtime-menu-width) max-w-[calc(100vw_-_24px)] flex-col overflow-hidden p-3" onInteractOutside={event => { if (trigger.current?.contains(event.target as Node)) event.preventDefault() }} onCloseAutoFocus={event => { event.preventDefault(); if (document.activeElement === document.body || document.activeElement?.closest('.runtime-menu')) trigger.current?.focus() }}>
      <header className="runtime-menu-header flex h-6 items-center pr-2 pl-(--runtime-menu-text-inset) text-muted-foreground">
        <p className="text-(length:--text-caption)" id={`${id}-models`}>Model</p>
      </header>
      <section className="runtime-model-section flex min-h-0 min-w-0 flex-col">
        <RadioGroup value={p.runtime.modelId} onValueChange={value => p.onChange('modelId', value)} disabled={p.busy} aria-labelledby={`${id}-models`} className="runtime-model-list min-h-0 gap-0 overflow-y-auto">
          {models.map(model => <label key={model.id} className={cn('runtime-model-option group/model control-choice flex min-h-(--target-compact) items-center gap-2 rounded-lg px-2 py-1 text-sm text-muted-foreground transition-colors duration-(--motion-fast) ease-(--ease-out) has-data-[state=checked]:text-base has-data-[state=checked]:font-medium has-data-[state=checked]:text-foreground', p.busy ? 'cursor-default opacity-50' : 'cursor-pointer hover:bg-(--glass-hover)')}>
            <RadioGroupItem className="sr-only" value={model.id} aria-label={model.displayName ?? model.id} /><Check className="runtime-model-check size-3.5 shrink-0 opacity-0 transition-opacity duration-(--motion-fast) ease-(--ease-out) group-has-data-[state=checked]/model:opacity-100" aria-hidden="true" /><span className="runtime-model-name min-w-0 flex-1 break-words">{model.displayName ?? model.id}</span>
          </label>)}
        </RadioGroup>
      </section>
      <section className="runtime-effort-section min-w-0">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="compact" aria-label={`Effort ${effortLabel(p.runtime.effort)}`} className="runtime-effort-trigger w-full justify-between pr-2 pl-(--runtime-menu-text-inset) text-sm text-muted-foreground hover:bg-(--glass-hover) focus-visible:text-foreground"><span>Effort</span><span className="inline-flex items-center text-foreground">{effortLabel(p.runtime.effort)}<span className="runtime-menu-cue" aria-hidden="true"><ChevronDown className="size-3" /></span></span></Button></DropdownMenuTrigger>
          <DropdownMenuContent aria-label="Effort" align="end" collisionPadding={12} className="runtime-effort-menu p-2 text-foreground">
            <DropdownMenuRadioGroup value={p.runtime.effort.toLowerCase()} onValueChange={value => p.onChange('effort', value.charAt(0).toUpperCase() + value.slice(1))}>
              {p.efforts.map(effort => <DropdownMenuRadioItem key={effort} value={effort.toLowerCase()} disabled={p.busy} className="runtime-effort-option cursor-pointer focus:bg-(--surface-focus)">{effortLabel(effort)}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </section>
      <footer className="runtime-account-section mt-4">
        {p.status === 'connected' && <span className="sr-only" role="status">{connectionLabel}</span>}
        <div className="runtime-account flex min-h-(--target-compact) min-w-0 items-center gap-2 px-2">
          <AgentMark identity="Codex" className="text-muted-foreground" />
          <p className="runtime-account-line min-w-0 flex-1 truncate text-(length:--text-caption) text-muted-foreground" role={p.status === 'connected' ? undefined : 'status'}>{p.status === 'connected' ? <>Codex{planLabel ? ' · ' + planLabel : ''}</> : connectionLabel}</p>
          <div className="runtime-account-actions flex shrink-0 items-center gap-2">
            {remaining !== null && <Tooltip><TooltipTrigger asChild><Button asChild variant="ghost" size="compact" className="runtime-usage-meter w-(--runtime-usage-width) cursor-default flex-col gap-1 px-0 text-(length:--text-caption) text-muted-foreground focus-visible:text-foreground"><span role="meter" tabIndex={0} aria-label="Usage remaining" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-valuetext={`${remainingLabel} remaining in the current usage window`} aria-busy={p.refreshing || undefined}>
              <span className="runtime-usage-label"><span className="font-medium tabular-nums text-foreground">{remainingLabel}</span> left</span>
              <span className="runtime-usage-track w-full overflow-hidden rounded-full bg-border" aria-hidden="true"><span className="block h-full rounded-full bg-muted-foreground" style={{ width: `${remaining}%` }} /></span>
            </span></Button></TooltipTrigger><TooltipContent>{remainingLabel} remaining in the current usage window</TooltipContent></Tooltip>}
          </div>
        </div>
        {p.status !== 'connected' && <Button type="button" size="compact" className="runtime-connect-action mt-2 w-full justify-start pr-2 pl-(--runtime-menu-text-inset) text-sm" disabled={p.status === 'connecting'} onClick={p.onConnect}>{p.status === 'connecting' ? 'Connecting…' : p.status === 'sign-in-required' ? 'Sign in with ChatGPT' : 'Connect built-in chat'}</Button>}
        {p.error && <p role="alert" className="runtime-menu-error break-words pr-2 pl-(--runtime-menu-text-inset) pt-2 text-sm text-destructive">{p.error}</p>}
      </footer>
    </PopoverContent>
  </Popover></div>
}
