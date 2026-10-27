/** What a model family does best, so an agent chooses by the task rather than
 * by habit. Drawn from Higgsfield's published routing guidance; families with
 * no reliable note get none. */
const NOTES: readonly [RegExp, string][] = [
  [/(^|\/)(gpt-image|gpt-5[\w.-]*image)/, 'Legible text on the image and exact colours.'],
  [/(nano-banana|gemini-[\w.-]*image)/, 'Edits that stay faithful to reference images: the same person, product or style; cartoons.'],
  [/seedream/, 'Complex compositions, faces and character sheets.'],
  [/^recraft\/.*vector/, 'Returns SVG, which the canvas cannot place yet; choose a raster Recraft model.'],
  [/^recraft\//, 'Logos, icons and brand graphics.'],
  [/ideogram/, 'Typography: posters and layouts with legible text.'],
  [/(^|\/)soul\/cinema/, 'Cinematic stills: film lighting, lenses and grading.'],
  [/(^|\/)soul\//, 'Photoreal people, fashion and editorial looks.'],
  [/(birefnet|background\/remove|remove-background)/, 'Cuts the subject out onto a transparent background; takes one image and no prompt.'],
  [/seedance/, 'The default for video: realistic human motion, sound, first and last frames.'],
  [/kling/, 'Stylised looks, multi-shot sequences and motion transfer.'],
  [/(^|\/)veo[-\d]/, 'Ultra-realistic scenes with sound.'],
  [/cinema-studio/, 'Directed cinematic scenes with sound.'],
  [/hailuo/, 'Fast, high-energy motion at low cost.'],
  [/(^|\/)wan-/, 'Precise start and end frames.'],
  [/(aleph|video-edit)/, 'Editing an existing video.'],
  [/video-upscale/, 'Upscaling a finished video.']
]

export const modelNote = (id: string) => NOTES.find(([pattern]) => pattern.test(id))?.[1]
