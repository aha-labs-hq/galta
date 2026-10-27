import { lexer, type Token } from 'marked'

/** Readable prose from Markdown, for surfaces that show a sentence rather
 * than a document: inline text is kept, syntax is dropped, and blocks are
 * joined by spaces. Partial Markdown from a stream reads as well as it can. */
export function plainText(markdown: string): string {
  const inline = (tokens: readonly Token[]): string => tokens.map(token => {
    const nested = (token as { tokens?: Token[] }).tokens
    if (nested?.length) return inline(nested)
    if (token.type === 'list') return token.items.map((item: { tokens: Token[] }) => inline(item.tokens)).join(' ')
    if (token.type === 'br') return ' '
    return 'text' in token && typeof token.text === 'string' ? token.text : ''
  }).join('')
  // A stream can stop inside emphasis or code; its unmatched markers are syntax, not prose.
  return lexer(markdown).map(block => inline([block])).join(' ').replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim()
}
