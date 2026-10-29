import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Real-model task scenarios for `scripts/verify-canvas-craft.ts`. Each seeds
 * a disposable canvas (and optionally the bound page), sends its prompts in one
 * conversation, and judges the result from the document, the replies and the
 * page. Checks test the outcome the words ask for, not a tool sequence. */
export type CraftCall = (name: string, args?: Record<string, unknown>) => Promise<any>
export type CraftSeed = { call: CraftCall; text: (result: any) => string; workspace: string; references: string; token: (key: string) => string }
export type CraftResult = { elements: any[]; revision: string; seededRevision?: string; answers: string[]; tools: string[]; pageText: string; token: (key: string) => string }
export type CraftScenario = {
  id: string
  /** Bound page HTML; `token` gives this run's unguessable strings. */
  page?: (token: (key: string) => string) => string
  seed?: (seed: CraftSeed) => Promise<void>
  prompts: { text: string; model?: string; effort?: string }[]
  check: (result: CraftResult) => Promise<{ pass: boolean; notes: string[] }> | { pass: boolean; notes: string[] }
}

/** The five references of the 2026-10-27 session, overlapping as they were. */
export const BOARD = [
  ['girl', 22.75, 214, 316.5, 420], ['ui', -209.18, 185, 326.36, 420], ['flower', 115.75, 242, 316.5, 420],
  ['ghost', -82.8, 728, 235.6, 420], ['suitcat', 54, 574.44, 420, 419.11]
] as const

async function seedBoard({ call, text, workspace, references }: CraftSeed) {
  await mkdir(join(workspace, 'sources'), { recursive: true })
  for (const [name] of BOARD) await copyFile(join(references, `${name}.jpg`), join(workspace, 'sources', `${name}.jpg`))
  const before = JSON.parse(text(await call('canvas_inspect', {})))
  await call('canvas_edit', { revision: before.revision, operations: BOARD.map(([name, x, y, width, height]) => ({ type: 'create_element', id: `ref-${name}`, elementType: 'image', x, y, props: { mediaPath: join(workspace, 'sources', `${name}.jpg`), width, height } })) })
}

async function seedNative({ call, text }: CraftSeed, operations: unknown[]) {
  const before = JSON.parse(text(await call('canvas_inspect', {})))
  await call('canvas_edit', { revision: before.revision, operations })
}

const byId = (elements: any[]) => new Map(elements.map(element => [element.id, element]))
const allText = (elements: any[]) => elements.map(element => element.text ?? '').join('\n')
const rgb = (hex: string) => { const m = /^#?([0-9a-f]{6})/i.exec(hex ?? ''); return m ? [0, 2, 4].map(i => parseInt(m[1]!.slice(i, i + 2), 16)) : undefined }
const blue = (hex: string) => { const c = rgb(hex); return !!c && c[2]! > c[0]! + 40 && c[2]! >= c[1]! }
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance

export const SCENARIOS: Record<string, CraftScenario> = {
  craft: {
    id: 'craft', seed: seedBoard,
    prompts: [{ text: '帮我给画布归归类' }, { text: '用画笔临摹一下西装猫' }],
    check: ({ elements }) => {
      const strokes = elements.filter(element => element.type === 'freedraw').length
      return { pass: strokes > 0, notes: [`${strokes} brush strokes`] }
    }
  },
  chat: {
    id: 'chat',
    prompts: [{ text: '你好，你能帮我做什么？一句话回答就好。' }],
    check: ({ answers, tools }) => ({ pass: tools.length === 0 && answers.join('').trim().length > 0, notes: [`tools: ${tools.join(',') || 'none'}`] })
  },
  perceive: {
    id: 'perceive', seed: seedBoard,
    prompts: [{ text: '画布上一共有几张图片？其中有几只猫？只回答，不要改动画布。' }],
    check: ({ answers, revision, seededRevision }) => {
      const reply = answers.join('\n')
      const images = /(5|五)\s*张/.test(reply), cats = /(2|两|二)\s*只/.test(reply), untouched = revision === seededRevision
      return { pass: images && cats && untouched, notes: [`five images: ${images}`, `two cats: ${cats}`, `canvas untouched: ${untouched}`] }
    }
  },
  diagram: {
    id: 'diagram',
    prompts: [{ text: '画一个用户注册流程图：填写邮箱 → 验证邮箱 → 设置密码 → 注册完成。每一步一个方框，用箭头按顺序连接。' }],
    check: ({ elements }) => {
      const steps = ['填写邮箱', '验证邮箱', '设置密码', '注册完成']
      const shapes = elements.filter(element => ['rectangle', 'ellipse', 'diamond'].includes(element.type))
      const texts = elements.filter(element => element.type === 'text')
      const box = (step: string) => {
        const bound = texts.find(text => text.containerId && (text.text ?? '').includes(step))
        if (bound) return { id: bound.containerId as string, bound: true }
        const loose = texts.find(text => (text.text ?? '').includes(step))
        const holder = loose && shapes.find(shape => loose.bounds.x >= shape.bounds.x - 4 && loose.bounds.x + loose.bounds.width <= shape.bounds.x + shape.bounds.width + 4 && loose.bounds.y >= shape.bounds.y - 4 && loose.bounds.y + loose.bounds.height <= shape.bounds.y + shape.bounds.height + 4)
        return holder ? { id: holder.id as string, bound: false } : undefined
      }
      const boxes = steps.map(box)
      const arrows = elements.filter(element => element.type === 'arrow')
      const linked = boxes.slice(1).map((to, index) => {
        const from = boxes[index]
        return !!from && !!to && arrows.some(arrow => arrow.startBinding?.elementId === from.id && arrow.endBinding?.elementId === to.id)
      })
      const allBound = boxes.every(item => item?.bound)
      return { pass: boxes.every(Boolean) && linked.every(Boolean), notes: [`steps in boxes: ${boxes.filter(Boolean).length}/4`, `text bound to boxes: ${allBound}`, `arrows bound in order: ${linked.filter(Boolean).length}/3`] }
    }
  },
  page: {
    id: 'page', seed: seedBoard,
    prompts: [{ text: '参考画布上的这些图，做一个简单的作品集落地页，放到画布上。' }],
    check: async ({ elements }) => {
      const pages = elements.filter(element => element.kind === 'html')
      let bytes = 0
      for (const element of pages) for (const value of Object.values(element)) {
        if (typeof value === 'string' && value.endsWith('.html')) bytes = Math.max(bytes, (await stat(value).catch(() => ({ size: 0 }))).size)
      }
      return { pass: pages.length > 0 && bytes > 500, notes: [`pages: ${pages.length}`, `largest page file: ${bytes} bytes`] }
    }
  },
  webpage: {
    id: 'webpage',
    page: token => `<!doctype html><title>${token('title')}</title><main style="font:20px sans-serif;margin:40px"><h1>${token('title')}</h1><ul><li>${token('one')}</li><li>${token('two')}</li><li>${token('three')}</li></ul></main>`,
    prompts: [{ text: '把左边网页上的标题和三个要点整理成一张便签，放到画布上。' }],
    check: ({ elements, token, tools }) => {
      const text = allText(elements)
      const found = ['title', 'one', 'two', 'three'].filter(key => text.includes(token(key)))
      return { pass: found.length === 4, notes: [`page strings on canvas: ${found.length}/4`, `browser tools: ${tools.filter(tool => tool.startsWith('browser_')).join(',') || 'none'}`] }
    }
  },
  edit: {
    id: 'edit',
    seed: seed => seedNative(seed, [
      { type: 'create_element', id: 'house-body', elementType: 'rectangle', x: 100, y: 200, props: { width: 300, height: 200, backgroundColor: '#f4e3c3', fillStyle: 'solid', strokeColor: '#5c4033', roughness: 0, groupIds: ['house'] } },
      { type: 'create_element', id: 'house-roof', elementType: 'line', x: 80, y: 200, props: { points: [[0, 0], [170, -130], [340, 0], [0, 0]], backgroundColor: '#e03131', fillStyle: 'solid', strokeColor: '#c92a2a', roughness: 0, groupIds: ['house'] } },
      { type: 'create_element', id: 'house-door', elementType: 'rectangle', x: 220, y: 300, props: { width: 60, height: 100, backgroundColor: '#8c5a3c', fillStyle: 'solid', strokeColor: '#5c4033', roughness: 0, groupIds: ['house'] } },
      { type: 'create_element', id: 'house-window', elementType: 'rectangle', x: 130, y: 240, props: { width: 60, height: 50, backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeColor: '#5c4033', roughness: 0, groupIds: ['house'] } }
    ]),
    prompts: [{ text: '把房子的屋顶改成蓝色，其他部分保持不变。' }],
    check: ({ elements }) => {
      const map = byId(elements)
      const roof = map.get('house-roof')
      const recoloured = !!roof && (blue(roof.backgroundColor) || blue(roof.strokeColor))
      const keep = { 'house-body': '#f4e3c3', 'house-door': '#8c5a3c', 'house-window': '#a5d8ff' } as Record<string, string>
      const kept = Object.entries(keep).every(([id, colour]) => map.get(id)?.backgroundColor?.toLowerCase() === colour)
      const unmoved = ['house-body', 'house-door', 'house-window'].every(id => map.get(id) && near(map.get(id).x, { 'house-body': 100, 'house-door': 220, 'house-window': 130 }[id]!, 1))
      return { pass: recoloured && kept && unmoved, notes: [`roof blue in place: ${recoloured}`, `other colours kept: ${kept}`, `others unmoved: ${unmoved}`] }
    }
  },
  translate: {
    id: 'translate',
    seed: seed => seedNative(seed, [
      { type: 'create_text', id: 'line-1', x: 100, y: 100, text: 'Morning light on the water' },
      { type: 'create_text', id: 'line-2', x: 100, y: 180, text: 'A quiet harbor at dawn' },
      { type: 'create_text', id: 'line-3', x: 100, y: 260, text: 'Paper boats drifting home' }
    ]),
    prompts: [{ text: '把画布上的英文都翻译成中文，直接替换原文，位置不变。' }],
    check: ({ elements }) => {
      const map = byId(elements)
      const results = ['line-1', 'line-2', 'line-3'].map((id, index) => {
        const element = map.get(id)
        return !!element && /[一-鿿]/.test(element.text ?? '') && !/[A-Za-z]{3,}/.test(element.text ?? '') && near(element.x, 100, 5) && near(element.y, 100 + index * 80, 5)
      })
      return { pass: results.every(Boolean), notes: [`replaced in place: ${results.filter(Boolean).length}/3`] }
    }
  },
  generate: {
    id: 'generate',
    prompts: [{ text: '生成一张小猫戴着礼帽的插画，放到画布上。' }],
    check: ({ elements, tools }) => {
      const images = elements.filter(element => element.type === 'image').length
      return { pass: images > 0, notes: [`images on canvas: ${images}`, `tools: ${[...new Set(tools)].join(',') || 'none'}`] }
    }
  },
  switch: {
    id: 'switch', seed: seedBoard,
    prompts: [{ text: '画布上有几张图？', model: 'gpt-6.1-sol', effort: 'Medium' }, { text: '把这些图排成一行，顶部对齐，间距一致。', model: 'gpt-6-astra', effort: 'High' }],
    check: ({ elements }) => {
      const images = BOARD.map(([name]) => elements.find(element => element.id === `ref-${name}`)).filter(Boolean).sort((a, b) => a.bounds.x - b.bounds.x)
      const tops = images.every(image => near(image.bounds.y, images[0].bounds.y, 2))
      const gaps = images.slice(1).map((image, index) => image.bounds.x - (images[index].bounds.x + images[index].bounds.width))
      const even = gaps.length === 4 && gaps.every(gap => gap > 0 && near(gap, gaps[0]!, 3))
      return { pass: images.length === 5 && tops && even, notes: [`images: ${images.length}`, `tops aligned: ${tops}`, `even gaps: ${even} (${gaps.map(gap => Math.round(gap)).join(',')})`] }
    }
  }
}
