import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasApp } from './App'

async function start() {
  if (__GALTA_WEB_APP__) await (await import('../web/host')).startWebHost()
const root = document.getElementById('root')
if (!root) throw new Error('Galta canvas root is missing')

createRoot(root).render(
  <StrictMode>
    <CanvasApp />
  </StrictMode>
)

}
void start().catch(error => { document.getElementById('root')!.textContent = String(error.message ?? error) })
