import { swirlLayers, type FlowView } from './view.ts';

// The cover moved by a fragment shader, drawn small and stretched, so the GPU cost stays low (quarter resolution at
// 30 fps took about half the GPU time of the CSS drift on an Iris Xe). Two looks:
// --art-animation: sleeve-art-flow, the cover (--art-size px) warped slowly;
// --art-animation: sleeve-art-swirl, Sunamu's background: two turning copies of the cover, exclusion blended, the
// small blurred cover standing in for its blur(180px) at a fraction of the cost.
// Everything moving is a uniform worked out in view.ts, so a changed setting carries on from where the picture is.

export type FlowMode = 'flow' | 'swirl';

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
out vec4 color;
uniform sampler2D previous;
uniform sampler2D cover;
uniform float fade;
uniform float phase;
uniform float amount;
uniform float detail;
uniform float zoom;
uniform float saturation;
uniform vec2 aspect;
uniform int mode;
uniform vec2 frame;
uniform vec4 centers;
uniform vec2 angles;
uniform float size;
uniform float brightness;
uniform vec3 tint;
vec3 sampled(vec2 p) {
  return mix(texture(previous, p).rgb, texture(cover, p).rgb, fade);
}
vec3 saturated(vec3 c) {
  return mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, saturation);
}
// One swirl layer at a point of the window (vmax, y down): the cover turned by angle around center, multiplied with
// the tint (white for none) as the CSS swirl's background-blend-mode does, then CSS's brightness() and saturate(),
// clamped as filters are
vec3 layer(vec2 at, vec2 center, float angle) {
  vec2 d = at - center;
  float c = cos(angle);
  float s = sin(angle);
  vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / size + 0.5;
  return clamp(saturated(sampled(vec2(q.x, 1.0 - q.y)) * tint * brightness), 0.0, 1.0);
}
void main() {
  if (mode == 1) {
    vec2 at = vec2(uv.x, 1.0 - uv.y) * frame;
    vec3 a = layer(at, centers.xy, angles.x);
    vec3 b = layer(at, centers.zw, angles.y);
    color = vec4(a + b - 2.0 * a * b, 1.0);
    return;
  }
  vec2 p = (uv - 0.5) * aspect / zoom + 0.5;
  p += amount * 0.07 * vec2(sin(p.y * 3.1 * detail + phase * 0.11), cos(p.x * 2.7 * detail - phase * 0.09));
  p += amount * 0.04 * vec2(sin(p.y * 5.3 * detail - phase * 0.07), cos(p.x * 4.3 * detail + phase * 0.13));
  color = vec4(saturated(sampled(p)), 1.0);
}`;

const UNIFORMS = ['previous', 'cover', 'fade', 'phase', 'amount', 'detail', 'zoom', 'saturation', 'aspect', 'mode', 'frame', 'centers', 'angles', 'size', 'brightness', 'tint'] as const;
type Uniform = typeof UNIFORMS[number];

export class CoverFlow {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private uniforms = new Map<Uniform, WebGLUniformLocation | null>();
  // Unit 0 holds the cover before, unit 1 the cover now
  private textures: WebGLTexture[] = [];
  private cover: TexImageSource | null = null;
  private fadeFrom = 0;
  private fadeMs = 0;
  private lastDraw = -Infinity;
  // The swirl's tint as 0 to 1 a channel, white for none (setTint)
  private tint: [number, number, number] = [1, 1, 1];

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'flow';
    parent.prepend(this.canvas);
    this.canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.gl = null;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.setUp();
      if (this.cover) this.setCover(this.cover, performance.now(), 0);
    });
    this.setUp();
  }

  // False without WebGL 2 or while its context is lost: the page falls back to the still cover
  get available(): boolean {
    return this.gl !== null;
  }

  private setUp(): void {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
    if (!gl) return;
    const program = gl.createProgram();
    for (const [type, text] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      // A mistake in a look's GLSL would otherwise only show as the still cover
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.warn(`sleeve: the cover's ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader did not compile, so the cover stays still:`, gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('sleeve: the cover\'s shaders did not link, so the cover stays still:', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (const name of UNIFORMS) {
      this.uniforms.set(name, gl.getUniformLocation(program, name));
    }
    gl.uniform1i(this.uniforms.get('previous')!, 0);
    gl.uniform1i(this.uniforms.get('cover')!, 1);
    this.textures = [gl.createTexture(), gl.createTexture()];
    this.textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    });
    this.gl = gl;
    this.lastDraw = -Infinity;
  }

  // Cross-fades from the cover shown to this one, over fadeMs
  setCover(image: TexImageSource, now: number, fadeMs: number): void {
    const gl = this.gl;
    const first = this.cover === null;
    this.cover = image;
    if (!gl) return;
    this.textures.reverse();
    this.textures.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.fadeFrom = now;
    this.fadeMs = first ? 0 : fadeMs;
    this.lastDraw = -Infinity;
  }

  // No cover any more: the next one comes in by itself, with no fade from this one
  // The color each swirl layer is multiplied with, as #rrggbb channels (0 to 255), or null for none
  setTint(rgb: [number, number, number] | null): void {
    this.tint = rgb ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255] : [1, 1, 1];
  }

  forgetCover(): void {
    this.cover = null;
  }

  // Draws when the frame rate asks for one; ease is --swirl-timing as a function
  draw(now: number, view: FlowView, mode: FlowMode, ease: (progress: number) => number): void {
    const gl = this.gl;
    if (!gl || !this.cover || now - this.lastDraw < 1000 / view.fps - 2) return;
    this.lastDraw = now;
    const width = Math.max(1, Math.round(innerWidth * view.resolution));
    const height = Math.max(1, Math.round(innerHeight * view.resolution));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    const uniform = (name: Uniform) => this.uniforms.get(name)!;
    gl.uniform1f(uniform('fade'), this.fadeMs > 0 ? Math.min(1, (now - this.fadeFrom) / this.fadeMs) : 1);
    gl.uniform1f(uniform('phase'), view.phase);
    gl.uniform1f(uniform('amount'), view.amount);
    gl.uniform1f(uniform('detail'), view.detail);
    gl.uniform1f(uniform('zoom'), view.zoom);
    gl.uniform1f(uniform('saturation'), view.saturation);
    gl.uniform2f(uniform('aspect'), width > height ? 1 : width / height, width > height ? height / width : 1);
    gl.uniform1i(uniform('mode'), mode === 'swirl' ? 1 : 0);
    if (mode === 'swirl') {
      const vmax = Math.max(1, innerWidth, innerHeight);
      const [first, second] = swirlLayers(view, ease, innerWidth, innerHeight);
      gl.uniform2f(uniform('frame'), innerWidth / vmax, innerHeight / vmax);
      gl.uniform4f(uniform('centers'), first.x, first.y, second.x, second.y);
      gl.uniform2f(uniform('angles'), first.angle, second.angle);
      gl.uniform1f(uniform('size'), view.size);
      gl.uniform1f(uniform('brightness'), view.brightness);
      gl.uniform3f(uniform('tint'), ...this.tint);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
