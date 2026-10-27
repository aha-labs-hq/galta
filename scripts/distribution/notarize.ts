import { writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

export type NotaryCredentials = { profile: string; keychain: string }

export function notaryCredentials(env = process.env): NotaryCredentials {
  const profile = env.GALTA_NOTARY_PROFILE?.trim(), keychain = env.GALTA_NOTARY_KEYCHAIN?.trim()
  if (!profile || !keychain || !isAbsolute(keychain)) throw new Error('Set GALTA_NOTARY_PROFILE and an absolute GALTA_NOTARY_KEYCHAIN path')
  return { profile, keychain }
}

/** Keep Apple's submission ID and result even if waiting times out or review fails. */
export async function notarize(artifact: string, credentials: NotaryCredentials, evidence: string) {
  const auth = ['--keychain-profile', credentials.profile, '--keychain', credentials.keychain]
  async function command(args: string[], name: string) {
    const child = Bun.spawn(['/usr/bin/xcrun', 'notarytool', ...args, ...auth, '--output-format', 'json'], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const record = join(evidence, `${basename(artifact)}.${name}.json`)
    await writeFile(record, JSON.stringify({ exitCode, stdout, stderr }, null, 2) + '\n')
    if (exitCode !== 0) throw new Error(`Notarization ${name} failed; see ${record}. ${stderr.slice(-2000)}`)
    return JSON.parse(stdout) as { id?: string; status?: string }
  }
  const submission = await command(['submit', artifact, '--no-wait'], 'submission')
  if (!submission.id || !/^[0-9a-f-]{36}$/i.test(submission.id)) throw new Error('Apple did not return a notarization submission ID')
  console.log(`Apple submission ${submission.id}: ${basename(artifact)}`)
  const result = await command(['wait', submission.id, '--timeout', '30m'], 'result')
  if (result.status !== 'Accepted') throw new Error(`Apple submission ${submission.id}: ${result.status ?? 'unknown status'}. Inspect it with notarytool log before rebuilding.`)
  return submission.id
}
