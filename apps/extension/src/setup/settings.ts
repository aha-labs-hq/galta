/** The views of the one Settings dialog. Settings lists the rest: the Galta
 * account, built-in chat, other AI apps, and the provider accounts agents
 * generate media with. */
export type SettingsView = 'settings' | 'account' | 'connect' | 'chat' | 'generation' | null

/** Views slide in the direction the user travels: deeper is forward. */
export const VIEW_ORDER: readonly SettingsView[] = ['settings', 'account', 'chat', 'connect', 'generation']
