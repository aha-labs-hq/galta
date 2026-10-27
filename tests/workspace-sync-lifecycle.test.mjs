import { test, expect } from 'bun:test'
import { WorkspaceSync } from '../apps/extension/src/canvas/workspaceSync.ts'

test('workspace sync receives and publishes after Strict Mode effect cleanup and setup', async () => {
  const project = crypto.randomUUID()
  const first = new WorkspaceSync(project), second = new WorkspaceSync(project)
  const discarded = first.subscribe(() => {})
  discarded(); first.close()
  let offFirst, offSecond
  try {
    const firstReceived = new Promise(resolve => { offFirst = first.subscribe(resolve) })
    const secondReceived = new Promise(resolve => { offSecond = second.subscribe(resolve) })
    second.publish({ revision: 1 })
    expect((await firstReceived).revision).toBe(1)
    first.publish({ revision: 2 })
    expect((await secondReceived).revision).toBe(2)
  } finally {
    offFirst?.(); offSecond?.(); first.close(); second.close()
  }
})

test('a database save finishing after view cleanup still notifies other views', async () => {
  const project = crypto.randomUUID()
  const first = new WorkspaceSync(project), second = new WorkspaceSync(project)
  const offFirst = first.subscribe(() => {})
  offFirst(); first.close()
  let offSecond
  try {
    const received = new Promise(resolve => { offSecond = second.subscribe(resolve) })
    first.publish({ revision: 3 })
    expect((await received).revision).toBe(3)
  } finally {
    offSecond?.(); first.close(); second.close()
  }
})
