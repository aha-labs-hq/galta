import { aggregateRuns, evaluateReceipts, readRun, writeEvaluation } from './lib/agent-evaluation'

const args = process.argv.slice(2)
const values = (name: string) => {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) if (args[index] === name && args[index + 1]) result.push(args[index + 1]!)
  return result
}
const candidatePaths = values('--candidate'), baselinePaths = values('--baseline'), output = values('--output')[0]
if (candidatePaths.length === 0 && args[0] && !args[0].startsWith('-')) candidatePaths.push(args[0])
if (candidatePaths.length === 0 || baselinePaths.length > 1 && baselinePaths.length !== candidatePaths.length || args.includes('--help')) {
  console.error('Usage: bun scripts/evaluate-agent.ts --candidate <receipt.json>... [--baseline <receipt.json>...] [--output <evaluation.json>]')
  console.error('Repeat --candidate and --baseline equally to aggregate independent isolated runs.')
  process.exit(args.includes('--help') ? 0 : 2)
}
const candidate = candidatePaths.length === 1 ? await readRun(candidatePaths[0]!) : await aggregateRuns(candidatePaths)
const baseline = baselinePaths.length === 0 ? undefined : baselinePaths.length === 1 ? await readRun(baselinePaths[0]!) : await aggregateRuns(baselinePaths)
const result = evaluateReceipts(candidate, baseline, { candidate: candidatePaths.join(','), baseline: baselinePaths.join(',') || '<baseline>' })
if (output) await writeEvaluation(output, result)
console.log(JSON.stringify({
  decision: result.decision,
  candidate: {
    taskSuccessRate: result.candidate.metrics.taskSuccessRate,
    toolCallErrorRate: result.candidate.metrics.toolCallErrorRate,
    recoveryRate: result.candidate.metrics.recoveryRate,
    evidenceVerified: result.candidate.run.evidenceVerified,
    ...(result.candidate.run.evidenceError ? { evidenceError: result.candidate.run.evidenceError } : {})
  },
  comparison: result.comparison,
  output: output ?? null
}, null, 2))
if (result.decision === 'regression') process.exitCode = 1
