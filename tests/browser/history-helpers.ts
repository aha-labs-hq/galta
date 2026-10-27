import { storedWorkspace } from '../helpers/stored-workspace'
import { expect, type Page } from '@playwright/test'
import { historyMoments } from '../../apps/extension/src/canvas/historyTimeline'
import { latestTip, pathTo } from '../../apps/extension/src/canvas/historyLayout'

export const historyWorkspace = storedWorkspace
export const timeMachine = (page: Page) => page.getByRole('dialog', { name: 'Time Machine', exact: true })
export const ruler = (page: Page) => page.getByRole('slider', { name: 'History', exact: true })
export const stage = (page: Page) => page.locator('.history-canvas')

export async function openHistory(page: Page) {
  if (!await timeMachine(page).count()) await page.getByRole('button', { name: 'Open Time Machine', exact: true }).click()
  await expect(timeMachine(page)).toBeVisible()
  await expect(page.locator('.history[data-arrived]')).toHaveCount(1)
}

export async function closeHistory(page: Page) {
  if (!await timeMachine(page).count()) return
  await page.getByRole('button', { name: 'Close Time Machine', exact: true }).click()
  await expect(timeMachine(page)).toHaveCount(0)
}

/** The stored history as Time Machine groups it, and the path from the first
 * moment to the current canvas. */
export async function storedMoments(page: Page) {
  const workspace = await historyWorkspace(page), moments = historyMoments(workspace)
  return { workspace, moments, home: pathTo(moments, moments.current) }
}

async function seek(page: Page, index: number) {
  const current = Number(await ruler(page).getAttribute('aria-valuenow')) - 1
  for (let i = 0; i < Math.abs(index - current); i++) await page.keyboard.press(index > current ? 'ArrowRight' : 'ArrowLeft')
  await expect(ruler(page)).toHaveAttribute('aria-valuenow', String(index + 1))
}

/** Show one saved version on the stage: travel to its timeline through its
 * fork, slide to its moment, and step to it with Option if it is inside one. */
export async function previewHistory(page: Page, id: string) {
  await closeHistory(page)
  await openHistory(page)
  const { moments, home } = await storedMoments(page)
  const target = moments.of.get(id)
  expect(target, `version ${id} is in history`).toBeTruthy()
  await ruler(page).focus()
  // Up at a fork enters the most recent future that branched there, so a
  // version behind several forks takes one step up per fork.
  let path = home
  const route = pathTo(moments, target!)
  while (!path.includes(target!)) {
    const fork = [...route].reverse().find(item => path.includes(item))!
    const branched = moments.byId.get(fork)!.children.filter(child => !path.includes(child))
    const next = branched.reduce((a, b) => moments.byId.get(latestTip(moments, a))!.end >= moments.byId.get(latestTip(moments, b))!.end ? a : b)
    await seek(page, path.indexOf(fork))
    await page.keyboard.press('ArrowUp')
    path = pathTo(moments, latestTip(moments, next))
    await expect(ruler(page)).toHaveAttribute('aria-valuemax', String(path.length))
    expect(route.includes(next), `the most recent future at ${fork} leads to ${id}`).toBe(true)
  }
  await seek(page, path.indexOf(target!))
  const commits = moments.byId.get(target!)!.commits
  for (let i = commits.length - 1; i > commits.indexOf(id); i--) await page.keyboard.press('Alt+ArrowLeft')
  await expect(stage(page)).toHaveAttribute('data-version', id)
  await expect(stage(page)).not.toHaveAttribute('data-state', 'loading')
}

export async function restoreHistory(page: Page, id: string) {
  await previewHistory(page, id)
  await page.getByRole('button', { name: 'Restore canvas', exact: true }).click()
  await expect(timeMachine(page)).toHaveCount(0)
}
