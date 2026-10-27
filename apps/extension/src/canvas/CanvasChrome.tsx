import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** One backing per group; controls own hover, open and keyboard-focus states. */
export function CanvasChromeSurface({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg bg-(--chrome-surface) backdrop-blur-(--chrome-blur)', className)} {...props} />
}

export function CanvasChromeButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="compact" className={cn(
    'canvas-chrome-button min-w-(--target) gap-1.5 rounded-lg px-2 text-xs font-normal text-(--chrome-foreground) duration-(--motion-fast) ease-(--ease-out) hover:bg-muted hover:text-(--chrome-foreground) data-[state=open]:bg-(--surface-pressed)',
    className,
  )} {...props} />
}
