import { ACCOUNT_KEY, GOOGLE_KEY } from '../shared/account'
import { createAccountService } from '../shared/accountService'

/** Only trusted Galta pages can ask this owner to use the browser's session. */
export async function protectAccountStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
}
const account = createAccountService({
  read: async () => (await chrome.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY] ?? {},
  write: value => chrome.storage.local.set({ [ACCOUNT_KEY]: value }),
  readGoogle: async () => (await chrome.storage.session.get(GOOGLE_KEY))[GOOGLE_KEY],
  writeGoogle: value => value ? chrome.storage.session.set({ [GOOGLE_KEY]: value }) : chrome.storage.session.remove(GOOGLE_KEY),
  async openGoogle(url, from) {
    const tab = await chrome.tabs.create(from?.id !== undefined ? { url, openerTabId: from.id, index: from.index + 1, windowId: from.windowId } : { url })
    if (tab.id === undefined) throw new Error('Galta could not open Google sign-in.')
    return tab.id
  },
  async showGoogle(id) {
    const tab = await chrome.tabs.get(id).catch(() => null)
    if (!tab?.id) return false
    await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true })
    return true
  },
  async closeGoogle(id) { if (await chrome.tabs.get(id).catch(() => null)) await chrome.tabs.remove(id) },
})
export const { handleAccount, receiveHandoff, googleTabClosed, speechGrant } = account
