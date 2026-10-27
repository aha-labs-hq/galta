import { EYES, HEAD, VIEW, shape } from './geometry'

/* The mark as markup, at a given openness.

   The mark is two-tone in every context: ink, and the paper showing through
   it. Those two colours are `--mark-ink` and `--mark-paper`; the classes below
   are filled by the surface's stylesheet, so the values live in `tokens.css`
   and nowhere else.

   Each eye is a group so the timeline can aim it (translate) and squint it
   (scale about its own centre) without touching the socket it sits in. The
   ring is a second copy of the head's own path, stroked rather than filled, so
   the edge follows the silhouette and no box is ever drawn around the mark. */
export function markup(open = 0): string {
  const eyes = EYES.map((e, i) =>
    `<g class="galta-mark__eye" data-eye="${i}" transform="translate(${e.c[0]} ${e.c[1]})">
       <circle class="galta-mark__socket" r="${e.r}"/>
       <g class="galta-mark__gaze"><circle class="galta-mark__pupil" r="${e.pr}"/></g>
     </g>`).join('')
  return `<svg class="galta-mark" viewBox="${VIEW}" aria-hidden="true">
    <path class="galta-mark__head" d="${HEAD}"/>
    <path class="galta-mark__ring" d="${HEAD}"/>
    ${eyes}
    <path class="galta-mark__lip" d="${shape(open)}"/>
  </svg>`
}
