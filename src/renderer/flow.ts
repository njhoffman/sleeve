import type { FlowView } from './view.ts';

// --art-animation: sleeve-art-flow: the 64 px cover warped slowly by a fragment shader, drawn small and stretched, so
// the GPU cost stays low (quarter resolution at 30 fps took about half the GPU time of the CSS drift on an Iris Xe).
// Everything moving is a uniform worked out in view.ts, so a changed setting carries on from where the picture is.

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
void main() {
  vec2 p = (uv - 0.5) * aspect / zoom + 0.5;
  p += amount * 0.07 * vec2(sin(p.y * 3.1 * detail + phase * 0.11), cos(p.x * 2.7 * detail - phase * 0.09));
  p += amount * 0.04 * vec2(sin(p.y * 5.3 * detail - phase * 0.07), cos(p.x * 4.3 * detail + phase * 0.13));
  vec3 c = mix(texture(previous, p).rgb, texture(cover, p).rgb, fade);
  color = vec4(mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, saturation), 1.0);
}`;

type Uniform = 'previous' | 'cover' | 'fade' | 'phase' | 'amount' | 'detail' | 'zoom' | 'saturation' | 'aspect';

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
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    for (const name of ['previous', 'cover', 'fade', 'phase', 'amount', 'detail', 'zoom', 'saturation', 'aspect'] as const) {
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

  // Draws when the frame rate asks for one
  draw(now: number, view: FlowView): void {
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
