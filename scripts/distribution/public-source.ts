import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, run } from './config'

/** Galta's public source; open-source/README.md owns what it holds and why. */
export const PUBLIC_SOURCE = 'https://github.com/aha-labs-hq/galta.git'

/** Exports `commit` into the public repository as one commit named `name`, unless the repository
    already holds that tree, so a stopped release simply runs it again. A commit from before
    open-source/ existed has nothing to publish. With `push: false` it only reports what would change. */
export async function publishSource(commit: string, name: string, { push = true } = {}) {
  if (Bun.spawnSync(['git', 'cat-file', '-e', `${commit}:open-source/export.py`], { cwd: root }).exitCode !== 0)
    return console.log(`${name} predates the public source; nothing to publish`)
  const work = await mkdtemp(join(tmpdir(), 'galta-public-source-'))
  const source = join(work, 'source'), target = join(work, 'public')
  try {
    run(['git', 'worktree', 'add', '--quiet', '--detach', source, commit])
    // The export copies that commit's build assets, which live in private R2.
    run(['python3', 'scripts/repository_assets.py', 'pull', 'build'], source)
    run(['git', 'clone', '--quiet', PUBLIC_SOURCE, target])
    run(['python3', 'open-source/export.py', target, '--ref', commit, '--assets', source], source)
    const changes = run(['git', 'status', '--porcelain'], target).trim()
    if (!changes) return console.log(`${PUBLIC_SOURCE} already holds the source of ${name}`)
    if (!push) return console.log(`${PUBLIC_SOURCE} would take the source of ${name}: ${changes.split('\n').length} changed paths`)
    run(['git', 'add', '--all'], target)
    // Signed by the releasing GitHub account through its noreply address, so the account is credited
    // and no personal address enters the public history.
    const account = JSON.parse(run(['gh', 'api', 'user'])) as { login: string; id: number; name: string | null }
    const email = `${account.id}+${account.login}@users.noreply.github.com`
    run(['git', '-c', `user.name=${account.name || account.login}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', name], target)
    run(['git', 'push', '--quiet', 'origin', 'main'], target)
    console.log(`${PUBLIC_SOURCE} holds the source of ${name}`)
  } finally {
    Bun.spawnSync(['git', 'worktree', 'remove', '--force', source], { cwd: root })
    await rm(work, { recursive: true, force: true })
  }
}
