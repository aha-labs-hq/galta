/** File-input failures cross the worker boundary as codes, never parser output.
 * This is the one presentation policy for portable canvas input. */
export type CanvasFileFailure = 'unreadable' | 'format' | 'version' | 'contents' | 'legacy' | 'processing'
const messages: Record<CanvasFileFailure, string> = {
  unreadable: 'This file can’t be read as a Galta canvas. Choose another .galta file. Your current canvas is unchanged.',
  format: 'This file isn’t a Galta canvas export. Choose a .galta file exported from Galta. Your current canvas is unchanged.',
  version: 'This canvas file uses an unsupported version. Update Galta or choose another export. Your current canvas is unchanged.',
  contents: 'This canvas file is incomplete or damaged. Choose another .galta file. Your current canvas is unchanged.',
  legacy: 'This older canvas needs a compatible export. Open it in its original Galta version and export its content there. Your current canvas is unchanged.',
  processing: 'Galta couldn’t open this canvas file. Try again. Your current canvas is unchanged.'
}

export class CanvasFileError extends Error {
  constructor(readonly reason: CanvasFileFailure, options?: ErrorOptions) {
    super(messages[reason], options)
    this.name = 'CanvasFileError'
  }
}
