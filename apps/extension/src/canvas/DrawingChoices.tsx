import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import './drawing-choices.css'

export type DrawingChoiceProps<T> = { label: string; value: T | undefined; options: ReadonlyArray<readonly [T, string, ReactNode?, string?]>; onChange(value: T): void }

/** Drawing controls share one pointer-only indicator; keyboard focus stays local. */
export function DrawingChoices<T extends string | number>({ label, value, options, onChange }: DrawingChoiceProps<T>) {
  const [pointerMotion, setPointerMotion] = useState(false)
  const selected = options.findIndex(([key]) => key === value)
  return <div className="style-choices" role="group" aria-label={label} data-pointer-motion={pointerMotion} onPointerDownCapture={() => setPointerMotion(true)} onKeyDownCapture={() => setPointerMotion(false)}>
    <span className="style-choice-indicator" aria-hidden="true" style={{ width: `calc((100% - var(--space-1) - ${options.length - 1} * var(--choice-gap)) / ${options.length})`, transform: `translateX(calc(${Math.max(0, selected)} * (100% + var(--choice-gap))))`, opacity: selected < 0 ? 0 : 1 }} />
    {options.map(([key, name, icon, description]) => <Button key={key} type="button" variant="ghost" size="compact" aria-label={`${label} ${name}`} aria-description={description} title={description ?? name} aria-pressed={key === value} onClick={() => onChange(key)}>{icon ?? name}</Button>)}
  </div>
}
