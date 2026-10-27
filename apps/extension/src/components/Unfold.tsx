import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { themeEasing, themeNumber, themeTime } from '@/design/theme'

/** The height a region is settling to: its motion's destination while it moves,
 * its height on screen at rest. Layout that must not chase the motion, such as
 * where new work lands, reads this rather than the height on screen. */
export function unfoldingHeight(element: Element): number {
  const growth = element.getAnimations().find(animation => animation.id === 'unfold-enter' || animation.id === 'unfold-exit')
  const to = (growth?.effect as KeyframeEffect | null | undefined)?.getKeyframes().at(-1)?.height
  return typeof to === 'string' ? Number.parseFloat(to) : element.getBoundingClientRect().height
}

/** A region that grows out of the edge it is attached to and settles back into
 * it. It stays mounted while shown and while settling. Every change of
 * direction moves its height from the height on screen to the destination, so
 * motion reverses midway without a jump. The frame clips; its contents (the
 * first child) hold their own height while it moves, so they are never relaid
 * out, and they fade in after the frame leads and fade out before it settles.
 * Entering, that height is the contents' own, kept live: what arrives while the
 * frame is still opening (a request's first message, the first line of work)
 * is laid out where it belongs at once, and the destination follows it from
 * the height on screen, so nothing scrolls inside a sheet that is too short
 * and nothing snaps when the motion ends.
 * A region shown from its first render appears without motion.
 *
 * Each use sets its timing in CSS, from motion tokens, on the frame:
 * `--unfold-enter`, `--unfold-enter-ease`, `--unfold-exit`, `--unfold-exit-ease`.
 * Under Radix, compose it through `forceMount`: the primitive keeps its open
 * state and semantics, and this owns presence and motion. */
export function Unfold({ shown, ref, children, ...props }: ComponentProps<'div'> & { shown: boolean }) {
  // `frame` is the mounted node; `seen` is the node the last layout pass saw,
  // so a new node is an entrance whatever the composed refs do on detach.
  const frame = useRef<HTMLDivElement | null>(null), seen = useRef<HTMLDivElement | null>(null)
  const motion = useRef<Animation[]>([])
  // Watches the contents while an entrance is under way.
  const following = useRef<ResizeObserver | null>(null)
  const initial = useRef(true)
  const [mounted, setMounted] = useState(shown)
  if (shown && !mounted) setMounted(true)
  const attach = useCallback((node: HTMLDivElement) => {
    frame.current = node
    const cleanup = typeof ref === 'function' ? ref(node) : ref ? void (ref.current = node) : undefined
    return () => {
      frame.current = null
      if (typeof cleanup === 'function') cleanup()
      else if (typeof ref === 'function') ref(null)
      else if (ref) ref.current = null
    }
  }, [ref])
  useLayoutEffect(() => {
    const first = initial.current
    initial.current = false
    const element = frame.current, entering = element !== seen.current
    seen.current = element
    if (!element) { motion.current = []; return }
    if (first) return
    const contents = element.firstElementChild instanceof HTMLElement ? element.firstElementChild : null
    // Read what is on screen before letting go of the motion that put it there.
    const from = entering ? 0 : element.getBoundingClientRect().height
    const opacity = entering || !contents ? 0 : Number(getComputedStyle(contents).opacity)
    for (const animation of motion.current) animation.cancel()
    motion.current = []
    following.current?.disconnect()
    following.current = null
    const release = () => { if (contents) contents.style.minHeight = contents.style.maxHeight = contents.style.flexShrink = '' }
    release()
    // Both destinations are measured at rest, before any new motion applies.
    const natural = element.getBoundingClientRect().height, to = shown ? natural : 0
    const settled = contents?.getBoundingClientRect().height ?? 0
    const duration = themeTime(shown ? '--unfold-enter' : '--unfold-exit', element)
    if (!duration || Math.abs(to - from) < .5) {
      if (!shown) setMounted(false)
      return
    }
    const easing = themeEasing(shown ? '--unfold-enter-ease' : '--unfold-exit-ease', element)
    const growth = element.animate([{ height: `${from}px` }, { height: `${to}px` }], { id: shown ? 'unfold-enter' : 'unfold-exit', duration, easing, fill: 'forwards' })
    motion.current = [growth]
    // A finished motion that fills forwards is removed once a later one has
    // finished too; this one is the base the others add to, and is ended below.
    growth.persist()
    // The region settles once the frame and everything that followed content
    // into it have arrived.
    const settle = () => {
      if (motion.current[0] !== growth || growth.playState !== 'finished' || motion.current.some(animation => animation.id === 'unfold-follow' && animation.playState !== 'finished')) return
      following.current?.disconnect()
      following.current = null
      if (!shown) { setMounted(false); return }
      for (const animation of motion.current) animation.cancel()
      motion.current = []
      release()
    }
    if (contents) {
      if (shown) {
        // The contents stand at the height they ask for rather than the share
        // of the frame that has led so far. A parent that holds them shorter
        // than they ask, such as a dock limited by a short window, already
        // sets the destination, so they hold that height and nothing follows.
        contents.style.flexShrink = '0'
        const asked = contents.getBoundingClientRect().height
        if (asked > settled + .5) contents.style.maxHeight = `${settled}px`
        else {
          let known = asked, end = to
          // Content that arrives while the frame leads moves the destination.
          // Moving only the end of the motion would lurch the frame by the
          // progress made times the change, so the lurch is taken out by a
          // second motion that releases it, over what remains of the first or
          // the time growth takes to be followed, whichever is longer. A
          // negative height is no value, so the lurch is written as a `calc()`,
          // which `add` carries through.
          following.current = new ResizeObserver(entries => {
            const height = entries.at(-1)!.borderBoxSize[0]!.blockSize, change = height - known
            if (Math.abs(change) < .5 || motion.current[0] !== growth) return
            known = height
            const timing = growth.effect!.getComputedTiming()
            end = Math.max(0, end + change)
            ;(growth.effect as KeyframeEffect).setKeyframes([{ height: `${from}px` }, { height: `${end}px` }])
            const lurch = (timing.progress ?? 0) * change
            if (!lurch) return
            const follow = element.animate([{ height: `calc(${-lurch}px)` }, { height: '0px' }], { id: 'unfold-follow', composite: 'add', duration: Math.max(duration - Number(timing.localTime ?? 0), themeTime('--motion-follow', element)), easing: themeEasing('--ease-settle'), fill: 'forwards' })
            follow.onfinish = settle
            motion.current.push(follow)
          })
          following.current.observe(contents)
        }
      } else contents.style.minHeight = `${settled}px`
      // Contents that start hidden wait for the frame to lead; a reversal
      // continues from the opacity on screen.
      const lead = shown && !opacity ? duration * themeNumber('--motion-contents-lead') : 0
      const span = shown ? duration - lead : duration * themeNumber('--motion-contents-exit')
      motion.current.push(contents.animate([{ opacity }, { opacity: shown ? 1 : 0 }], { id: 'unfold-contents', duration: span, delay: lead, easing: themeEasing('--ease-out'), fill: 'both' }))
    }
    growth.onfinish = settle
  }, [shown, mounted])
  useLayoutEffect(() => () => {
    following.current?.disconnect()
    for (const animation of motion.current) animation.cancel()
  }, [])
  return mounted ? <div {...props} ref={attach} data-state={shown ? 'open' : 'closed'} inert={!shown}>{children}</div> : null
}
