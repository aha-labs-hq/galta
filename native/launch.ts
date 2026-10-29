const compiled = Bun.main.startsWith('/$bunfs/')

/** How this executable was started, read before a runtime entry removes its
 * role from argv, so a role can start another copy of itself. Undefined when
 * running from source, where the caller names the entry. */
export const selfCommand = compiled ? [process.execPath, ...process.argv.slice(2)] : undefined

/** This runtime started in another role, compiled or from source. */
export const runtimeCommand = (role: string) => compiled ? [process.execPath, role] : [process.execPath, Bun.main, role]
