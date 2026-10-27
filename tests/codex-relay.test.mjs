import { test, expect } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NativeMessageDecoder } from '../packages/runtime/src/transport.ts'

const root = resolve(import.meta.dir, '..')
const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
const frame = value => {
  const body = Buffer.from(JSON.stringify(value)), bytes = Buffer.alloc(body.length + 4)
  bytes.writeUInt32LE(body.length); body.copy(bytes, 4)
  return bytes
}
async function* messages(stream) {
  let buffer = Buffer.alloc(0)
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0)
      yield JSON.parse(buffer.subarray(4, length + 4).toString())
      buffer = buffer.subarray(length + 4)
    }
  }
  if (buffer.length) throw new Error('Incomplete native fixture frame')
}

test('native relay preserves split UTF-8 while browser requests arrive in the other direction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-relay-'))
  const fakeCodex = join(directory, 'codex')
  let host
  try {
    // One write contains a complete notification followed by part of a Chinese
    // character. Receiving the notification proves the streaming decoder has
    // consumed that partial character before the browser sends its own frame.
    await writeFile(fakeCodex, `#!${process.execPath}
const text = Buffer.from('画布 🧭')
await Bun.stdout.write(Buffer.concat([Buffer.from('{"method":"fixture/ready"}\\n{"id":"utf8","result":"'), text.subarray(0, 1)]))
for await (const chunk of Bun.stdin.stream()) {
  await Bun.stdout.write(Buffer.concat([text.subarray(1), Buffer.from('"}\\n')]))
  await Bun.stdout.write(JSON.stringify({ id: 'echo', result: JSON.parse(Buffer.from(chunk).toString()).params }) + '\\n')
  break
}
for await (const chunk of Bun.stdin.stream()) {}
`)
    await chmod(fakeCodex, 0o700)
    host = Bun.spawn([process.execPath, join(root, 'native/adapters/codex/host.ts'), origin], {
      env: { ...process.env, GALTA_CODEX_BIN: fakeCodex, GALTA_MCP_BIN: fakeCodex, GALTA_WORKSPACE_DIRECTORY: join(directory, 'workspaces'), GALTA_RUNTIME_DIRECTORY: join(directory, 'runtime') },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const errors = new Response(host.stderr).text()
    const output = messages(host.stdout)
    expect((await output.next()).value).toEqual({ method: 'fixture/ready' })
    host.stdin.write(frame({ id: 'input', method: 'fixture/continue', params: '双向输入 🖼️' }))
    expect((await output.next()).value).toEqual({ id: 'utf8', result: '画布 🧭' })
    expect((await output.next()).value).toEqual({ id: 'echo', result: '双向输入 🖼️' })
    host.stdin.end()
    expect(await host.exited).toBe(0)
    expect(await errors).toBe('')
  } finally {
    host?.kill(); if (host) await host.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test('an invalid explicit Codex executable fails instead of silently selecting another installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-codex-override-'))
  const marker = join(directory, 'fallback-started'), fallback = join(directory, '.local/bin/codex')
  let host
  try {
    await mkdir(join(directory, '.local/bin'), { recursive: true })
    await writeFile(fallback, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, 'started')\n`)
    await chmod(fallback, 0o700)
    host = Bun.spawn([process.execPath, join(root, 'native/adapters/codex/host.ts'), origin], {
      env: { ...process.env, HOME: directory, GALTA_CODEX_BIN: join(directory, 'missing-codex'), GALTA_MCP_BIN: fallback, GALTA_WORKSPACE_DIRECTORY: join(directory, 'workspaces'), GALTA_RUNTIME_DIRECTORY: join(directory, 'runtime') },
      stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
    })
    const error = new Response(host.stderr).text()
    expect(await host.exited).not.toBe(0)
    expect(await error).toContain('missing-codex')
    expect(await readFile(marker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })).toBe(false)
  } finally {
    host?.kill(); if (host) await host.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test('app-server exit closes the native relay while the browser input is still open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-relay-exit-'))
  const fakeCodex = join(directory, 'codex')
  let host, deadline
  try {
    await writeFile(fakeCodex, `#!${process.execPath}\nprocess.exit(17)\n`)
    await chmod(fakeCodex, 0o700)
    host = Bun.spawn([process.execPath, join(root, 'native/adapters/codex/host.ts'), origin], {
      env: { ...process.env, GALTA_CODEX_BIN: fakeCodex, GALTA_MCP_BIN: fakeCodex, GALTA_WORKSPACE_DIRECTORY: join(directory, 'workspaces'), GALTA_RUNTIME_DIRECTORY: join(directory, 'runtime') },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    // Do not end stdin: the browser must learn that its provider has gone away.
    const exited = await Promise.race([host.exited.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), 3000) })])
    expect(exited).toBe(true)
  } finally {
    clearTimeout(deadline); host?.kill(); if (host) await host.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test.skipIf(process.platform !== 'darwin')('native relay completes large responses through a slow nonblocking browser pipe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galta-relay-backpressure-'))
  const fakeCodex = join(directory, 'codex'), launcher = join(directory, 'nonblocking')
  let host, deadline
  try {
    // Chrome/Dia can pass a nonblocking pipe. An ordinary subprocess test
    // misses that boundary, even when its response exceeds the pipe capacity.
    await writeFile(`${launcher}.c`, `#include <fcntl.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  int flags = fcntl(STDOUT_FILENO, F_GETFL);
  if (flags < 0 || fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) return 3;
  execvp(argv[1], argv + 1);
  return 4;
}
`)
    const compiled = Bun.spawnSync(['/usr/bin/cc', '-Wall', '-Wextra', '-Werror', `${launcher}.c`, '-o', launcher])
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0)
    await writeFile(fakeCodex, `#!${process.execPath}
let pending = ''
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk)
  let end
  while ((end = pending.indexOf('\\n')) >= 0) {
    const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
    const result = request.method === 'fixture/large' ? '画布 🧭'.repeat(200000) : 'ready'
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n', error => error ? reject(error) : resolve()))
  }
}
`)
    await chmod(fakeCodex, 0o700)
    host = Bun.spawn([launcher, process.execPath, join(root, 'native/adapters/codex/host.ts'), origin], {
      env: { ...process.env, GALTA_CODEX_BIN: fakeCodex, GALTA_MCP_BIN: fakeCodex, GALTA_WORKSPACE_DIRECTORY: join(directory, 'workspaces'), GALTA_RUNTIME_DIRECTORY: join(directory, 'runtime') },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const errors = new Response(host.stderr).text()
    const output = messages(host.stdout), decoder = new NativeMessageDecoder()
    await Promise.race([(async () => {
      host.stdin.write(frame({ id: 'large', method: 'fixture/large' }))
      await Bun.sleep(100) // Let the browser pipe fill before consuming it.
      let result, fragments = 0
      while (!result) {
        const next = await output.next()
        expect(next.done).toBe(false)
        result = decoder.push(next.value); fragments++
        await Bun.sleep(2)
      }
      expect(fragments).toBeGreaterThan(1)
      expect(result).toEqual({ id: 'large', result: '画布 🧭'.repeat(200000) })
      host.stdin.write(frame({ id: 'after', method: 'fixture/status' }))
      expect((await output.next()).value).toEqual({ id: 'after', result: 'ready' })
      host.stdin.end()
      expect(await host.exited).toBe(0)
      expect(await errors).toBe('')
    })(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Native output stalled under backpressure')), 4000) })])
  } finally {
    clearTimeout(deadline); host?.kill(); if (host) await host.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
