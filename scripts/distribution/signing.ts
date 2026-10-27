export type CodeIdentity = { identifier: string; requirement: string; team?: string }

/** Parse public codesign metadata; no certificate or private key material is read. */
export function parseCodeIdentity(details: string): CodeIdentity {
  const identifier = details.match(/^Identifier=(.+)$/m)?.[1]
  // codesign prefixes the designated requirement with `# ` for ad-hoc
  // signatures. That requirement is intentionally a cdhash and is not stable
  // across rebuilds, so callers must keep their existing ad-hoc restrictions.
  const requirement = details.match(/^(?:# )?designated => (.+)$/m)?.[1]
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]
  if (!identifier || !requirement) throw new Error('Code signature has no identity metadata')
  return { identifier, requirement, ...(team && team !== 'not set' ? { team } : {}) }
}

export function readCodeIdentity(path: string): CodeIdentity {
  const result = Bun.spawnSync(['/usr/bin/codesign', '--display', '--verbose=4', '--requirements', '-', path], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`Unable to inspect code signature: ${result.stderr.toString()}`)
  return parseCodeIdentity(result.stdout.toString() + '\n' + result.stderr.toString())
}
