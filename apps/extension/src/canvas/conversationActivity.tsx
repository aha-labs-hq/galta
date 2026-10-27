import type { ConversationItem } from '@galta/domain'
import { isMediaTool, type CanvasToolName, type MediaToolName } from '@galta/canvas'

/** The words for each canvas verb, running and finished. Keyed on the tool
 * name the protocol reported, never on the item's label: the label is prose
 * and a reworded one must not silently cost the canvas its copy. Declaring the
 * record total over `CanvasToolName` makes a new verb a compile error here. */
const CANVAS_ACTIVITY: Record<CanvasToolName, { active: string; done: string }> = {
  canvas_inspect: { active: 'Looking at the canvas', done: 'Viewed the canvas' },
  canvas_capture: { active: 'Looking at the artwork', done: 'Looked at the canvas' },
  canvas_report: { active: 'Checking visual evidence', done: 'Checked visual evidence' },
  canvas_edit: { active: 'Updating the canvas', done: 'Updated the canvas' },
  canvas_place: { active: 'Updating the canvas', done: 'Updated the canvas' },
  canvas_reserve: { active: 'Making room on the canvas', done: 'Made room on the canvas' },
  canvas_extract: { active: 'Preparing source files', done: 'Prepared source files' },
  canvas_deliver: { active: 'Delivering a file', done: 'Delivered a file' }
}
const MEDIA_ACTIVITY: Record<MediaToolName, [active: string, done: string]> = {
  generation_models: ['Checking generation models', 'Checked generation models'],
  generate_image: ['Generating an image', 'Generated an image'],
  generate_video: ['Generating a video', 'Started a video'],
  generate_speech: ['Generating speech', 'Generated speech'],
  generation_get: ['Waiting for generated media', 'Checked generated media'],
  generation_list: ['Reading recent generations', 'Read recent generations']
}
export function canvasActivity(item: ConversationItem) {
  if (item.type !== 'dynamicToolCall' && !(item.type === 'mcpToolCall' && item.server === 'galta')) return undefined
  const changes = item.canvasChanges
  if (changes) {
    if (changes.kind) return { active: `Updating the ${changes.kind}`, done: `${changes.created ? 'Added' : 'Replaced'} the ${changes.kind}` }
    const count = changes.created + changes.updated + changes.deleted
    return { active: 'Updating the canvas', done: count ? `Updated ${count} canvas ${count === 1 ? 'object' : 'objects'}` : 'Canvas unchanged' }
  }
  return item.tool ? CANVAS_ACTIVITY[item.tool as CanvasToolName] : undefined
}
export function activityText(item: ConversationItem, stopped = false) {
  if (item.type === 'agentMessage') return item.status === 'inProgress' && !stopped ? 'Writing an update' : 'Shared an update'
  const canvas = canvasActivity(item)
  const interrupted = item.status === 'interrupted' || item.status === 'stopped' || item.status === 'cancelled' || stopped && item.status === 'inProgress'
  if (item.type === 'modelRetry') return interrupted ? 'Model retry stopped' : item.status === 'failed' ? 'Model retry failed' : item.status === 'completed' ? 'Model connection resumed' : 'Reconnecting to the model'
  if (canvas) return interrupted ? 'Canvas operation stopped' : item.status === 'failed' ? 'Canvas operation failed' : item.status === 'completed' ? canvas.done : canvas.active
  const browser = { browser_inspect: ['Reading the webpage', 'Read the webpage'], browser_capture: ['Looking at the webpage', 'Viewed the webpage'], browser_act: ['Operating the webpage', 'Operated the webpage'] }[item.tool ?? '']
  if (browser) return interrupted ? 'Webpage operation stopped' : item.status === 'failed' ? 'Webpage operation failed' : browser[item.status === 'completed' ? 1 : 0]!
  const media = item.type === 'mcpToolCall' && item.server === 'galta' && item.tool && isMediaTool(item.tool) ? MEDIA_ACTIVITY[item.tool] : undefined
  if (media) return interrupted ? 'Generation stopped' : item.status === 'failed' ? 'Generation failed' : media[item.status === 'completed' ? 1 : 0]
  if (item.status === 'declined') return ({ commandExecution: 'Command declined', fileChange: 'File change declined', mcpToolCall: 'Tool declined', dynamicToolCall: 'Canvas operation declined' } as Record<string, string>)[item.type] ?? 'Action declined'
  if (interrupted) return ({ reasoning: 'Thinking stopped', commandExecution: 'Command stopped', fileChange: 'File editing stopped', webSearch: 'Search stopped', imageGeneration: 'Image generation stopped', contextCompaction: 'Condensing stopped', imageView: 'Image viewing stopped', collabToolCall: 'Agent collaboration stopped', plan: 'Planning stopped', mcpToolCall: 'Tool stopped', dynamicToolCall: 'Canvas operation stopped' } as Record<string, string>)[item.type] ?? 'Stopped'
  if (item.type === 'commandExecution' && item.status === 'failed' && item.exitCode !== undefined) return `Command exited with code ${item.exitCode}`
  if (item.status === 'failed') return ({ reasoning: 'Thinking failed', commandExecution: 'Command failed', fileChange: 'File editing failed', webSearch: 'Search failed', imageGeneration: 'Image generation failed', contextCompaction: 'Earlier context could not be condensed', imageView: 'Image viewing failed', collabToolCall: 'Agent collaboration failed', plan: 'Planning failed', functionCallOutput: 'Tool output failed' } as Record<string, string>)[item.type] ?? 'Tool failed'
  if (item.type === 'dynamicToolCall') return canvasActivity(item)?.done ?? item.text
  if (item.status === 'inProgress') return ({ reasoning: 'Thinking through the next step', commandExecution: 'Running a command', fileChange: 'Editing files', webSearch: 'Searching the web', imageGeneration: 'Generating an image', contextCompaction: 'Condensing earlier context', imageView: 'Viewing an image', collabToolCall: 'Working with another agent', plan: 'Making a plan', functionCallOutput: 'Receiving tool output', mcpToolCall: 'Using a tool', enteredReviewMode: 'Entering review mode', exitedReviewMode: 'Leaving review mode' } as Record<string, string>)[item.type] ?? 'Working'
  return ({ reasoning: 'Thought through the next step', commandExecution: 'Ran a command', fileChange: 'Edited files', webSearch: 'Searched the web', imageGeneration: item.status === 'completed' ? 'Generated an image' : 'Generating an image', contextCompaction: 'Earlier context condensed', imageView: 'Viewed an image', collabToolCall: 'Worked with another agent', plan: 'Made a plan', functionCallOutput: 'Received tool output', mcpToolCall: 'Used a tool', enteredReviewMode: 'Entered review mode', exitedReviewMode: 'Left review mode' } as Record<string, string>)[item.type] ?? item.text
}
function detailParts(item: ConversationItem) {
  const changes = item.canvasChanges
  const effect = changes ? `${changes.created} added, ${changes.updated} updated, ${changes.deleted} removed.` : undefined
  return item.type === 'commandExecution' ? [item.text, item.cwd ? `Working directory: ${item.cwd}` : undefined,
    item.exitCode !== undefined ? `Exit code: ${item.exitCode}` : undefined, item.error,
    item.output || (item.exitCode !== undefined ? 'No output.' : undefined)].filter((part): part is string => Boolean(part))
    : [
      item.error && !item.details?.includes(item.error) ? `Error\n${item.error}` : undefined,
      item.details,
      item.output ? `Output\n${item.output}` : undefined,
      effect ? `Effect\n${effect}` : undefined
    ].filter((part): part is string => Boolean(part))
}
/** Whether a step has anything to show beyond its line: a command, a public
 * reasoning summary, output, an error or a canvas effect. A step without any
 * is a plain line, never a disclosure that opens onto nothing. */
export function hasActivityDetails(item: ConversationItem) {
  return detailParts(item).length > 0
}
export function activityDetails(item: ConversationItem, limit: number) {
  const parts = detailParts(item)
  // Bound formatting as well as DOM size: joining a whole command receipt
  // before slicing would still copy its growing output on each delta.
  return { text: parts.map(part => part.slice(0, limit)).join('\n\n').slice(0, limit),
    length: parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1) * 2 }
}
export function elapsedLabel(startedAt: number | undefined, now: number) {
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds === 0) return '<1s'
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
export function WorkingDot() {
  return <span className="working-dot inline-block size-1.5 shrink-0 animate-working rounded-full bg-indicator motion-reduce:animate-none" aria-hidden="true" />
}
