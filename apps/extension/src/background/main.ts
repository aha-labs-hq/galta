import type { GaltaMessage } from '../shared/messages'
import { codexAdapter, handleCodexMessage } from './codexAdapter'
import { canvasBridge } from './canvasBridge'
import { attachBrowser } from './browserBridge'
import { checkSetup, isGaltaPage, mediaSettings } from './setup'
import { attachTaskHost, ensureTaskHost } from './taskHost'
import { addToCollection, listCollection, removeFromCollection } from './collectionStore'
import { googleTabClosed, handleAccount, protectAccountStorage, receiveHandoff } from './account'
import { hasExtensionSidePanels } from '../shared/sidePanel'

// A store installation opens a canvas once, so a new user lands in Galta
// rather than in the browser's extensions menu. Chrome Web Store installs carry
// an update URL; development and test loads do not, and open nothing.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL && 'update_url' in chrome.runtime.getManifest()) openCanvasTab()
})

// The account session lives in local storage; content scripts never see it.
void protectAccountStorage().catch(error => console.error('[Galta] Could not protect account storage', error))
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void receiveHandoff(message, sender).then(sendResponse)
  return true
})
chrome.tabs.onRemoved.addListener(tabId => { void googleTabClosed(tabId) })

const sidePanelAvailable = hasExtensionSidePanels()

// `setPanelBehavior` is persistent browser state. A previous build enabled
// browser-owned action routing, which bypasses `action.onClicked` entirely on
// hosts that do not implement extension side panels. Keep the action owned by
// this worker so the capability check below can select the right surface.
if (typeof chrome.sidePanel?.setPanelBehavior === 'function') {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(error => {
    console.info('Galta could not reset browser-owned side panel action routing', error)
  })
}

function openCanvasTab(windowId?: number): void {
  const options = windowId === undefined ? {} : { windowId }
  void chrome.tabs.create({ ...options, active: true, url: chrome.runtime.getURL('canvas/index.html') }).catch(error => {
    console.error('Unable to open the Galta canvas', error)
  })
}

chrome.action.onClicked.addListener((tab) => {
  if (!sidePanelAvailable || tab.windowId === undefined) {
    openCanvasTab(tab.windowId)
    return
  }
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(error => {
    console.info('Galta side panel could not open; using the full-screen fallback', error)
    openCanvasTab(tab.windowId)
  })
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'galta-task-host') attachTaskHost(port)
  if (port.name.startsWith('galta-browser:')) attachBrowser(port)
  if (port.name.startsWith('galta-canvas:')) canvasBridge.attach(port)
  if (port.name.startsWith('galta-codex-client:')) {
    const owner = port.name.slice('galta-codex-client:'.length)
    codexAdapter.attachClient(owner)
    port.onDisconnect.addListener(() => codexAdapter.detachClient(owner))
  }
})

chrome.runtime.onMessage.addListener((message: GaltaMessage | { type: 'task-host-ensure' }, sender, sendResponse) => {
  if (message.type === 'collection-list') { void listCollection().then(items => sendResponse({ ok: true, items }), error => sendResponse({ ok: false, error: String(error) })); return true }
  if (message.type === 'collection-add') { void addToCollection(message.item).then(item => sendResponse({ ok: true, item }), error => sendResponse({ ok: false, error: String(error) })); return true }
  if (message.type === 'collection-remove') { void removeFromCollection(message.id).then(items => sendResponse({ ok: true, items }), error => sendResponse({ ok: false, error: String(error) })); return true }
  if (message.type === 'task-host-ensure') { void ensureTaskHost().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: String(error) })); return true }
  if (message.type === 'setup-status') { void checkSetup().then(sendResponse); return true }
  if (message.type === 'media-settings') {
    if (!isGaltaPage(sender)) { sendResponse({ ok: false, error: 'Connect providers from Galta.' }); return false }
    void mediaSettings(message.request).then(response => {
      // Generation tools are listed only for connected providers; built-in chat
      // picks up the new list once it is idle, without interrupting work.
      if (response.ok && message.request.action !== 'status') codexAdapter.refreshTools()
      sendResponse(response)
    })
    return true
  }
  if (message.type === 'account') {
    if (!isGaltaPage(sender)) { sendResponse({ ok: false, error: 'Manage your account from Galta.', state: { user: null, ended: false, google: null } }); return false }
    void handleAccount(message.request, sender.tab).then(sendResponse)
    return true
  }
  if (message.type === 'setup-reconnect') { sendResponse({ ok: codexAdapter.reconnectWhenIdle() }); return false }
  if (message.type === 'codex-connect' || message.type === 'codex-login' || message.type === 'codex-rpc' || message.type === 'codex-respond') {
    void handleCodexMessage(message, sendResponse)
    return true
  }
  return false
})
