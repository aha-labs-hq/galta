/** The application host can be Chrome or the explicitly started local web host. */
export type HostRuntime = Pick<typeof chrome.runtime, 'connect' | 'sendMessage' | 'onMessage' | 'lastError'>
let web: HostRuntime | undefined
export function installWebRuntime(runtime: HostRuntime) { web = runtime }
export function hostRuntime(): HostRuntime | undefined { return web ?? globalThis.chrome?.runtime }
export function hasTaskHost() { return Boolean(web || globalThis.chrome?.runtime?.id) }
export function isWebApp() { return Boolean(web) }
