import type { ComponentProps } from 'react'
import { Select as Primitive } from 'radix-ui'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Select = Primitive.Root
export const SelectValue = Primitive.Value

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger data-slot="select-trigger" className={cn('flex min-h-(--target-compact) min-w-0 items-center justify-between gap-2 rounded-md border-0 bg-field px-3 py-1.5 text-sm text-foreground outline-none hover:bg-muted disabled:opacity-50 [&>span]:truncate', className)} {...props}>
    {children}<Primitive.Icon asChild><ChevronDown className="size-3 shrink-0 text-muted-foreground" /></Primitive.Icon>
  </Primitive.Trigger>
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content data-slot="select-content" position="popper" sideOffset={6} collisionPadding={8} className={cn('glass-surface z-(--layer-popup) max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) max-w-[calc(100vw_-_16px)] overflow-hidden rounded-popover p-1 text-popover-foreground outline-none', className)} {...props}>
    <Primitive.ScrollUpButton className="flex h-6 items-center justify-center"><ChevronUp className="size-3" /></Primitive.ScrollUpButton>
    <Primitive.Viewport>{children}</Primitive.Viewport>
    <Primitive.ScrollDownButton className="flex h-6 items-center justify-center"><ChevronDown className="size-3" /></Primitive.ScrollDownButton>
  </Primitive.Content></Primitive.Portal>
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-slot="select-item" className={cn('relative flex min-h-(--target-compact) cursor-default items-center rounded-md py-1.5 pr-9 pl-3 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)} {...props}>
    <Primitive.ItemText>{children}</Primitive.ItemText><Primitive.ItemIndicator className="absolute right-3"><Check className="size-3.5" /></Primitive.ItemIndicator>
  </Primitive.Item>
}
