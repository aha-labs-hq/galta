declare const __GALTA_BUILD__: { mode: string; source: string; companion: string }
declare const __GALTA_COMPANION_URL__: string
declare module '*.svg?url&no-inline' { const url: string; export default url }
/* The content script cannot load a stylesheet on the host page — the manifest
   has no `css` key and no web-accessible resources — so the design tokens are
   inlined into its shadow root as text. See docs/design/mark.md. */
declare module '*.css?raw' { const css: string; export default css }

interface Window { EXCALIDRAW_ASSET_PATH: string }

// Chrome 141 API, not yet present in the pinned Chrome type package.
declare namespace chrome.sidePanel {
  function close(options: { tabId?: number; windowId?: number }): Promise<void>
}
