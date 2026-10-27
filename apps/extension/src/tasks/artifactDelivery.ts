import { lexer, walkTokens } from 'marked'

/** Only Markdown links are delivery declarations. Bare paths, code blocks,
 * images, tool output and commentary remain ordinary conversation text. */
export function markdownDeliveryLinks(text: string): string[] {
  const links: string[] = []
  try {
    walkTokens(lexer(text), token => {
      if (token.type === 'link' && typeof token.href === 'string') links.push(token.href)
    })
  }
  catch { return [] }
  return [...new Set(links)]
}

export function isWorkspaceDeliveryLink(href: string): boolean {
  if (!href || href.startsWith('//') || href.startsWith('#')) return false
  if (/^(https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(href)) return false
  // A Windows drive path is a local path, not a URI scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href) && !href.startsWith('galta-workspace:/') && !href.startsWith('file:') && !href.startsWith('sandbox:')) return false
  return true
}
