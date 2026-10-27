import { useCallback, useEffect, useState } from 'react'
import { ACCOUNT_KEY, GOOGLE_KEY, type AccountRequest, type AccountResponse, type AccountState } from '../shared/account'

const SIGNED_OUT: AccountState = { user: null, ended: false, google: null }

/** A page that cannot reach the background learns nothing about the account:
 * its state is null, never "signed out". */
type Answer = { ok: true; state: AccountState } | { ok: false; error: string; state: AccountState | null }
async function request(message: AccountRequest): Promise<Answer> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return { ok: false, error: 'Open Galta in your browser to sign in.', state: SIGNED_OUT }
  try {
    const response: AccountResponse | undefined = await chrome.runtime.sendMessage({ type: 'account', request: message })
    if (response && typeof response.state === 'object' && response.state !== null) return response
  } catch { /* the background is gone, as after an extension reload */ }
  return { ok: false, error: 'Reload this canvas to reconnect to Galta.', state: null }
}

export type Account = {
  /** Null until the background first answers. */
  state: AccountState | null
  unavailable: string | null
  act(message: Exclude<AccountRequest, { action: 'status' }>): Promise<Answer>
}

/** This browser's Aha Labs account, as the background owns it. Every open Galta
 * page follows the same record, so signing in from the side panel updates a
 * full canvas tab too. */
export function useAccount(): Account {
  const [state, setState] = useState<AccountState | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    const answer = await request({ action: 'status' })
    if (answer.state) { setState(answer.state); setUnavailable(null) }
    else if (!answer.ok) setUnavailable(answer.error)
  }, [])
  useEffect(() => {
    void refresh()
    const changed = (changes: Record<string, unknown>) => { if (ACCOUNT_KEY in changes || GOOGLE_KEY in changes) void refresh() }
    const focus = () => { void refresh() }
    const storage = typeof chrome === 'undefined' ? undefined : chrome.storage?.onChanged
    storage?.addListener(changed)
    window.addEventListener('focus', focus)
    return () => { storage?.removeListener(changed); window.removeEventListener('focus', focus) }
  }, [refresh])
  const act = useCallback(async (message: Exclude<AccountRequest, { action: 'status' }>) => {
    const response = await request(message)
    if (response.state) { setState(response.state); setUnavailable(null) }
    else if (!response.ok) setUnavailable(response.error)
    return response
  }, [])
  return { state, unavailable, act }
}
