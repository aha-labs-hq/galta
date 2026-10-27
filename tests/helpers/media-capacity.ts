// Browser-only benchmark fixture; never shipped or used by production code.
import { createInitialWorkspace, initializeWorkspaceSnapshot, commitWorkspaceSnapshot } from '../../apps/extension/src/canvas/workspace'
import { IndexedDbWorkspaceRepository } from '../../packages/storage/src'
import type { CanvasAssets } from '../../packages/canvas/src'

export type MediaWorkload = {
  name: string; images: number; videos: number; imageWidth: number
  layout: 'overview' | 'spread'; videoBytes?: number; history?: number
}

async function seed(workload: MediaWorkload, videoBase64: string) {
  const files: CanvasAssets = {}, elements: any[] = [], total = workload.images + workload.videos
  const video = await (await fetch(`data:video/webm;base64,${videoBase64}`)).blob()
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!
  const width = workload.imageWidth, height = Math.round(width * 9 / 16)
  canvas.width = width; canvas.height = height
  // Unique raster content and IDs prevent a duplicated tiny fixture from
  // accidentally standing in for independently decoded source images.
  const texture = ctx.createImageData(width, height)
  let random = 47
  for (let i = 0; i < texture.data.length; i += 4) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    const noise = random >>> 25
    texture.data[i] = 70 + noise; texture.data[i + 1] = 100 + noise
    texture.data[i + 2] = 130 + noise; texture.data[i + 3] = 255
  }
  const columns = workload.layout === 'overview' ? Math.ceil(Math.sqrt(total * 1.65)) : 8
  const cellWidth = workload.layout === 'overview' ? 1240 / columns : 340
  const cellHeight = workload.layout === 'overview' ? 810 / Math.ceil(total / columns) : 215
  let sourceBytes = 0, rasterBytes = 0
  for (let i = 0; i < total; i++) {
    ctx.putImageData(texture, 0, 0)
    ctx.fillStyle = `hsl(${i * 137.508 % 360} 45% 50% / .55)`
    ctx.fillRect(0, 0, width, height)
    ctx.font = `${Math.round(width / 9)}px sans-serif`; ctx.fillStyle = '#ffffff'
    ctx.fillText(`Media ${i + 1}`, width / 12, height * .6)
    const raster = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/jpeg', .85))
    const id = `media-${i}`, isVideo = Math.floor((i + 1) * workload.videos / total) > Math.floor(i * workload.videos / total), fileId = `source-${i}`
    const common = {
      id, x: 140 + i % columns * cellWidth, y: 90 + Math.floor(i / columns) * cellHeight,
      width: cellWidth - 12, height: Math.min(cellHeight - 10, (cellWidth - 12) * 9 / 16),
      angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 0, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
      roundness: null, seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false,
      boundElements: null, updated: 1, link: null, locked: false,
    }
    if (isVideo) {
      const posterId = `poster-${i}`
      // Tail padding controls persisted source size without pretending to test
      // a longer or higher-resolution codec stream. This benchmark is idle media.
      const target = Math.max(video.size + 8, workload.videoBytes ?? video.size)
      const source = new Blob([video, new Uint8Array(target - video.size - 8), new Float64Array([i])], { type: video.type })
      files[fileId] = { id: fileId, created: 1, mimeType: video.type, blob: source }
      files[posterId] = { id: posterId, created: 1, mimeType: raster.type, blob: raster }
      elements.push({ ...common, type: 'embeddable', link: 'galta:video', customData: { video: {
        version: 1, fileId, posterId, name: `${id}.webm`, width: 320, height: 180, duration: 2,
      } } })
      sourceBytes += source.size
    } else {
      files[fileId] = { id: fileId, created: 1, mimeType: raster.type, blob: raster }
      elements.push({ ...common, type: 'image', fileId, status: 'saved', scale: [1, 1], crop: null })
    }
    rasterBytes += raster.size
  }
  const snapshot = { engine: 'excalidraw' as const, version: 1 as const,
    document: { elements, files }, view: { scrollX: 0, scrollY: 0, zoom: 1 } }
  let bundle = createInitialWorkspace()
  bundle = initializeWorkspaceSnapshot(bundle, bundle.project.headCommitId, snapshot)
  for (let i = 1; i < (workload.history ?? 1); i++) {
    bundle = commitWorkspaceSnapshot(bundle, bundle.project.headCommitId, {
      ...snapshot, document: { files, elements: elements.map(el => ({ ...el, x: el.x + i, version: i + 1 })) },
    }, 'user')
  }
  const start = performance.now()
  await new IndexedDbWorkspaceRepository().save(bundle)
  return { sourceBytes, rasterBytes, assets: Object.keys(files).length, snapshots: Object.keys(bundle.snapshots).length,
    rasterWidth: width, rasterHeight: height, saveMs: performance.now() - start }
}

Object.assign(globalThis, { __seedMediaCapacity: seed })
