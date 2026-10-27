/** How this executable was started, read before a runtime entry removes its
 * role from argv, so a role can start another copy of itself. Undefined when
 * running from source, where the caller names the entry. */
export const selfCommand = Bun.main.startsWith('/$bunfs/') ? [process.execPath, ...process.argv.slice(2)] : undefined
