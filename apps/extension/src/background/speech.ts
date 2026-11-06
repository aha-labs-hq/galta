import { speechRequestSchema, speechResponseSchema, type SpeechResponse } from '@galta/capture'
import { isGaltaPage } from './setup'

/** Closing the view's port cancels its native invocation. Content scripts
 * cannot submit audio or request speech permission. */
export function attachSpeech(client: chrome.runtime.Port) {
  if (!client.sender || !isGaltaPage(client.sender)) { client.disconnect(); return }
  let native: chrome.runtime.Port | undefined, timer: ReturnType<typeof setTimeout> | undefined, finished = false
  const close = () => { finished = true; clearTimeout(timer); native?.disconnect(); native = undefined }
  const reply = (value: SpeechResponse) => { if (finished) return; try { client.postMessage(value) } finally { close() } }
  client.onDisconnect.addListener(close)
  client.onMessage.addListener(value => {
    if (finished || native) return
    const request = speechRequestSchema.safeParse(value)
    if (!request.success) { reply({ ok: false, error: 'The recording audio is invalid or too large.' }); return }
    try {
      native = chrome.runtime.connectNative('com.galta.companion')
      native.onMessage.addListener(value => {
        const response = speechResponseSchema.safeParse(value)
        reply(response.success ? response.data : { ok: false, error: 'Update Galta for Mac to transcribe recorded requests.' })
      })
      native.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message
        reply({ ok: false, error: error === 'Specified native messaging host not found.' ? 'Connect Galta for Mac to this browser to transcribe recordings.' : 'Galta for Mac could not transcribe this recording. Check the Mac app and try again.' })
      })
      timer = setTimeout(() => reply({ ok: false, error: 'Apple Speech did not respond in time. Check Speech Recognition permission for Galta.' }), 100_000)
      native.postMessage({ method: 'speech/transcribe', params: request.data })
    } catch { reply({ ok: false, error: 'Connect Galta for Mac to this browser to transcribe recordings.' }) }
  })
}
