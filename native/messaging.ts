import { encodeNativeMessages } from '../packages/runtime/src/transport'

/** One ordered writer per host, including when the browser pipe applies backpressure. */
export function createNativeSender() {
  let output = Promise.resolve()
  return (message: unknown): Promise<void> => {
    output = output.then(async () => {
      for (const part of encodeNativeMessages(message)) {
        const bytes = Buffer.from(JSON.stringify(part))
        if (bytes.length > 1024 * 1024) throw new Error('Outgoing native message is too large')
        const frame = Buffer.alloc(bytes.length + 4)
        frame.writeUInt32LE(bytes.length)
        bytes.copy(frame, 4)
        // Browser pipes can be nonblocking. The stream waits for writable
        // capacity; Bun.stdout.write can stall its worker after a partial write.
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(frame, error => error ? reject(error) : resolve())
        })
      }
    })
    return output
  }
}
