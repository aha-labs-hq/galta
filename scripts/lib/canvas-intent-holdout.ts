import { createHash, randomUUID } from 'node:crypto'

/**
 * Data for a live intent trial. The runner owns the UI actions and the oracle
 * owns only facts that can be checked after the turn. Prompts intentionally do
 * not name tools, element IDs, or expected filenames.
 */
export type CanvasIntentHoldout = {
  seed: string
  oldImageName: string
  selectedImageName: string
  staleOutputName: string
  oldLabel: string
  selectedLabel: string
  oldColor: string
  selectedColor: string
  noteName: string
  copyName: string
  independentName: string
  noteContent: string
  selectedFirst: boolean
  overlap: boolean
  prompts: {
    empty: string
    describe: string
    ordinary: string
    unsupported: string
    deliverSelected: string
    compareSelection: string
    independent: string
    explicitOther: string
  }
}

const colors = ['#b03040', '#2f5aa8', '#8a4f24', '#5f3d8f', '#1d6b64'] as const
const labels = ['amber', 'cedar', 'linen', 'quartz', 'violet'] as const
const describePrompts = [
  '看一下当前画布，用一句话说说你观察到的内容；保持原作不变。',
  '请先观察眼前的画面，概括你看到的东西，不要修改任何内容。',
  '告诉我你现在看到的画面大致是什么样，阅读即可，不要动作品。'
] as const
const deliverPrompts = [
  '刚才我点中的那张图，帮我把原始文件交付到当前工作目录，并给一个下载链接，画布不要变。',
  '把我刚刚圈出来的图片源文件放到当前工作目录，完成后给我链接；不要替换画布内容。',
  '我手边那张图片需要原文件，请将它交到当前工作目录并返回下载链接，保持作品不动。'
] as const
const comparePrompts = [
  '比较这两张图片，分别说出图上的文字和背景颜色，别改画面。',
  '这两张图的文字和底色有什么不同？请分别看清楚后告诉我，保持原作不变。',
  '请读出这两张图片各自的文字，并比较背景颜色，这次不要编辑。'
] as const
const emptyPrompts = [
  '先看一眼现在的画布，告诉我它是否有内容；不要创建或修改任何东西。',
  '请观察当前空白画布并说明状态，这次只读，不要动它。',
  '当前画布是什么状态？请直接回答，保持画布不变。'
] as const
const ordinaryPrompts = [
  (name: string, destination: string) => `请把工作区里名为“${name}”的普通文本文件复制到当前工作目录，命名为“${destination}”，并给我可下载的文件链接。不要修改画布。`,
  (name: string, destination: string) => `找到工作区中的“${name}”，把它交付到当前工作目录并保存成“${destination}”，最后提供下载链接；画布保持原样。`,
  (name: string, destination: string) => `请将文件“${name}”保存一份到当前工作目录，目标名为“${destination}”，并返回用户可以下载的链接，不要改变作品。`
] as const
const unsupportedPrompts = [
  '请交付我刚刚点到的对象的原始可编辑来源；如果没有来源，照实说明，不要拿别的文件代替。',
  '把我指向的对象对应的源文件取出来；没有就告诉我，不要生成截图或换成旧导出。',
  '请尝试给出当前焦点对象的原始文件；如果系统没有保存源文件，就明确拒绝交付，作品不要改变。'
] as const

function digest(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0)
}

function pick<T>(values: readonly T[], state: { value: number }): T {
  state.value = (state.value * 1664525 + 1013904223) >>> 0
  return values[state.value % values.length]!
}

function suffix(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 10)
}

/** Generate a reproducible but opaque holdout. Persist the seed in the receipt
 * so a reviewer can replay the exact trial, while each default run remains
 * different from the previous one. */
export function createCanvasIntentHoldout(seed: string = randomUUID()): CanvasIntentHoldout {
  const state = { value: digest(seed) }
  const token = suffix(seed)
  const oldLabel = `${pick(labels, state)}-${token}`
  let selectedWord = pick(labels, state)
  if (selectedWord === oldLabel.slice(0, oldLabel.indexOf('-'))) selectedWord = labels[(labels.indexOf(selectedWord) + 1) % labels.length]!
  const selectedLabel = `${selectedWord}-${token}`
  const oldColor = pick(colors, state)
  let selectedColor = pick(colors, state)
  if (selectedColor === oldColor) selectedColor = colors[(colors.indexOf(oldColor) + 1) % colors.length]!
  return {
    seed,
    oldImageName: `asset-${suffix(seed + '/old')}.png`,
    selectedImageName: `asset-${suffix(seed + '/selected')}.png`,
    staleOutputName: `asset-${suffix(seed + '/stale')}.png`,
    oldLabel,
    selectedLabel,
    oldColor,
    selectedColor,
    noteName: `note-${token}.txt`,
    copyName: `handoff-${token}.txt`,
    independentName: `independent-${token}.txt`,
    noteContent: `galta holdout note ${token}\nThis byte sequence is the source of truth.\n`,
    selectedFirst: digest(seed + '/order') % 2 === 0,
    overlap: digest(seed + '/layout') % 2 === 0,
    prompts: {
      empty: pick(emptyPrompts, state),
      describe: pick(describePrompts, state),
      ordinary: pick(ordinaryPrompts, state)(`note-${token}.txt`, `handoff-${token}.txt`),
      unsupported: pick(unsupportedPrompts, state),
      deliverSelected: pick(deliverPrompts, state),
      compareSelection: pick(comparePrompts, state),
      independent: `我虽然选着一个画布对象，但这次只需要工作区里的 note-${token}.txt。原样复制成 independent-${token}.txt，给我下载链接，画布别动。`,
      explicitOther: `这次不是选中的图，请把写着 ${oldLabel} 的那张图的原文件交给我，给下载链接，不要修改画布。`
    }
  }
}
