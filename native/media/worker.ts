import type { Prepared } from './providers/provider'
import { MediaGeneration } from './service'

/** A generation worker's whole life: one paid job, from stdin to saved files. */
export async function carryGeneration(payload: string) {
  const { directory, job, prepared } = JSON.parse(payload) as { directory: string; job: string; prepared: Prepared }
  const generation = new MediaGeneration(directory)
  try { await generation.carry(job, prepared) } finally { generation.close() }
}
