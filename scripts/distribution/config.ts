import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export type Distribution = {
  channel: 'development' | 'beta' | 'stable'; build: number; extensionId: string
  extensionPublicKey?: string; downloadUrl?: string; appcastUrl?: string; updatePublicKey?: string
}
export const root = resolve(import.meta.dir, '../..')
export const minimumMacOS = '15.0'

export function validateDistribution(value: Distribution) {
  if (!['development', 'beta', 'stable'].includes(value.channel) || !/^[a-p]{32}$/.test(value.extensionId)
    || !Number.isSafeInteger(value.build) || value.build < 1) throw new Error('Invalid distribution channel, extension ID or build number')
  if (value.channel !== 'development') {
    if (!value.extensionPublicKey || !value.downloadUrl || !value.appcastUrl || !value.updatePublicKey) throw new Error('A release needs its verified store key, download URL, appcast URL and public update key')
    const id = createHash('sha256').update(Buffer.from(value.extensionPublicKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)))
    if (id !== value.extensionId) throw new Error('The extension ID does not match its store public key')
    if (Buffer.from(value.updatePublicKey, 'base64').length !== 32) throw new Error('Expected an Ed25519 public update key')
  }
  for (const url of [value.downloadUrl, value.appcastUrl]) if (url) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /YOUR_DOMAIN|example\.(com|org)/i.test(parsed.hostname)) throw new Error('Distribution URLs must be real HTTPS endpoints')
  }
  return value
}

export function run(args: string[], cwd = root, env = process.env) {
  const child = Bun.spawnSync(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  if (child.exitCode !== 0) throw new Error(`${args[0]} failed: ${child.stderr.toString().slice(-5000)}`)
  return child.stdout.toString()
}
