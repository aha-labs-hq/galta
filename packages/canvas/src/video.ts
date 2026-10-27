export const MAX_VIDEO_BYTES = 128_000_000
// A valid opaque URI avoids the editor throwing while checking every media
// link on each frame. The old relative marker remains readable on import.
export const VIDEO_LINK = 'galta:video'
export const isVideoLink = (link: unknown): boolean => link === VIDEO_LINK || link === '/galta-video'
/** Playback position and runtime URLs are not document data. */
export type CanvasVideo = Readonly<{
  version: 1; fileId: string; posterId: string; name: string
  width: number; height: number; duration: number
}>
export function validateVideo(value: unknown): asserts value is CanvasVideo {
  const v = value as CanvasVideo | undefined
  if (!v || v.version !== 1 || !v.fileId || !v.posterId || typeof v.fileId !== 'string' || typeof v.posterId !== 'string' ||
    typeof v.name !== 'string' || v.name.length > 512 || ![v.width, v.height, v.duration].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid canvas video')
}
export function videoFile(name: string, mime = ''): boolean {
  return mime.startsWith('video/') || /\.(mp4|m4v|webm|mov|ogv)$/i.test(name)
}

export function videoData(element: { type: string; link?: string | null; customData?: Record<string, any> }): CanvasVideo | undefined {
  return element.type === 'embeddable' && isVideoLink(element.link) ? element.customData?.video : undefined
}
