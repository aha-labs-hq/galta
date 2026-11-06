import { CanvasPixels } from './CanvasPixels'
import { PointerTrail } from './PointerTrail'
import { MAX_POINTER_WAVES, PointerWaves } from './PointerWaves'

const fieldVertex = `attribute vec2 position;
uniform float extent;
varying vec2 point;
void main() { point = position * extent; gl_Position = vec4(position, 0., 1.); }`
const fieldFragment = `precision mediump float;
varying vec2 point;
uniform sampler2D artwork;
uniform vec4 waves[${MAX_POINTER_WAVES}];
uniform vec3 shape;
uniform vec3 crop;
void main() {
  vec2 shift = vec2(0.);
  float coverage = 0., light = 0.;
  for (int i = 0; i < ${MAX_POINTER_WAVES}; i++) {
    if (waves[i].w <= 0.) continue;
    vec2 relative = point - waves[i].xy;
    float distance = length(relative), offset = (distance - waves[i].z) / shape.x;
    if (abs(offset) >= 1.) continue;
    vec2 direction = relative / max(1., distance);
    float envelope = .5 + .5 * cos(offset * 3.14159265);
    float slope = sin(offset * 3.14159265) * envelope * waves[i].w;
    shift += direction * slope * shape.y;
    // Coverage reaches full strength before amplitude. Otherwise compositing
    // squares the microphone level and quiet speech vanishes on blank paper.
    coverage = max(coverage, envelope * min(1., waves[i].w * 4.));
    light += slope * dot(direction, vec2(-.6, .8)) * shape.z;
  }
  if (coverage <= 0.) discard;
  shift *= min(1., shape.y / max(shape.y, length(shift)));
  vec2 uv = (point - shift + crop.xy) / crop.z + .5;
  vec3 color = clamp(texture2D(artwork, uv).rgb + clamp(light, -shape.z, shape.z), 0., 1.);
  gl_FragColor = vec4(color * coverage, coverage);
}`
const trailVertex = `attribute vec2 position;
attribute vec3 detail;
uniform vec2 origin;
uniform float extent;
uniform float now;
uniform float duration;
varying vec3 edge;
void main() {
  edge = detail;
  // Normalize timestamps in high-precision vertex arithmetic before varying
  // interpolation; fragment mediump must never carry a long recording clock.
  edge.y = (now - detail.y) / duration;
  vec2 local = position - origin;
  gl_Position = vec4(local.x / extent, -local.y / extent, 0., 1.);
}`
const trailFragment = `precision mediump float;
varying vec3 edge;
uniform vec4 ink;
uniform vec3 core;
uniform vec3 beam;
uniform float halfWidth;
void main() {
  // Evaluate decay per pixel so sparse straight spans retain the exact same
  // continuous taper as dense curves; geometry no longer samples the fade.
  float age = clamp(edge.y, 0., 1.);
  float tail = 1. - clamp(edge.z, 0., 1.);
  float strength = 1. - max(age * age * age, tail * tail * tail);
  float d = abs(edge.x), width = halfWidth * strength;
  float body = (1. - smoothstep(max(0., width - .6), width + .6, d)) * sqrt(strength) * ink.a;
  float spread = max(.5, (width + beam.x) / 2.5);
  float halo = exp(-.5 * pow(d / spread, 2.)) * strength * strength * beam.y;
  float inner = (1. - smoothstep(max(0., width * .35 - .3), width * .35 + .3, d)) * strength * ink.a * beam.z;
  float base = body + halo * (1. - body);
  float alpha = inner + base * (1. - inner);
  gl_FragColor = vec4(core * inner + ink.rgb * base * (1. - inner), alpha);
}`
type Program = { program: WebGLProgram; names: string[]; uniform: Record<string, WebGLUniformLocation | null> }
export type PointerStyle = { extent: number; band: number; displacement: number; contrast: number; opacity: number; ink: string; core: string; halo: number; haloOpacity: number; coreOpacity: number; cacheMargin: number }

/** One fixed local surface for both effects. No SVG path strings or viewport
 * paint layer. Only input changes upload ribbon geometry; only crop changes or
 * a 15 Hz artwork refresh upload pixels. Both fades stay on the GPU. */
export class PointerRenderer {
  private source = document.createElement('canvas')
  private context: CanvasRenderingContext2D
  private programs: Program[] = []
  private shaders: WebGLShader[] = []
  private field: Program
  private ribbon: Program
  private triangle: WebGLBuffer
  private mesh: WebGLBuffer
  private texture: WebGLTexture
  private uploaded = -1
  private meshCapacity = 0
  private meshViews: Float32Array[] = []
  private cropX = Infinity
  private cropY = Infinity
  private refreshed = -Infinity
  private disposed = false
  private initialized = false
  private parallel: KHR_parallel_shader_compile | null
  private position = ''
  private waveData = new Float32Array(MAX_POINTER_WAVES * 4)
  private constructor(private canvas: HTMLCanvasElement, private gl: WebGLRenderingContext, private style: PointerStyle) {
    const dpr = Math.min(devicePixelRatio, 2), sourceSize = (style.extent + style.cacheMargin) * 2
    canvas.width = canvas.height = Math.ceil(style.extent * 2 * dpr)
    this.source.width = this.source.height = Math.ceil(sourceSize * dpr)
    this.context = this.source.getContext('2d')!
    this.parallel = gl.getExtension('KHR_parallel_shader_compile')
    this.triangle = gl.createBuffer()!; this.mesh = gl.createBuffer()!; this.texture = gl.createTexture()!
    try {
      this.field = this.program(fieldVertex, fieldFragment, ['extent', 'shape', 'crop', 'waves[0]', 'artwork'])
      this.ribbon = this.program(trailVertex, trailFragment, ['origin', 'extent', 'now', 'duration', 'ink', 'core', 'beam', 'halfWidth'])
    } catch (error) { this.dispose(); throw error }
  }
  private initialize() {
    const gl = this.gl, style = this.style, canvas = this.canvas
    for (const { program, names, uniform } of this.programs) {
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Pointer renderer unavailable')
      for (const name of names) uniform[name] = gl.getUniformLocation(program, name)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.source.width, this.source.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.useProgram(this.field.program)
    gl.uniform1f(this.field.uniform.extent!, style.extent)
    gl.uniform3f(this.field.uniform.shape!, style.band, style.displacement, style.contrast)
    gl.uniform1i(this.field.uniform.artwork!, 0)
    gl.useProgram(this.ribbon.program); gl.uniform1f(this.ribbon.uniform.extent!, style.extent)
    // Resolve the theme color once; never read artwork pixels back.
    this.context.fillStyle = style.ink; this.context.fillRect(0, 0, 1, 1)
    this.context.fillStyle = style.core; this.context.fillRect(1, 0, 1, 1)
    const color = this.context.getImageData(0, 0, 2, 1).data
    gl.uniform4f(this.ribbon.uniform.ink!, color[0]! / 255, color[1]! / 255, color[2]! / 255, style.opacity)
    gl.uniform3f(this.ribbon.uniform.core!, color[4]! / 255, color[5]! / 255, color[6]! / 255)
    gl.uniform3f(this.ribbon.uniform.beam!, style.halo, style.haloOpacity, style.coreOpacity)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this.initialized = true
  }
  private program(vertex: string, fragment: string, names: string[]): Program {
    const gl = this.gl, program = gl.createProgram()!
    const result = { program, names, uniform: {} as Program['uniform'] }; this.programs.push(result)
    for (const [type, code] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!; this.shaders.push(shader); gl.shaderSource(shader, code); gl.compileShader(shader); gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'position'); gl.bindAttribLocation(program, 1, 'detail'); gl.linkProgram(program)
    return result
  }
  static create(canvas: HTMLCanvasElement, style: PointerStyle) {
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true })
    if (!gl) return undefined
    try { return new PointerRenderer(canvas, gl, style) } catch { return undefined }
  }
  draw(pixels: CanvasPixels, x: number, y: number, now: number, trail: PointerTrail, waves: PointerWaves, drawing: boolean) {
    const gl = this.gl, style = this.style
    if (gl.isContextLost()) return false
    if (!this.initialized) {
      // LINK_STATUS, uniform lookup and first use can synchronously wait on the
      // driver. Poll completion first where supported; native cursor/input keep
      // running while both programs compile. No extra timers or frame loop.
      if (this.parallel && this.programs.some(({ program }) => !gl.getProgramParameter(program, this.parallel!.COMPLETION_STATUS_KHR))) return true
      try { this.initialize() } catch { return false }
    }
    // All bounds are in surface coordinates, including the anchored births.
    // Cumulative travel bounds the wake independently of viewport size.
    const bounds = trail.bounds, voice = waves.bounds
    const left = Math.min(x, trail.count ? bounds.left : x, waves.count ? voice.left : x)
    const right = Math.max(x, trail.count ? bounds.right : x, waves.count ? voice.right : x)
    const top = Math.min(y, trail.count ? bounds.top : y, waves.count ? voice.top : y)
    const bottom = Math.max(y, trail.count ? bounds.bottom : y, waves.count ? voice.bottom : y)
    const centerX = (left + right) / 2, centerY = (top + bottom) / 2
    const position = `translate3d(${centerX - style.extent}px,${centerY - style.extent}px,0)`
    if (position !== this.position) { this.canvas.style.transform = position; this.position = position }
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (waves.count) {
      // Cache the whole live wake, not the moving hotspot. The guard available
      // on each axis grows when the wave footprint is small or stationary.
      const area = pixels.bounds, size = (style.extent + style.cacheMargin) * 2
      const cx = (voice.left + voice.right) / 2 + area.left, cy = (voice.top + voice.bottom) / 2 + area.top
      const marginX = size / 2 - (voice.right - voice.left) / 2 - style.displacement
      const marginY = size / 2 - (voice.bottom - voice.top) / 2 - style.displacement
      if (Math.abs(cx - this.cropX) > marginX || Math.abs(cy - this.cropY) > marginY || now - this.refreshed >= 1000 / 15 || drawing) {
        pixels.draw(this.context, cx - size / 2, cy - size / 2, size, size)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.source)
        this.cropX = cx; this.cropY = cy; this.refreshed = now
      }
      for (let i = 0; i < this.waveData.length; i += 4) {
        this.waveData[i] = waves.data[i]! - centerX; this.waveData[i + 1] = centerY - waves.data[i + 1]!
        this.waveData[i + 2] = waves.data[i + 2]!; this.waveData[i + 3] = waves.data[i + 3]!
      }
      gl.useProgram(this.field.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.triangle)
      gl.enableVertexAttribArray(0); gl.disableVertexAttribArray(1); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.uniform3f(this.field.uniform.crop!, centerX + area.left - this.cropX, -(centerY + area.top - this.cropY), size)
      gl.uniform4fv(this.field.uniform['waves[0]']!, this.waveData)
      const scale = this.canvas.width / (style.extent * 2)
      const sx = Math.floor((style.extent + voice.left - centerX) * scale), sy = Math.floor((style.extent + centerY - voice.bottom) * scale)
      const ex = Math.ceil((style.extent + voice.right - centerX) * scale), ey = Math.ceil((style.extent + centerY - voice.top) * scale)
      gl.enable(gl.SCISSOR_TEST); gl.scissor(sx, sy, ex - sx, ey - sy)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.disable(gl.SCISSOR_TEST)
    }
    if (trail.count) {
      gl.useProgram(this.ribbon.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.mesh)
      if (this.uploaded !== trail.version) {
        if (this.meshCapacity !== trail.vertices.byteLength) {
          this.meshCapacity = trail.vertices.byteLength; this.meshViews = []
          gl.bufferData(gl.ARRAY_BUFFER, this.meshCapacity, gl.DYNAMIC_DRAW)
          gl.uniform1f(this.ribbon.uniform.halfWidth!, trail.width / 2)
          gl.uniform1f(this.ribbon.uniform.duration!, trail.duration)
        }
        // Reuse prefix views in 32-vertex buckets. No per-frame view allocation,
        // no unused maximum-history upload, no buffer storage reallocation.
        const bucket = Math.ceil(trail.count / 32)
        const data = this.meshViews[bucket] ??= trail.vertices.subarray(0, bucket * 32 * 5)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
        this.uploaded = trail.version
      }
      gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8)
      gl.uniform2f(this.ribbon.uniform.origin!, centerX, centerY); gl.uniform1f(this.ribbon.uniform.now!, now)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, trail.count)
    }
    return true
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const shader of this.shaders) this.gl.deleteShader(shader)
    for (const { program } of this.programs) this.gl.deleteProgram(program)
    this.meshViews = []
    this.gl.deleteBuffer(this.triangle); this.gl.deleteBuffer(this.mesh); this.gl.deleteTexture(this.texture)
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.source.width = this.source.height = this.canvas.width = this.canvas.height = 0
  }
}
