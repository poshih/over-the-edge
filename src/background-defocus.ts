import {
  BufferGeometry, Color, DepthTexture, Float32BufferAttribute, HalfFloatType, Matrix3, Mesh, NoBlending, OrthographicCamera,
  ShaderMaterial, SRGBColorSpace, UnsignedByteType, Vector2, Vector3, WebGLRenderTarget,
} from 'three';
import type { Fog, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import type { GameTheme } from './theme';

// The background's depth of field, the theme camera's blur. Whatever lies nearer than the blur start draws to the
// screen as ever. What lies behind it draws first, into an offscreen image with its depth; that image is shown as the
// screen would show it, tone-mapped and encoded over the sky, blurred by how deep each point lies, and drawn to the
// screen before the nearer part draws over it. Moving the camera's near or far plane to the blur start leaves each part
// only what reaches its side, and the nearer part reaches a little past it, so no seam opens where an object crosses
// it. The blur works on a small copy of the image, so it looks the same at any size. Off, nothing is drawn offscreen or
// allocated.
const DEFOCUS = {
  // Lines of the small copy the blur works on, at most.
  lines: 360,
  // Samples each side of a pixel in each of the two blur passes, spread over the blur's radius.
  taps: 12,
  // The offscreen image's multisampling, matching the screen's antialiasing.
  samples: 4,
  // Pixels, measured at the blur start, that the sharp part reaches past it over the blurred part: behind its cut the
  // blurred part then holds the same surface, even where the surface turns steeply from the camera.
  overlap: 16,
  // Bilinear samples across each side of the block of the image's pixels that makes one pixel of the small copy, at most.
  gather: 8,
} as const;

// three.js's ACES filmic tone mapping, the view's (tonemapping_pars_fragment): exposure over 0.6, the input matrix,
// the RRT and ODT fit, then the output matrix. Its GLSL matrices are column-major; these rows are their columns.
const ACES_INPUT_INVERSE = new Matrix3().set(
  0.59719, 0.35458, 0.04823,
  0.07600, 0.90834, 0.01566,
  0.02840, 0.13383, 0.83777,
).invert();
const ACES_OUTPUT_INVERSE = new Matrix3().set(
  1.60475, -0.53108, -0.07367,
  -0.10208, 1.10813, -0.00605,
  -0.00327, -0.07276, 1.07602,
).invert();

// The input to the RRT and ODT fit that gives `y`: the positive root of
// (1 - 0.983729y)v² + (0.0245786 - 0.432951y)v - (0.000090537 + 0.238081y) = 0, for y within what the fit reaches.
function unfit(y: number): number {
  const target = Math.min(Math.max(y, 0), 1);
  const a = 1 - 0.983729 * target, b = 0.0245786 - 0.432951 * target, c = -(0.000090537 + 0.238081 * target);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

// The height in metres one of `lines` lines of the view covers `at` metres from the camera.
function pixelHeight(camera: PerspectiveCamera | OrthographicCamera, at: number, lines: number): number {
  const height = (camera as PerspectiveCamera).isPerspectiveCamera === true
    ? 2 * at * Math.tan((camera as PerspectiveCamera).getEffectiveFOV() * Math.PI / 360)
    : ((camera as OrthographicCamera).top - (camera as OrthographicCamera).bottom) / camera.zoom;
  return height / lines;
}

// The light that the tone mapping shows as `shown`, a linear colour, written into `shown`.
function untoneMap(shown: Color, exposure: number, scratch: Vector3): void {
  scratch.set(shown.r, shown.g, shown.b).applyMatrix3(ACES_OUTPUT_INVERSE);
  scratch.set(unfit(scratch.x), unfit(scratch.y), unfit(scratch.z)).applyMatrix3(ACES_INPUT_INVERSE)
    .multiplyScalar(0.6 / exposure);
  shown.setRGB(Math.max(0, scratch.x), Math.max(0, scratch.y), Math.max(0, scratch.z));
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// What the offscreen image shows at a point: its colour as the screen shows it, tone-mapped (the view's ACES filmic)
// and encoded over the sky; its distance from the camera, the far plane where it shows nothing; and how blurred it is,
// from the blur start to the full-blur depth.
const SHOWN = /* glsl */ `
#include <packing>
#include <tonemapping_pars_fragment>
uniform sampler2D sceneColor;
uniform sampler2D sceneDepth;
uniform vec2 imageTexel;
uniform float cameraNear;
uniform float cameraFar;
uniform float perspective;
uniform vec3 skyColor;
uniform float planeDistance;
uniform float blurNear;
uniform float blurFar;
vec3 shown(vec2 uv) {
  vec4 color = texture2D(sceneColor, uv);
  // Additive blending can count coverage past whole.
  float coverage = min(color.a, 1.0);
  if (coverage <= 0.0) return skyColor;
  vec3 screen = sRGBTransferOETF(vec4(ACESFilmicToneMapping(color.rgb / coverage), 1.0)).rgb;
  return mix(skyColor, screen, coverage);
}
float viewDepth(vec2 uv) {
  float depth = texture2D(sceneDepth, uv).x;
  return perspective > 0.5 ? -perspectiveDepthToViewZ(depth, cameraNear, cameraFar)
    : -orthographicDepthToViewZ(depth, cameraNear, cameraFar);
}
float defocus(float depth) {
  return smoothstep(blurNear, blurFar, depth - planeDistance);
}
`;

// The small copy, each colour weighted by how blurred it is, so what stays sharp never bleeds into what blurs. Each of
// its pixels averages the block of the image's pixels it covers: `gather` bilinear samples a side, `stepping` apart.
const PREFILTER = /* glsl */ `
uniform int gather;
uniform vec2 stepping;
varying vec2 vUv;
${SHOWN}
vec4 weighted(vec2 uv) {
  float amount = defocus(viewDepth(uv));
  return vec4(shown(uv) * amount, amount);
}
void main() {
  vec4 sum = vec4(0.0);
  float middle = float(gather - 1) * 0.5;
  for (int x = 0; x < ${DEFOCUS.gather}; x++) {
    if (x >= gather) break;
    for (int y = 0; y < ${DEFOCUS.gather}; y++) {
      if (y >= gather) break;
      sum += weighted(vUv + (vec2(float(x), float(y)) - middle) * stepping);
    }
  }
  gl_FragColor = sum / float(gather * gather);
}
`;

// One direction of a Gaussian blur, its radius three standard deviations.
const BLUR = /* glsl */ `
uniform sampler2D source;
uniform vec2 stride;
varying vec2 vUv;
void main() {
  vec4 sum = texture2D(source, vUv);
  float total = 1.0;
  for (int tap = 1; tap <= ${DEFOCUS.taps}; tap++) {
    float weight = exp(-4.5 * float(tap * tap) / ${DEFOCUS.taps * DEFOCUS.taps}.0);
    vec2 offset = stride * float(tap);
    sum += (texture2D(source, vUv + offset) + texture2D(source, vUv - offset)) * weight;
    total += 2.0 * weight;
  }
  gl_FragColor = sum / total;
}
`;

// The background as the screen shows it: sharp where it is in focus, blurred where it is not. Each pixel takes the
// blur of the nearest point around it, so an antialiased edge keeps its object's focus. It is already encoded.
const COMPOSITE = /* glsl */ `
uniform sampler2D blurred;
varying vec2 vUv;
${SHOWN}
void main() {
  float depth = viewDepth(vUv);
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) depth = min(depth, viewDepth(vUv + vec2(float(x), float(y)) * imageTexel));
  }
  vec3 sharp = shown(vUv);
  vec4 soft = texture2D(blurred, vUv);
  gl_FragColor = vec4(soft.a > 0.0001 ? mix(sharp, soft.rgb / soft.a, defocus(depth)) : sharp, 1.0);
}
`;

// Every pass writes each pixel once, unblended. None is tone-mapped by three.js: SHOWN tone-maps itself.
function pass(fragmentShader: string, uniforms: ShaderMaterial['uniforms']): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERTEX, fragmentShader, uniforms,
    toneMapped: false, blending: NoBlending, depthTest: false, depthWrite: false,
  });
}

/** Blurs the background by its depth behind the course plane, as the backdrop and the course draw. */
export class BackgroundDefocus {
  private image: WebGLRenderTarget | null = null;
  private small: readonly [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  private readonly size = new Vector2();
  private readonly clearColor = new Color();
  private readonly fogColor = new Color();
  private readonly scratch = new Vector3();
  private readonly quad: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly screen = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly shown = {
    sceneColor: { value: null as Texture | null }, sceneDepth: { value: null as Texture | null }, imageTexel: { value: new Vector2() },
    cameraNear: { value: 0 }, cameraFar: { value: 1 }, perspective: { value: 0 }, skyColor: { value: new Color() },
    planeDistance: { value: 0 }, blurNear: { value: 0 }, blurFar: { value: 1 },
  };
  private readonly prefilter: ShaderMaterial;
  private readonly blur: ShaderMaterial;
  private readonly composite: ShaderMaterial;

  constructor() {
    // One triangle covering the screen.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    // The prefilter and the composite share the same uniform objects.
    this.prefilter = pass(PREFILTER, { ...this.shown, gather: { value: 1 }, stepping: { value: new Vector2() } });
    this.blur = pass(BLUR, { source: { value: null }, stride: { value: new Vector2() } });
    this.composite = pass(COMPOSITE, { ...this.shown, blurred: { value: null } });
    this.quad = new Mesh(geometry, this.composite);
    this.quad.frustumCulled = false;
  }

  /**
   * Draws the backdrop and the course with `draw`, which renders them to the current target: the part behind the blur
   * start blurred by its depth, the nearer part sharp. The view's fog colour, the camera's near and far planes and the
   * renderer's clear colour and target are restored. `distance` is the camera's from the course plane.
   */
  render(renderer: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera, fog: Fog, distance: number,
    settings: GameTheme['camera'], draw: () => void): void {
    const near = camera.near, far = camera.far;
    const split = Math.min(Math.max(distance + settings.blurNear, near), far);
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    this.fogColor.copy(fog.color);
    try {
      const { image, small } = this.prepare(renderer);
      // Behind the blur start, offscreen over nothing. Materials mix fog in before the image is tone-mapped, so the fog
      // colour there is the light the tone mapping shows as the fog: the fully fogged meets the sky as on the screen.
      camera.near = split;
      camera.updateProjectionMatrix();
      untoneMap(fog.color, renderer.toneMappingExposure, this.scratch);
      renderer.setRenderTarget(image);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.setClearColor(this.clearColor, clearAlpha);
      draw();
      fog.color.copy(this.fogColor);
      this.blurBackground(renderer, camera, distance, settings, split, far, small);
      // In front of it, sharp on the screen as ever, over the blurred background.
      camera.near = near;
      camera.far = Math.min(split + DEFOCUS.overlap * pixelHeight(camera, split, image.height), far);
      camera.updateProjectionMatrix();
      draw();
    } finally {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
      fog.color.copy(this.fogColor);
      renderer.setRenderTarget(null);
      renderer.setClearColor(this.clearColor, clearAlpha);
    }
  }

  // Frees the offscreen images, as while the blur is off.
  release(): void {
    this.image?.dispose();
    for (const target of this.small ?? []) target.dispose();
    this.image = null;
    this.small = null;
    this.shown.sceneColor.value = null;
    this.shown.sceneDepth.value = null;
  }

  dispose(): void {
    this.release();
    this.quad.geometry.dispose();
    for (const material of [this.prefilter, this.blur, this.composite]) material.dispose();
  }

  // The offscreen images at the screen's size, made or remade when it changes.
  private prepare(renderer: WebGLRenderer): { image: WebGLRenderTarget; small: readonly [WebGLRenderTarget, WebGLRenderTarget] } {
    renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, this.size.x), height = Math.max(1, this.size.y);
    if (this.image !== null && this.small !== null && this.image.width === width && this.image.height === height) {
      return { image: this.image, small: this.small };
    }
    this.release();
    // Half floats keep the light above white until it is tone-mapped; without them, sRGB bytes keep the darks smooth.
    const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    const image = new WebGLRenderTarget(width, height, {
      ...(hdr ? { type: HalfFloatType } : { type: UnsignedByteType, colorSpace: SRGBColorSpace }),
      samples: DEFOCUS.samples, depthTexture: new DepthTexture(width, height),
    });
    // The small copy is already encoded, but weighting by blur needs more than bytes where little blurs.
    const scale = Math.max(1, height / DEFOCUS.lines);
    const smallWidth = Math.max(1, Math.round(width / scale)), smallHeight = Math.max(1, Math.round(height / scale));
    const copy = (): WebGLRenderTarget =>
      new WebGLRenderTarget(smallWidth, smallHeight, { type: hdr ? HalfFloatType : UnsignedByteType, depthBuffer: false });
    const small = [copy(), copy()] as const;
    this.image = image;
    this.small = small;
    this.shown.sceneColor.value = image.texture;
    this.shown.sceneDepth.value = image.depthTexture;
    this.shown.imageTexel.value.set(1 / width, 1 / height);
    // Each bilinear sample averages up to 2 by 2 pixels; spread evenly, they cover the whole block.
    const blockWidth = width / smallWidth, blockHeight = height / smallHeight;
    const gather = Math.min(DEFOCUS.gather, Math.ceil(Math.max(blockWidth, blockHeight) / 2));
    this.prefilter.uniforms.gather.value = gather;
    this.prefilter.uniforms.stepping.value.set(blockWidth / gather / width, blockHeight / gather / height);
    return { image, small };
  }

  // Shows the offscreen image on the screen, blurred by depth: the small copy, blurred both ways, then the composite.
  private blurBackground(renderer: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera, distance: number,
    settings: GameTheme['camera'], near: number, far: number, small: readonly [WebGLRenderTarget, WebGLRenderTarget]): void {
    const shown = this.shown;
    shown.cameraNear.value = near;
    shown.cameraFar.value = far;
    shown.perspective.value = (camera as PerspectiveCamera).isPerspectiveCamera === true ? 1 : 0;
    // The clear colour is the sky, which the screen shows encoded.
    this.clearColor.getRGB(shown.skyColor.value, SRGBColorSpace);
    shown.planeDistance.value = distance;
    shown.blurNear.value = settings.blurNear;
    shown.blurFar.value = settings.blurFar;
    this.draw(renderer, this.prefilter, small[0]);
    // The blur's radius is a share of the view's height.
    const step = settings.blur / 100 * small[0].height / DEFOCUS.taps;
    this.blur.uniforms.source.value = small[0].texture;
    this.blur.uniforms.stride.value.set(step / small[0].width, 0);
    this.draw(renderer, this.blur, small[1]);
    this.blur.uniforms.source.value = small[1].texture;
    this.blur.uniforms.stride.value.set(0, step / small[0].height);
    this.draw(renderer, this.blur, small[0]);
    this.composite.uniforms.blurred.value = small[0].texture;
    this.draw(renderer, this.composite, null);
  }

  private draw(renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.quad, this.screen);
  }
}
