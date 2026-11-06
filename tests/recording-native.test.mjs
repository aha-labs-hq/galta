import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skipIf(process.platform !== 'darwin')('native speech coverage and repair preserve the original audio clock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'galta-speech-tests-'))
  try {
    for (const name of ['SpeechAudioTests', 'RecordingSpeechTests']) {
      const binary = join(dir, name)
      const build = Bun.spawn(['swiftc', '-parse-as-library', '-warnings-as-errors', 'native/speech/SpeechAudio.swift', 'native/speech/SpeechAccumulator.swift', `tests/native/${name}.swift`, '-o', binary], { stdout: 'pipe', stderr: 'pipe' })
      const errors = await new Response(build.stderr).text()
      expect(await build.exited, errors).toBe(0)
      const run = Bun.spawn([binary], { stdout: 'pipe', stderr: 'pipe' })
      expect(await run.exited, await new Response(run.stderr).text()).toBe(0)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 30_000)
