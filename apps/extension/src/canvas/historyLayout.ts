import { SESSION_GAP, type Moment, type Moments } from './historyTimeline'

export type Spacing = { gap: number; session: number }
/** Lanes above the line before further futures become buds. */
export const MAX_LANES = 3

/** One universe drawn as a strand: the moments of a future that branches off
 * another strand at `fork`. Strand 0 is the path being travelled. A strand
 * with no free lane is a bud: a sprout at its fork that still leads there. */
export type Strand = { index: number; parent: number; fork: string | null; lane: number; bud: boolean; moments: readonly string[] }

export type MultiverseLayout = {
  /** From the first moment to the travelled universe's last, left to right. */
  path: readonly string[]
  strands: readonly Strand[]
  /** Where each moment sits: its distance along the ruler and its lane. */
  at: ReadonlyMap<string, { x: number; lane: number; strand: number }>
  /** Moments of the travelled path that start a session. */
  sessionStarts: ReadonlySet<string>
  lanes: number
}

/** The universe's last moment: follow the most recently made future. */
export function latestTip(moments: Moments, from: string): string {
  let id = from, moment: Moment
  while ((moment = moments.byId.get(id)!).children.length) {
    id = moment.children.reduce((best, child) => latestEnd(moments, child) > latestEnd(moments, best) ? child : best)
  }
  return id
}
/** When each moment's most recent future was made. Moments are listed with
 * every parent before its children, so one pass from the end computes them
 * all without recursion, however long the history. */
const ends = new WeakMap<Moments, Map<string, number>>()
function latestEnd(moments: Moments, id: string): number {
  let cache = ends.get(moments)
  if (!cache) {
    cache = new Map()
    for (const moment of [...moments.byId.values()].reverse()) {
      let end = moment.end
      for (const child of moment.children) end = Math.max(end, cache.get(child)!)
      cache.set(moment.id, end)
    }
    ends.set(moments, cache)
  }
  return cache.get(id)!
}

export function pathTo(moments: Moments, tip: string): string[] {
  const path: string[] = []
  for (let id: string | null = tip; id !== null; id = moments.byId.get(id)!.parent) path.push(id)
  return path.reverse()
}

/**
 * Lay out every universe around the travelled one. The path from the first
 * moment to `tip` is a straight line; each other future grows from the moment
 * it branched at as a parallel strand above it. A strand follows its most
 * recent future, and its own branches become strands above it. Lanes are
 * assigned greedily left to right so strands never overlap, and a strand
 * always sits above the one it grows from; `maxLanes` stacks the rest.
 */
export function multiverseLayout(moments: Moments, tip: string, spacing: Spacing, maxLanes = MAX_LANES): MultiverseLayout {
  const path = pathTo(moments, tip)
  const at = new Map<string, { x: number; lane: number; strand: number }>()
  const sessionStarts = new Set<string>()
  const strands: Strand[] = []
  const advance = (previous: Moment | undefined, moment: Moment) => spacing.gap + (previous && moment.start - previous.end >= SESSION_GAP ? spacing.session : 0)
  path.forEach((id, i) => {
    const moment = moments.byId.get(id)!, previous = i ? moments.byId.get(path[i - 1]!) : undefined
    const x = i ? at.get(path[i - 1]!)!.x + advance(previous, moment) : 0
    if (i === 0 || previous && moment.start - previous.end >= SESSION_GAP) sessionStarts.add(id)
    at.set(id, { x, lane: 0, strand: 0 })
  })
  strands.push({ index: 0, parent: -1, fork: null, lane: 0, bud: false, moments: path })
  // Occupied spans per lane; lane 0 is the travelled path.
  const occupied: [number, number][][] = [[]]
  const pending: { fork: string; first: string; parent: number }[] = []
  const branches = (strand: Strand) => {
    for (const id of strand.moments) for (const child of moments.byId.get(id)!.children) if (!at.has(child)) pending.push({ fork: id, first: child, parent: strand.index })
  }
  branches(strands[0]!)
  // A future someone chose (a restore, or more than one moment of work) takes
  // a lane before a single stray moment does.
  const chosen = (first: string, fork: string) => moments.byId.get(first)!.restored || moments.byId.get(first)!.children.length > 0
    || moments.byId.get(fork)!.children.some(child => moments.byId.get(child)!.restored)
  while (pending.length) {
    // Left to right, so earlier forks take the lower lanes.
    pending.sort((a, b) => Number(chosen(b.first, b.fork)) - Number(chosen(a.first, a.fork)) || at.get(a.fork)!.x - at.get(b.fork)!.x || moments.byId.get(a.first)!.start - moments.byId.get(b.first)!.start)
    const { fork, first, parent } = pending.shift()!
    if (at.has(first)) continue
    const ids = pathTo(moments, latestTip(moments, first)), start = ids.indexOf(first)
    const own = ids.slice(start)
    const xs: number[] = []
    own.forEach((id, i) => {
      const previous = moments.byId.get(i ? own[i - 1]! : fork)!
      xs.push((i ? xs[i - 1]! : at.get(fork)!.x) + advance(previous, moments.byId.get(id)!))
    })
    const from = at.get(fork)!.x, to = xs.at(-1)!, pad = spacing.gap
    let lane = strands[parent]!.bud ? maxLanes + 1 : strands[parent]!.lane + 1
    while (lane <= maxLanes && (occupied[lane] ?? []).some(([a, b]) => from < b + pad && to > a - pad)) lane++
    const bud = lane > maxLanes
    if (bud) lane = strands[parent]!.lane
    else (occupied[lane] ??= []).push([from, to])
    const strand: Strand = { index: strands.length, parent, fork, lane, bud, moments: own }
    strands.push(strand)
    own.forEach((id, i) => at.set(id, { x: xs[i]!, lane, strand: strand.index }))
    branches(strand)
  }
  return { path, strands, at, sessionStarts, lanes: Math.max(0, ...strands.filter(strand => !strand.bud).map(strand => strand.lane)) }
}
