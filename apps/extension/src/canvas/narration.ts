import type { ConversationItem } from '@galta/domain'
import type { CreativeConversationTurn } from '@galta/storage'
import { plainText } from './conversationText'

function latest(turn: CreativeConversationTurn | null | undefined, test: (item: ConversationItem) => unknown) {
  for (let i = (turn?.items.length ?? 0) - 1; i >= 0; i--) if (test(turn!.items[i]!)) return turn!.items[i]
  return undefined
}

/** Where the turn last changed the canvas. */
export function lastRegion(turn: CreativeConversationTurn | null | undefined) {
  return latest(turn, item => item.canvasChanges?.region)?.canvasChanges?.region
}

// A sentence ends at terminal punctuation. A full stop ends one only before a
// space or the end, so decimals, versions and file names stay whole.
const BOUNDARY = /(?<=[。！？!?；;…])|(?<=\.)(?=\s|$)/
export function sentences(text: string): string[] {
  return text.split(BOUNDARY).map(part => part.trim()).filter(Boolean)
}

/** What the agent is saying, one sentence at a time, in its own words rather
 * than a tool's name: while it works, the sentence it is on; once it has
 * finished, the opening of its answer. The key names the message and the
 * sentence, so each new sentence arrives as a new line. */
export function narration(turn: CreativeConversationTurn | null | undefined, settled: boolean): { key: string; text: string } | null {
  const message = latest(turn, item => item.type === 'agentMessage' && item.text.trim())
  if (!message) return null
  const said = sentences(plainText(message.text))
  if (!said.length) return null
  const index = settled ? 0 : said.length - 1
  return { key: `${message.id}:${index}`, text: said[index]! }
}
