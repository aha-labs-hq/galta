/** Bound generated documents before crossing native messaging or saving history. */
export const MAX_HTML_BYTES = 4_000_000
export function validateHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim() || !/<html[\s>]/i.test(html)) throw new Error('A complete HTML document is required')
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error('HTML document exceeds 4 MB')
  return html
}
