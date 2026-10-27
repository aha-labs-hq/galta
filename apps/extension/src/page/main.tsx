import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { asProjectId } from '@galta/domain'
import { IndexedDbWorkspaceRepository } from '@galta/storage'
import { Button } from '@/components/ui/button'
import { HtmlEmbed, htmlDocument } from '../canvas/htmlEmbed'
import { validateSnapshot } from '../canvas/sceneSnapshot'
import { downloadFile } from '../shared/download'
import '../styles.css'
import './page.css'

async function readPage(): Promise<string> {
  const query = new URLSearchParams(location.search)
  const project = query.get('project'), version = query.get('version'), id = query.get('element')
  if (!project || !version || !id) throw new Error('Open a webpage from your canvas to preview it here.')
  const workspace = await new IndexedDbWorkspaceRepository().load(asProjectId(project))
  const snapshot = workspace?.snapshots[version]
  const element = snapshot ? validateSnapshot(snapshot).document.elements.find(element => element.id === id && !element.isDeleted) : undefined
  const document = element && htmlDocument(element)
  if (!document) throw new Error('This saved page is no longer available. Open the current version from your canvas.')
  return document.html
}

function PagePreview() {
  const [html, setHtml] = useState<string | null>(null), [error, setError] = useState('')
  useEffect(() => { void readPage().then(setHtml).catch(error => setError(error instanceof Error ? error.message : 'Unable to read this saved page.')) }, [])
  return <main className="page-preview">
    <header className="page-preview-bar"><h1>Page preview</h1>{html !== null && <Button variant="ghost" size="compact" onClick={() => downloadFile(new Blob([html], { type: 'text/html;charset=utf-8' }), 'galta-page.html')}>Download HTML</Button>}</header>
    {html !== null ? <HtmlEmbed html={html} /> : <p className="page-preview-notice" role={error ? 'alert' : 'status'}>{error || 'Opening page…'}</p>}
  </main>
}

const root = document.getElementById('root')
if (!root) throw new Error('Galta page preview root is missing')
createRoot(root).render(<PagePreview />)
