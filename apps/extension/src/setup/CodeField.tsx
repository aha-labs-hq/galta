import { useState, type Ref } from 'react'

/** A sign-in code as six cells. One real input sits over them, so typing,
 * pasting and the browser's one-time-code fill all work; the cells only
 * draw it. A refused code shakes the row once. */
export function CodeField({ value, length, onChange, invalid, disabled, label, describedBy, inputRef }: {
  value: string; length: number; onChange(value: string): void
  invalid: boolean; disabled: boolean; label: string; describedBy?: string | undefined
  inputRef?: Ref<HTMLInputElement>
}) {
  const [focused, setFocused] = useState(false)
  const [selection, setSelection] = useState({ start: value.length, end: value.length })
  const active = Math.min(selection.start, length - 1)
  return <div className="settings-code" data-focused={focused || undefined} data-invalid={invalid || undefined}>
    {Array.from({ length }, (_, index) => <span key={index} className="settings-code-cell" aria-hidden="true"
      data-filled={index < value.length || undefined} data-active={focused && index === active && !disabled || undefined}
      data-selected={focused && index >= selection.start && index < selection.end || undefined}>{value[index] ?? ''}</span>)}
    <input ref={inputRef} className="settings-code-input" aria-label={label} value={value} inputMode="numeric" autoComplete="one-time-code" maxLength={length}
      disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} spellCheck={false}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onSelect={event => setSelection({ start: event.currentTarget.selectionStart ?? 0, end: event.currentTarget.selectionEnd ?? 0 })}
      onPaste={event => {
        event.preventDefault()
        const digits = event.clipboardData.getData('text').replace(/\D/g, '')
        if (!digits) return
        const input = event.currentTarget
        const next = digits.length >= length ? digits.slice(0, length)
          : (value.slice(0, input.selectionStart ?? 0) + digits + value.slice(input.selectionEnd ?? value.length)).slice(0, length)
        setSelection({ start: next.length, end: next.length })
        onChange(next)
      }}
      onChange={event => onChange(event.target.value.replace(/\D/g, '').slice(0, length))} />
  </div>
}
