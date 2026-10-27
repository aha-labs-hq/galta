import { useState } from 'react'
import { ArrowDownToLine, ArrowLeft, Check, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { downloadFile } from '../shared/download'
import type { CanvasScene } from './scene'
import { selectionFile } from './selectionExport'

type Format = 'original' | 'html' | 'png'

// Each rendered export step owns its feedback. Leaving that step never lets a
// late completion change the controls belonging to a new selection.
function useDownload(scene: CanvasScene, onError: (message: string) => void) {
  const [pending, setPending] = useState<Format | null>(null)
  const [delivered, setDelivered] = useState<Format | null>(null)
  const download = async (format: Format) => {
    setPending(format); setDelivered(null)
    try {
      const { blob, name } = await selectionFile(scene, format)
      downloadFile(blob, name)
      setDelivered(format)
    } catch (error) { onError(error instanceof Error ? error.message : 'Unable to export this selection.') }
    finally { setPending(null) }
  }
  return { pending, delivered, download }
}

/** A selection with one output format needs no format-selection step. */
export function SelectionPngExport({ scene, onError }: { scene: CanvasScene; onError: (message: string) => void }) {
  const { pending, delivered, download } = useDownload(scene, onError)
  return <>
    <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" className="selection-export-trigger selection-export-format" aria-label="Export selection" aria-description="Download the selected artwork as one PNG image" aria-disabled={Boolean(pending)} aria-busy={Boolean(pending)} onClick={() => { if (!pending) void download('png') }}>
      {pending ? <LoaderCircle className="selection-export-progress" aria-hidden="true" /> : delivered ? <Check aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
    </Button></TooltipTrigger><TooltipContent side="top" sideOffset={8}>{pending ? 'Preparing download…' : delivered ? 'Download started' : 'Download PNG'}</TooltipContent></Tooltip>
    <span role="status" className="sr-only">{pending ? 'Preparing download…' : delivered ? 'PNG image download started.' : ''}</span>
  </>
}

/** One step inside the selection capsule; the browser still owns saving files. */
export function SelectionExportActions({ scene, source, onBack, onError }: {
  scene: CanvasScene
  source: 'image' | 'video' | 'html' | undefined
  onBack: () => void
  onError: (message: string) => void
}) {
  const { pending, delivered, download } = useDownload(scene, onError)
  const formats: { format: Format; label: string; name: string; description: string }[] = [
    ...(source === 'html' ? [{ format: 'html' as const, label: 'HTML', name: 'HTML webpage', description: 'Editable page source' }]
      : source ? [{ format: 'original' as const, label: 'Original', name: 'Original file', description: source === 'video' ? 'Full-quality video' : 'Original image, before canvas edits' }] : []),
    { format: 'png', label: 'PNG', name: 'PNG image', description: source === 'video' ? 'The cover on your canvas' : 'As shown on your canvas' }
  ]
  return <>
    <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-compact" className="selection-back" aria-label="Back to selection actions" onClick={onBack}><ArrowLeft aria-hidden="true" /></Button></TooltipTrigger><TooltipContent side="top" sideOffset={8}>Back</TooltipContent></Tooltip>
    <span className="selection-divider" aria-hidden="true" />
    {formats.map(({ format, label, name, description }) => <Tooltip key={format}><TooltipTrigger asChild>
      <Button variant="ghost" size="compact" className="selection-export-format" data-format={format} aria-label={name} aria-description={description} aria-disabled={Boolean(pending)} aria-busy={pending === format} onClick={() => { if (!pending) void download(format) }}>
        {label}{pending === format ? <LoaderCircle className="selection-export-progress" aria-hidden="true" /> : delivered === format ? <Check aria-hidden="true" /> : <ArrowDownToLine aria-hidden="true" />}
      </Button>
    </TooltipTrigger><TooltipContent side="top" sideOffset={8}>{pending === format ? 'Preparing download…' : delivered === format ? 'Download started' : description}</TooltipContent></Tooltip>)}
    <span role="status" className="sr-only">{pending ? 'Preparing download…' : delivered ? `${formats.find(option => option.format === delivered)!.name} download started.` : ''}</span>
  </>
}
