import type { MediaKind } from '../../packages/canvas/src/capabilities/media'

/**
 * How to prompt for each kind, given only when the agent is about to make that
 * kind (generation_models with a kind), so the craft costs nothing otherwise.
 * Distilled from professional practice, Higgsfield's published guidance among
 * it, and fitted to Galta: start from what the user made, and keep the work
 * on the canvas as it happens.
 */
const ENDPOINTS = 'On fal and Higgsfield each task is its own model id (text-to-video, image-to-video, edit): choose the one that takes what you pass. A control a model lacks is refused before anything is paid for, with what it takes.'
const CANVAS = 'Keep the work on the canvas: before generating, reserve each result\'s place with canvas_reserve, sized to its aspect ratio, and fill it with canvas_place slot as soon as that result is ready instead of holding results until the end; for an edit that replaces an image, reserve over that image and pass replace with the slot. Release a place whose work failed. Keep the conversation to a sentence.'

const GUIDE: Record<MediaKind, string> = {
  image: [
    'Start from what the user made: pass selected images (canvas_extract) and sketches, layouts or marks drawn over an image (canvas_capture with file) as references.',
    'Local images are read for the request only: up to 10 MB each and 32 MB in total.',
    'Name each reference\'s role in the prompt, such as "Image 1: the product, keep its shape and label. Image 2: the light and palette."',
    'For an edit, describe only the change. Otherwise write a concrete prompt under about 200 words: subject, setting, composition and camera (lens, height, angle), light source and time of day, palette and finish.',
    'Choose the model by the task (see bestFor) and keep a model the user names.',
    'Keep a series consistent with the same references and style words; make variants differ deliberately in light, angle or palette.',
    'Check the placed result; fix a flaw with a narrow edit rather than a new generation.',
    ENDPOINTS,
    CANVAS
  ].join(' '),
  video: [
    'Anchor first: make or choose the key image, place it, then animate it with firstFrame, adding lastFrame for a transition.',
    'Describe only what moves: one camera move chosen for its effect (push in for intimacy, crane up to reveal a place, orbit a hero object, dolly zoom for a realization), the subject\'s action, pacing and sound.',
    'Frames and reference images do not mix. Some models also take referenceAudio and referenceVideo as HTTPS URLs (asset:// only on BytePlus); BytePlus Seedance 2.5 reworks a referenceVideo with task edit or extend (ratio adaptive; edit needs duration -1).',
    'Draft short at 720p before a longer or sharper version, which costs more.',
    ENDPOINTS,
    CANVAS
  ].join(' '),
  speech: [
    'The model speaks the text exactly as written: write it for the ear, with punctuation for pauses, and pick one of the model\'s voices; a voice it lacks is refused with its list.',
    CANVAS
  ].join(' ')
}

export const generationGuide = (kind: MediaKind) => GUIDE[kind]
