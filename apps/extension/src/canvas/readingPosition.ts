import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent, type WheelEvent } from 'react'
import { themeLength, themeTime } from '@/design/theme'

/** Disclosures a reader opened in one turn, kept while the sheet closes and reopens. */
export type TurnReadingState = { activities: Set<string>; processExpanded: Set<string> }
/** Where the reader is in one session: the scroll position, whether they follow
 * new output, and what they opened. It outlives the sheet's mount; changing
 * sessions resets it. */
export type ReadingPosition = { sessionId?: string | undefined; top: number; following: boolean; turns: Map<string, TurnReadingState> }

// A reader this close to the bottom is reading the latest output.
const LATEST_SLACK = 24
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']
const UPWARD_KEYS = ['ArrowUp', 'PageUp', 'Home']

type Reveal = (disclosure: HTMLElement, opening: boolean) => void
const RevealContext = createContext<Reveal | null>(null)
export const RevealProvider = RevealContext.Provider
/** Tells the reading position that the reader toggled a disclosure. */
export function useReveal(): Reveal {
  const reveal = useContext(RevealContext)
  if (!reveal) throw new Error('A conversation disclosure must render inside its transcript.')
  return reveal
}

/** The transcript's scroll policy, in one place. Following the latest and
 * reading history are distinct intentions:
 * - While following, growth glides to the new bottom; output arriving during a
 *   glide joins it. Only an upward move leaves the latest.
 * - While reading, the top edge holds still as output grows.
 * - Back to latest glides once; any wheel, press or scroll key takes it over.
 * - A toggled disclosure keeps what the reader pressed in place. An opening one
 *   reveals its contents as they unfold, but never pushes its trigger past the
 *   top edge; it keeps doing so if its contents grow, until the reader scrolls.
 * A frame loop runs only while a glide does, with one geometry read batch and
 * one scroll write per frame, and no React update per frame. */
export function useReadingPosition(reading: MutableRefObject<ReadingPosition>, sessionId: string | undefined) {
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(reading.current.sessionId !== sessionId || reading.current.following)
  // Whether newer output lies below the view. Following is the reader's
  // intention; this is a fact about the view, and Back to latest needs both.
  const [away, setAway] = useState(false)
  // The top edge to hold while reading, and the last position seen.
  const held = useRef<number | null>(null), seen = useRef(0)
  // A glide owns the scroll position until it ends; `written` is where it last
  // put the view, so a move against it is recognisably someone else's.
  const glide = useRef<{ kind: 'return' | 'follow'; frame: number; written: number } | null>(null)
  const revealing = useRef<HTMLElement | null>(null)

  const measure = useCallback(() => {
    const element = scroll.current!
    setAway(element.scrollHeight - element.scrollTop - element.clientHeight >= LATEST_SLACK)
  }, [])
  const follow = useCallback((value: boolean) => {
    if (glide.current) cancelAnimationFrame(glide.current.frame)
    glide.current = null
    if (value) { held.current = null; revealing.current = null }
    reading.current.following = value
    setFollowing(value)
  }, [reading])
  const hold = useCallback(() => {
    held.current = scroll.current!.scrollTop
    follow(false)
  }, [follow])
  const glideToLatest = useCallback((kind: 'return' | 'follow') => {
    const element = scroll.current!
    const duration = themeTime(kind === 'return' ? '--motion-scroll' : '--motion-follow', element)
    if (!duration || element.scrollHeight - element.clientHeight - element.scrollTop <= 1) {
      element.scrollTop = element.scrollHeight
      return
    }
    const startedAt = performance.now()
    let previousEase = 0
    const advance = (now: number) => {
      const progress = Math.max(0, Math.min(1, (now - startedAt) / duration))
      const ease = 1 - (1 - progress) ** 3
      // Read the current destination once per frame. Apportion the remaining
      // distance so new output joins this transition instead of restarting it.
      const target = element.scrollHeight - element.clientHeight
      const top = element.scrollTop
      element.scrollTop = top + (target - top) * (ease - previousEase) / (1 - previousEase)
      previousEase = ease
      if (ease >= 1) {
        glide.current = null
        reading.current.top = element.scrollTop
        return
      }
      glide.current = { kind, frame: requestAnimationFrame(advance), written: element.scrollTop }
    }
    glide.current = { kind, frame: requestAnimationFrame(advance), written: element.scrollTop }
  }, [reading])
  /** Scroll just enough to show an opening disclosure, never so far that what
   * the reader pressed leaves the top edge. */
  const showDisclosure = useCallback((disclosure: HTMLElement) => {
    const element = scroll.current!
    if (held.current !== null && Math.abs(element.scrollTop - held.current) > 1) element.scrollTop = held.current
    const view = element.getBoundingClientRect(), box = disclosure.getBoundingClientRect(), margin = themeLength('--space-3')
    const shift = Math.min(box.bottom - (view.bottom - margin), box.top - (view.top + margin))
    if (shift > .5) element.scrollTop += shift
    held.current = element.scrollTop
  }, [])

  useLayoutEffect(() => {
    const element = scroll.current!
    if (reading.current.sessionId !== sessionId) reading.current = { sessionId, top: 0, following: true, turns: new Map() }
    revealing.current = null
    setFollowing(reading.current.following)
    element.scrollTop = reading.current.following ? element.scrollHeight : reading.current.top
    seen.current = element.scrollTop
    held.current = reading.current.following ? null : element.scrollTop
    measure()
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (glide.current) return
        if (reading.current.following) return glideToLatest('follow')
        if (revealing.current?.isConnected) showDisclosure(revealing.current)
        else if (held.current !== null && Math.abs(element.scrollTop - held.current) > 1) element.scrollTop = held.current
        measure()
      })
    })
    observer.observe(element); observer.observe(content.current!)
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame)
      if (glide.current) cancelAnimationFrame(glide.current.frame)
      glide.current = null
    }
  }, [sessionId, reading, glideToLatest, showDisclosure, measure])

  const returnToLatest = useCallback(() => {
    follow(true)
    glideToLatest('return')
  }, [follow, glideToLatest])
  // Turns brought in above the reader's view must not move the view. The
  // first turn on screen is the anchor: where it sat before the change is where
  // it sits after. The position the reader holds and the one last seen move
  // with it, or the hold would pull the view back and the move would read as a
  // scroll.
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null)
  const markAnchor = useCallback((element: HTMLElement | null) => {
    anchor.current = element ? { element, top: element.getBoundingClientRect().top } : null
  }, [])
  const keepAnchor = useCallback(() => {
    const marked = anchor.current
    anchor.current = null
    if (!marked?.element.isConnected) return
    const shift = marked.element.getBoundingClientRect().top - marked.top
    if (Math.abs(shift) < .5) return
    const element = scroll.current!
    element.scrollTop += shift
    seen.current = element.scrollTop
    if (held.current !== null) held.current = element.scrollTop
    reading.current.top = element.scrollTop
  }, [reading])
  /** Navigation: bring an anchor to the top edge and read from there. */
  const goTo = useCallback((anchor: HTMLElement) => {
    const element = scroll.current!
    revealing.current = null
    follow(false)
    element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - themeLength('--space-3')
    reading.current.top = element.scrollTop
    held.current = element.scrollTop
    measure()
    anchor.focus({ preventScroll: true })
  }, [follow, reading, measure])
  const reveal = useCallback<Reveal>((disclosure, opening) => {
    hold()
    revealing.current = opening ? disclosure : null
  }, [hold])

  // A reader's own gesture takes over from a glide or a reveal. Following
  // output is not the reader's gesture, so only an intent to read earlier
  // output takes a following glide over: scrolling up or grabbing the
  // scrollbar. Pressing content, such as a disclosure, keeps following.
  const takeOver = (intent: boolean) => {
    revealing.current = null
    if (glide.current && (glide.current.kind === 'return' || intent)) hold()
  }
  const scrollProps = {
    onWheel: (event: WheelEvent<HTMLDivElement>) => takeOver(event.deltaY < 0),
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => { if (event.target === event.currentTarget || glide.current?.kind === 'return') takeOver(true) },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if (SCROLL_KEYS.includes(event.key)) takeOver(UPWARD_KEYS.includes(event.key)) },
    onScroll: () => {
      const element = scroll.current!
      reading.current.top = element.scrollTop
      // Output growing below a pinned reader moves the bottom away without
      // moving the reader, and can land between a glide's last write and this
      // event. Only a reader who moved up has left the latest.
      const movedUp = element.scrollTop < seen.current - 1
      seen.current = element.scrollTop
      const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight < LATEST_SLACK
      // A touch drag or any other scroll that runs up against a following
      // glide is the reader's; a clamp at the bottom is not.
      if (glide.current?.kind === 'follow' && element.scrollTop < glide.current.written - 1 && !atLatest) {
        hold(); setAway(true)
        return
      }
      if (glide.current) return
      setAway(!atLatest)
      // Wheel, touch, scrollbar drag and keyboard scrolling all converge here.
      if (atLatest || reading.current.following && !movedUp) follow(true)
      else hold()
    }
  }
  return { scroll, content, behind: !following && away, returnToLatest, goTo, reveal, scrollProps, markAnchor, keepAnchor }
}
