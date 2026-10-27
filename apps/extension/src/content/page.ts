import type { BrowserAction } from '@galta/canvas'
import { sourceId } from './sourceId'

// Runs in Chrome's isolated content-script world. Refs never become selectors
// or code supplied by an agent, and never survive a document replacement.
// The worker validates arguments; this layer checks live document/control state.
export function sourcePage() {
  const documentId = sourceId()
  let snapshotId = '', snapshotUrl = ''
  let revision = 0, snapshotRevision = 0
  const changes = new MutationObserver(() => { revision++ })
  changes.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'src', 'type', 'disabled', 'readonly', 'aria-label', 'aria-disabled', 'aria-hidden', 'hidden'] })
  let refs = new Map<string, { element: HTMLElement; fingerprint: string }>()
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim()
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && !element.closest('[hidden],[aria-hidden="true"],script,style,noscript')
  }
  const sensitive = (el: Element) => el.matches('input[type="password"],input[type="file"],input[autocomplete*="cc-"],input[autocomplete*="password"],input[autocomplete="one-time-code"]')
  const label = (el: HTMLElement) => clean(el.getAttribute('aria-label') || (el instanceof HTMLInputElement ? [...(el.labels ?? [])].map(l => l.innerText).join(' ') || el.placeholder : '') || (el instanceof HTMLImageElement ? el.alt : el.innerText) || el.title)
  const fingerprint = (el: HTMLElement) => JSON.stringify([el.tagName, label(el), el.getAttribute('href'), el.getAttribute('src'), el.getAttribute('type'), el.getAttribute('disabled'), el.getAttribute('aria-disabled')])
  const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  const identity = () => ({ documentId, url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } })
  const target = (ref: unknown) => {
    const entry = typeof ref === 'string' ? refs.get(ref) : undefined
    if (!entry || !entry.element.isConnected || !visible(entry.element) || fingerprint(entry.element) !== entry.fingerprint) throw new Error('The webpage target changed. Read the page again.')
    return entry.element
  }
  const assertSnapshot = (value: unknown) => {
    if (changes.takeRecords().length) revision++
    if (!snapshotId || value !== snapshotId || location.href !== snapshotUrl || revision !== snapshotRevision) throw new Error('The webpage changed. Read the page again.')
  }
  return (tool: string, args: Record<string, any>) => {
    if (tool === 'browser_inspect') {
      if (changes.takeRecords().length) revision++
      snapshotRevision = revision
      snapshotId = `${documentId}:${sourceId()}`; snapshotUrl = location.href; refs = new Map()
      const elements: unknown[] = []
      let truncated = false
      for (const el of document.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="link"],img,[tabindex]')) {
        if (!visible(el) || sensitive(el)) continue
        if (refs.size >= 160) { truncated = true; break }
        const ref = String(refs.size + 1)
        refs.set(ref, { element: el, fingerprint: fingerprint(el) })
        const name = label(el), src = el instanceof HTMLImageElement ? el.currentSrc || el.src : ''
        const omittedSource = /^https?:\/\//i.test(src) && src.length > 4096
        const omittedOptions = el instanceof HTMLSelectElement && el.options.length > 80
        if (name.length > 240 || omittedSource || omittedOptions) truncated = true
        elements.push({ ref, tag: el.tagName.toLowerCase(), label: name.slice(0, 240), ...(name.length > 240 ? { labelTruncated: true } : {}), rect: rect(el),
          ...(el instanceof HTMLAnchorElement ? { href: el.href } : {}),
          ...(el instanceof HTMLImageElement ? { ...(omittedSource ? { srcOmitted: 'URL exceeds 4096 characters; use browser_capture for pixels.' } : { src: /^https?:\/\//i.test(src) ? src : '(inline image; use browser_capture)' }), width: el.naturalWidth, height: el.naturalHeight } : {}),
          ...(el instanceof HTMLSelectElement ? { options: [...el.options].slice(0, 80).map(o => ({ value: o.value, label: o.label })), ...(omittedOptions ? { optionCount: el.options.length, optionsTruncated: true } : {}) } : {}),
          disabled: el.matches(':disabled,[aria-disabled="true"]') })
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let text = '', count = 0, node: Node | null
      while ((node = walker.nextNode())) {
        if (count++ >= 12000) { truncated = true; break }
        const parent = node.parentElement
        if (!parent || !visible(parent) || parent.closest('textarea,input,[contenteditable="true"]')) continue
        const value = clean(node.textContent ?? '')
        if (!value) continue
        const part = value + '\n', remaining = 16000 - text.length
        text += part.slice(0, remaining)
        if (part.length > remaining) { truncated = true; break }
      }
      return { ...identity(), snapshotId, text, elements, truncated, limitations: ['Top-document DOM blocks intersecting the viewport; clipping and occlusion are not resolved. Use browser_capture for pixels. Nested frames and shadow roots are not traversed.', 'Password, payment and file inputs are excluded.'] }
    }
    if (tool === 'browser_check') {
      if (args.snapshotId !== undefined) assertSnapshot(args.snapshotId)
      return { ...identity(), ...(args.ref !== undefined ? { rect: rect(target(args.ref)) } : {}) }
    }
    if (tool !== 'browser_act') throw new Error('Unknown webpage operation')
    const action = args as BrowserAction
    assertSnapshot(action.snapshotId)
    if (action.action === 'navigate') { snapshotId = ''; refs.clear(); return identity() } // The worker owns tab navigation.
    const el = action.ref === undefined ? undefined : target(action.ref)
    if (el?.matches(':disabled,[aria-disabled="true"]') || (el && sensitive(el))) throw new Error('This webpage control cannot be operated')
    if (action.action === 'click') {
      if (!el) throw new Error('click requires a ref')
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(Math.max(0, r.left) + Math.min(r.width, innerWidth - Math.max(0, r.left)) / 2, Math.max(0, r.top) + Math.min(r.height, innerHeight - Math.max(0, r.top)) / 2)
      if (!hit || !(el === hit || el.contains(hit))) throw new Error('The target is covered. Read the page again.')
      el.click()
    } else if (action.action === 'fill') {
      if ((el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type)) || el instanceof HTMLTextAreaElement) {
        if (el.readOnly) throw new Error('This input is read-only')
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, action.text)
      } else if (el?.isContentEditable) el.textContent = action.text
      else throw new Error('This control does not support fill')
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text })); el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (action.action === 'select') {
      if (!(el instanceof HTMLSelectElement) || ![...el.options].some(o => o.value === action.text && !o.disabled)) throw new Error('select requires an available option value and select ref')
      el.value = action.text; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (action.action === 'scroll') {
      ;(el ?? window).scrollBy({ left: action.deltaX ?? 0, top: action.deltaY ?? 0, behavior: 'instant' })
    } else throw new Error('Unsupported webpage action')
    snapshotId = ''; refs.clear()
    return { ...identity(), dispatched: action.action, verification: 'Inspect or capture the page again to verify the outcome.' }
  }
}
