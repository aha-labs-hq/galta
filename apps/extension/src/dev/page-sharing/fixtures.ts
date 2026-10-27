import { convertToExcalidrawElements, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type { CanvasAssets } from '@galta/canvas'
import type { CanvasScene } from '../../canvas/scene'
import { createVideoElement, prepareVideo } from '../../canvas/video'
import { HTML_EMBED_LINK } from '../../canvas/htmlEmbed'
import film from '../../../../../site/footage/media/film.mp4?url'
import { PAGE_ID, pageHtml, pictures, type Revision } from './artwork'

export const fixtureLabels = { image: 'Image', text: 'Text', shape: 'Shape', group: 'Group', video: 'Video', page: 'Webpage', multiple: 'Multiple images' } as const
export type FixtureKind = keyof typeof fixtureLabels
const groupId = 'tide-design-group'
let videoPromise: ReturnType<typeof prepareVideo> | undefined
const imageAssets = Promise.all(Object.entries(pictures).map(async ([key, url]) => {
  const blob = await (await fetch(url)).blob()
  const bitmap = await createImageBitmap(blob)
  const ratio = bitmap.width / bitmap.height; bitmap.close()
  return { key, ratio, file: { id: `demo-${key}`, mimeType: blob.type, created: 1, blob } }
}))

export async function loadFixture(scene: CanvasScene, kind: FixtureKind, revision: Revision) {
  const sources = await imageAssets
  const files: CanvasAssets = Object.fromEntries(sources.map(({ file }) => [file.id, file]))
  const image = (id: string, key: keyof typeof pictures, x: number, y: number, width: number, groups: string[] = []) => {
    const source = sources.find(source => source.key === key)!
    return convertToExcalidrawElements([{ id, type: 'image', x, y, width, height: width / source.ratio, fileId: source.file.id as FileId, status: 'saved', groupIds: groups }])[0]!
  }
  let elements: ExcalidrawElement[], selected: string[]
  if (kind === 'page') {
    elements = [image('reference-shell', 'shell', -330, 0, 230), ...convertToExcalidrawElements([{ id: 'reference-note', type: 'text', x: -330, y: 260, text: 'From the sea,\nfor the everyday.', width: 270, autoResize: false, fontSize: 18, fontFamily: 2, strokeColor: '#716e66' }]), ...restoreElements([{ id: PAGE_ID, type: 'embeddable', x: 0, y: 0, width: 960, height: 660, link: HTML_EMBED_LINK, customData: { htmlDocument: { html: pageHtml(revision) } } } as unknown as ExcalidrawElement], null)]
    selected = [PAGE_ID]
  } else if (kind === 'image') {
    elements = [image('tide-image', 'fused', 0, 0, 600)]; selected = elements.map(el => el.id)
  } else if (kind === 'text') {
    elements = convertToExcalidrawElements([{ id: 'tide-text', type: 'text', x: 0, y: 0, text: 'A little ocean.\nA softer evening.', fontSize: 64, fontFamily: 2, strokeColor: '#252525' }]); selected = elements.map(el => el.id)
  } else if (kind === 'shape') {
    elements = convertToExcalidrawElements([{ id: 'tide-shape', type: 'ellipse', x: 0, y: 0, width: 520, height: 520, strokeColor: '#536760', backgroundColor: '#d9e0db', strokeWidth: 2, fillStyle: 'solid', roughness: 0 }]); selected = elements.map(el => el.id)
  } else if (kind === 'group') {
    elements = [image('group-image', 'shell', 0, 0, 420, [groupId]), ...convertToExcalidrawElements([{ id: 'group-title', type: 'text', x: 460, y: 90, text: 'Tide', fontSize: 72, fontFamily: 2, strokeColor: '#252525', groupIds: [groupId] }, { id: 'group-body', type: 'text', x: 464, y: 190, text: 'From the sea,\nfor the everyday.', fontSize: 26, fontFamily: 2, strokeColor: '#536760', groupIds: [groupId] }])]; selected = elements.map(el => el.id)
  } else if (kind === 'multiple') {
    elements = [image('multi-shell', 'shell', 0, 0, 290), image('multi-glaze', 'glaze', 320, 35, 290), image('multi-render', 'render', 640, 0, 290)]; selected = elements.map(el => el.id)
  } else {
    videoPromise ??= fetch(film).then(response => response.blob()).then(blob => prepareVideo(blob, 'tide-film.mp4'))
    const video = await videoPromise
    Object.assign(files, video.files)
    const el = createVideoElement(video.video, { x: 0, y: 0, width: 800, height: 800 * video.video.height / video.video.width })
    elements = [el]; selected = [el.id]
  }
  scene.restore({ engine: 'excalidraw', version: 1, document: { elements, files }, view: { scrollX: 0, scrollY: 0, zoom: 1 } })
  scene.select(selected)
  return selected
}
