import type { Stats } from 'node:fs'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { galtaBridgeDirectory } from '../paths'
import { join } from 'node:path'
import { assertGaltaToolContract, galtaToolContract } from '../../packages/canvas/src/contract'

type Descriptor = { version: number; id: string; port: number; token: string; toolContract?: unknown }
type Waiter = { resolve: (value: any) => void; reject: (error: Error) => void }
class UnavailableBridge extends Error {}
/** A live bridge from a browser whose Galta build has different tools. */
class IncompatibleBridge extends Error {}
export class BridgeClient {
  private readonly pending = new Map<string, Waiter>()
  private constructor(readonly id: string, private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data))
        const waiter = this.pending.get(message.id)
        if (message.error) waiter?.reject(new Error(message.error.message))
        else waiter?.resolve(message.result)
      } catch { this.close() }
    })
    socket.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('Galta bridge disconnected'))
      this.pending.clear()
    })
  }

  static async open(descriptor: Descriptor) {
    if (descriptor.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !/^[\da-f-]{36}$/.test(descriptor.id) || !/^[\da-f-]{36}$/.test(descriptor.token)) throw new Error('Invalid Galta bridge descriptor')
    // The descriptor cannot redirect a local credential to another host.
    const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}/bridge`, { headers: { Authorization: `Bearer ${descriptor.token}` } })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new UnavailableBridge('Galta bridge connection timed out')) }, 2000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timeout); socket.close(); reject(new UnavailableBridge('Galta bridge is not running')) }, { once: true })
    })
    // Check only live bridges: abandoned descriptors must not block discovery.
    try { await assertGaltaToolContract(descriptor.toolContract) }
    catch (error) { socket.close(); throw new IncompatibleBridge(error instanceof Error ? error.message : String(error)) }
    return new BridgeClient(descriptor.id, socket)
  }

  async request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    if (['connect', 'call', 'execution/call', 'execution/workspace'].includes(method)) params = { ...params, toolContract: await galtaToolContract() }
    signal?.throwIfAborted()
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Galta bridge disconnected')
    const id = crypto.randomUUID()
    const cancel = () => {
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ method: 'cancel', params: { requestId: id } }))
      this.pending.get(id)?.reject(new Error('Canvas operation cancelled'))
      // A completed connect may have a lease whose reply has not reached us.
      // Closing its owner releases that lease even after the request is gone.
      if (method === 'connect') this.close()
    }
    const timeout = setTimeout(() => { cancel(); this.close() }, 65_000)
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        signal?.addEventListener('abort', cancel, { once: true })
        this.socket.send(JSON.stringify({ id, method, params }))
      })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      this.pending.delete(id)
    }
  }

  close() { this.socket.close() }
}

const defaultDirectory = () => process.env.GALTA_BRIDGE_DIRECTORY ?? galtaBridgeDirectory
const unsafe = (info: Stats) => {
  const currentUid = process.getuid?.()
  return info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077 || (currentUid !== undefined && info.uid !== currentUid)))
}

/** False when no bridge has ever run. A directory others could write is never trusted. */
async function bridgeDirectory(directory: string) {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || unsafe(info)) throw new Error('Unsafe Galta bridge directory permissions')
    return true
  } catch (error: any) { if (error.code === 'ENOENT') return false; throw error }
}

async function openDescriptor(directory: string, name: string) {
  const path = join(directory, name)
  const info = await lstat(path)
  if (!info.isFile() || unsafe(info)) throw new Error('Unsafe Galta bridge descriptor permissions')
  let descriptor: Descriptor
  // A bridge creates its descriptor before writing it; it is not live yet.
  try { descriptor = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error instanceof SyntaxError) throw new UnavailableBridge('Galta bridge is starting'); throw error }
  if (name !== `${descriptor.id}.json`) throw new Error('Invalid Galta bridge descriptor identity')
  return BridgeClient.open(descriptor)
}

/** The one bridge a bound call belongs to. Other browsers' bridges, live,
 * stale or built with other tools, never affect it. */
export async function openBridge(id: string, directory = defaultDirectory()): Promise<BridgeClient | undefined> {
  if (!/^[\da-f-]{36}$/.test(id) || !await bridgeDirectory(directory)) return undefined
  try { return await openDescriptor(directory, `${id}.json`) }
  catch (error: any) { if (error instanceof UnavailableBridge || error.code === 'ENOENT') return undefined; throw error }
}

/** Every live, compatible bridge. A bridge with other tools is left out and
 * reported, so one browser that has not reloaded Galta hides no other canvas. */
export async function discoverBridges(directory = defaultDirectory()): Promise<{ bridges: BridgeClient[]; incompatible: string[] }> {
  if (!await bridgeDirectory(directory)) return { bridges: [], incompatible: [] }
  const files = await readdir(directory)
  const results = await Promise.allSettled(files.filter(name => name.endsWith('.json')).map(name => openDescriptor(directory, name)))
  // Stale descriptors left by a killed process are discoverable but not live canvases.
  const failure = results.find(result => result.status === 'rejected' && !(result.reason instanceof UnavailableBridge) && !(result.reason instanceof IncompatibleBridge) && result.reason?.code !== 'ENOENT')
  const bridges = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  if (failure?.status === 'rejected') { bridges.forEach(bridge => bridge.close()); throw failure.reason }
  return { bridges, incompatible: results.flatMap(result => result.status === 'rejected' && result.reason instanceof IncompatibleBridge ? [result.reason.message] : []) }
}
