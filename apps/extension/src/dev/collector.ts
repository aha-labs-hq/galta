import '../content/main'

/* Test-only entry. Never included in an extension build.

   It loads the real content script against the shapes that actually break a
   collector: images inside links, a transformed ancestor that would defeat a
   naive fixed-position mark, a page that styles every element aggressively, a
   favicon that must be refused, and a grid large enough that a per-image
   listener would show up. The collector is then driven and inspected through
   the read-only handle `content/main.ts` exposes in development builds. */

const sources = [
  new URL('../../../../tests/fixtures/reference-pink.png', import.meta.url).href,
  new URL('../../../../tests/fixtures/reference-glass.png', import.meta.url).href,
  new URL('../../../../tests/fixtures/reference-flower.png', import.meta.url).href,
]

const grid = document.getElementById('grid')
if (!grid) throw new Error('The collector fixture is missing its grid')
const layout = new URL(location.href).searchParams.get('layout')
if (layout) document.body.dataset.layout = layout

grid.innerHTML = Array.from({ length: 96 }, (_, i) => `
  <figure class="card" ${layout ? 'data-test-id="pin"' : ''}>
    <div class="media" role="button" aria-label="Image card ${i}">
      <a href="${layout ? `/pin/${10000 + i}/` : `https://example.com/${i}`}"><img src="${sources[i % sources.length]}" alt="Sample ${i}"></a>
      <div class="overlay"><button type="button" class="save">Save</button>${layout ? '<button type="button" class="more" aria-label="More actions">···</button>' : ''}</div>
    </div>
    <figcaption>Sample ${i}</figcaption>
  </figure>`).join('')

if (layout === 'detail') {
  grid.insertAdjacentHTML('beforebegin', `<section id="detail" class="media" data-test-id="closeup-media-container">
    <div data-test-id="closeup-body-image-container"><img src="${sources[2]}" alt="Detail image"></div>
    <button type="button" class="visual-search" aria-label="Search image">Search</button>
  </section>`)
}

/* A favicon-sized image must never offer the mark. */
const tiny = document.getElementById('tiny')
if (!tiny) throw new Error('The collector fixture is missing its small-image slot')
tiny.innerHTML = `<img src="${sources[0]}" width="16" height="16" alt="Tiny">`
