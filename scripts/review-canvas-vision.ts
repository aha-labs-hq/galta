import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { judgeCanvasAnswers } from './lib/canvas-intent-judge'
import { isSupportedAnswer, type AnswerCase } from './lib/canvas-intent-assessment'

const directory = resolve(Bun.argv[2] ?? '')
if (!Bun.argv[2]) throw new Error('Supply a completed diagnostic directory')
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const planBytes = await readFile(join(directory, 'plan.json')), plan = JSON.parse(planBytes.toString())
assert.equal(hash(planBytes), (await readFile(join(directory, 'plan.sha256'), 'utf8')).trim())
assert.equal(plan.schema, 'galta-vision-diagnostic-v2', 'Use the archived execution-time reviewer for an earlier protocol')
const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))
assert.equal(run.planSha256, hash(planBytes))
assert.equal(run.results.length, plan.trials.length)
assert.deepEqual(new Set(run.results.map((item: any) => item.id)), new Set(plan.trials.map((item: any) => item.id)))
await mkdir(join(directory, 'review'))
const packets: any[] = []
for (const scene of plan.scenes) {
  assert.equal(hash(await readFile(join(directory, scene.image))), scene.imageSha256)
  const cases: AnswerCase[] = []
  for (const trial of plan.trials.filter((item: any) => item.scene === scene.id)) {
    const result = run.results.find((item: any) => item.id === trial.id)
    if (result.status !== 'completed') continue
    const pixels = plan.conditions.find((item: any) => item.id === trial.condition).pixels
    cases.push({ id: trial.id, request: plan.request, answer: result.answer,
      facts: pixels ? ['The attached image is the actual submitted viewport. Judge appearance from these pixels. Shape names are optional when the spatial description is accurate.']
        : ['The answering agent received only these bounding boxes and no image or path vertices. Shape, color and stroke direction are unknown. Explicitly acknowledging these limits and describing supported box relationships is an appropriate complete response; a lucky guess about hidden pixels is not supported evidence.'],
      ...(pixels ? { previewPath: join(directory, scene.image) } : { canvas: { selectedIds: [], elements: scene.observation.visible.items.map((item: any) => ({ id: item.id, type: 'freedraw', bounds: item.bounds })) } }) })
  }
  const evidence = join(directory, 'review', scene.id); await mkdir(evidence)
  // No family name, condition name, treatment instructions, answer key or native
  // path is included. Only the user request, answer and applicable evidence.
  packets.push({ scene: scene.id, evidence, cases })
}
const reviews: any[] = [], source = ['scripts/review-canvas-vision.ts', 'scripts/lib/canvas-intent-judge.ts', 'scripts/lib/canvas-intent-assessment.ts']
await writeFile(join(directory, 'review', 'protocol.json'), JSON.stringify({ preparedAt: new Date().toISOString(), planSha256: hash(planBytes),
  sourceHashes: Object.fromEntries(await Promise.all(source.map(async file => [file, hash(await readFile(resolve(import.meta.dir, '..', file)))]))),
  blinding: 'Condition and family names, path geometry and source facts withheld from the judge. The same model in a fresh context is not an independent model; retain uncertain verdicts and manual-review disagreements.',
  packets: packets.map(item => ({ scene: item.scene, caseIds: item.cases.map((entry: any) => entry.id) })) }, null, 2), { flag: 'wx' })
let next = 0
async function worker() {
  while (next < packets.length) {
    const packet = packets[next++]
    try {
      if (!packet.cases.length) {
        reviews.push({ scene: packet.scene, status: 'no-completed-trials' })
        continue
      }
      const results = await judgeCanvasAnswers(packet.cases, packet.evidence, plan.model)
      reviews.push({ scene: packet.scene, status: 'calibrated', results })
    } catch (error) {
      const failure = { scene: packet.scene, status: 'unscored', error: String(error) }
      reviews.push(failure)
      await writeFile(join(packet.evidence, 'failure.json'), JSON.stringify(failure, null, 2), { flag: 'wx' })
    }
    console.log(JSON.stringify({ scene: packet.scene, completed: reviews.length, total: packets.length }))
  }
}
await Promise.all([worker(), worker()])
const assessments = reviews.flatMap(item => item.results ?? [])
const counts = Object.fromEntries(plan.conditions.map((condition: any) => {
  const trials = plan.trials.filter((item: any) => item.condition === condition.id)
  const results = trials.flatMap((item: any) => assessments.filter((result: any) => result.id === item.id))
  const completed = run.results.filter((item: any) => item.condition === condition.id && item.status === 'completed').length
  return [condition.id, { total: trials.length, completed, executionFailures: trials.length - completed, unscored: completed - results.length,
    scored: results.length, supportedAndComplete: results.filter(isSupportedAnswer).length,
    contradicted: results.filter((item: any) => item.verdict === 'contradicted').length,
    insufficientEvidence: results.filter((item: any) => item.verdict === 'insufficient-evidence').length,
    incomplete: results.filter((item: any) => !item.complete).length }]
}))
await writeFile(join(directory, 'review.json'), JSON.stringify({ planSha256: hash(planBytes), completedAt: new Date().toISOString(), reviews, counts,
  status: run.results.every((item: any) => item.status === 'completed') && reviews.every(item => item.status === 'calibrated') ? 'scored-pending-manual-review' : 'incomplete-assessment',
  populationSuccessClaim: false }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(counts, null, 2))
