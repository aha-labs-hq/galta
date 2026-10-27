import { createPublicKey, verify } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { run, type Distribution } from './config'

/** Sparkle owns signatures, feed generation and installation; Galta only binds release identity. */
export async function createAppcast(archive: string, staging: string, sparkle: string, config: Distribution, releaseNotes: string) {
  if (!config.appcastUrl || !config.updatePublicKey) throw new Error('Update configuration is missing')
  const account = process.env.GALTA_SPARKLE_KEY_ACCOUNT ?? 'ed25519'
  const signature = run([join(sparkle, 'bin/sign_update'), '--account', account, '-p', archive]).trim()
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(config.updatePublicKey, 'base64')]), format: 'der', type: 'spki' })
  if (!verify(null, await readFile(archive), key, Buffer.from(signature, 'base64'))) throw new Error('The update signing key does not match the app’s embedded public key')
  const directory = join(staging, 'updates')
  await mkdir(directory)
  await copyFile(archive, join(directory, basename(archive)))
  // Sparkle pairs notes with the archive of the same name; embedding keeps them inside the signed feed.
  await copyFile(releaseNotes, join(directory, basename(archive).replace(/\.zip$/, '.html')))
  run([join(sparkle, 'bin/generate_appcast'), '--account', account, '--download-url-prefix', new URL('.', config.appcastUrl).href, '--embed-release-notes', directory])
  const feed = join(directory, 'appcast.xml')
  run([join(sparkle, 'bin/sign_update'), '--account', account, '--verify', feed])
  return feed
}
