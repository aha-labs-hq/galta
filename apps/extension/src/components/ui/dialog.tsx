import * as React from 'react'
import { Dialog as Primitive } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export const Dialog = Primitive.Root
export const DialogTitle = Primitive.Title
export const DialogDescription = Primitive.Description
export function DialogContent({ className, children, closeLabel = 'Close', ...props }: React.ComponentProps<typeof Primitive.Content> & { closeLabel?: string }) {
  return <Primitive.Portal>
    <Primitive.Overlay className="dialog-overlay fixed inset-0 z-(--layer-popup) bg-foreground/8" />
    <Primitive.Content data-slot="dialog-content" className={cn('dialog-surface glass-surface fixed top-1/2 left-1/2 z-(--layer-popup) max-h-[calc(100dvh-32px)] w-[calc(100%_-_32px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl p-6 text-foreground outline-none sm:p-8', className)} {...props}>
      {children}
      <Primitive.Close asChild><Button data-dialog-close variant="ghost" size="icon-compact" className="absolute top-3 right-3 text-muted-foreground" aria-label={closeLabel}><X /></Button></Primitive.Close>
    </Primitive.Content>
  </Primitive.Portal>
}
