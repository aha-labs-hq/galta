/**
 * A place on the canvas held for work in progress, so the user sees where a
 * result will land while a slow capability makes it. It is view state: never
 * part of the document, its revision, history or exports. It ends when filled,
 * released, or when the execution that reserved it ends.
 */
export type CanvasSlot = { id: string; x: number; y: number; width: number; height: number }
export type CanvasPlace = { width: number; height: number; x?: number; y?: number }

/** Places one execution may hold at once, and the largest side of one. */
export const CANVAS_SLOT_LIMIT = 24
export const CANVAS_SLOT_SIDE = 20_000
const GAP = 32

/** Places without a position are lined up in one row centred on `center`. */
export function arrangePlaces(places: readonly CanvasPlace[], center: { x: number; y: number }): Array<Omit<CanvasSlot, 'id'>> {
  const loose = places.filter(place => place.x === undefined)
  let x = center.x - (loose.reduce((sum, place) => sum + place.width, 0) + GAP * Math.max(0, loose.length - 1)) / 2
  return places.map(place => {
    if (place.x !== undefined) return { x: place.x, y: place.y!, width: place.width, height: place.height }
    const box = { x, y: center.y - place.height / 2, width: place.width, height: place.height }
    x += place.width + GAP
    return box
  })
}

/** The box an element takes in a place: media keeps its proportions, anything else fills it. */
export function slotBox(slot: Omit<CanvasSlot, 'id'>, media?: { width: number; height: number }) {
  return media ? fitInSlot(slot, media.width, media.height) : { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
}

/** The largest box of the media's proportions inside the slot, centred. */
export function fitInSlot(slot: Omit<CanvasSlot, 'id'>, width: number, height: number) {
  const scale = Math.min(slot.width / width, slot.height / height)
  const fitted = { width: width * scale, height: height * scale }
  return { ...fitted, x: slot.x + (slot.width - fitted.width) / 2, y: slot.y + (slot.height - fitted.height) / 2 }
}
