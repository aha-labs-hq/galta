// Deliberately omitted from Vite's release entry points. Run through the local
// Vite server at /dev/verification.html, never as a shipped product surface.
import { createRoot } from 'react-dom/client'
import { CanvasApp } from '../canvas/App'
import '../content/main'
import './verification.css'
import fixtureUrl from '../../../../tests/fixtures/reference.svg?url&no-inline'

(document.getElementById('reference-image') as HTMLImageElement).src = fixtureUrl
document.getElementById('source-form')!.addEventListener('submit', (event) => {
  event.preventDefault()
  const value = (document.getElementById('source-url') as HTMLInputElement).value
  const url = new URL(value)
  if (url.protocol === 'https:' || url.protocol === 'http:') (document.getElementById('reference-image') as HTMLImageElement).src = url.href
})
createRoot(document.getElementById('root')!).render(<CanvasApp />)
