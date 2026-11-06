import { join } from 'node:path'
import { galtaPaths } from '../paths'
import { readRelease } from './release'
import { assertRegistration, ReleaseChangedError } from './registration'
import { inspectRelease } from './health'
import { inspectCodex, startCodexDownload } from './codex'
import { runtimeCommand } from '../launch'
import { createNativeSender } from '../messaging'
import { mediaSettings } from '../media/settings'
import { transcribeRecording } from './speech'

const directory = process.env.GALTA_RELEASE_DIRECTORY
if (!directory) throw new Error('Start the companion through its installed launcher')
const origin = Bun.argv[2]
let input = Buffer.alloc(0)
const send = createNativeSender()

/** The browser shows this sentence: what is wrong on this Mac and the step that fixes it. */
function problem(error: unknown) {
  if (error instanceof ReleaseChangedError) return 'Galta for Mac was just updated. Try again.'
  return 'Galta for Mac needs to repair this browser’s connection. Open Galta on your Mac and choose “Repair connection”.'
}

const reader = Bun.stdin.stream().getReader()
while (true) {
  const { value: chunk, done } = await reader.read()
  if (done) break
  input = Buffer.concat([input, chunk])
  if (input.length < 4) continue
  const length = input.readUInt32LE(0)
  if (length > 2_700_000) throw new Error('Companion request is too large')
  if (input.length < 4 + length) continue
  const message = JSON.parse(input.subarray(4, 4 + length).toString())
  // Every request gets an answer. Chrome reports a host that exits without
  // one only as “Native host has exited.”, which names neither cause nor step.
  const fail = (error: string) => send(message.method === 'media/settings' || message.method === 'speech/transcribe' ? { ok: false, error } : { error })
  try {
    const { release } = await readRelease(directory)
    if (origin !== `chrome-extension://${release.extensionId}/`) throw new Error('Unexpected extension origin')
    if (!['status', 'media/settings', 'codex/download', 'speech/transcribe'].includes(message.method) || message.method !== 'speech/transcribe' && length > 4096) { await fail('Update Galta for Mac to use this.'); break }
    try { await assertRegistration(directory, release.extensionId) }
    catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      await fail(problem(error))
      break
    }
    if (message.method === 'speech/transcribe') {
      const disconnected = new AbortController()
      // Native messaging closes stdin when the owning browser port closes.
      // Keep reading while the Mac app works so cancellation reaches it.
      void reader.read().then(() => disconnected.abort(), () => disconnected.abort())
      const response = await transcribeRecording(directory, message.params, disconnected.signal)
      if (!disconnected.signal.aborted) await send(response)
    }
    else if (message.method === 'media/settings') await send(await mediaSettings(message.params))
    else {
      // Downloading Codex is always the user's explicit request; the reply is the status that follows.
      if (message.method === 'codex/download') await startCodexDownload(runtimeCommand('codex-download'))
      await send({ ...await inspectRelease(directory), codex: await inspectCodex(), mcpCommand: join(galtaPaths.dataDirectory, 'current', 'Resources', 'galta-mcp') })
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    await fail('Galta for Mac couldn’t answer. Open Galta on your Mac to check the connection.')
  }
  break
}
