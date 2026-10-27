type SourceImageFormat = { type: string; mimeType: string; aliases: readonly string[]; extensions: readonly string[] }

// Source preservation is independent of the formats a model accepts as vision
// input. The browser still decodes an image before placing it on the canvas.
export const sourceImageFormats: readonly SourceImageFormat[] = [
  { type: 'png', mimeType: 'image/png', aliases: ['image/apng'], extensions: ['png', 'apng'] },
  { type: 'jpg', mimeType: 'image/jpeg', aliases: [], extensions: ['jpg', 'jpeg', 'jpe'] },
  { type: 'webp', mimeType: 'image/webp', aliases: [], extensions: ['webp'] },
  { type: 'gif', mimeType: 'image/gif', aliases: [], extensions: ['gif'] },
  { type: 'svg', mimeType: 'image/svg+xml', aliases: [], extensions: ['svg'] },
  { type: 'avif', mimeType: 'image/avif', aliases: [], extensions: ['avif'] },
  { type: 'bmp', mimeType: 'image/bmp', aliases: ['image/x-ms-bmp'], extensions: ['bmp'] },
  { type: 'ico', mimeType: 'image/vnd.microsoft.icon', aliases: ['image/x-icon'], extensions: ['ico'] }
]

export function sourceImageFormat(mimeType: string): SourceImageFormat | undefined {
  return sourceImageFormats.find(format => format.mimeType === mimeType || format.aliases.includes(mimeType))
}
