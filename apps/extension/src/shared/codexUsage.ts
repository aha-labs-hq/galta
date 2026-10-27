import type { CodexRateLimits } from './messages'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** The named Codex bucket is authoritative; the RPC also supports a legacy single bucket. */
export function readCodexUsage(value: unknown): CodexRateLimits | undefined {
  const response = record(value)
  const buckets = record(response?.rateLimitsByLimitId)
  const limits = record(buckets ? buckets.codex : response?.rateLimits)
  if (!limits || typeof limits.limitId === 'string' && limits.limitId !== 'codex') return undefined
  const primary = record(limits.primary)
  const used = primary?.usedPercent
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return undefined
  return {
    ...(typeof limits.planType === 'string' ? { planType: limits.planType } : {}),
    primary: {
      usedPercent: used,
      ...(typeof primary?.resetsAt === 'number' && Number.isFinite(primary.resetsAt) ? { resetsAt: primary.resetsAt } : {}),
      ...(typeof primary?.windowDurationMins === 'number' && primary.windowDurationMins > 0 ? { windowDurationMins: primary.windowDurationMins } : {})
    }
  }
}
