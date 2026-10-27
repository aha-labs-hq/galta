import { useEffect, useState, type ReactNode } from 'react'
import { FONT_FAMILY } from '@excalidraw/excalidraw'
import type { AppState } from '@excalidraw/excalidraw/types'
import { AlignLeft, AlignCenter, AlignRight, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, Check, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import type { CanvasScene } from './scene'
import { drawingStyle, changeDrawingStyle, type DrawingStyleValues } from './drawingStyleModel'
import { defaultDrawingFont } from './drawingDefaults'
import { drawingPalette } from './drawingPalette'
import { DrawingChoices, type DrawingChoiceProps } from './DrawingChoices'
import './drawing-style.css'

const colors = Object.entries(drawingPalette.stroke).map(([name, color]) => [color, name] as const)
const fills = Object.entries(drawingPalette.fill).map(([name, color]) => [color, name] as const)
const lightColors = new Set<string>([drawingPalette.stroke.Gold, drawingPalette.stroke.White, ...fills.map(([color]) => color)])
const fonts = [defaultDrawingFont.name, 'Georgia', 'Helvetica', 'Nunito', 'Excalifont', 'Comic Shanns', 'Lilita One', 'Cascadia', 'Virgil'] as const
const heads = [ ['none', 'None'], ['arrow', 'Arrow'], ['triangle', 'Triangle'], ['triangle_outline', 'Open triangle'], ['circle', 'Circle'], ['circle_outline', 'Open circle'], ['diamond', 'Diamond'], ['diamond_outline', 'Open diamond'], ['bar', 'Bar'], ['crowfoot_one', 'One'], ['crowfoot_many', 'Many'], ['crowfoot_one_or_many', 'One or many'] ] as const

/** Draft only while editing. One commit per choice, not per keystroke. */
function ValueInput({ value, label, onCommit, min, max, suffix }: { value: string | number | undefined; label: string; onCommit(value: string): void; min?: number; max?: number; suffix?: string }) {
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  const valid = min === undefined ? /^(#[\da-f]{3}|#[\da-f]{6}|transparent)$/i.test(draft) : draft.trim() !== '' && Number.isFinite(Number(draft)) && Number(draft) >= min && Number(draft) <= max!
  const commit = () => { if (valid && draft !== String(value ?? '')) onCommit(draft); else if (!valid) setDraft(String(value ?? '')) }
  return <span className="style-value control-field"><input type={min === undefined ? 'text' : 'number'} aria-label={label} min={min} max={max} step={1} spellCheck={false} placeholder="Mixed" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(String(value ?? '')) }
  }} />{suffix && <span aria-hidden="true">{suffix}</span>}</span>
}
function ColorField({ label, value, palette, onChange }: { label: string; value: string | undefined; palette: ReadonlyArray<readonly [string, string]>; onChange(value: string): void }) {
  return <div className="style-color">
    <div className="style-row"><span className="style-label">{label}</span><ValueInput value={value} label={label === 'Color' ? 'Text color value' : `${label} color value`} onCommit={onChange} /></div>
    <div className="style-palette" role="group" aria-label={label === 'Color' ? 'Text color' : `${label} color`}>{palette.map(([color, name]) => <Button key={color} type="button" variant="ghost" size="icon-compact" aria-label={`${label} ${name}`} aria-pressed={value === color} title={color === 'transparent' ? 'No fill' : color} onClick={() => onChange(color)}>
      <span className="style-swatch" style={{ backgroundColor: color, color: lightColors.has(color) ? 'var(--foreground)' : 'var(--surface)' }}>
        {color === 'transparent' ? <Minus className="-rotate-45 text-muted-foreground" /> : value === color ? <Check /> : null}
      </span>
    </Button>)}</div>
  </div>
}
function Choices<T extends string | number>(props: DrawingChoiceProps<T>) {
  return <div className="style-row"><span className="style-label">{props.label}</span><DrawingChoices {...props} /></div>
}
function Range({ label, value, min, max, suffix, onChange }: { label: string; value: number | undefined; min: number; max: number; suffix: string; onChange(value: number): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <div className="style-row"><span className="style-label">{label}</span><div className="style-range"><Slider aria-label={label} aria-valuetext={draft === undefined ? 'Mixed' : `${draft}${suffix}`} value={[draft ?? min]} min={min} max={max} step={1} onValueChange={v => setDraft(v[0])} onValueCommit={v => onChange(v[0]!)} /><ValueInput label={`${label} value`} value={draft} min={min} max={max} suffix={suffix} onCommit={v => onChange(Number(v))} /></div></div>
}
function StyleSelect({ label, value, children, onChange }: { label: string; value: string | number | undefined; children: ReactNode; onChange(value: string): void }) {
  return <div className="style-row"><span className="style-label">{label}</span><Select value={value === undefined ? '' : String(value)} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue placeholder="Mixed" /></SelectTrigger><SelectContent>{children}</SelectContent></Select></div>
}

export function DrawingStyle({ scene, state }: { scene: CanvasScene; state: AppState }) {
  const { available: a, values: v, title, description, selectionKey } = drawingStyle(scene.api.getSceneElements(), state)
  const change = <K extends keyof DrawingStyleValues>(key: K, value: DrawingStyleValues[K]) => changeDrawingStyle(scene.api, key, value)
  const hasStyle = Object.values(a).some(Boolean)
  return <div key={selectionKey} className="drawing-style-content">
    <header className="style-heading"><h2>{title}</h2>{hasStyle && <p>{description}</p>}</header>
    {!hasStyle ? <p className="style-empty">Select an object or choose a drawing tool to edit its style.</p> : <>
      {a.text && <section className="style-section" aria-label="Typography">
        <StyleSelect label="Font" value={v.fontFamily} onChange={value => change('fontFamily', Number(value))}>{fonts.map(name => <SelectItem key={name} value={String(FONT_FAMILY[name])} textValue={name}><span className="style-font-preview" style={{ fontFamily: `"${name}"` }}>{name}</span></SelectItem>)}</StyleSelect>
        <div className="style-row"><span className="style-label">Size</span><div className="style-font-size"><DrawingChoices label="Text size" value={v.fontSize} options={[16, 20, 28, 36].map(size => [size, String(size)] as const)} onChange={value => change('fontSize', value)} /><ValueInput value={v.fontSize} label="Font size" min={1} max={400} suffix="px" onCommit={value => change('fontSize', Number(value))} /></div></div>
        <Choices label="Align" value={v.textAlign} options={[[ 'left', 'Left', <AlignLeft /> ], [ 'center', 'Center', <AlignCenter /> ], [ 'right', 'Right', <AlignRight /> ]]} onChange={value => change('textAlign', value)} />
        {a.verticalAlign && <Choices label="Vertical" value={v.verticalAlign} options={[[ 'top', 'Top', <AlignVerticalJustifyStart /> ], [ 'middle', 'Middle', <AlignVerticalJustifyCenter /> ], [ 'bottom', 'Bottom', <AlignVerticalJustifyEnd /> ]]} onChange={value => change('verticalAlign', value)} />}
      </section>}
      {a.stroke && <section className="style-section" aria-label="Stroke settings">
        <ColorField label={a.text && !a.width ? 'Color' : 'Stroke'} value={v.strokeColor} palette={colors} onChange={value => change('strokeColor', value)} />
        {a.width && <Range label="Stroke width" value={v.strokeWidth} min={1} max={16} suffix="px" onChange={value => change('strokeWidth', value)} />}
        {a.line && <><Choices label="Line" value={v.strokeStyle} options={[[ 'solid', 'Solid' ], [ 'dashed', 'Dashed' ], [ 'dotted', 'Dotted' ]]} onChange={value => change('strokeStyle', value)} />
          <Choices label="Drawing" value={v.roughness} options={[[ 0, 'Precise' ], [ 1, 'Sketch' ], [ 2, 'Loose' ]]} onChange={value => change('roughness', value)} /></>}
      </section>}
      {a.fill && <section className="style-section" aria-label="Fill settings"><ColorField label="Fill" value={v.backgroundColor} palette={fills} onChange={value => change('backgroundColor', value)} />
        {v.backgroundColor !== 'transparent' && <StyleSelect label="Pattern" value={v.fillStyle} onChange={value => change('fillStyle', value as DrawingStyleValues['fillStyle'])}><SelectItem value="hachure">Hatch</SelectItem><SelectItem value="cross-hatch">Cross-hatch</SelectItem><SelectItem value="solid">Solid</SelectItem><SelectItem value="zigzag">Zigzag</SelectItem></StyleSelect>}
      </section>}
      {a.arrow && <section className="style-section" aria-label="Arrow settings">
        <Choices label="Path" value={v.arrowType} options={[[ 'sharp', 'Straight' ], [ 'round', 'Curved' ], [ 'elbow', 'Elbow' ]]} onChange={value => change('arrowType', value)} />
        {(['startArrowhead', 'endArrowhead'] as const).map((key, index) => <StyleSelect key={key} label={index ? 'End' : 'Start'} value={v[key] === null ? 'none' : v[key]} onChange={value => change(key, value === 'none' ? null : value as DrawingStyleValues[typeof key])}>{heads.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</StyleSelect>)}
      </section>}
      {(a.corners || a.opacity) && <section className="style-section" aria-label="Appearance">
        {a.corners && <Choices label="Corners" value={v.roundness} options={[[ 'sharp', 'Sharp' ], [ 'round', 'Round' ]]} onChange={value => change('roundness', value)} />}
        {a.opacity && <Range label="Opacity" value={v.opacity} min={0} max={100} suffix="%" onChange={value => change('opacity', value)} />}
      </section>}
    </>}
  </div>
}
