/** Whether this browser shows extension side panels. A Chromium host without
 * them can still expose part of the API, so the open method alone is not enough. */
export function hasExtensionSidePanels(): boolean {
  return typeof chrome.sidePanel?.open === 'function'
    && typeof chrome.runtime?.getContexts === 'function'
    && typeof chrome.runtime.ContextType?.SIDE_PANEL === 'string'
}
