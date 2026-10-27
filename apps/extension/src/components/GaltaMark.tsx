import { cn } from '@/lib/utils'

/** Inside Galta, the same expressive character introduces the app and collects references. */
export function GaltaMark({ className }: { className?: string }) {
  return <img src="/galta-logo.svg" alt="" className={cn('inline-block size-5 shrink-0 object-contain [@media(forced-colors:active)_and_(prefers-color-scheme:dark)]:invert', className)} />
}
