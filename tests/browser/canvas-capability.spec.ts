import { test, expect } from '@playwright/test'

test('canvas tools expose complete native views, exact state and fresh verification bytes', async ({ page }) => {
  await page.goto('/dev/scene-test.html?capability-audit')
  await page.waitForFunction(() => Boolean((window as any).capabilityResults))
  const result = await page.evaluate(() => (window as any).capabilityResults)
  expect(result.checks).toHaveLength(4)
  expect(result.passed, JSON.stringify(result.checks, null, 2)).toBe(true)
})
