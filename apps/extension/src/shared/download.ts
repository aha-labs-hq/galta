/** The browser owns the save destination; object URLs live only for delivery. */
export function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
