import { assessCompanion, type SetupStatus } from '@galta/runtime'
import type { MediaSettingsRequest, MediaSettingsResponse } from '@galta/canvas'

type Unreachable = { absent: boolean; detail: string }

/** Chrome reports native host failures with fixed strings. Say what each means on this Mac. */
function unreachable(message: string | undefined): Unreachable {
  if (message === 'Specified native messaging host not found.') return { absent: true, detail: 'Galta for Mac isn’t connected to this browser. Open Galta on your Mac and choose “Connect browser”.' }
  if (message === 'Access to the specified native messaging host is forbidden.') return { absent: false, detail: 'Galta for Mac on this Mac is set up for a different copy of the Galta extension. Use that extension, or the Mac app made for this one.' }
  return { absent: false, detail: 'Galta for Mac couldn’t answer. Open Galta on your Mac to check the connection.' }
}

/** One short-lived exchange with the Mac app's companion host. */
function companion<T>(message: Record<string, unknown>, timeoutMs: number, answer: (value: unknown) => T, failed: (problem: Unreachable) => T): Promise<T> {
  return new Promise(resolve => {
    let port: chrome.runtime.Port | undefined
    let finished = false
    const finish = (result: T) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      port?.disconnect()
      resolve(result)
    }
    // Chrome starts the host itself; the Mac app does not need to be open.
    const timeout = setTimeout(() => finish(failed({ absent: false, detail: 'Galta for Mac didn’t answer in time. Try again.' })), timeoutMs)
    try {
      port = chrome.runtime.connectNative('com.galta.companion')
      port.onMessage.addListener(value => finish(answer(value)))
      port.onDisconnect.addListener(() => finish(failed(unreachable(chrome.runtime.lastError?.message))))
      port.postMessage(message)
    } catch { finish(failed(unreachable(undefined))) }
  })
}

/** No account or Codex connection is needed to diagnose the installation. */
export function checkSetup(): Promise<SetupStatus> {
  return companion({ method: 'status' }, 8_000, assessCompanion, ({ absent, detail }) => ({ state: absent ? 'absent' : 'unavailable', detail }))
}

/** Provider keys come only from Galta's own pages (the canvas and the side
 * panel), never from a content script running inside a website. */
export function isGaltaPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''))
}

/** Checking a key waits for the provider, so this allows longer than a status check. */
export function mediaSettings(request: MediaSettingsRequest): Promise<MediaSettingsResponse> {
  return companion({ method: 'media/settings', params: request }, 25_000,
    value => value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean' ? value as MediaSettingsResponse : { ok: false, error: 'Update Galta for Mac to connect providers.' },
    ({ detail }) => ({ ok: false, error: detail }))
}
