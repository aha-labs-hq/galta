import { ChevronRight, CircleAlert } from 'lucide-react'

const brief = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\r\n]/.test(value)
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Presentation only: retain the original error in history and in details.
 * Provider envelopes describe where a request failed, not its root cause.
 */
export function conversationError(text: string): { title: string; message: string; context: string | undefined; details: string | undefined } {
  let envelope: Record<string, unknown> | undefined
  try { envelope = record(JSON.parse(text)) } catch { /* Plain-text errors are also valid. */ }
  const error = record(envelope?.error) ?? envelope
  const status = error?.upstream_status ?? error?.status
  const http = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined
  const upstream = error?.type === 'upstream_error' || (http !== undefined && error?.upstream_status !== undefined)
  const message = upstream
    ? http === 400 ? 'The model provider rejected this request.' : 'The model provider could not complete this request.'
    : brief(error?.message) ? error.message.trim()
    : !envelope && brief(text) ? text.trim()
    : 'The request could not be completed. See the details below.'
  const provider = brief(error?.provider) ? error.provider.trim() : undefined
  return {
    title: upstream ? 'Provider request failed' : 'Request failed',
    message,
    context: [provider, http ? `HTTP ${http}` : undefined].filter(Boolean).join(' · ') || undefined,
    details: envelope || !brief(text) ? text : undefined
  }
}

export function ConversationError({ text, announce = false }: { text: string; announce?: boolean }) {
  const error = conversationError(text)
  return <div className="conversation-assistant conversation-error is-error my-3 flex gap-2.5 text-sm leading-relaxed">
    <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div role={announce ? 'alert' : undefined} aria-atomic={announce || undefined}>
        <p className="font-medium text-foreground">{error.title}</p>
        <p className="mt-0.5 text-muted-foreground wrap-anywhere">{error.message}</p>
        {error.context && <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">{error.context}</p>}
      </div>
      {error.details && <details className="group/error mt-1">
        <summary className="flex min-h-(--target-compact) w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 group-open/error:rotate-90" aria-hidden="true" />Error details
        </summary>
        <pre tabIndex={0} aria-label="Original error" className="mt-1 max-h-40 overflow-auto overscroll-contain rounded-sm bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground wrap-anywhere outline-none">{error.details}</pre>
      </details>}
    </div>
  </div>
}
