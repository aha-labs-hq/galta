/** One embedded runtime, with isolated process roles and no resident daemon. */
import '../launch'
const role = Bun.argv[2]
process.argv.splice(2, 1)
try {
  switch (role) {
    case 'canvas': await import('../bridge/host'); break
    case 'codex': await import('../adapters/codex/host'); break
    case 'mcp': await import('../mcp/main'); break
    case 'companion': await import('./host'); break
    case 'install': {
      const { activateRelease } = await import('./activation')
      if (!Bun.argv[2]) throw new Error('A release directory is required')
      console.log(JSON.stringify(await activateRelease(Bun.argv[2])))
      break
    }
    case 'codex-download': {
      const { downloadCodex } = await import('./codex')
      await downloadCodex()
      break
    }
    case 'inspect': {
      const { inspectInstallation } = await import('./installation')
      if (!Bun.argv[2]) throw new Error('A release directory is required')
      console.log(JSON.stringify(await inspectInstallation(Bun.argv[2])))
      break
    }
    default: throw new Error('Expected canvas, codex, mcp, companion, install, inspect or codex-download')
  }
} catch (error) {
  // The Mac app shows this text under What happened. One line, never the
  // compiled bundle's source excerpt and stack.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
export {}
