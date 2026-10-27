import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasApp } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Galta canvas root is missing')

createRoot(root).render(
  <StrictMode>
    <CanvasApp />
  </StrictMode>
)
