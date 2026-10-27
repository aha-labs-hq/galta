// Local server for the exact production directory. Not shipped.
import { resolve, extname } from 'node:path'
import { acceptanceBuild as root, acceptanceOrigin, acceptancePort } from './lib/acceptance'
Bun.serve({ hostname: '127.0.0.1', port: acceptancePort, async fetch(request) {
  const path = decodeURIComponent(new URL(request.url).pathname)
  const file = resolve(root, `.${path.endsWith('/') ? path + 'index.html' : path}`)
  if (!file.startsWith(`${root}/`)) return new Response('Not found', { status: 404 })
  const asset = Bun.file(file)
  if (!await asset.exists()) return new Response('Not found', { status: 404 })
  return new Response(asset, { headers: { 'Content-Type': extname(file) === '.js' ? 'text/javascript' : extname(file) === '.woff2' ? 'font/woff2' : asset.type } })
} })
console.log(`Serving ${root} at ${acceptanceOrigin}`)
