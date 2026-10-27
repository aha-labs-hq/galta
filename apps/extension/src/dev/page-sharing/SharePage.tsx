import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { downloadPage, publishedUrl, type Revision } from './artwork'

export type ShareModel = {
  live: Revision | null; draft: Revision; everPublished: boolean
  signedIn: boolean; busy: boolean; error: string
  publish(): void; unpublish(): void; signIn(): void
}

/** A single reading column: what will happen, the action, then a local copy. */
export function ShareBody({ model, onClose, onUnpublish, html }: { model: ShareModel; onClose(): void; onUnpublish(): void; html: string }) {
  const [copied, setCopied] = useState(false), [downloaded, setDownloaded] = useState(false), [copyError, setCopyError] = useState('')
  const link = useRef<HTMLInputElement>(null)
  const dirty = model.live !== null && model.live !== model.draft
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2_000); return () => clearTimeout(timer) }, [copied])
  useEffect(() => { if (!downloaded) return; const timer = window.setTimeout(() => setDownloaded(false), 2_000); return () => clearTimeout(timer) }, [downloaded])
  const copy = async () => {
    try { await navigator.clipboard.writeText(publishedUrl()); setCopied(true); setCopyError('') }
    catch { setCopyError('Select the link and copy it.'); link.current?.focus(); link.current?.select() }
  }
  return <div className="delivery-panel">
    <header className="delivery-header"><h2>Share Tide</h2><Button variant="ghost" size="compact" className="delivery-close" aria-label="Close sharing" onClick={onClose}>Close</Button></header>
    <p className="delivery-description">{model.live === null ? 'Give this page a link of its own.' : dirty ? 'Your latest changes are still on the canvas.' : 'Your page is live. Ready to be explored.'}</p>
    <div className="delivery-main">
      {model.live === null ? <>
        <Button className="delivery-primary" disabled={model.busy} onClick={model.signedIn ? model.publish : model.signIn}>{model.busy ? 'Publishing…' : model.signedIn ? 'Publish page' : 'Sign in to publish'}</Button>
        <p className="delivery-note">Anyone with the link can view this page.<br />The rest of your canvas stays private.</p>
      </> : <>
        {dirty && <div className="delivery-update"><Button className="delivery-primary" disabled={model.busy} onClick={model.publish}>{model.busy ? 'Updating…' : model.signedIn ? 'Update page' : 'Sign in to update'}</Button><p className="delivery-note">Same link. Visitors see the last published version until you update.</p></div>}
        <div className="delivery-link"><input ref={link} aria-label="Published page link" value={publishedUrl()} readOnly onFocus={event => event.currentTarget.select()} /><Button size="compact" variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button></div>
        <div className="delivery-link-actions"><a href={publishedUrl()} target="_blank" rel="noreferrer">Open page</a><Button variant="ghost" size="compact" disabled={model.busy} onClick={onUnpublish}>Unpublish…</Button></div>
      </>}
      {(model.error || copyError) && <p className="delivery-error" role="status">{model.error || copyError}</p>}
    </div>
    <footer className="delivery-footer"><Button variant="ghost" className="delivery-download" onClick={() => { downloadPage(html); setDownloaded(true) }}><span>{downloaded ? 'Downloaded' : 'Download HTML'}</span><small>Keep a local copy</small></Button></footer>
    <span className="sr-only" role="status" aria-live="polite">{model.busy ? 'Publishing page.' : copied ? 'Link copied.' : downloaded ? 'HTML file downloaded.' : ''}</span>
  </div>
}

export function UnpublishDialog({ open, onOpenChange, onConfirm, onReturnFocus }: { open: boolean; onOpenChange(open: boolean): void; onConfirm(): void; onReturnFocus(): void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="page-share-dialog" onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus() }}>
    <DialogTitle className="page-share-dialog-title">Unpublish Tide?</DialogTitle>
    <DialogDescription className="page-share-dialog-description">The link will stop showing this page. Your work stays on your canvas, and you can publish it again.</DialogDescription>
    <div className="page-share-dialog-actions"><Button ref={cancel} variant="secondary" onClick={() => onOpenChange(false)}>Keep published</Button><Button variant="destructive" onClick={onConfirm}>Unpublish</Button></div>
  </DialogContent></Dialog>
}
