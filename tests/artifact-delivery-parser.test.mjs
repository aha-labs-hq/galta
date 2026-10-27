import { test, expect } from 'bun:test'
import { isWorkspaceDeliveryLink, markdownDeliveryLinks } from '../apps/extension/src/tasks/artifactDelivery.ts'

test('delivery declarations come from Markdown link tokens, including references', () => {
  const text = [
    '[selected](<outputs/selected image.png>)',
    '[report][report-ref]',
    '',
    '`[not-a-file](outputs/code.png)`',
    '',
    '```md',
    '[also-not-a-file](outputs/block.png)',
    '```',
    '',
    '![not-a-download](outputs/preview.png)',
    '',
    '| file | status |',
    '| --- | --- |',
    '| [table file](outputs/table.csv) | ready |',
    '',
    '[report-ref]: outputs/report.pdf'
  ].join('\n')
  expect(markdownDeliveryLinks(text)).toEqual(['outputs/selected image.png', 'outputs/report.pdf', 'outputs/table.csv'])
  expect(isWorkspaceDeliveryLink('outputs/report.pdf')).toBe(true)
  expect(isWorkspaceDeliveryLink('https://example.com/report.pdf')).toBe(false)
  expect(isWorkspaceDeliveryLink('galta-workspace:/sources/report.pdf')).toBe(true)
  expect(isWorkspaceDeliveryLink('sandbox:/workspace/report.pdf')).toBe(true)
  expect(isWorkspaceDeliveryLink('javascript:alert(1)')).toBe(false)
})
