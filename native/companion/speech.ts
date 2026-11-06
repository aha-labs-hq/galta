import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { speechRequestSchema, speechResponseSchema, type SpeechResponse } from '@galta/capture'
import { speechBundle } from './release'

/** Launch Services makes Galta, rather than the browser or terminal, the owner
 * of speech permission. The one-use socket is local, private and cancellable. */
export async function transcribeRecording(directory: string, input: unknown, signal: AbortSignal): Promise<SpeechResponse> {
  const request = speechRequestSchema.safeParse(input)
  if (!request.success) return { ok: false, error: 'The recording audio is invalid or too large.' }
  signal.throwIfAborted()
  const temporary = await mkdtemp(join(tmpdir(), 'galta-speech-'))
  await chmod(temporary, 0o700)
  let connection: Socket | undefined
  const server = createServer()
  try {
    return await new Promise<SpeechResponse>(resolve => {
      let finished = false
      const finish = (value: SpeechResponse) => {
        if (finished) return; finished = true
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        connection?.destroy(); server.close(); resolve(value)
      }
      const abort = () => finish({ ok: false, error: 'Transcription cancelled.' })
      const timer = setTimeout(() => finish({ ok: false, error: 'Apple Speech did not finish. Check Speech Recognition permission for Galta, then try again.' }), 95_000)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      server.on('error', () => finish({ ok: false, error: 'Could not open the local speech connection.' }))
      server.on('connection', socket => {
        if (connection || finished) { socket.destroy(); return }
        connection = socket
        const data = Buffer.from(JSON.stringify(request.data)), header = Buffer.alloc(4)
        header.writeUInt32LE(data.length)
        socket.write(Buffer.concat([header, data]))
        const chunks: Buffer[] = []; let bytes = 0
        socket.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 300_000) { finish({ ok: false, error: 'Apple Speech returned too much data.' }); return }
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        })
        socket.on('end', () => {
          try {
            const result = speechResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString()))
            if (result.ok && result.id !== request.data.id) throw new Error('Mismatched recording')
            finish(result)
          } catch { finish({ ok: false, error: 'Apple Speech returned an invalid result.' }) }
        })
        socket.on('error', () => finish({ ok: false, error: 'The speech connection closed.' }))
        socket.on('close', () => finish({ ok: false, error: 'The speech connection closed.' }))
      })
      const endpoint = join(temporary, 'speech.sock')
      server.listen(endpoint, () => {
        if (finished) { server.close(); return }
        try {
          const launch = Bun.spawn(['/usr/bin/open', '-n', '-g', join(directory, speechBundle), '--args', '--transcribe-recording', endpoint], { stdout: 'ignore', stderr: 'ignore' })
          void launch.exited.then(code => { if (code !== 0) finish({ ok: false, error: 'Update Galta for Mac to transcribe recorded requests.' }) })
        } catch { finish({ ok: false, error: 'Could not start Galta speech recognition.' }) }
      })
    })
  } finally { connection?.destroy(); server.close(); await rm(temporary, { recursive: true, force: true }) }
}
