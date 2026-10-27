import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* The content script draws on someone else's page, where `tokens.css` does not
   exist — the manifest has no `css` key and no web-accessible resources, so the
   mark cannot load it the way an extension page does. The file is therefore
   inlined into the collector's shadow root as text.

   That inlining is the risk this file guards: if a token the surface reads is
   renamed or moved, the mark renders with no ring width and no size, in
   silence, on every page. */

const root = resolve(import.meta.dir, '..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')
const tokens = read('apps/extension/src/design/tokens.css')

/* Every `var(--x)` a file reads, with fallbacks (`var(--x, 4px)`) counted as
   reads of `--x`. Derived from source rather than listed by hand: a list can
   only ever be as current as the last person to edit it. */
const reads = (source) => new Set([...source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m => m[1]))

test('the token file declares the roots both of its consumers live in', () => {
  /* A shadow tree matches `:host`, a document matches `:root`, and neither
     matches the other. The file declares both so no consumer has to rewrite it
     — a consumer rewriting a stylesheet's text can only ever be right about the
     shape that stylesheet happened to have when the rewrite was written. */
  expect(tokens).toContain(':root, :host {')
  /* No rule anywhere may name `:root` alone: a bare one would be a block that
     the shadow tree cannot match, which is the failure this pair exists to
     prevent. A comma-modifier (`:root:hover`, `:root.foo`) is not a root block
     and is not what is being forbidden. */
  expect(tokens).not.toMatch(/(^|[^\w-]):root(?=[\s{])/)
})

test('the status-qualified blocks survive with both roots', () => {
  /* Pointer-coarse and reduced-motion reach the mark the same way they reach
     any other control, so they have to be attached to both roots too. Each
     block is required to exist before it is inspected: a `?? ''` fallback would
     pass a file that had lost the block entirely. */
  const at = (re) => {
    const found = tokens.match(re)
    expect(found).not.toBeNull()
    return found[0]
  }
  expect(at(/@media \(pointer: coarse\)[^}]*}/)).toContain(':root, :host')
  expect(at(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n}/)).toContain(':root, :host')
})

test('every token the in-page surface reads is declared in tokens.css', () => {
  /* This is the guard that makes the inlining safe. It reads the two files that
     render the mark and asserts the token file defines everything they use, so
     a rename fails here rather than degrading the mark on every page. */
  const surface = read('apps/extension/src/marks/surface.ts')
  const collector = read('apps/extension/src/content/collector.ts')
  const wanted = [...reads(surface), ...reads(collector)]
  expect(wanted.length).toBeGreaterThan(0)
  /* Scoped to the block the shadow tree actually matches. A plain substring
     search would accept a token declared only under `[data-theme="graphite"]`
     or inside a media query the host never satisfies — and the surface would
     then render with no value while the guard reported success. */
  const rootBlock = tokens.match(/:root, :host \{([\s\S]*?)\n\}/)?.[1]
  expect(rootBlock).toBeDefined()
  for (const token of wanted) expect(rootBlock).toContain(`${token}:`)
})

test('the mark\'s ink and paper are declared once, and the theme may not reassign them', () => {
  /* The mark is two-tone: its own ink and the paper showing through. Those are
     the artwork's colours, so they live in tokens.css like everything else and
     are read through `var()`, never restated as literals in the modules that
     draw with them. */
  const markup = read('apps/extension/src/marks/markup.ts')
  expect(markup).not.toMatch(/#[0-9a-f]{3,6}/i)
  expect(tokens).toContain('--mark-ink:')
  expect(tokens).toContain('--mark-paper:')
  expect(reads(read('apps/extension/src/marks/surface.ts')).has('--mark-ink')).toBe(true)
  expect(reads(read('apps/extension/src/marks/surface.ts')).has('--mark-paper')).toBe(true)
})

test('the one import edge into tokens.css is unchanged', () => {
  /* tokens.css is the single source of truth. If a second stylesheet starts
     re-declaring its values, the guard above stops meaning anything. */
  const styles = read('apps/extension/src/styles.css')
  expect((styles.match(/@import "\.\/design\/tokens\.css"/g) ?? []).length).toBe(1)
})

test('the mark modules declare no token of their own', () => {
  /* A module that declares `--foo: value` beside the file that owns the values
     is a second source. The mark's ring, ink and paper all come from tokens.css;
     artwork geometry (the ring's clearance, the beat, the phases) is arithmetic
     and lives in the geometry module instead. */
  const surface = read('apps/extension/src/marks/surface.ts')
  const collector = read('apps/extension/src/content/collector.ts')
  for (const source of [surface, collector]) expect([...source.matchAll(/--[a-z-]+\s*:/g)]).toEqual([])
})
