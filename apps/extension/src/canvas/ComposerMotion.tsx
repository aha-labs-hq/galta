import { Component, type ReactNode, type RefObject } from 'react'
import { themeEasing, themeLength, themeTime } from '../design/theme'
import type { DockSurfaceMotion } from './DockSurface'

const moving = '[data-composer-motion]', motionId = 'composer-morph'
export const composerMotion = (element: Element) => element.getAnimations().find(animation => animation.id === motionId)
type Position = { x: number; y: number; width: number; clip: string }
type Snapshot = { height: number; positions: Map<HTMLElement, Position> }
type Props = { mode: string; composer: RefObject<HTMLFormElement | null>; surface: RefObject<DockSurfaceMotion | null>; children: ReactNode }

/** A pre-commit snapshot is essential: microphone and storage settle
 * asynchronously, and a reversal must begin at the currently painted frame.
 * Layout commits once. Text translates without scaling; clips reveal each row
 * in order, and the surface interpolates its outline without resizing the dock.
 * No animation frame reads layout or writes inherited canvas reservations. */
export class ComposerMotion extends Component<Props> {
  private animations: Animation[] = []
  private extent: { animation: Animation; from: number; to: number } | undefined
  private keyboard = false
  private motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
  private modality = (event: Event) => {
    this.keyboard = event.type === 'keydown'
    if (this.keyboard) this.clear()
    this.props.composer.current?.toggleAttribute('data-instant', this.keyboard)
  }
  private resize = () => this.clear()
  private reduce = () => { if (this.motionPreference.matches) this.clear() }
  componentDidMount() {
    document.addEventListener('pointerdown', this.modality, true)
    document.addEventListener('keydown', this.modality, true)
    this.motionPreference.addEventListener('change', this.reduce)
    window.addEventListener('resize', this.resize)
  }
  componentWillUnmount() {
    document.removeEventListener('pointerdown', this.modality, true)
    document.removeEventListener('keydown', this.modality, true)
    this.motionPreference.removeEventListener('change', this.reduce)
    window.removeEventListener('resize', this.resize)
    this.clear()
  }
  private clear() {
    for (const animation of this.animations) { animation.onfinish = null; animation.cancel() }
    this.animations = []; this.extent = undefined
    this.props.composer.current?.removeAttribute('data-morphing')
  }
  private positions(form: HTMLElement) {
    return new Map(Array.from(form.querySelectorAll<HTMLElement>(moving), element => {
      const rect = element.getBoundingClientRect()
      const parent = element.parentElement?.closest(moving)?.getBoundingClientRect()
      return [element, { x: rect.x - (parent?.x ?? 0), y: rect.y - (parent?.y ?? 0), width: rect.width, clip: getComputedStyle(element).clipPath }]
    }))
  }
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const form = this.props.composer.current
    if (previous.mode === this.props.mode || !form) return null
    const progress = this.extent?.animation.effect?.getComputedTiming().progress
    const height = this.extent && progress != null ? this.extent.from + (this.extent.to - this.extent.from) * progress : form.getBoundingClientRect().height
    const snapshot = { height, positions: this.positions(form) }
    this.clear()
    return snapshot
  }
  componentDidUpdate(_previous: Props, _state: unknown, before: Snapshot | null) {
    const form = this.props.composer.current
    if (!before || !form || this.keyboard || this.motionPreference.matches) return
    const height = form.getBoundingClientRect().height
    const ownDuration = themeTime(height > before.height ? '--motion-disclosure' : '--motion-disclosure-exit', form)
    const reading = form.parentElement?.querySelector('.conversation-presence')?.getAnimations().find(animation => animation.id === 'unfold-enter' || animation.id === 'unfold-exit')
    const timing = reading?.effect?.getComputedTiming()
    const duration = Math.max(ownDuration, timing ? Number(timing.endTime) - Number(timing.localTime ?? 0) : 0)
    if (!duration) return
    const positions = this.positions(form)
    const options: KeyframeAnimationOptions = { duration, easing: themeEasing('--ease-sheet', form), fill: 'both' }
    const margin = themeLength('--space-1')
    const clip = (top: number) => `inset(${top - margin}px ${-margin}px ${-margin}px ${-margin}px)`
    // Measure and prepare the silhouette before starting any content animation.
    this.animations.push(...this.props.surface.current?.resize(before.height, options) ?? [])
    form.dataset.morphing = 'moving'
    const boundary = form.animate([{ clipPath: clip(height - before.height) }, { clipPath: clip(0) }], { ...options, id: motionId })
    this.extent = { animation: boundary, from: before.height, to: height }
    this.animations.push(boundary)
    for (const [element, after] of positions) {
      const from = before.positions.get(element)
      if (!from?.width || !after.width) continue
      const x = from.x - after.x, y = from.y - after.y
      if (Math.abs(x) < .01 && Math.abs(y) < .01 && from.clip === after.clip) continue
      this.animations.push(element.animate([
        { transform: `translate(${x}px, ${y}px)`, clipPath: from.clip },
        { transform: 'translate(0, 0)', clipPath: after.clip }
      ], options))
    }
    boundary.onfinish = () => this.clear()
  }
  render() { return this.props.children }
}
