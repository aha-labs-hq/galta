import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

type Environment = Readonly<Record<string, string | undefined>>
type PathOptions = { platform?: NodeJS.Platform; home?: string; env?: Environment }

/**
 * Galta owns one platform-native private data root. Source checkouts and
 * user-selected export locations are deliberately outside this hierarchy.
 */
export function resolveGaltaPaths({ platform = process.platform, home = homedir(), env = process.env }: PathOptions = {}) {
  const path = platform === 'win32' ? win32 : posix
  let dataDirectory: string
  if (platform === 'darwin') {
    dataDirectory = path.join(home, 'Library', 'Application Support', 'Galta')
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    if (!localAppData || !win32.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be an absolute path for Galta on Windows')
    dataDirectory = path.join(localAppData, 'Galta')
  } else {
    const xdgDataHome = env.XDG_DATA_HOME?.trim()
    if (xdgDataHome && !posix.isAbsolute(xdgDataHome)) throw new Error('XDG_DATA_HOME must be an absolute path')
    dataDirectory = path.join(xdgDataHome || path.join(home, '.local', 'share'), 'galta')
  }

  const legacyDefault = platform === 'darwin' || (platform !== 'win32' && Boolean(env.XDG_DATA_HOME))
    ? posix.join(home, '.local', 'share', 'galta')
    : undefined
  return {
    dataDirectory,
    binaryDirectory: path.join(dataDirectory, 'bin'),
    bridgeDirectory: path.join(dataDirectory, 'bridges'),
    runtimeDirectory: path.join(dataDirectory, 'runtime'),
    workspaceDirectory: path.join(dataDirectory, 'workspaces'),
    mediaDirectory: path.join(dataDirectory, 'media'),
    /** Codex that Galta downloaded or kept, one directory per version. */
    codexDirectory: path.join(dataDirectory, 'codex'),
    legacyDataDirectories: legacyDefault && legacyDefault !== dataDirectory ? [legacyDefault] : []
  }
}

export const galtaPaths = resolveGaltaPaths()
export const nativeBinaryDirectory = galtaPaths.binaryDirectory
export const galtaBridgeDirectory = galtaPaths.bridgeDirectory
export const galtaRuntimeDirectory = galtaPaths.runtimeDirectory
export const galtaWorkspaceDirectory = galtaPaths.workspaceDirectory
