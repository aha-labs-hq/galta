export type CanvasDeletion = {
  title: string
  /** Deletes the canvas's records in one transaction; refuses one no longer archived. */
  removeRecords(): Promise<void>
  /** Removes the files Galta's app kept for it; 'kept' when they are shared. */
  removeFiles(): Promise<'removed' | 'kept' | 'none'>
  removeDrafts(): Promise<void>
  forget(): Promise<void>
}

/**
 * Delete one archived canvas. Its records go first, in a transaction that
 * refuses a canvas restored meanwhile; only a canvas that is really gone has
 * its leftovers removed. A failure after that point can leave stray files of
 * a deleted canvas, never a canvas without its files. Returns a note about
 * anything left on this device.
 */
export async function deleteCanvas(canvas: CanvasDeletion): Promise<string | undefined> {
  await canvas.removeRecords()
  let note: string | undefined
  try {
    if (await canvas.removeFiles() === 'kept') note = `“${canvas.title}” was the first canvas in this browser. Its files on this device stay, because the first canvas of other browsers shares them.`
  } catch (error) {
    note = `“${canvas.title}” is deleted, but Galta's app could not remove its files on this device. ${error instanceof Error ? error.message : String(error)}`
  }
  await canvas.removeDrafts()
  await canvas.forget()
  return note
}
