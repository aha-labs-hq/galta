/** Galta advertises these tools; the editor still owns their editing behavior. */
export const toolShortcuts = {
  selection: 'v', hand: 'h', freedraw: 'p', eraser: 'e', text: 't',
  rectangle: 'r', diamond: 'd', ellipse: 'o', arrow: 'a', line: 'l', frame: 'f'
} as const

const toolKeys = new Set<string>(Object.values(toolShortcuts))

/** Gate engine shortcuts at their source, including its window-level listeners.
 * Returning false leaves browser defaults and text entry untouched. */
export function allowCanvasShortcut(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.closest('.excalidraw')) return false
  if (event.isComposing || event.keyCode === 229) return false

  const key = event.key.toLowerCase(), command = event.metaKey || event.ctrlKey
  // These open engine-owned UI or files, bypassing Galta's workspace controls.
  if (command && (key === '/' || key === 'p' || key === 'f' || key === 'e' || event.shiftKey && key === 's')) return false

  if (target.isContentEditable || target.closest('input, textarea, select, [role=textbox]')) return true
  if (command && (key === 'backspace' || key === 'delete')) return false
  if (!command && event.altKey && ['KeyZ', 'KeyR', 'KeyS', 'Slash'].includes(event.code)) return false
  if (!command && !event.altKey) {
    if (key === '?' || event.shiftKey && ['f', 'g', 's', 'i'].includes(key)) return false
    if (/^[0-9]$/.test(key) && (!event.shiftKey || !/^(Digit[0-3]|Numpad0)$/.test(event.code))) return false
    // Numbers describe positions in the original toolbar, not Galta's tools.
    // This also excludes its hidden laser, tool lock, eyedropper and color menus.
    if (!event.shiftKey && /^[a-z]$/.test(key)) return toolKeys.has(key)
  }
  return true
}
