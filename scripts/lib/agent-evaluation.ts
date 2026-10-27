import { readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'

export const AGENT_RUN_SCHEMA = 'galta-agent-run-v1'
export const AGENT_EVALUATION_SCHEMA = 'galta-agent-evaluation-v1'
export const AGENT_EVIDENCE_SCHEMA = 'galta-agent-evidence-v1'
export const MIN_MATCHED_SCENARIOS = 6

/*
 * Receipts are a protocol boundary, even though they are produced by our own
 * verification scripts. Keep the shape in one runtime schema so a new field
 * cannot accidentally become an unchecked assertion. `passthrough` is
 * deliberate: the receipt also carries scenario-specific evidence, while the
 * fields below remain the stable evaluator contract.
 */
const toolCallSchema = z.object({
  tool: z.string().min(1),
  status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
  error: z.string().optional()
}).passthrough()
const scenarioSchema = z.object({
  id: z.string().min(1),
  success: z.boolean(),
  toolCalls: z.array(toolCallSchema).readonly(),
  fixture: z.string().min(1).optional(),
  recovered: z.boolean().optional(),
  note: z.string().optional()
}).passthrough()
const isolationSchema = z.object({
  chromeProfile: z.string().min(1),
  codexHome: z.string().min(1),
  workspaceDirectory: z.string().min(1),
  runCount: z.number().int().positive().optional()
}).passthrough()
const agentRunReceiptSchema = z.object({
  schema: z.literal(AGENT_RUN_SCHEMA),
  runStatus: z.enum(['completed', 'failed', 'timed_out', 'cancelled']),
  runId: z.string().min(1).optional(),
  verifiedAt: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  realModel: z.boolean(),
  isolated: z.boolean(),
  noUserCanvasMutation: z.boolean(),
  noUserWorkspaceAccess: z.boolean(),
  evidenceDirectory: z.string().min(1),
  isolation: isolationSchema,
  scenarios: z.array(scenarioSchema).min(1).readonly(),
  trial: z.strictObject({ suite: z.string().min(1), harness: z.string().min(1), conditions: z.string().min(1) }).optional(),
  boundaries: z.record(z.string(), z.boolean()).optional(),
  evidence: z.object({
    manifest: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    receiptSha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).optional()
}).passthrough()
const evidenceManifestSchema = z.object({
  schema: z.literal(AGENT_EVIDENCE_SCHEMA),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).passthrough())
}).passthrough()

export type ToolCallReceipt = z.infer<typeof toolCallSchema>
export type ScenarioReceipt = z.infer<typeof scenarioSchema>
export type IsolationEvidence = z.infer<typeof isolationSchema>
export type AgentRunStatus = z.infer<typeof agentRunReceiptSchema>['runStatus']
export type AgentRunReceipt = z.infer<typeof agentRunReceiptSchema> & { evidenceVerified?: boolean; evidenceError?: string }
type EvidenceManifest = z.infer<typeof evidenceManifestSchema>

export type Rate = { value: number; numerator: number; denominator: number; confidence95: [number, number] }

export type AgentEvaluation = {
  schema: typeof AGENT_EVALUATION_SCHEMA
  generatedAt: string
  baseline?: { path: string; run: AgentRunReceipt; metrics: AgentMetrics }
  candidate: { path: string; run: AgentRunReceipt; metrics: AgentMetrics }
  comparison?: AgentComparison
  decision: 'pass' | 'insufficient-evidence' | 'unchanged' | 'regression'
}

export type AgentMetrics = {
  scenarios: number
  passedScenarios: number
  taskSuccessRate: Rate
  toolCalls: number
  failedToolCalls: number
  toolCallErrorRate: Rate
  recoveryAttempts: number
  recoveredTasks: number
  recoveryRate: Rate
}

export type AgentComparison = {
  matchedScenarios: number
  minimumMatchedScenarios: number
  evidenceSufficient: boolean
  inputEligible: boolean
  eligibilityReasons: ReadonlyArray<string>
  candidateSuccessDelta: number
  candidateToolErrorDelta: number
  candidateRecoveryDelta: number
  candidateImproved: boolean
  paired: ReadonlyArray<{ id: string; baseline: boolean; candidate: boolean }>
}

function rate(numerator: number, denominator: number): Rate {
  const value = denominator === 0 ? 0 : numerator / denominator
  if (denominator === 0) return { value, numerator, denominator, confidence95: [0, 0] }
  // Wilson interval keeps small evaluation runs honest instead of presenting
  // a brittle 0%/100% as certainty.
  const z = 1.959963984540054
  const z2 = z * z
  const centre = (value + z2 / (2 * denominator)) / (1 + z2 / denominator)
  const spread = z * Math.sqrt((value * (1 - value) + z2 / (4 * denominator)) / denominator) / (1 + z2 / denominator)
  return { value, numerator, denominator, confidence95: [Math.max(0, centre - spread), Math.min(1, centre + spread)] }
}

function isTemporaryAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  const resolved = resolve(value), temporaryRoot = resolve(tmpdir())
  return resolved.startsWith(`${temporaryRoot}${sep}`) || resolved.startsWith('/tmp/') || resolved.startsWith('/private/tmp/')
}

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const withoutEvidence = (run: AgentRunReceipt): Record<string, unknown> => {
  const { evidence: _evidence, evidenceVerified: _verified, evidenceError: _error, ...core } = run as AgentRunReceipt & Record<string, unknown>
  return core
}

function safeRelativePath(root: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return undefined
  const normalized = value.replaceAll('\\', '/'), target = resolve(root, normalized), rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || normalized.startsWith('../') || normalized.includes('/../')) return undefined
  return rel.split(sep).join('/')
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch { return false }
}

async function evidenceFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), rel = relative(root, path).split(sep).join('/')
    if (entry.isDirectory()) {
      files.push(...await evidenceFiles(root, path))
      continue
    }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Evidence contains a non-regular entry: ${rel}`)
    files.push(rel)
  }
  return files
}

/**
 * Create a detached, tamper-evident manifest for a run receipt. The manifest
 * excludes the receipt and itself; the receipt binds both back to its
 * canonical pre-attestation bytes. This is integrity evidence, not a claim
 * that the test process itself was trusted.
 */
export async function writeAgentRunReceipt(
  evidenceDirectory: string,
  baseReceipt: AgentRunReceipt,
  receiptName = 'live.json'
): Promise<AgentRunReceipt> {
  const root = resolve(evidenceDirectory), receiptPath = join(root, receiptName), manifestName = 'attestation.json', manifestPath = join(root, manifestName)
  const entries: Array<{ path: string; size: number; sha256: string }> = []
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), rel = relative(root, path).split(sep).join('/')
      if (rel === receiptName || rel === manifestName) continue
      if (entry.isDirectory()) { await visit(path); continue }
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Evidence must contain regular files only: ${rel}`)
      const bytes = await readFile(path)
      entries.push({ path: rel, size: bytes.byteLength, sha256: sha256(bytes) })
    }
  }
  await visit(root)
  const core = agentRunReceiptSchema.parse({ ...withoutEvidence(baseReceipt), evidenceDirectory: root })
  const manifest: EvidenceManifest = { schema: AGENT_EVIDENCE_SCHEMA, receiptSha256: sha256(canonical(core)), files: entries }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  const finalReceipt: AgentRunReceipt = {
    ...core,
    evidence: { manifest: manifestName, manifestSha256: sha256(canonical(manifest)), receiptSha256: manifest.receiptSha256 }
  }
  await writeFile(receiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`, { mode: 0o600 })
  return finalReceipt
}

async function verifyEvidence(run: AgentRunReceipt, receiptPath: string): Promise<{ verified: boolean; error?: string }> {
  if (!run.evidence) return { verified: false, error: 'Receipt has no detached evidence manifest.' }
  const root = resolve(run.evidenceDirectory), manifestRel = safeRelativePath(root, run.evidence.manifest)
  if (!manifestRel) return { verified: false, error: 'Evidence manifest must be a relative path inside evidenceDirectory.' }
  const manifestPath = join(root, manifestRel)
  if (!await regularFile(manifestPath)) return { verified: false, error: `Evidence manifest is missing or not a regular file: ${manifestRel}` }
  let manifest: EvidenceManifest
  try {
    const parsed = evidenceManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8')))
    if (!parsed.success) return { verified: false, error: `Unsupported evidence manifest: ${manifestRel}` }
    manifest = parsed.data as EvidenceManifest
  }
  catch { return { verified: false, error: `Evidence manifest is not valid JSON: ${manifestRel}` } }
  if (sha256(canonical(manifest)) !== run.evidence.manifestSha256) return { verified: false, error: 'Evidence manifest hash does not match the receipt.' }
  if (manifest.receiptSha256 !== run.evidence.receiptSha256 || manifest.receiptSha256 !== sha256(canonical(withoutEvidence(run)))) {
    return { verified: false, error: `Receipt contents changed after attestation: ${receiptPath}` }
  }
  const receiptRel = relative(root, resolve(receiptPath)).split(sep).join('/'), seen = new Set<string>()
  for (const file of manifest.files) {
    const rel = safeRelativePath(root, file?.path)
    if (!rel || rel === manifestRel || rel === receiptRel || seen.has(rel) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      return { verified: false, error: `Invalid evidence file entry: ${String(file?.path)}` }
    }
    seen.add(rel)
    const path = join(root, rel)
    if (!await regularFile(path)) return { verified: false, error: `Evidence file is missing or not a regular file: ${rel}` }
    const bytes = await readFile(path)
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) return { verified: false, error: `Evidence file changed after attestation: ${rel}` }
  }
  // The manifest is a complete inventory, not merely a list of files the
  // evaluator happens to use. An extra file added after attestation must make
  // the receipt unverifiable instead of leaving reviewers with a partial view.
  let actualFiles: string[]
  try { actualFiles = await evidenceFiles(root) }
  catch (error) { return { verified: false, error: error instanceof Error ? error.message : String(error) } }
  const expectedFiles = [...seen].sort()
  actualFiles = actualFiles.filter(rel => rel !== manifestRel && rel !== receiptRel).sort()
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((rel, index) => rel !== expectedFiles[index])) {
    return { verified: false, error: 'Evidence directory contains files outside the detached manifest.' }
  }
  return { verified: true }
}

function assertReceipt(value: unknown, path: string): asserts value is AgentRunReceipt {
  const parsed = agentRunReceiptSchema.safeParse(value)
  if (!parsed.success) {
    const candidate = value && typeof value === 'object' ? value as Partial<AgentRunReceipt> : undefined
    if (candidate?.schema !== AGENT_RUN_SCHEMA) throw new Error(`Unsupported agent run schema in ${path}`)
    if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(candidate?.runStatus as string)) throw new Error(`Invalid run status in ${path}`)
    if (candidate?.realModel !== true) throw new Error(`Real-model evidence is required: ${path}`)
    if (candidate?.isolated !== true || candidate?.noUserCanvasMutation !== true || candidate?.noUserWorkspaceAccess !== true) throw new Error(`Receipt is not isolated from the user's canvas: ${path}`)
    throw new Error(`Invalid agent run receipt in ${path}: ${parsed.error.issues[0]?.message ?? 'schema validation failed'}`)
  }
  const run = parsed.data as AgentRunReceipt
  if (!run.realModel) throw new Error(`Real-model evidence is required: ${path}`)
  if (!run.isolated || !run.noUserCanvasMutation || !run.noUserWorkspaceAccess) throw new Error(`Receipt is not isolated from the user's canvas: ${path}`)
  const evidenceDirectory = typeof run.evidenceDirectory === 'string' ? resolve(run.evidenceDirectory) : ''
  if (!isTemporaryAbsolutePath(evidenceDirectory)) {
    throw new Error(`Evidence must live in a temporary directory: ${path}`)
  }
  for (const name of ['chromeProfile', 'codexHome', 'workspaceDirectory'] as const) {
    const value = run.isolation[name]
    if (!isTemporaryAbsolutePath(value)) throw new Error(`Isolation path ${name} must be a temporary absolute path: ${path}`)
  }
  if (new Set(run.scenarios.map(scenario => scenario.id)).size !== run.scenarios.length) throw new Error(`Duplicate scenario ID in ${path}`)
}

export function metrics(run: AgentRunReceipt): AgentMetrics {
  const calls = run.scenarios.flatMap(scenario => scenario.toolCalls)
  const recoveryScenarios = run.scenarios.filter(scenario => scenario.toolCalls.some(call => call.status === 'failed' || call.status === 'cancelled'))
  const recoveredTasks = recoveryScenarios.filter(scenario => scenario.recovered === true && scenario.success).length
  return {
    scenarios: run.scenarios.length,
    passedScenarios: run.scenarios.filter(scenario => scenario.success).length,
    taskSuccessRate: rate(run.scenarios.filter(scenario => scenario.success).length, run.scenarios.length),
    toolCalls: calls.length,
    failedToolCalls: calls.filter(call => call.status === 'failed' || call.status === 'cancelled').length,
    toolCallErrorRate: rate(calls.filter(call => call.status === 'failed' || call.status === 'cancelled').length, calls.length),
    recoveryAttempts: recoveryScenarios.length,
    recoveredTasks,
    recoveryRate: rate(recoveredTasks, recoveryScenarios.length)
  }
}

export function compare(baseline: AgentRunReceipt, candidate: AgentRunReceipt): AgentComparison {
  const after = new Map(candidate.scenarios.map(scenario => [scenario.id, scenario]))
  // The baseline defines the controlled task set. Omitting a hard candidate
  // scenario is a failure, while candidate-only scenarios cannot inflate the
  // result with easier work.
  const pairedScenarios = baseline.scenarios.map(baselineScenario => ({
    baseline: baselineScenario,
    candidate: after.get(baselineScenario.id) ?? { id: baselineScenario.id, success: false, toolCalls: [], note: 'Candidate omitted this baseline scenario.' }
  }))
  const paired = pairedScenarios.map(({ baseline, candidate }) => ({ id: baseline.id, baseline: baseline.success, candidate: candidate.success }))
  const pairedBaselineCalls = pairedScenarios.flatMap(({ baseline }) => baseline.toolCalls)
  const pairedCandidateCalls = pairedScenarios.flatMap(({ candidate }) => candidate.toolCalls)
  const pairedBaselineRecovery = pairedScenarios.filter(({ baseline }) => baseline.toolCalls.some(call => call.status === 'failed' || call.status === 'cancelled'))
  const pairedCandidateRecovery = pairedScenarios.filter(({ candidate }) => candidate.toolCalls.some(call => call.status === 'failed' || call.status === 'cancelled'))
  const baselineSuccess = rate(paired.filter(item => item.baseline).length, paired.length)
  const candidateSuccess = rate(paired.filter(item => item.candidate).length, paired.length)
  const baselineToolError = rate(pairedBaselineCalls.filter(call => call.status === 'failed' || call.status === 'cancelled').length, pairedBaselineCalls.length)
  const candidateToolError = rate(pairedCandidateCalls.filter(call => call.status === 'failed' || call.status === 'cancelled').length, pairedCandidateCalls.length)
  const baselineRecovery = rate(pairedBaselineRecovery.filter(({ baseline }) => baseline.recovered === true && baseline.success).length, pairedBaselineRecovery.length)
  const candidateRecovery = rate(pairedCandidateRecovery.filter(({ candidate }) => candidate.recovered === true && candidate.success).length, pairedCandidateRecovery.length)
  const candidateSuccessDelta = candidateSuccess.value - baselineSuccess.value
  const candidateToolErrorDelta = candidateToolError.value - baselineToolError.value
  const candidateRecoveryDelta = candidateRecovery.value - baselineRecovery.value
  const eligibilityReasons: string[] = []
  if (baseline.runStatus !== 'completed') eligibilityReasons.push(`Baseline run is ${baseline.runStatus}.`)
  if (candidate.runStatus !== 'completed') eligibilityReasons.push(`Candidate run is ${candidate.runStatus}.`)
  if (!baseline.model || !candidate.model) eligibilityReasons.push('Both runs must declare a model.')
  else if (baseline.model !== candidate.model) eligibilityReasons.push('Baseline and candidate must use the same model.')
  if (baseline.evidenceVerified !== true) eligibilityReasons.push(baseline.evidenceError ?? 'Baseline evidence is not independently attested.')
  if (candidate.evidenceVerified !== true) eligibilityReasons.push(candidate.evidenceError ?? 'Candidate evidence is not independently attested.')
  if (!baseline.trial || !candidate.trial) eligibilityReasons.push('Both runs must declare a controlled trial contract.')
  else if (canonical(baseline.trial) !== canonical(candidate.trial)) eligibilityReasons.push('Baseline and candidate must use the same suite, harness and execution conditions.')
  if (pairedScenarios.some(({ baseline, candidate }) => !baseline.fixture || !candidate.fixture || baseline.fixture !== candidate.fixture)) eligibilityReasons.push('Paired scenarios must have identical fixture fingerprints.')
  if (!baseline.runId || !candidate.runId) eligibilityReasons.push('Both runs must declare distinct run IDs.')
  if (baseline.runId && baseline.runId === candidate.runId) eligibilityReasons.push('A run cannot be compared with itself.')
  const inputEligible = eligibilityReasons.length === 0
  const evidenceSufficient = inputEligible && paired.length >= MIN_MATCHED_SCENARIOS
  return {
    matchedScenarios: paired.length,
    minimumMatchedScenarios: MIN_MATCHED_SCENARIOS,
    evidenceSufficient,
    inputEligible,
    eligibilityReasons,
    candidateSuccessDelta,
    candidateToolErrorDelta,
    candidateRecoveryDelta,
    candidateImproved: evidenceSufficient && candidateSuccessDelta >= 0 && candidateToolErrorDelta <= 0 && candidateRecoveryDelta >= 0 && (candidateSuccessDelta > 0 || candidateToolErrorDelta < 0 || candidateRecoveryDelta > 0),
    paired
  }
}

export async function readRun(path: string): Promise<AgentRunReceipt> {
  const value = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
  assertReceipt(value, path)
  const evidence = await verifyEvidence(value, path)
  return { ...value, evidenceVerified: evidence.verified, ...(evidence.error ? { evidenceError: evidence.error } : {}) }
}

export async function aggregateRuns(paths: ReadonlyArray<string>): Promise<AgentRunReceipt> {
  if (paths.length === 0) throw new Error('At least one run receipt is required')
  if (new Set(paths.map(path => resolve(path))).size !== paths.length) throw new Error('Repeated receipt paths are not independent runs')
  const runs = await Promise.all(paths.map(readRun))
  const runIds = runs.flatMap(run => run.runId ? [run.runId] : [])
  if (runIds.length !== runs.length) throw new Error('Every repeated run must declare its run ID')
  if (new Set(runIds).size !== runIds.length) throw new Error('Repeated run IDs are not independent runs')
  const first = runs[0]!
  const model = first.model
  if (runs.some(run => run.model !== model)) throw new Error('All repeated runs must use the same model')
  if (runs.some(run => canonical(run.trial ?? null) !== canonical(first.trial ?? null))) throw new Error('All repeated runs must use the same trial contract')
  const scenarioIds = first.scenarios.map(scenario => scenario.id)
  const expected = new Set(scenarioIds)
  const scenarios = runs.flatMap((run, runIndex) => {
    const byId = new Map(run.scenarios.map(scenario => [scenario.id, scenario]))
    if (byId.size !== expected.size || [...expected].some(id => !byId.has(id))) throw new Error(`Run ${paths[runIndex]} does not contain the same scenario set`)
    return scenarioIds.map(id => {
      const scenario = byId.get(id)!
      return { ...scenario, id: `${id}#run-${runIndex + 1}` }
    })
  })
  const evidenceError = runs.find(run => run.evidenceError)?.evidenceError
  return {
    schema: AGENT_RUN_SCHEMA,
    runStatus: runs.every(run => run.runStatus === 'completed') ? 'completed' : 'failed',
    runId: runs.map((run, index) => run.runId ?? `run-${index + 1}`).join(','),
    ...(model ? { model } : {}),
    realModel: runs.every(run => run.realModel),
    isolated: runs.every(run => run.isolated),
    noUserCanvasMutation: runs.every(run => run.noUserCanvasMutation),
    noUserWorkspaceAccess: runs.every(run => run.noUserWorkspaceAccess),
    evidenceDirectory: first.evidenceDirectory,
    isolation: { ...first.isolation, runCount: runs.length },
    scenarios,
    ...(first.trial ? { trial: first.trial } : {}),
    boundaries: Object.fromEntries(Object.keys(first.boundaries ?? {}).map(key => [key, runs.every(run => run.boundaries?.[key] === true)])),
    evidenceVerified: runs.every(run => run.evidenceVerified === true),
    ...(evidenceError ? { evidenceError } : {})
  }
}

export function evaluateReceipts(candidate: AgentRunReceipt, baseline?: AgentRunReceipt, paths = { candidate: '<candidate>', baseline: '<baseline>' }): AgentEvaluation {
  const candidateMetrics = metrics(candidate)
  const comparison = baseline ? compare(baseline, candidate) : undefined
  const unchanged = comparison && comparison.candidateSuccessDelta === 0 && comparison.candidateToolErrorDelta === 0 && comparison.candidateRecoveryDelta === 0
  const decision = !baseline || !comparison?.evidenceSufficient ? 'insufficient-evidence' : comparison.candidateImproved ? 'pass' : unchanged ? 'unchanged' : 'regression'
  return {
    schema: AGENT_EVALUATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    ...(baseline ? { baseline: { path: paths.baseline, run: baseline, metrics: metrics(baseline) } } : {}),
    candidate: { path: paths.candidate, run: candidate, metrics: candidateMetrics },
    ...(comparison ? { comparison } : {}),
    decision
  }
}

export async function evaluate(candidatePath: string, baselinePath?: string): Promise<AgentEvaluation> {
  const candidate = await readRun(candidatePath)
  const baseline = baselinePath ? await readRun(baselinePath) : undefined
  return evaluateReceipts(candidate, baseline, { candidate: candidatePath, baseline: baselinePath ?? '<baseline>' })
}

export async function writeEvaluation(path: string, evaluation: AgentEvaluation): Promise<void> {
  await writeFile(resolve(path), `${JSON.stringify(evaluation, null, 2)}\n`)
}
