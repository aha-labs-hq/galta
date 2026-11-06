/** In-memory end of the same message/port protocol used by Chrome. */
export function portEvent<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>()
  return { addListener: (listener: T) => { listeners.add(listener) }, removeListener: (listener: T) => { listeners.delete(listener) },
    getRules() { throw new Error('Declarative event rules are unavailable on the local host.') },
    removeRules() { throw new Error('Declarative event rules are unavailable on the local host.') },
    addRules() { throw new Error('Declarative event rules are unavailable on the local host.') },
    hasListener: (listener: T) => listeners.has(listener), hasListeners: () => listeners.size > 0,
    emit: (...args: Parameters<T>) => { for (const listener of [...listeners]) listener(...args) } }
}
export function runtimePort(name: string, send: (value: unknown) => void, close: () => void) {
  const onMessage = portEvent<(message: any, port: chrome.runtime.Port) => void>()
  const onDisconnect = portEvent<(port: chrome.runtime.Port) => void>()
  let closed = false
  const port: chrome.runtime.Port = { name, onMessage, onDisconnect, postMessage(value) { if (closed) throw new Error('The local connection closed.'); send(value) }, disconnect() { if (!closed) { closed = true; close() } } }
  return { port, receive: (value: unknown) => { if (!closed) onMessage.emit(value, port) },
    ended: () => { if (!closed) { closed = true; onDisconnect.emit(port) } } }
}
