import { afterAll, test, expect } from 'bun:test'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { aggregateRuns, compare, metrics, readRun, MIN_MATCHED_SCENARIOS, evaluate, evaluateReceipts, writeAgentRunReceipt } from '../scripts/lib/agent-evaluation.ts'

// Every directory a test makes is removed after the file, so runs leave nothing in /tmp.
const temporary = []
const temporaryDirectory = async () => { const directory = await mkdtemp('/tmp/galta-evaluation-test-'); temporary.push(directory); return directory }
afterAll(() => Promise.all(temporary.map(directory => rm(directory, { recursive: true, force: true }))))

const run = (overrides = {}) => {
  const result = {
  schema: 'galta-agent-run-v1', runStatus: 'completed', model: 'gpt-test', realModel: true, isolated: true, noUserCanvasMutation: true,
  noUserWorkspaceAccess: true,
  runId: crypto.randomUUID(), evidenceVerified: true,
  trial: { suite: 'test', harness: 'test-harness', conditions: 'test-conditions' },
  evidenceDirectory: '/tmp/galta-evaluation-fixture',
  isolation: { chromeProfile: '/tmp/galta-profile', codexHome: '/tmp/galta-codex', workspaceDirectory: '/tmp/galta-workspace' },
  scenarios: [{ id: 'source', success: true, toolCalls: [{ tool: 'browser_inspect', status: 'completed' }] }, { id: 'canvas', success: true, toolCalls: [{ tool: 'canvas_edit', status: 'completed' }] }],
  ...overrides
  }
  result.scenarios = result.scenarios.map(scenario => ({ fixture: `fixture-${scenario.id}`, ...scenario }))
  return result
}

test('agent metrics expose task success, tool errors and recovery separately', () => {
  const result = metrics(run({ scenarios: [
    { id: 'failed-then-recovered', success: true, recovered: true, toolCalls: [{ tool: 'canvas_inspect', status: 'failed', error: 'stale revision' }, { tool: 'canvas_inspect', status: 'completed' }] },
    { id: 'failed', success: false, toolCalls: [{ tool: 'canvas_edit', status: 'failed', error: 'invalid operation' }] }
  ]}))
  expect(result.taskSuccessRate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
  expect(result.toolCallErrorRate).toMatchObject({ numerator: 2, denominator: 3 })
  expect(result.recoveryRate).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
  expect(result.taskSuccessRate.confidence95[0]).toBeGreaterThanOrEqual(0)
  expect(result.taskSuccessRate.confidence95[1]).toBeLessThanOrEqual(1)
})

test('comparison is paired by scenario ID and only calls a strict improvement an improvement', () => {
  const baseline = run({ scenarios: [{ id: 'source', success: false, toolCalls: [{ tool: 'browser_act', status: 'failed' }] }, { id: 'canvas', success: true, toolCalls: [{ tool: 'canvas_edit', status: 'completed' }] }] })
  const candidate = run({ scenarios: [{ id: 'source', success: true, toolCalls: [{ tool: 'browser_act', status: 'completed' }] }, { id: 'canvas', success: true, toolCalls: [{ tool: 'canvas_edit', status: 'completed' }] }, { id: 'new', success: true, toolCalls: [] }] })
  expect(compare(baseline, candidate)).toMatchObject({ matchedScenarios: 2, evidenceSufficient: false, candidateImproved: false, candidateSuccessDelta: 0.5, candidateToolErrorDelta: -0.5 })
})

test('omitting a baseline scenario is scored as a candidate failure', () => {
  const baseline = run({ scenarios: [
    { id: 'hard', success: true, toolCalls: [{ tool: 'canvas_inspect', status: 'completed' }] },
    { id: 'other', success: true, toolCalls: [{ tool: 'canvas_inspect', status: 'completed' }] }
  ] })
  const candidate = run({ scenarios: [{ id: 'other', success: true, toolCalls: [{ tool: 'canvas_inspect', status: 'completed' }] }] })
  expect(compare(baseline, candidate)).toMatchObject({ matchedScenarios: 2, candidateSuccessDelta: -0.5, candidateImproved: false })
})

test('requires enough controlled scenarios before reporting sample improvement', async () => {
  const scenarios = Array.from({ length: MIN_MATCHED_SCENARIOS }, (_, index) => ({ id: `case-${index}`, success: false, toolCalls: [{ tool: 'canvas_inspect', status: 'failed' }] }))
  const improved = scenarios.map(scenario => ({ ...scenario, success: true, recovered: true, toolCalls: [{ tool: 'canvas_inspect', status: 'failed' }, { tool: 'canvas_inspect', status: 'completed' }] }))
  const baseline = run({ scenarios })
  const candidate = run({ scenarios: improved })
  const comparison = compare(baseline, candidate)
  expect(comparison).toMatchObject({ matchedScenarios: MIN_MATCHED_SCENARIOS, evidenceSufficient: true, candidateImproved: true })
  const directory = await temporaryDirectory()
  const baselineEvidence = join(directory, 'baseline'), candidateEvidence = join(directory, 'candidate')
  await mkdir(baselineEvidence); await mkdir(candidateEvidence)
  await writeFile(join(baselineEvidence, 'turn.json'), '{"status":"completed"}\n')
  await writeFile(join(candidateEvidence, 'turn.json'), '{"status":"completed"}\n')
  const baselinePath = join(baselineEvidence, 'live.json'), candidatePath = join(candidateEvidence, 'live.json')
  await writeAgentRunReceipt(baselineEvidence, { ...baseline, evidenceDirectory: baselineEvidence })
  await writeAgentRunReceipt(candidateEvidence, { ...candidate, evidenceDirectory: candidateEvidence })
  await expect(evaluate(candidatePath, baselinePath)).resolves.toMatchObject({ decision: 'pass' })
})

test('aggregation keeps independent runs paired by their original scenario IDs', async () => {
  const directory = await temporaryDirectory()
  const paths = await Promise.all([1, 2, 3].map(async index => {
    const path = join(directory, `run-${index}.json`)
    await writeFile(path, JSON.stringify(run({ runId: `run-${index}` })))
    return path
  }))
  const aggregated = await aggregateRuns(paths)
  expect(aggregated.scenarios.map(scenario => scenario.id)).toEqual(['source#run-1', 'canvas#run-1', 'source#run-2', 'canvas#run-2', 'source#run-3', 'canvas#run-3'])
  await expect(aggregateRuns([paths[0], paths[0]])).rejects.toThrow('Repeated receipt paths')
  const duplicate = join(directory, 'duplicate.json')
  await writeFile(duplicate, JSON.stringify(run({ runId: 'run-1' })))
  await expect(aggregateRuns([paths[0], duplicate])).rejects.toThrow('Repeated run IDs')
})

test('different fixtures, execution conditions, absent evidence and self-comparison cannot count as controlled pairs', () => {
  const baseline = run({ scenarios: Array.from({ length: MIN_MATCHED_SCENARIOS }, (_, index) => ({ id: `case-${index}`, success: true, toolCalls: [] })) })
  for (const candidate of [
    { ...baseline },
    { ...baseline, runId: undefined },
    { ...baseline, runId: 'new', evidenceVerified: undefined },
    { ...baseline, runId: 'new', trial: undefined },
    { ...baseline, runId: 'new', trial: { ...baseline.trial, conditions: 'different' } },
    { ...baseline, runId: 'new', scenarios: baseline.scenarios.map(item => ({ ...item, fixture: 'different-seed' })) }
  ]) expect(evaluateReceipts(candidate, baseline).decision).toBe('insufficient-evidence')
})

test('receipts without isolation proof are rejected before scoring', async () => {
  const directory = await temporaryDirectory(), path = join(directory, 'invalid.json')
  await writeFile(path, JSON.stringify(run({ isolated: false })))
  await expect(readRun(path)).rejects.toThrow('not isolated')
})

test('timed out receipts cannot authorize a passing comparison', () => {
  const scenarios = Array.from({ length: MIN_MATCHED_SCENARIOS }, (_, index) => ({ id: `timeout-${index}`, success: false, toolCalls: [{ tool: 'canvas_inspect', status: 'failed' }] }))
  const candidate = run({ runStatus: 'timed_out', scenarios: scenarios.map(item => ({ ...item, success: true })) })
  const result = evaluateReceipts(candidate, run({ scenarios }))
  expect(result.decision).toBe('insufficient-evidence')
  expect(result.comparison).toMatchObject({ inputEligible: false, eligibilityReasons: ['Candidate run is timed_out.'] })
})

test('different models cannot be compared as an improvement', () => {
  const scenarios = Array.from({ length: MIN_MATCHED_SCENARIOS }, (_, index) => ({ id: `model-${index}`, success: false, toolCalls: [] }))
  const result = evaluateReceipts(run({ model: 'gpt-baseline', scenarios }), run({ model: 'gpt-candidate', scenarios }))
  expect(result.decision).toBe('insufficient-evidence')
  expect(result.comparison?.eligibilityReasons).toContain('Baseline and candidate must use the same model.')
})

test('an unchanged controlled result is not a regression', () => {
  const scenarios = Array.from({ length: MIN_MATCHED_SCENARIOS }, (_, index) => ({ id: `same-${index}`, success: true, toolCalls: [] }))
  const result = evaluateReceipts(run({ scenarios }), run({ scenarios }))
  expect(result.decision).toBe('unchanged')
})

test('receipts pointing at the repository are rejected as non-isolated', async () => {
  const directory = await temporaryDirectory(), path = join(directory, 'unsafe.json')
  await writeFile(path, JSON.stringify(run({ isolation: { chromeProfile: process.cwd(), codexHome: '/tmp/galta-codex', workspaceDirectory: '/tmp/galta-workspace' } })))
  await expect(readRun(path)).rejects.toThrow('temporary absolute path')
})

test('unattested receipts cannot authorize a passing comparison', async () => {
  const directory = await temporaryDirectory()
  const scenarios = Array.from({ length: MIN_MATCHED_SCENARIOS }, (_, index) => ({ id: `probe-${index}`, success: index > 0, toolCalls: [] }))
  const baselinePath = join(directory, 'baseline.json'), candidatePath = join(directory, 'candidate.json')
  await writeFile(baselinePath, JSON.stringify(run({ scenarios: scenarios.map(item => ({ ...item, success: false })) })))
  await writeFile(candidatePath, JSON.stringify(run({ scenarios: scenarios.map(item => ({ ...item, success: true })) })))
  const result = await evaluate(candidatePath, baselinePath)
  expect(result.decision).toBe('insufficient-evidence')
  expect(result.comparison?.eligibilityReasons).toEqual(['Receipt has no detached evidence manifest.', 'Receipt has no detached evidence manifest.'])
})

test('detached evidence binds receipt contents and recorded files', async () => {
  const directory = await temporaryDirectory(), evidence = join(directory, 'evidence')
  await mkdir(evidence)
  const sample = join(evidence, 'turn.json')
  await writeFile(sample, '{"status":"completed"}\n')
  const base = run({ evidenceDirectory: evidence })
  await writeAgentRunReceipt(evidence, base)
  const receiptPath = join(evidence, 'live.json')
  expect((await readRun(receiptPath)).evidenceVerified).toBe(true)
  await writeFile(sample, '{"status":"forged"}\n')
  const changed = await readRun(receiptPath)
  expect(changed.evidenceVerified).toBe(false)
  expect(changed.evidenceError).toContain('Evidence file changed after attestation')
})

test('detached evidence rejects files added after attestation', async () => {
  const directory = await temporaryDirectory(), evidence = join(directory, 'evidence')
  await mkdir(evidence)
  const base = run({ evidenceDirectory: evidence })
  await writeAgentRunReceipt(evidence, base)
  await writeFile(join(evidence, 'late.json'), '{"written":"after attestation"}\n')
  const changed = await readRun(join(evidence, 'live.json'))
  expect(changed.evidenceVerified).toBe(false)
  expect(changed.evidenceError).toContain('outside the detached manifest')
})
