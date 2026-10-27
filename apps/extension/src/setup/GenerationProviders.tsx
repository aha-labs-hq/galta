import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import { MEDIA_PROVIDERS, type MediaProviderId, type MediaProviderState, type MediaSettingsRequest, type MediaSettingsResponse } from '@galta/canvas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const KINDS = { image: 'Images', video: 'Video', speech: 'Speech' } as const

async function request(message: MediaSettingsRequest): Promise<MediaSettingsResponse> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return { ok: false, error: 'Open Galta in your browser extension to connect a provider.' }
  try {
    const response: MediaSettingsResponse | undefined = await chrome.runtime.sendMessage({ type: 'media-settings', request: message })
    if (response?.ok && Array.isArray(response.providers)) return response
    return response && !response.ok ? response : { ok: false, error: 'Update Galta for Mac to connect providers.' }
  } catch { return { ok: false, error: 'Reload this canvas to reconnect to Galta.' } }
}

export type MediaProviders = {
  providers: MediaProviderState[] | null
  unavailable: string
  change(message: Exclude<MediaSettingsRequest, { action: 'status' }>): Promise<MediaSettingsResponse>
}

/** Which providers are connected, read whenever the dialog opens or the window regains focus. */
export function useMediaProviders(open: boolean): MediaProviders {
  const [providers, setProviders] = useState<MediaProviderState[] | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const latest = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++latest.current
    const response = await request({ action: 'status' })
    if (id !== latest.current) return
    if (response.ok) { setProviders(response.providers); setUnavailable('') }
    else setUnavailable(response.error)
  }, [])
  useEffect(() => {
    if (!open) return
    void refresh()
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    return () => { ++latest.current; window.removeEventListener('focus', focus) }
  }, [open, refresh])
  const change = useCallback(async (message: Exclude<MediaSettingsRequest, { action: 'status' }>) => {
    ++latest.current
    const response = await request(message)
    if (response.providers) setProviders(response.providers)
    return response
  }, [])
  return { providers, unavailable, change }
}

/** One quiet phrase for the Generation row: who is connected, or that nobody is. */
export function generationSummary({ providers, unavailable }: MediaProviders) {
  if (unavailable) return 'Unavailable'
  if (!providers) return 'Checking…'
  const names = MEDIA_PROVIDERS.filter(provider => providers.some(state => state.id === provider.id && state.connected)).map(provider => provider.name)
  return names.length ? names.join(' · ') : 'Not connected'
}

type Props = { state: MediaProviders; editing: MediaProviderId | null; onEdit(provider: MediaProviderId | null): void }

/** A key is pasted once, checked with the provider, then never shown again. */
export function GenerationProviders({ state, editing, onEdit }: Props) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ provider: MediaProviderId; message: string } | null>(null)
  const field = useId()
  const input = useRef<HTMLInputElement>(null)
  const buttons = useRef(new Map<MediaProviderId, HTMLButtonElement | null>())
  const previous = useRef(editing)

  useEffect(() => {
    // Leaving a field returns focus to the control that opened it.
    if (previous.current && !editing) buttons.current.get(previous.current)?.focus()
    if (editing !== previous.current) { setKey(''); setFailure(null) }
    previous.current = editing
  }, [editing])
  // The field keeps focus across a refused check, which disables it briefly.
  // preventScroll: the field sits in a folding container that must not scroll.
  useEffect(() => { if (editing && !busy) input.current?.focus({ preventScroll: true }) }, [editing, busy])

  const act = async (message: Exclude<MediaSettingsRequest, { action: 'status' }>) => {
    setBusy(true); setFailure(null)
    const response = await state.change(message)
    setBusy(false)
    if (response.ok && message.action === 'connect') {
      // The row now says Connected; keyboard focus restarts from the dialog.
      input.current?.closest<HTMLElement>('[role=dialog]')?.focus()
      onEdit(null)
    }
    if (response.ok) return
    setFailure({ provider: message.provider, message: response.error })
  }

  if (state.unavailable) return <p role="status" className="settings-hint settings-unavailable">{state.unavailable}</p>
  return <div className="settings-list" aria-busy={!state.providers}>
    {MEDIA_PROVIDERS.map(provider => {
      const connected = state.providers?.find(item => item.id === provider.id)?.connected ?? false
      const open = editing === provider.id && !connected
      const error = failure?.provider === provider.id ? failure.message : ''
      return <div key={provider.id} className="generation-provider">
        <div className="settings-row">
          <span className="settings-row-lead"><span className="generation-mark" style={{ maskImage: `url("/provider-marks/${provider.id}.svg")` }} aria-hidden="true" /></span>
          <span className="settings-row-text"><span className="settings-row-label">{provider.name}</span><span className="settings-row-detail">{connected ? <span className="settings-ok"><Check aria-hidden="true" />Connected</span> : provider.kinds.map(kind => KINDS[kind]).join(' · ')}</span></span>
          <span className="settings-row-state">{connected
            ? <Button variant="ghost" size="compact" className="settings-quiet" disabled={busy} onClick={() => void act({ action: 'disconnect', provider: provider.id })}>Disconnect</Button>
            : !open && <Button ref={button => { buttons.current.set(provider.id, button) }} variant="secondary" size="compact" className="generation-connect" disabled={!state.providers || busy} onClick={() => onEdit(provider.id)}>Connect</Button>}</span>
        </div>
        <div className="settings-reveal" data-open={open} inert={!open}><div>
          <form className="generation-form" data-folds-on-escape onSubmit={event => { event.preventDefault(); if (key.trim() && !busy) void act({ action: 'connect', provider: provider.id, key }) }}>
            <label htmlFor={`${field}-${provider.id}`} className="sr-only">{provider.name} API key</label>
            <div className="settings-inline-form">
              <Input ref={open ? input : undefined} id={`${field}-${provider.id}`} type="password" value={open ? key : ''} placeholder={'keyHint' in provider ? provider.keyHint : 'Paste API key'} autoComplete="off" spellCheck={false} maxLength={2048} disabled={busy}
                className="settings-field settings-field-compact" onChange={event => { setKey(event.target.value); setFailure(null) }} />
              <Button type="submit" size="compact" disabled={!key.trim() || busy}>{busy ? 'Checking…' : 'Connect'}</Button>
            </div>
            {error && <p role="alert" className="settings-error">{error}</p>}
            <div className="generation-help">
              <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer">Get a key<ArrowUpRight aria-hidden="true" /></a>
              <Button type="button" variant="ghost" size="compact" className="settings-quiet" disabled={busy} onClick={() => onEdit(null)}>Cancel</Button>
            </div>
          </form>
        </div></div>
        {!open && error && <p role="alert" className="settings-error generation-row-error">{error}</p>}
      </div>
    })}
  </div>
}
