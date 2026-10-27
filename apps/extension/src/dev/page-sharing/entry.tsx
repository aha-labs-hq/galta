import { createRoot } from 'react-dom/client'
import { Prototype, PublishedPreview } from './main'

createRoot(document.getElementById('root')!).render(
  ['published', 'preview'].includes(new URLSearchParams(location.search).get('view') ?? '') ? <PublishedPreview /> : <Prototype />
)
