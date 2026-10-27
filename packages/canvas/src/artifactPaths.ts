/** Browser-safe path helpers for native artifact paths supplied by the bridge. */
const MANAGED_REFERENCE = 'galta-workspace:/'

export const MANAGED_ARTIFACT_SCHEME = MANAGED_REFERENCE

export function isManagedArtifactReference(value: string): boolean {
  return value.startsWith(MANAGED_REFERENCE)
}

export function isAbsoluteArtifactPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path)
}

export function joinArtifactPath(root: string, ...segments: string[]): string {
  if (!isAbsoluteArtifactPath(root)) throw new Error('An absolute creative workspace path is required')
  const separator = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\') ? '\\' : '/'
  const cleanRoot = root.replace(/[\\/]+$/, '') || separator
  const cleanSegments = segments.map(segment => {
    if (!segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)) throw new Error('Invalid artifact path segment')
    return segment
  })
  return cleanRoot === separator ? `${separator}${cleanSegments.join(separator)}` : [cleanRoot, ...cleanSegments].join(separator)
}

function reference(segments: readonly string[]): string | undefined {
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) return undefined
  return MANAGED_REFERENCE + segments.map(encodeURIComponent).join('/')
}

/** Remove machine-specific roots from legacy workspace artifact metadata. */
export function canonicalManagedArtifactReference(path: string): string {
  if (path.startsWith(MANAGED_REFERENCE)) {
    try { return reference(path.slice(MANAGED_REFERENCE.length).split('/').map(decodeURIComponent)) ?? path }
    catch { return path }
  }
  if (!isAbsoluteArtifactPath(path)) return path
  const pathParts = path.split(/[\\/]+/).filter(Boolean)
  for (let index = pathParts.length - 2; index >= 0; index--) {
    if (pathParts[index - 1]?.toLowerCase() !== 'galta' || pathParts[index]?.toLowerCase() !== 'workspaces' || !/^[a-f0-9]{32}$/i.test(pathParts[index + 1]!)) continue
    return reference(pathParts.slice(index + 2)) ?? path
  }
  return path
}

/** Store a current absolute artifact path without the user's machine root. */
export function managedArtifactReference(path: string, workspace: string): string {
  if (!isAbsoluteArtifactPath(path) || !isAbsoluteArtifactPath(workspace)) return path
  const windows = /^[A-Za-z]:[\\/]/.test(workspace) || workspace.startsWith('\\\\')
  const clean = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  const root = clean(workspace), candidate = clean(path)
  const compareRoot = windows ? root.toLowerCase() : root
  const compareCandidate = windows ? candidate.toLowerCase() : candidate
  if (!compareCandidate.startsWith(`${compareRoot}/`)) return path
  return reference(candidate.slice(root.length + 1).split('/')) ?? path
}

/** Resolve stable references and rebase legacy absolute paths after a move. */
export function resolveManagedArtifactPath(path: string, workspace: string): string {
  const canonical = canonicalManagedArtifactReference(path)
  if (canonical.startsWith(MANAGED_REFERENCE)) {
    try { return joinArtifactPath(workspace, ...canonical.slice(MANAGED_REFERENCE.length).split('/').map(decodeURIComponent)) }
    catch { return path }
  }
  return path
}
