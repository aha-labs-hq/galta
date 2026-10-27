import { build, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { relative, resolve } from 'node:path'
import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** A build is named by what it is built from: a digest of its sources. The
 * same source builds to the same bytes, and a change that touches none of its
 * sources (a docs commit) leaves the build as it was. A clock time or commit
 * id here would break both. */
function sourceDigest() {
  const hash = createHash('sha256'), base = resolve('../..')
  const visit = (path: string) => {
    if (!existsSync(path) || /(^|\/)(node_modules|dist|release)$/.test(path) || path.endsWith('.tsbuildinfo')) return
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path).sort()) visit(`${path}/${name}`); return }
    hash.update(relative(base, path)).update('\0').update(readFileSync(path)).update('\0')
  }
  for (const root of ['src', 'vite.config.ts', 'package.json', '../../packages', '../../patches', '../../bun.lock', '../../tsconfig.json', '../../tsconfig.base.json']) visit(resolve(root))
  return hash.digest('hex').slice(0, 16)
}

export default defineConfig(({ mode }) => {
  const outDir = mode === 'development' ? 'dist' : 'release'
  const define = {
    'process.env.IS_PREACT': 'false',
    __GALTA_BUILD__: JSON.stringify({ mode, source: sourceDigest(), companion: process.env.GALTA_COMPANION_URL ?? '' }),
    __GALTA_COMPANION_URL__: JSON.stringify(process.env.GALTA_COMPANION_URL ?? '')
  }
  return {
  plugins: [react(), tailwindcss(), {
    name: 'excalidraw-local-fonts',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const root = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts')
        const file = resolve(root, `.${decodeURIComponent(req.url?.split('?')[0] ?? '/')}`)
        if (!file.startsWith(`${root}/`) || !file.endsWith('.woff2') || !existsSync(file)) return next()
        res.setHeader('Content-Type', 'font/woff2')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() { cpSync(resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts'), resolve(outDir, 'fonts'), { recursive: true }) }
  }, {
    name: 'classic-content-script',
    // Manifest content scripts are classic scripts. Bundle this entry on its
    // own so shared extension modules cannot introduce ESM imports into it.
    async closeBundle() {
      await build({ configFile: false, define, mode, logLevel: 'warn', build: {
        outDir: resolve(outDir), emptyOutDir: false,
        rollupOptions: { input: resolve('src/content/main.ts'), output: { format: 'iife', entryFileNames: 'content.js', inlineDynamicImports: true } }
      } })
    }
  }],
  resolve: { alias: { '@': resolve('src') } },
  // This lazy worker entry is outside Vite's initial page scan. Discovering it
  // during the first preview otherwise reoptimizes dependencies and reloads
  // the document in the middle of the calculation.
  optimizeDeps: { include: ['@excalidraw/excalidraw/freeDrawPath'] },
  define,
  root: 'src',
  build: {
    outDir: `../${outDir}`,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        canvas: 'src/canvas/index.html',
        page: 'src/page/index.html',
        sidepanel: 'src/sidepanel/index.html',
        tasks: 'src/tasks/index.html',
        background: 'src/background/main.ts',
        /* Development only. A verification harness in `release` would ship the
           collector's own test page to users. */
        ...(mode === 'development' ? { 'dev/collector': 'src/dev/collector.html' } : {})
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
  }
})
