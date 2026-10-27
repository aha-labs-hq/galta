import { swallow } from '../marks/swallow'
import { createSurface, type CollectorSurface } from '../marks/surface'
import type { CollectionItemInput } from '../shared/collection'
import { sourceId } from './sourceId'

/* ===========================================================================
   The collect affordance.

   `content/main.ts` states the rule this module has to obey: "Do not mutate
   every link/image or infer drags from ordinary pointer clicks." So there is no
   per-image listener, no per-image node, and no crawl. The whole page is
   served by:

     - one delegated pointer listener set, installed once at module scope
     - one rAF-coalesced work frame, so a mouse sweeping across a 200-image grid
       resolves at most one candidate per frame instead of one per element
     - one mark, one shadow root, two swallow layers, however many images a page
       happens to hold

   Listener and surface counts do not grow with the page, and the surface is
   built on the first qualifying hover rather than at content-script start —
   most pages never produce one, and the inlined stylesheet is not free.
   =========================================================================== */

/* Images below this are not offered. A 16px favicon sprouting a collect button
   is noise, and the mark itself needs room to be a target. It is a product
   floor, so it is one named constant rather than a number at a comparison. */
const MIN_IMAGE_EDGE = 72

/* The mark is an image action, so it belongs to the image's own surface. Keep
   it inset from the rendered pixels instead of placing it in the page gap;
   Pinterest's masonry cards have no reliable space outside the image and the
   old outside-corner placement could land over the site header. */
const MARK_INSET = 12

/* How long the pointer may leave the image and the mark before the mark goes.
   The short grace period absorbs the event boundary between a host image and
   the shadow-owned action without leaving a stale control on the page. */
const LINGER = 180
const FEEDBACK_TIME = { collected: 2200, failed: 5000 }

/* Collection and drag both hand a fetchable reference to the canvas importer.
   Do not offer inline or blob images the collection store cannot retain. */
export const isHttpImage = (url: string) => /^https?:\/\//i.test(url)

/* The element under the pointer and the URL its bytes come from, or null.

   `<picture>` needs no branch of its own: the `<img>` inside it is the rendered
   element and `currentSrc` already resolves to the chosen source. A `<video>` is
   offered only through its poster — collecting video bytes is a separate feature
   with its own cap and its own pipeline, and offering it here would promise
   something this path cannot deliver. */
type Candidate = { image: HTMLImageElement | HTMLVideoElement; url: string }
const mediaUrl = (media: Candidate['image']) => media instanceof HTMLImageElement ? media.currentSrc || media.src : media.poster

/* Only the closeup media is the detail main image. A /pin/ URL also contains
   recommended cards, so URL alone (or absence of a link) cannot own this rule.
   Cards, including board cards, share a bottom action row; actual native
   controls decide how much room to reserve on its right. */
function pinterestScene(doc: Document, media: Element): 'main' | 'card' | null {
  const location = doc.location
  if (!location || !(location.hostname === 'pinterest.com' || location.hostname.endsWith('.pinterest.com'))) return null
  return /^\/pin\/\d+\/?$/.test(location.pathname) && media.closest('[data-test-id="closeup-media-container"]') ? 'main' : 'card'
}

export type CollectedImage = CollectionItemInput & { id: string; sourceUrl: string; pageUrl: string }

/* Freeze provenance at activation. Neither srcset changes, navigation, nor the
   animation may turn this click into a reference to another image or page. */
function collectionInput(doc: Document, media: Candidate['image'], url: string): CollectedImage {
  const pageUrl = doc.location.href
  const link = media.closest<HTMLAnchorElement>('a[href]')
  const sourceUrl = pinterestScene(doc, media) === 'main' ? pageUrl
    : link && isHttpImage(link.href) ? link.href : pageUrl
  const title = (media.getAttribute('title') || media.getAttribute('alt'))?.trim()
  return Object.freeze({
    id: sourceId(), mediaUrl: url, sourceUrl, pageUrl,
    ...(doc.title.trim() ? { pageTitle: doc.title.trim() } : {}),
    ...(title ? { title } : {}),
  })
}

/* What the pointer is over, as far as this module cares. Three outcomes, and the
   distinction between two of them is what keeps the mark steady: the pointer can
   be over the mark itself, which means "keep what you have", and it can be over
   something that is not a collectable image at all, which means "let go". */
type Hit = { kind: 'image'; candidate: Candidate } | { kind: 'own' } | { kind: 'none' }

type Point = { x: number; y: number }

/* A card overlay belongs to an image only while their common surface has the
   image's bounds. This handles Pinterest's sibling hover layers without
   reaching through an unrelated dialog, header, or neighbouring card. One CSS
   pixel permits rounding between an image and its enclosing surface. */
function onImage(media: Element, target: Element): boolean {
  if (media === target) return true
  const image = media.getBoundingClientRect()
  for (let parent = media.parentElement; parent; parent = parent.parentElement) {
    const r = parent.getBoundingClientRect()
    if (r.left < image.left - 1 || r.top < image.top - 1
      || r.right > image.right + 1 || r.bottom > image.bottom + 1) return false
    if (parent.contains(target)) return true
  }
  return false
}

function hitTest(doc: Document, target: EventTarget | null, point: Point): Hit {
  const el = target instanceof Element ? target : null
  if (!el) return { kind: 'none' }
  /* The mark's shadow content is closed, so an event from it reports the host as
     its target. That is the mark: the pointer is on the affordance, not on the
     page, and the candidate must be kept rather than re-resolved — resolving it
     again would return "nothing here", hide the mark, drop the pointer back onto
     the image underneath, and re-show it, once per event, for as long as the
     pointer rests there. */
  if (el.closest('[data-galta-collector]')) return { kind: 'own' }

  /* Resolve the rendered stack at the pointer, since a hover overlay can
     appear between the event and this work frame. Only an image-local overlay
     is allowed to reveal the media underneath it. */
  const stack = doc.elementsFromPoint(point.x, point.y)
  const top = stack[0] ?? el
  if (top.closest('[data-galta-collector]')) return { kind: 'own' }
  const media = top.closest('img, video') ?? stack.find(node =>
    node.matches('img, video') && onImage(node, top))
  if (!media) return { kind: 'none' }
  const url = mediaUrl(media as Candidate['image'])
  if (!url || !isHttpImage(url)) return { kind: 'none' }
  return { kind: 'image', candidate: { image: media as HTMLImageElement | HTMLVideoElement, url } }
}

/* Whether an element is still worth offering: attached to the document, laid out
   at a real size, and not scrolled away. A detached element measures as all
   zeroes, and an element above or below the viewport measures off-screen; either
   one would place the mark at a corner of the viewport with nothing under it. */
function offered(media: HTMLImageElement | HTMLVideoElement, view: { width: number; height: number }): boolean {
  if (!media.isConnected || media.getClientRects().length === 0) return false
  const rect = media.getBoundingClientRect()
  if (rect.width < MIN_IMAGE_EDGE || rect.height < MIN_IMAGE_EDGE) return false
  return rect.bottom > 0 && rect.top < view.height && rect.right > 0 && rect.left < view.width
}

/* A closed shadow control is retargeted to its host in elementsFromPoint.
   That host may be 0x0, or an inert viewport layer; its rectangle is not the
   button's occupied space. Measure the hit edge in our travel direction
   instead. Eight strides and four refinements bound this local measurement;
   a larger obstruction is checked again by the bounded placement loop. No
   other extension's DOM, styles or stacking order are changed. */
function obstructionEdge(doc: Document, obstacle: Element, x: number, y: number, horizontal: boolean, mark: number) {
  const bounds = obstacle.getBoundingClientRect()
  if (x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom
    && doc.defaultView!.getComputedStyle(obstacle).pointerEvents !== 'none') {
    return horizontal ? bounds.left : bounds.bottom
  }
  const origin = horizontal ? x : y
  const direction = horizontal ? -1 : 1
  const occupied = (at: number) => doc.elementsFromPoint(horizontal ? at : x, horizontal ? y : at).includes(obstacle)
  let inside = origin
  for (let step = 1; step <= 8; step++) {
    let outside = origin + direction * step * mark / 4
    if (occupied(outside)) { inside = outside; continue }
    for (let refine = 0; refine < 4; refine++) {
      const middle = (inside + outside) / 2
      if (occupied(middle)) inside = middle
      else outside = middle
    }
    return outside
  }
  return inside
}

/* Start at the scene's corner, with the whole control inside both the rendered
   image and the viewport. Pinterest cards stay on their bottom action row;
   the detail main stays on the left. Other pages retain the top-right rule. The
   image rect is the authority here — not a parent card whose padding,
   caption, or transform may be unrelated to the pixels under the pointer.

   Clamping matters for a partially visible Pinterest card: the action remains
   on the visible image instead of being clipped by the viewport. `mark` is
   the mark's drawn size, read from the theme rather than restated. */
function place(doc: Document, media: Element, view: { width: number; height: number }, mark: number) {
  const rect = media.getBoundingClientRect()
  const scene = pinterestScene(doc, media)
  const inset = scene === 'main' ? 16 : MARK_INSET
  const minLeft = Math.max(inset, rect.left + inset)
  const maxLeft = Math.min(view.width - mark - inset, rect.right - mark - inset)
  const minTop = Math.max(inset, rect.top + inset)
  const maxTop = Math.min(view.height - mark - inset, rect.bottom - mark - inset)
  if (minLeft > maxLeft || minTop > maxTop) return null
  let left = scene === 'main' ? minLeft : maxLeft
  let top = scene === 'card' ? maxTop : minTop

  /* Cards move left along the bottom row; other images move down their edge.
     Never switch corners in response to a hover. Five probes
     cover the mark's corners and centre, and three cover the gap toward the
     previous control. The host-owned image link is not an
     obstruction, but its Save/Share buttons and fixed page chrome are. Work
     is bounded even on a page with pathological stacked controls. */
  for (let step = 0; step < 8; step++) {
    let nextLeft = left, nextTop = top
    const probes = [[left + 1, top + 1], [left + mark - 1, top + 1],
      [left + 1, top + mark - 1], [left + mark - 1, top + mark - 1],
      [left + mark / 2, top + mark / 2]]
    for (const offset of [1, mark / 2, mark - 1]) {
      probes.push(scene === 'card' ? [left + mark + inset - 1, top + offset] : [left + offset, top - inset + 1])
    }
    for (const [x, y] of probes) {
      const hit = doc.elementsFromPoint(x!, y!).find(node => !node.closest('[data-galta-collector]'))
      if (!hit) return null
      const control = hit.closest('button, [role="button"], [role="checkbox"], a[href], input, select, textarea, [role="dialog"], [role="banner"]')
      const obstacle = !onImage(media, hit) ? control ?? hit
        : control && !control.contains(media) ? control : null
      if (obstacle) {
        const edge = obstructionEdge(doc, obstacle, x!, y!, scene === 'card', mark)
        if (scene === 'card') nextLeft = Math.min(nextLeft, edge - mark - inset)
        else nextTop = Math.max(nextTop, edge + inset)
      }
    }
    if (nextLeft === left && nextTop === top) return { left, top }
    if (nextLeft < minLeft || nextTop > maxTop) return null
    left = nextLeft; top = nextTop
  }
  return null
}

export type CollectorOptions = {
  /* Called at activation with no DOM objects. Resolve only after durable
     storage; reject to show a failed collection instead of a success. */
  onCollected: (item: CollectedImage) => Promise<void>
}

export type CollectorState = {
  shown: boolean
  markRect: { left: number; top: number; width: number; height: number } | null
  imageRect: { left: number; top: number; width: number; height: number } | null
  listenerCount: number
  inFlight: boolean
  feedback: 'collected' | 'failed' | null
}

export type Collector = {
  /* Removes every listener, node and style the collector added. */
  stop: () => void
  /* What the collector is doing right now. Reads only. */
  state: () => CollectorState
}

/* A fresh object each time: a shared literal handed to two callers is a value
   one of them can mutate into the other's answer. */
const NOTHING = (): CollectorState => ({ shown: false, markRect: null, imageRect: null, listenerCount: 0, inFlight: false, feedback: null })

/* Which documents already have a collector. Keyed by the document rather than
   by a marker attribute in the DOM, because the attribute can only appear once
   the surface exists — which is the first hover — so for the whole life of the
   page before that hover, two mounts would both find nothing and both install a
   full listener set. */
const mounted = new WeakSet<Document>()

export function startCollector(doc: Document = document, options: CollectorOptions): Collector {
  /* One collector per document, and the check happens at mount time rather than
     at first hover. */
  if (mounted.has(doc)) return { stop: () => {}, state: NOTHING }
  mounted.add(doc)

  const view = doc.defaultView ?? window

  /* Every listener this module installs goes through these two, so the count is
     a fact about what was installed rather than a claim written beside it. The
     rule being held here — one delegated set for the whole page, never one per
     image — is the difference between working on an image-heavy page and
     melting it, and it has to be measurable. */
  let listeners = 0
  const listen = (target: EventTarget, type: string, handler: EventListener, opts?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, handler, opts)
    listeners += 1
    return () => { target.removeEventListener(type, handler, opts); listeners -= 1 }
  }

  let surface: CollectorSurface | null = null
  let markSize = 0
  let candidate: Candidate | null = null
  let pending: EventTarget | null = null
  let pointer: Point = { x: 0, y: 0 }
  /* Two independent things want a frame: resolving which element the pointer is
     over, and moving the mark after a scroll. They must not share one slot —
     whichever was scheduled first would swallow the other, leaving either a
     stale mark after a scroll or a hover that never draws. Each keeps its own
     handle and coalesces only its own repeats. */
  let workFrame = 0
  let moveFrame = 0
  let linger = 0
  let feedbackTimer = 0
  let feedback: CollectorState['feedback'] = null
  let feedbackImage: Element | null = null
  let inFlight = false
  /* `stop()` is terminal. Without this the lazily built surface would be
     recreated by the next pointer event, and its listener pushed onto `listens`
     — a list the caller has already drained — so the collector would keep
     working after being told to stop, with a listener count that could never
     return to zero. */
  let stopped = false
  /* Filled below, once every handler exists. Declared here because the surface,
     built lazily, adds the mark's own listener to it. */
  const listens: (() => void)[] = []

  /* Built on first use. The surface carries the design tokens as an inlined
     stylesheet, so creating it eagerly would make every page in the browser pay
     for a feature the user has not reached for. */
  function ensureSurface(): CollectorSurface | null {
    if (stopped) return null
    if (surface) return surface
    surface = createSurface(doc)
    markSize = Number.parseFloat(getComputedStyle(surface.mark).width) || 34
    /* The element is placed by a surface-level listener so a click on the mark
       is not mistaken for a click on the page's own content. */
    listens.push(listen(surface.mark, 'click', onActivate))
    return surface
  }

  function show(next: Candidate) {
    if (!offered(next.image, { width: view.innerWidth, height: view.innerHeight })) { hide(); return }
    const s = ensureSurface()
    if (!s) return
    const at = place(doc, next.image, { width: view.innerWidth, height: view.innerHeight }, markSize)
    if (!at) { hide(); return }
    if (feedbackImage !== next.image) clearFeedback()
    candidate = next
    s.mark.style.left = `${at.left}px`
    s.mark.style.top = `${at.top}px`
    s.mark.dataset.shown = 'true'
  }

  function hide() {
    candidate = null
    if (surface) surface.mark.dataset.shown = 'false'
  }

  function clearFeedback() {
    view.clearTimeout(feedbackTimer)
    feedback = null
    feedbackImage = null
    if (surface) surface.status.textContent = ''
  }

  function report(result: NonNullable<CollectorState['feedback']>, at: DOMRect, image: Element) {
    if (stopped || !surface) return
    clearFeedback()
    feedback = result
    feedbackImage = image
    const status = surface.status
    status.textContent = result === 'collected' ? 'Collected' : 'Couldn’t collect image. Try again.'
    const bounds = status.getBoundingClientRect()
    status.style.left = `${Math.max(12, Math.min(view.innerWidth - bounds.width - 12, at.left + at.width / 2 - bounds.width / 2))}px`
    status.style.top = `${Math.max(12, Math.min(view.innerHeight - bounds.height - 12, at.top >= bounds.height + 20 ? at.top - bounds.height - 8 : at.bottom + 8))}px`
    feedbackTimer = view.setTimeout(clearFeedback, FEEDBACK_TIME[result])
  }

  /* Move the mark onto its picture, or let go of a picture that is no longer
     there. This is the only writer of the mark's position after it is shown, so
     the liveness test lives here: an image can be removed by its page or
     scrolled out from under the mark at any moment, and neither fires a pointer
     event to tell us. */
  function reposition() {
    if (inFlight) return
    if (!candidate || !surface) return
    if (!offered(candidate.image, { width: view.innerWidth, height: view.innerHeight })) { hide(); return }
    const at = place(doc, candidate.image, { width: view.innerWidth, height: view.innerHeight }, markSize)
    if (!at) { hide(); return }
    surface.mark.style.left = `${at.left}px`
    surface.mark.style.top = `${at.top}px`
  }

  function work() {
    workFrame = 0
    if (inFlight) { pending = null; return }
    const hit = hitTest(doc, pending, pointer)
    pending = null
    /* The pointer is on the mark. Keep the candidate and its position — this is
       the only thing standing between the mark and a hide/show loop at event
       cadence, because the mark sits over the picture that summoned it. */
    if (hit.kind === 'own') return
    if (hit.kind === 'none') { hide(); return }
    const next = hit.candidate
    /* Already the current candidate: the pointer crossed a child of the same
       image, or re-entered it. Refresh both the URL and the position — the page
       may have swapped the source under a responsive `srcset` or scrolled
       between the last placement and this frame, and the collect must use the
       bytes that are on screen now. */
    if (candidate?.image === next.image) { candidate = next; reposition(); return }
    show(next)
  }

  function schedule(target: EventTarget | null) {
    pending = target
    if (!workFrame) workFrame = view.requestAnimationFrame(work)
  }

  const onOver = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY }
    if (inFlight) return
    view.clearTimeout(linger)
    schedule(event.target)
  }

  /* Leaving is judged by where the pointer went, not by the event's own target:
     moving from the image onto the shadow-owned mark must not dismiss it. */
  const onOut = (event: PointerEvent) => {
    if (inFlight) return
    const to = event.relatedTarget
    if (to instanceof Node && surface?.host.contains(to)) return
    view.clearTimeout(linger)
    linger = view.setTimeout(() => {
      /* The pointer may have landed on the mark itself, which lives in a closed
         root and therefore reports the host. Keep the mark while it is hovered. */
      if (surface?.mark.matches(':hover')) return
      hide()
    }, LINGER)
  }

  const onScroll = () => {
    if (moveFrame) return
    moveFrame = view.requestAnimationFrame(() => { moveFrame = 0; reposition() })
  }

  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide() }

  const onActivate = async (event: Event) => {
    /* Captured before the await. `stop()` can run while the swallow is playing —
       the surface is torn down from under it — so the local reference is what
       the rest of this function talks to, not the field that `stop()` clears. */
    const s = surface
    if (!candidate || !s || inFlight) return
    event.preventDefault()
    event.stopPropagation()
    const url = mediaUrl(candidate.image)
    if (!isHttpImage(url) || !candidate.image.isConnected) { hide(); return }
    const target = { image: candidate.image, url }
    const item = collectionInput(doc, target.image, url)
    const at = s.mark.getBoundingClientRect()
    clearFeedback()
    /* Reserved before the first await, and the only thing that stops a second
       swallow: a later activation returns above, before any default is
       prevented, so the page keeps its own click. Do not also disable the mark's
       hit testing — the mark is one element shared by every image on the page,
       and disabling it for the duration would leave it inert for the rest of the
       page's life. */
    inFlight = true
    try {
      /* Start storage in this click turn, before animation can delay or lose
         the handoff. Await both outcomes so a failed save cannot release the
         shared mark while its animation is still restoring the source. */
      const saving = Promise.resolve().then(() => options.onCollected(item))
      const [animation, storage] = await Promise.allSettled([
        swallow({ image: target.image, url, markEl: s.mark, back: s.back, front: s.front, document: doc }), saving,
      ])
      // The content-script owner aborts and tears down an invalidated page.
      // Await restoration, then leave it stopped without failed/success feedback.
      if (stopped && storage.status === 'rejected' && storage.reason instanceof DOMException && storage.reason.name === 'AbortError') return
      hide()
      if (animation.status === 'rejected') console.error('[Galta] Collection animation failed', { id: item.id }, animation.reason)
      if (storage.status === 'rejected') console.error('[Galta] Collection failed', { id: item.id }, storage.reason)
      report(storage.status === 'fulfilled' ? 'collected' : 'failed', at, target.image)
    } finally {
      inFlight = false
    }
  }

  listens.push(
    listen(doc, 'pointerover', onOver as EventListener, true),
    listen(doc, 'pointermove', onOver as EventListener, true),
    listen(doc, 'pointerout', onOut as EventListener, true),
    listen(doc, 'scroll', onScroll, { capture: true, passive: true }),
    listen(view, 'resize', onScroll, { passive: true }),
    listen(doc, 'keydown', onKey as EventListener, true),
  )

  return {
    stop: () => {
      /* Idempotent: a second call has nothing left to remove, and running the
         removals again would drive the listener count negative. */
      if (stopped) return
      stopped = true
      for (const off of listens) off()
      listens.length = 0
      if (workFrame) view.cancelAnimationFrame(workFrame)
      if (moveFrame) view.cancelAnimationFrame(moveFrame)
      view.clearTimeout(linger)
      view.clearTimeout(feedbackTimer)
      surface?.host.remove()
      surface = null
      candidate = null
    },
    state: () => {
      if (!surface) return NOTHING()
      const box = (el: Element | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      }
      return {
        shown: surface.mark.dataset.shown === 'true',
        markRect: box(surface.mark),
        imageRect: box(candidate?.image ?? null),
        listenerCount: listeners,
        inFlight,
        feedback,
      }
    },
  }
}
