import { installWebRuntime, type HostRuntime } from '../shared/hostRuntime'
import { portEvent, runtimePort } from '../shared/runtimePort'

/** Local development transport only; the canvas and task executor are unchanged. */
export async function startWebHost() {
  const response = await fetch('/__galta/session', { headers: { 'X-Galta-Web': '1' } })
  if (!response.ok) throw new Error('Start the local web app with bun run web:dev.')
  const { endpoint, token } = await response.json() as { endpoint: string; token: string }
  const socket = new WebSocket(endpoint, ['galta-local', token])
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('The local Galta service could not be reached.'))
  })
  const notifications = portEvent<Parameters<HostRuntime['onMessage']['addListener']>[0]>()
  const ports = new Map<string, ReturnType<typeof runtimePort>>()
  const requests = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  const hostChannel = new BroadcastChannel('galta-web-task-host')
  let taskReady = false, claimed = false
  const lifetime = new AbortController()
  const send = (value: unknown) => { if (socket.readyState !== WebSocket.OPEN) throw new Error('The local Galta service disconnected. Reload to reconnect.'); socket.send(JSON.stringify(value)) }
  hostChannel.onmessage = ({ data }) => { if (data === 'ping' && taskReady) hostChannel.postMessage('ready') }
  const ensureTasks = async () => {
    const ready = new Promise<void>((resolve, reject) => {
      const done = ({ data }: MessageEvent) => { if (data === 'ready') { clearTimeout(timeout); hostChannel.removeEventListener('message', done); resolve() } }
      const timeout = setTimeout(() => { hostChannel.removeEventListener('message', done); reject(new Error('The local task host did not start. Reload this page.')) }, 15_000)
      hostChannel.addEventListener('message', done)
    })
    if (!claimed) {
      claimed = true
      // One task executor per origin. Other tabs observe the same real tasks.
      void navigator.locks.request('galta-web-task-host', { signal: lifetime.signal }, async () => {
        const iframe = document.createElement('iframe'); iframe.hidden = true; iframe.src = '/tasks/index.html'; iframe.title = 'Galta tasks'; document.body.append(iframe)
        try { await new Promise<void>(resolve => lifetime.signal.addEventListener('abort', () => resolve(), { once: true })) }
        finally { taskReady = false; iframe.remove() }
      }).catch(error => { if (!lifetime.signal.aborted) console.error('Local task host failed', error) })
    }
    hostChannel.postMessage('ping')
    await ready
    return { ok: true }
  }
  const runtime: HostRuntime = {
    onMessage: notifications, lastError: undefined,
    connect(...args: any[]) {
      const name = (args[0] as { name?: string })?.name ?? '', id = crypto.randomUUID()
      const channel = runtimePort(name, value => send({ type: 'port-message', id, value }), () => { ports.delete(id); send({ type: 'port-close', id }) })
      ports.set(id, channel); send({ type: 'port-open', id, name })
      if (name === 'galta-task-host') { taskReady = true; hostChannel.postMessage('ready') }
      return channel.port
    },
    sendMessage: (async (message: any) => {
      if (message.type === 'task-host-ensure') return ensureTasks()
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { requests.delete(id); reject(new Error('The local Galta service did not respond.')) }, 70_000)
        requests.set(id, { resolve: value => { clearTimeout(timeout); resolve(value) }, reject: error => { clearTimeout(timeout); reject(error) } })
        try { send({ type: 'request', id, message }) } catch (error) { requests.get(id)?.reject(error as Error); requests.delete(id) }
      })
    }) as HostRuntime['sendMessage']
  }
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.type === 'notification') notifications.emit(message.value, {}, () => {})
    else if (message.type === 'port-message') ports.get(message.id)?.receive(message.value)
    else if (message.type === 'port-close') { ports.get(message.id)?.ended(); ports.delete(message.id) }
    else if (message.type === 'response') { const pending = requests.get(message.id); requests.delete(message.id); message.error ? pending?.reject(new Error(message.error)) : pending?.resolve(message.value) }
  }
  socket.onclose = () => {
    // A disconnected tab must release its executor lock and stop announcing
    // readiness to other tabs. A reloaded tab can then own the replacement.
    lifetime.abort(); taskReady = false; hostChannel.close()
    for (const pending of requests.values()) pending.reject(new Error('The local Galta service disconnected. Reload to reconnect.'))
    requests.clear(); for (const channel of ports.values()) channel.ended(); ports.clear()
    notifications.emit({ type: 'task-host-closed' }, {}, () => {})
  }
  window.addEventListener('pagehide', () => { lifetime.abort(); socket.close(); hostChannel.close() }, { once: true })
  installWebRuntime(runtime)
}
