import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasApp } from '../canvas/App'
import './sidepanel.css'

const root = document.getElementById('root')
if (!root) throw new Error('Galta side panel root is missing')

createRoot(root).render(
  <StrictMode>
    <CanvasApp />
  </StrictMode>
)
