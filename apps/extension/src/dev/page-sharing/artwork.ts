import template from './tide.html?raw'
import fused from '../../../../../site/footage/media/fused.jpg?inline'
import render from '../../../../../site/footage/media/render.jpg?inline'
import shell from '../../../../../site/footage/media/shell.jpg?inline'
import glaze from '../../../../../site/footage/media/glaze.jpg?inline'
import jellyfish from '../../../../../site/footage/media/jellyfish.jpg?inline'

export const pictures = { fused, render, shell, glaze, jellyfish }
export const PAGE_ID = 'tide-page'
export const storageKey = 'galta.page-sharing-prototype.v1'
export type Revision = 1 | 2

/** Demo artwork reuses the real website film's page and images. Its source is
 * self-contained, so the HTML download can genuinely be opened offline. */
export function pageHtml(revision: Revision) {
  return template.replace(/\{\{(fused|render|shell|glaze|jellyfish)\}\}/g, (_, key: keyof typeof pictures) => pictures[key])
    .replace('A lamp that breathes like the sea.', revision === 1 ? 'A lamp that breathes like the sea.' : 'A little ocean. A softer evening.')
    .replace('</style>', '@media(max-width:600px){nav{padding:20px}.hero{grid-template-columns:1fr;padding:24px 20px;gap:32px}h1{font-size:80px}.hero img{aspect-ratio:1}.row{grid-template-columns:1fr;padding:32px 20px}.band{grid-template-columns:1fr;padding:20px;gap:24px}footer{padding:24px 20px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style>')
}

export function publishedUrl() {
  const url = new URL(location.href)
  url.search = '?view=published'
  return url.href
}

export function downloadPage(html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = 'tide.html'; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return blob.size
}
