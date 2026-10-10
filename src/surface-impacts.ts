import {
  AdditiveBlending, Color, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4,
  MeshStandardMaterial, OctahedronGeometry, PlaneGeometry, ShaderMaterial, TetrahedronGeometry, UniformsLib, UniformsUtils,
  Vector3,
} from 'three';
import type { BufferAttribute, BufferGeometry, Material } from 'three';
import { between, seeded, VALUE_NOISE } from './effect-noise';
import type { MomentEffect } from './effects';
import { angleDifference, clamp } from './math';
import type { ImpactMoment, Moment } from './moments';
import { OBSTACLE_LINE } from './obstacle-line';
import type { SceneFrame } from './scene-frame';
import { SURFACES } from './surfaces';
import type { Surface } from './surfaces';

// Where the hammer head strikes terrain or a platform, the blow shows what it struck, lit by the scene's light as the
// characters are. Rock spits stone chips and grit into a cloud of dust, sparking off a hard blow; wood throws splinters
// in a puff of sawdust; metal flashes and showers sparks that cool from white through orange to red as they arc and
// fall; ice breaks into glossy shards in drifting frost that glints; and rubber, taking the blow, only puffs dust out
// along its face. Debris and dust leave the struck face, leaning the way a glancing blow carries on, and sparks glance
// off along the head's reflected path. A harder blow throws more, farther: debris and dust by how squarely it lands too,
// sparks by its speed alone, so a fast scrape along metal still showers them. Strikes on enemies show nothing here; the
// strikes effect draws those.
const IMPACT = {
  // Impacts showing at once; a new one takes the oldest's place.
  count: 10,
  // The most of each kind one impact throws: debris, dust puffs, sparks, and glows, its flash and glints.
  debris: 12, dust: 5, sparks: 34, glows: 10,
  // Debris, sparks and the flash leave from this far off the struck face, in metres, dust and glints from farther out.
  lift: 0.03, dustLift: [0.05, 0.13], glintLift: 0.08,
  // How far along the face, either way, debris, dust and glints start from where it was struck.
  debrisAlong: 0.04, dustAlong: 0.08, glintAlong: 0.12,
  // Where each starts in front of the obstacle line, toward the camera, in metres, and how fast it moves toward the
  // camera, as a share of its speed for debris and sparks and in metres a second for dust.
  front: [0.02, 0.14], dustFront: [0.05, 0.25], debrisDepth: [-0.1, 0.45], sparkDepth: [-0.15, 0.35], dustDepth: [0, 0.3],
  // How far from straight out of the face anything may leave, in radians, so nothing flies into it.
  maxLean: 1.35,
  gravity: 9.8,
  // Dust and glints: how fast the air slows them (/s), and how fast a puff grows to its full size (/s). Puffs thicken in
  // over `dustIn` seconds.
  dustDrag: 3.2, dustGrowth: 3, dustIn: 0.05,
  // Sparks: how fast the air slows them (/s), their width in metres, and how many seconds of flight each streak shows.
  sparkDrag: 1.8, sparkWidth: [0.022, 0.034], streak: 0.022,
  // Debris shrinks away over this last share of its life.
  shrink: 0.3,
} as const;

type Range = readonly [number, number];
// A colour in linear light; above 1 for glowing light.
type Rgb = readonly [number, number, number];
type DebrisShape = 'chunk' | 'splinter' | 'shard';

// Solid pieces broken off the struck face, tumbling and falling, then shrinking away. `count` runs from the softest blow
// to the hardest; each piece is about `size` metres long, `breadth` and `thickness` shares of that across, and leaves at
// `speed` (m/s), spun at `spin` (rad/s) for `life` seconds. Pieces fan `spread` radians either side of their way out and
// the air slows them at `drag` (/s). Each one's colour lies between `dark` and `light`; their material is `roughness`
// rough, `opacity` see-through, and glows `glow` from within.
interface DebrisLook {
  readonly shape: DebrisShape;
  readonly count: Range; readonly size: Range; readonly breadth: Range; readonly thickness: Range;
  readonly speed: Range; readonly life: Range; readonly spin: Range; readonly spread: number; readonly drag: number;
  readonly dark: Rgb; readonly light: Rgb; readonly roughness: number; readonly opacity: number; readonly glow: Rgb;
}

// Soft puffs billowing from the struck face, growing from `size` to `grown` metres across while they thin away. They fan
// `spread` radians either side of straight out, or with `sideways` leave along the face both ways, and rise at `rise`
// (m/s², below zero they settle). `opacity` is their thickest and `albedo` the colour light shows them in.
interface DustLook {
  readonly count: Range; readonly size: Range; readonly grown: Range; readonly speed: Range; readonly life: Range;
  readonly spread: number; readonly sideways: boolean; readonly rise: number; readonly opacity: number; readonly albedo: Rgb;
}

// Glowing sparks, streaked along their flight, from blows at least `from` strong: `count` runs from such a blow to the
// hardest. `heat` is how hot they start, 1 white.
interface SparkLook {
  readonly from: number; readonly count: Range; readonly speed: Range; readonly life: Range; readonly heat: number;
}

// A hot flash where the head struck, from blows at least `from` strong, `size` metres across at most.
interface FlashLook { readonly from: number; readonly size: number; readonly life: number; readonly color: Rgb }

// Glints twinkling in the dust, such as light catching frost: each waits `delay` seconds, then twinkles for `life`, drifting
// out at `speed` within `spread` radians either side of straight out, rising at `rise` (m/s²).
interface GlintLook {
  readonly count: Range; readonly size: Range; readonly delay: Range; readonly life: Range; readonly speed: Range;
  readonly spread: number; readonly rise: number; readonly color: Rgb;
}

interface SurfaceLook {
  readonly debris: DebrisLook | null;
  readonly dust: DustLook | null;
  readonly sparks: SparkLook | null;
  readonly flash: FlashLook | null;
  readonly glints: GlintLook | null;
}

const LOOK: Readonly<Record<Surface, SurfaceLook>> = {
  rock: {
    debris: {
      shape: 'chunk', count: [2, 11], size: [0.03, 0.11], breadth: [0.65, 1], thickness: [0.5, 0.85], speed: [1.4, 5.5],
      life: [0.45, 0.9], spin: [4, 15], spread: 0.8, drag: 0.5,
      dark: [0.03, 0.028, 0.026], light: [0.16, 0.145, 0.125], roughness: 0.95, opacity: 1, glow: [0, 0, 0],
    },
    dust: {
      count: [2, 5], size: [0.2, 0.34], grown: [0.65, 1.15], speed: [0.3, 1.2], life: [0.9, 1.7], spread: 1.35,
      sideways: false, rise: 0.3, opacity: 0.5, albedo: [0.3, 0.27, 0.235],
    },
    sparks: { from: 0.45, count: [1, 6], speed: [2.5, 7], life: [0.1, 0.3], heat: 0.8 },
    flash: { from: 0.6, size: 0.32, life: 0.05, color: [1.3, 0.75, 0.38] },
    glints: null,
  },
  wood: {
    debris: {
      shape: 'splinter', count: [2, 9], size: [0.05, 0.16], breadth: [0.08, 0.14], thickness: [0.12, 0.22], speed: [1.3, 5],
      life: [0.5, 0.95], spin: [8, 24], spread: 0.9, drag: 1.3,
      dark: [0.09, 0.05, 0.025], light: [0.4, 0.26, 0.12], roughness: 0.85, opacity: 1, glow: [0, 0, 0],
    },
    dust: {
      count: [1, 4], size: [0.15, 0.26], grown: [0.45, 0.85], speed: [0.3, 1.1], life: [0.7, 1.3], spread: 1.2,
      sideways: false, rise: 0.15, opacity: 0.4, albedo: [0.4, 0.29, 0.17],
    },
    sparks: null,
    flash: null,
    glints: null,
  },
  metal: {
    debris: null,
    // A faint wisp of smoke off the struck steel.
    dust: {
      count: [0, 2], size: [0.12, 0.2], grown: [0.35, 0.6], speed: [0.15, 0.5], life: [0.6, 1.1], spread: 1,
      sideways: false, rise: 0.45, opacity: 0.22, albedo: [0.12, 0.12, 0.13],
    },
    sparks: { from: 0, count: [8, 34], speed: [3.5, 12], life: [0.25, 0.8], heat: 1 },
    flash: { from: 0, size: 0.75, life: 0.08, color: [2.4, 1.9, 1.3] },
    glints: null,
  },
  ice: {
    debris: {
      shape: 'shard', count: [3, 12], size: [0.03, 0.1], breadth: [0.5, 0.85], thickness: [0.18, 0.32], speed: [1.4, 5.5],
      life: [0.5, 0.95], spin: [6, 18], spread: 0.85, drag: 0.7,
      dark: [0.36, 0.52, 0.68], light: [0.72, 0.85, 0.97], roughness: 0.15, opacity: 0.82, glow: [0.025, 0.05, 0.08],
    },
    // Frost powder, settling.
    dust: {
      count: [2, 4], size: [0.16, 0.28], grown: [0.5, 0.95], speed: [0.3, 1.1], life: [0.7, 1.3], spread: 1.3,
      sideways: false, rise: -0.35, opacity: 0.42, albedo: [0.66, 0.75, 0.86],
    },
    sparks: null,
    flash: null,
    glints: {
      count: [3, 9], size: [0.07, 0.16], delay: [0.02, 0.6], life: [0.12, 0.3], speed: [0.3, 1.1], spread: 1.3, rise: -0.35,
      color: [1.4, 1.75, 2.2],
    },
  },
  rubber: {
    debris: null,
    // Dust squeezed out along the face as the head sinks in.
    dust: {
      count: [1, 2], size: [0.12, 0.2], grown: [0.35, 0.6], speed: [0.35, 0.9], life: [0.5, 0.9], spread: 0.25,
      sideways: true, rise: 0.1, opacity: 0.3, albedo: [0.08, 0.075, 0.07],
    },
    sparks: null,
    flash: null,
    glints: null,
  },
};

// Every particle's birth values start alike, `stride` floats apiece: where it leaves from, its velocity and its life.
const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, LIFE = 6;
// Then each kind's own. A debris piece's `shade` places its colour between its look's dark and light.
const DEBRIS = {
  length: 7, breadth: 8, thickness: 9, axisX: 10, axisY: 11, axisZ: 12, angle: 13, spin: 14, shade: 15, stride: 16,
} as const;
const DUST = { size: 7, grown: 8, angle: 9, spin: 10, opacity: 11, seed: 12, shade: 13, stride: 14 } as const;
const SPARK = { width: 7, heat: 8, stride: 9 } as const;
// A glow is the flash or, with `twinkle` 1, a glint.
const GLOW = { delay: 7, size: 8, angle: 9, brightness: 10, twinkle: 11, stride: 12 } as const;

// Quads lit by a colour each, from an instance attribute.
const TINTED_VERTEX = /* glsl */ `
attribute vec3 tint;
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vUv = uv;
  vTint = tint;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

// A streak along the quad's x, bright and round at its head and fading along its tail.
const SPARK_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vec2 p = vUv - 0.5;
  float across = 1.0 - smoothstep(0.0, 0.5, abs(p.y));
  float head = 1.0 - smoothstep(0.25, 0.5, p.x);
  float tail = smoothstep(-0.5, 0.25, p.x);
  gl_FragColor = vec4(vTint * across * across * head * tail, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// A bloom with a hot core and a four-pointed glint.
const GLOW_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vec2 p = vUv - 0.5;
  float d = length(p) * 2.0;
  float bloom = pow(max(0.0, 1.0 - d), 3.0);
  float core = pow(max(0.0, 1.0 - d * 3.0), 2.0);
  float rays = max(0.0, 1.0 - abs(p.y) * 30.0) * max(0.0, 1.0 - abs(p.x) * 2.0)
    + max(0.0, 1.0 - abs(p.x) * 30.0) * max(0.0, 1.0 - abs(p.y) * 2.0);
  gl_FragColor = vec4(vTint * (bloom * 0.7 + core * 1.6 + rays * 0.8), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DUST_VERTEX = /* glsl */ `
#include <fog_pars_vertex>
attribute vec3 tint;
attribute vec3 puff;
varying vec2 vUv;
varying vec2 vFacing;
varying vec3 vTint;
varying vec3 vPuff;
void main() {
  vUv = uv;
  // Where on the puff this corner lies, -1 to 1 across it, in view space whatever way the puff has spun, so the scene's
  // lights, given in view space, light every puff from the same side.
  vFacing = (modelViewMatrix * instanceMatrix * vec4(position.xy * 2.0, 0.0, 0.0)).xy / length(instanceMatrix[0].xyz);
  vTint = tint;
  vPuff = puff;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// A puff filling a circle on its quad, its rim eaten into billows that roll on as it ages (puff: opacity, seed, age).
// The scene lights it as a ball of dust, rounded toward the camera and swelling where it billows, with the sunlight
// wrapping past its shadowed side as dust scatters it.
const DUST_FRAGMENT = /* glsl */ `
#include <common>
#include <lights_pars_begin>
#include <fog_pars_fragment>
varying vec2 vUv;
varying vec2 vFacing;
varying vec3 vTint;
varying vec3 vPuff;
${VALUE_NOISE}
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  vec2 roll = vec2(vPuff.y * 41.0, vPuff.y * 17.0 - vPuff.z * 0.5);
  float billow = fbm(p * 1.6 + roll);
  float density = 1.0 - smoothstep(0.25, 1.0, length(p) + (billow - 0.5) * 0.8);
  density *= 0.55 + 0.9 * fbm(p * 3.3 - roll * 1.3);
  float alpha = clamp(density, 0.0, 1.0) * vPuff.x;
  if (alpha < 0.003) discard;
  vec3 normal = normalize(vec3(vFacing * 0.85,
    0.55 + sqrt(max(0.0, 1.0 - dot(vFacing, vFacing))) + (billow - 0.5) * 0.6));
  vec3 irradiance = getAmbientLightIrradiance(ambientLightColor);
  #if NUM_HEMI_LIGHTS > 0
    #pragma unroll_loop_start
    for (int i = 0; i < NUM_HEMI_LIGHTS; i++) {
      irradiance += getHemisphereLightIrradiance(hemisphereLights[ i ], normal);
    }
    #pragma unroll_loop_end
  #endif
  #if NUM_DIR_LIGHTS > 0
    #pragma unroll_loop_start
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
      irradiance += directionalLights[ i ].color * saturate(dot(normal, directionalLights[ i ].direction) * 0.6 + 0.4);
    }
    #pragma unroll_loop_end
  #endif
  gl_FragColor = vec4(irradiance * BRDF_Lambert(vTint), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// A unit solid with each corner pushed in or out by up to `rough` of its distance, the same every time.
function roughened(geometry: BufferGeometry, rough: number, salt: number): BufferGeometry {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const corners = new Map<string, number>();
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
    // Faces repeat their corners; each corner moves once, so the solid stays closed.
    const key = `${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`;
    let corner = corners.get(key);
    if (corner === undefined) corners.set(key, corner = corners.size);
    const scale = 1 + (seeded(corner, salt) * 2 - 1) * rough;
    position.setXYZ(index, x * scale, y * scale, z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

// Each debris shape, spanning about a unit along each axis before its pieces are sized: lumpy chunks, double-pointed
// splinters along x, angular flakes.
const SHAPES: Readonly<Record<DebrisShape, () => BufferGeometry>> = {
  chunk: () => roughened(new IcosahedronGeometry(0.59, 0), 0.3, 1),
  splinter: () => roughened(new OctahedronGeometry(0.5, 0), 0.15, 2),
  shard: () => roughened(new TetrahedronGeometry(0.87, 0), 0.25, 3),
};

// Marks the first `count` instances of `attribute` for upload, through its reused range.
function written(attribute: BufferAttribute, range: { start: number; count: number }, count: number): void {
  range.count = count * attribute.itemSize;
  attribute.updateRanges.length = 0;
  attribute.updateRanges.push(range);
  attribute.needsUpdate = true;
}

// An instanced mesh refilled each drawn frame with only what shows, uploading only what was written and drawing only
// while it shows anything.
class Batch {
  readonly mesh: InstancedMesh;
  // Each instance's colour: what light shows debris and dust in, or the light sparks and glows give.
  readonly tint: InstancedBufferAttribute;
  // Each dust puff's opacity, noise seed and age.
  readonly puff: InstancedBufferAttribute | null;
  shown = 0;
  // One upload range for each attribute, reused every frame.
  private readonly matrixRange = { start: 0, count: 0 };
  private readonly tintRange = { start: 0, count: 0 };
  private readonly puffRange = { start: 0, count: 0 };

  constructor(mesh: InstancedMesh, tint: InstancedBufferAttribute, puff: InstancedBufferAttribute | null, renderOrder: number) {
    this.mesh = mesh;
    this.tint = tint.setUsage(DynamicDrawUsage);
    this.puff = puff?.setUsage(DynamicDrawUsage) ?? null;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
  }

  finish(): void {
    this.mesh.count = this.shown;
    this.mesh.visible = this.shown > 0;
    if (this.shown === 0) return;
    written(this.mesh.instanceMatrix, this.matrixRange, this.shown);
    written(this.tint, this.tintRange, this.shown);
    if (this.puff !== null) written(this.puff, this.puffRange, this.shown);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as Material).dispose();
    this.mesh.dispose();
  }
}

// Lit and depth-tested among the actors, colour per instance.
function debrisBatch(look: DebrisLook): Batch {
  const capacity = IMPACT.count * IMPACT.debris;
  const material = new MeshStandardMaterial({
    roughness: look.roughness, metalness: 0, flatShading: true, emissive: new Color(look.glow[0], look.glow[1], look.glow[2]),
    transparent: look.opacity < 1, opacity: look.opacity,
  });
  const mesh = new InstancedMesh(SHAPES[look.shape](), material, capacity);
  const tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  mesh.instanceColor = tint;
  return new Batch(mesh, tint, null, 0);
}

// Quads facing the camera. They ignore depth, so the characters never cut them off.
function quadBatch(material: ShaderMaterial, capacity: number, renderOrder: number, puffs: boolean): Batch {
  const geometry = new PlaneGeometry(1, 1);
  const tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  geometry.setAttribute('tint', tint);
  const puff = puffs ? new InstancedBufferAttribute(new Float32Array(capacity * 3), 3) : null;
  if (puff !== null) geometry.setAttribute('puff', puff);
  return new Batch(new InstancedMesh(geometry, material, capacity), tint, puff, renderOrder);
}

function glowMaterial(fragmentShader: string): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: TINTED_VERTEX, fragmentShader, transparent: true, blending: AdditiveBlending, depthTest: false,
    depthWrite: false,
  });
}

/**
 * The engine's impacts: instanced debris for each surface that breaks, dust, sparks and glows, in the actors pass among
 * the characters, lit by its lights. Pools are fixed; each drawn frame refills only what shows, without allocating, and
 * nothing draws between impacts.
 */
export class SurfaceImpacts implements MomentEffect {
  readonly root = new Group();
  readonly pass = 'actors';
  readonly moments = Object.freeze(['impact', 'placed'] as const);
  private readonly debrisBatches: Readonly<Partial<Record<Surface, Batch>>>;
  private readonly dustBatch: Batch;
  private readonly sparkBatch: Batch;
  private readonly glowBatch: Batch;
  private readonly batches: readonly Batch[];
  // Each slot: when it was struck in run time, -1 while its slot is free; how long it shows; what it struck; how many
  // of each kind it threw; and the order it started in, so the oldest gives way.
  private readonly born = new Float64Array(IMPACT.count).fill(-1);
  private readonly life = new Float32Array(IMPACT.count);
  private readonly surface = Array<Surface>(IMPACT.count).fill('rock');
  private readonly debrisCount = new Uint8Array(IMPACT.count);
  private readonly dustCount = new Uint8Array(IMPACT.count);
  private readonly sparkCount = new Uint8Array(IMPACT.count);
  private readonly glowCount = new Uint8Array(IMPACT.count);
  private readonly order = new Float64Array(IMPACT.count);
  // Every particle's birth values, in slots of the most each slot throws.
  private readonly debris = new Float32Array(IMPACT.count * IMPACT.debris * DEBRIS.stride);
  private readonly dust = new Float32Array(IMPACT.count * IMPACT.dust * DUST.stride);
  private readonly sparks = new Float32Array(IMPACT.count * IMPACT.sparks * SPARK.stride);
  private readonly glows = new Float32Array(IMPACT.count * IMPACT.glows * GLOW.stride);
  // The slot being started: where it struck, the face's outward normal, its angle and the angles debris, dust and
  // sparks leave at, the sparks' fan, how strong it was and how hard it landed, counting how squarely, and its seed.
  private readonly blow = {
    x: 0, y: 0, normalX: 0, normalY: 0, normal: 0, debris: 0, dust: 0, sparks: 0, sparkSpread: 0, strength: 0, force: 0,
    seed: 0,
  };
  // Where the particle being drawn is and its velocity on the course plane.
  private readonly at = { x: 0, y: 0, z: 0, vx: 0, vy: 0 };
  private readonly matrix = new Matrix4();
  private readonly axis = new Vector3();
  private active = 0;
  // Every slot started so far, which seeds the next one.
  private started = 0;

  constructor() {
    const batches: Batch[] = [];
    const debrisBatches: Partial<Record<Surface, Batch>> = {};
    for (const surface of SURFACES) {
      const look = LOOK[surface].debris;
      if (look === null) continue;
      const batch = debrisBatch(look);
      debrisBatches[surface] = batch;
      batches.push(batch);
    }
    this.debrisBatches = debrisBatches;
    this.dustBatch = quadBatch(new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.lights, UniformsLib.fog]), vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT, lights: true, fog: true, transparent: true, depthTest: false, depthWrite: false,
    }), IMPACT.count * IMPACT.dust, 1, true);
    this.sparkBatch = quadBatch(glowMaterial(SPARK_FRAGMENT), IMPACT.count * IMPACT.sparks, 2, false);
    this.glowBatch = quadBatch(glowMaterial(GLOW_FRAGMENT), IMPACT.count * IMPACT.glows, 3, false);
    // Debris among the characters; then dust over it, sparks and glows over all.
    batches.push(this.dustBatch, this.sparkBatch, this.glowBatch);
    this.batches = batches;
    for (const batch of batches) this.root.add(batch.mesh);
  }

  moment(moment: Moment): void {
    if (moment.type === 'placed') {
      // A checkpoint return lets impacts finish where they were struck; a new run rewinds time, so they end.
      if (moment.bonfire === null) this.clear();
    } else if (moment.type === 'impact' && moment.surface !== null) {
      this.start(moment, moment.surface);
    }
  }

  update(frame: SceneFrame): boolean {
    for (let index = 0; index < this.batches.length; index++) this.batches[index]!.shown = 0;
    for (let slot = 0; slot < IMPACT.count; slot++) {
      const born = this.born[slot]!;
      if (born < 0) continue;
      const age = Math.max(0, frame.time - born);
      if (age >= this.life[slot]!) {
        this.end(slot);
        continue;
      }
      const look = LOOK[this.surface[slot]!];
      if (look.debris !== null) this.drawDebris(slot, age, look.debris, this.debrisBatches[this.surface[slot]!]!);
      if (look.dust !== null) this.drawDust(slot, age, look.dust);
      if (look.sparks !== null) this.drawSparks(slot, age);
      this.drawGlows(slot, age, look);
    }
    for (let index = 0; index < this.batches.length; index++) this.batches[index]!.finish();
    return this.active > 0;
  }

  dispose(): void {
    for (const batch of this.batches) batch.dispose();
  }

  private clear(): void {
    for (let slot = 0; slot < IMPACT.count; slot++) if (this.born[slot]! >= 0) this.end(slot);
    for (let index = 0; index < this.batches.length; index++) {
      const batch = this.batches[index]!;
      batch.shown = 0;
      batch.finish();
    }
  }

  private end(slot: number): void {
    this.born[slot] = -1;
    this.active--;
  }

  // Starts showing `impact` in a free slot or, with none, the oldest impact's.
  private start(impact: Readonly<ImpactMoment>, surface: Surface): void {
    let slot = 0;
    for (let index = 0; index < IMPACT.count; index++) {
      if (this.born[index]! < 0) {
        slot = index;
        break;
      }
      if (this.born[index]! < this.born[slot]! ||
        (this.born[index] === this.born[slot] && this.order[index]! < this.order[slot]!)) slot = index;
    }
    if (this.born[slot]! >= 0) this.end(slot);
    const blow = this.blow;
    const normalX = impact.normalX, normalY = impact.normalY;
    const into = impact.directionX * normalX + impact.directionY * normalY;
    const glancing = 1 - Math.min(1, Math.abs(into));
    // The head's path reflected off the face, which a glancing blow's debris leans along and sparks glance off along.
    const reflectedX = impact.directionX - 2 * into * normalX, reflectedY = impact.directionY - 2 * into * normalY;
    const lean = 0.2 + 0.5 * glancing;
    blow.x = impact.x;
    blow.y = impact.y;
    blow.normalX = normalX;
    blow.normalY = normalY;
    blow.normal = Math.atan2(normalY, normalX);
    blow.debris = Math.atan2(normalY + reflectedY * lean, normalX + reflectedX * lean);
    blow.dust = Math.atan2(normalY + reflectedY * 0.3, normalX + reflectedX * 0.3);
    blow.sparks = Math.atan2(reflectedY, reflectedX);
    // A square blow splashes its sparks wide; a glancing one sprays them in a stream.
    blow.sparkSpread = 0.3 + 0.6 * (1 - glancing);
    blow.strength = impact.strength;
    blow.force = impact.strength * (0.35 + 0.65 * (1 - glancing));
    blow.seed = this.started++ * 131;
    const look = LOOK[surface];
    this.born[slot] = impact.time;
    this.life[slot] = Math.max(this.throwDebris(slot, look.debris), this.throwDust(slot, look.dust),
      this.throwSparks(slot, look.sparks), this.throwGlows(slot, look));
    this.surface[slot] = surface;
    this.order[slot] = blow.seed;
    this.active++;
  }

  // `angle`, turned back to leave the struck face at least a little.
  private leave(angle: number): number {
    const normal = this.blow.normal;
    return normal + clamp(angleDifference(angle, normal), -IMPACT.maxLean, IMPACT.maxLean);
  }

  // Each `throw*` writes one impact's particles of its kind and returns how long the last of them lasts.
  private throwDebris(slot: number, look: DebrisLook | null): number {
    this.debrisCount[slot] = 0;
    if (look === null) return 0;
    const blow = this.blow, birth = this.debris;
    const count = Math.min(IMPACT.debris, Math.round(between(look.count, blow.force)));
    this.debrisCount[slot] = count;
    let longest = 0;
    for (let piece = 0; piece < count; piece++) {
      const random = blow.seed + piece, at = (slot * IMPACT.debris + piece) * DEBRIS.stride;
      const angle = this.leave(blow.debris + (seeded(random, 1) * 2 - 1) * look.spread);
      const speed = between(look.speed, seeded(random, 2)) * (0.55 + 0.45 * blow.force);
      const along = (seeded(random, 3) * 2 - 1) * IMPACT.debrisAlong;
      birth[at + X] = blow.x + blow.normalX * IMPACT.lift - blow.normalY * along;
      birth[at + Y] = blow.y + blow.normalY * IMPACT.lift + blow.normalX * along;
      birth[at + Z] = OBSTACLE_LINE + between(IMPACT.front, seeded(random, 4));
      birth[at + VX] = Math.cos(angle) * speed;
      birth[at + VY] = Math.sin(angle) * speed;
      birth[at + VZ] = speed * between(IMPACT.debrisDepth, seeded(random, 5));
      const life = between(look.life, seeded(random, 6));
      birth[at + LIFE] = life;
      // Mostly small pieces, a few large.
      birth[at + DEBRIS.length] = between(look.size, seeded(random, 7) ** 2);
      birth[at + DEBRIS.breadth] = between(look.breadth, seeded(random, 8));
      birth[at + DEBRIS.thickness] = between(look.thickness, seeded(random, 9));
      // An axis to tumble about, evenly over every direction.
      const axisZ = seeded(random, 10) * 2 - 1, around = seeded(random, 11) * Math.PI * 2;
      const ring = Math.sqrt(1 - axisZ * axisZ);
      birth[at + DEBRIS.axisX] = Math.cos(around) * ring;
      birth[at + DEBRIS.axisY] = Math.sin(around) * ring;
      birth[at + DEBRIS.axisZ] = axisZ;
      birth[at + DEBRIS.angle] = seeded(random, 12) * Math.PI * 2;
      birth[at + DEBRIS.spin] = between(look.spin, seeded(random, 13)) * (seeded(random, 14) < 0.5 ? -1 : 1);
      birth[at + DEBRIS.shade] = seeded(random, 15);
      longest = Math.max(longest, life);
    }
    return longest;
  }

  private throwDust(slot: number, look: DustLook | null): number {
    this.dustCount[slot] = 0;
    if (look === null) return 0;
    const blow = this.blow, birth = this.dust;
    const count = Math.min(IMPACT.dust, Math.round(between(look.count, blow.force)));
    this.dustCount[slot] = count;
    let longest = 0;
    for (let puff = 0; puff < count; puff++) {
      const random = blow.seed + puff, at = (slot * IMPACT.dust + puff) * DUST.stride;
      const fan = (seeded(random, 21) * 2 - 1) * look.spread;
      // Sideways puffs leave along the face, the first one way and the next the other.
      const angle = this.leave(look.sideways ? blow.normal + (puff % 2 === 0 ? 1 : -1) * IMPACT.maxLean + fan : blow.dust + fan);
      const speed = between(look.speed, seeded(random, 22)) * (0.6 + 0.4 * blow.force);
      const along = (seeded(random, 23) * 2 - 1) * IMPACT.dustAlong;
      const lift = between(IMPACT.dustLift, seeded(random, 24));
      birth[at + X] = blow.x + blow.normalX * lift - blow.normalY * along;
      birth[at + Y] = blow.y + blow.normalY * lift + blow.normalX * along;
      birth[at + Z] = OBSTACLE_LINE + between(IMPACT.dustFront, seeded(random, 25));
      birth[at + VX] = Math.cos(angle) * speed;
      birth[at + VY] = Math.sin(angle) * speed;
      birth[at + VZ] = between(IMPACT.dustDepth, seeded(random, 26));
      const life = between(look.life, seeded(random, 27)) * (0.8 + 0.2 * blow.force);
      birth[at + LIFE] = life;
      birth[at + DUST.size] = between(look.size, seeded(random, 28)) * (0.75 + 0.25 * blow.force);
      birth[at + DUST.grown] = between(look.grown, seeded(random, 29)) * (0.7 + 0.3 * blow.force);
      birth[at + DUST.angle] = seeded(random, 30) * Math.PI * 2;
      birth[at + DUST.spin] = (seeded(random, 31) * 2 - 1) * 0.5;
      birth[at + DUST.opacity] = look.opacity * (0.6 + 0.4 * blow.force) * (0.75 + 0.25 * seeded(random, 32));
      birth[at + DUST.seed] = seeded(random, 33);
      birth[at + DUST.shade] = 0.88 + 0.24 * seeded(random, 34);
      longest = Math.max(longest, life);
    }
    return longest;
  }

  private throwSparks(slot: number, look: SparkLook | null): number {
    this.sparkCount[slot] = 0;
    if (look === null || this.blow.strength < look.from) return 0;
    const blow = this.blow, birth = this.sparks;
    // How far past its threshold the blow was, 0-1.
    const power = look.from >= 1 ? 1 : (blow.strength - look.from) / (1 - look.from);
    const count = Math.min(IMPACT.sparks, Math.round(between(look.count, power)));
    this.sparkCount[slot] = count;
    let longest = 0;
    for (let spark = 0; spark < count; spark++) {
      const random = blow.seed + spark, at = (slot * IMPACT.sparks + spark) * SPARK.stride;
      const angle = this.leave(blow.sparks + (seeded(random, 41) * 2 - 1) * blow.sparkSpread);
      const speed = between(look.speed, seeded(random, 42)) * (0.6 + 0.4 * power);
      birth[at + X] = blow.x + blow.normalX * IMPACT.lift;
      birth[at + Y] = blow.y + blow.normalY * IMPACT.lift;
      birth[at + Z] = OBSTACLE_LINE + between(IMPACT.front, seeded(random, 43));
      birth[at + VX] = Math.cos(angle) * speed;
      birth[at + VY] = Math.sin(angle) * speed;
      birth[at + VZ] = speed * between(IMPACT.sparkDepth, seeded(random, 44));
      const life = between(look.life, seeded(random, 45));
      birth[at + LIFE] = life;
      birth[at + SPARK.width] = between(IMPACT.sparkWidth, seeded(random, 46));
      birth[at + SPARK.heat] = look.heat * (0.8 + 0.2 * seeded(random, 47));
      longest = Math.max(longest, life);
    }
    return longest;
  }

  // The flash first, then the glints.
  private throwGlows(slot: number, look: SurfaceLook): number {
    const blow = this.blow, birth = this.glows;
    let count = 0, longest = 0;
    const flash = look.flash;
    if (flash !== null && blow.strength >= flash.from) {
      const at = slot * IMPACT.glows * GLOW.stride;
      birth[at + X] = blow.x + blow.normalX * IMPACT.lift;
      birth[at + Y] = blow.y + blow.normalY * IMPACT.lift;
      birth[at + Z] = OBSTACLE_LINE + IMPACT.front[0];
      birth[at + VX] = birth[at + VY] = birth[at + VZ] = 0;
      birth[at + LIFE] = flash.life;
      birth[at + GLOW.delay] = 0;
      birth[at + GLOW.size] = flash.size * (0.6 + 0.4 * blow.strength);
      // Its rays lie along the face and straight out of it.
      birth[at + GLOW.angle] = blow.normal;
      birth[at + GLOW.brightness] = 0.6 + 0.4 * blow.strength;
      birth[at + GLOW.twinkle] = 0;
      count = 1;
      longest = flash.life;
    }
    const glints = look.glints;
    if (glints !== null) {
      const total = Math.min(IMPACT.glows, count + Math.round(between(glints.count, blow.force)));
      for (let glint = count; glint < total; glint++) {
        const random = blow.seed + glint, at = (slot * IMPACT.glows + glint) * GLOW.stride;
        const angle = this.leave(blow.normal + (seeded(random, 61) * 2 - 1) * glints.spread);
        const speed = between(glints.speed, seeded(random, 62));
        const along = (seeded(random, 63) * 2 - 1) * IMPACT.glintAlong;
        const out = IMPACT.glintLift * (0.5 + seeded(random, 64));
        birth[at + X] = blow.x + blow.normalX * out - blow.normalY * along;
        birth[at + Y] = blow.y + blow.normalY * out + blow.normalX * along;
        birth[at + Z] = OBSTACLE_LINE + between(IMPACT.dustFront, seeded(random, 65));
        birth[at + VX] = Math.cos(angle) * speed;
        birth[at + VY] = Math.sin(angle) * speed;
        birth[at + VZ] = 0;
        const delay = between(glints.delay, seeded(random, 66)), life = between(glints.life, seeded(random, 67));
        birth[at + LIFE] = life;
        birth[at + GLOW.delay] = delay;
        birth[at + GLOW.size] = between(glints.size, seeded(random, 68));
        birth[at + GLOW.angle] = seeded(random, 69) * Math.PI / 2;
        birth[at + GLOW.brightness] = 0.7 + 0.3 * seeded(random, 70);
        birth[at + GLOW.twinkle] = 1;
        longest = Math.max(longest, delay + life);
      }
      count = total;
    }
    this.glowCount[slot] = count;
    return longest;
  }

  // Where the particle whose birth values start at `birth[at]` is `age` seconds on, slowed by `drag` (/s) and pulled down
  // by `gravity` (m/s², below zero it rises), with its velocity on the course plane, into `this.at`.
  private fly(birth: Float32Array, at: number, age: number, drag: number, gravity: number): void {
    const decay = Math.exp(-drag * age), slowed = (1 - decay) / drag, fall = gravity / drag;
    const vx = birth[at + VX]!, vy = birth[at + VY]!;
    this.at.x = birth[at + X]! + vx * slowed;
    this.at.y = birth[at + Y]! + vy * slowed - fall * (age - slowed);
    this.at.z = birth[at + Z]! + birth[at + VZ]! * slowed;
    this.at.vx = vx * decay;
    this.at.vy = (vy + fall) * decay - fall;
  }

  // Pieces tumble about their axes as they fly and fall, then shrink away.
  private drawDebris(slot: number, age: number, look: DebrisLook, batch: Batch): void {
    const birth = this.debris, tint = batch.tint.array as Float32Array, elements = this.matrix.elements;
    for (let piece = 0; piece < this.debrisCount[slot]!; piece++) {
      const at = (slot * IMPACT.debris + piece) * DEBRIS.stride;
      const life = birth[at + LIFE]!;
      if (age >= life) continue;
      this.fly(birth, at, age, look.drag, IMPACT.gravity);
      const left = Math.min(1, (1 - age / life) / IMPACT.shrink);
      const length = birth[at + DEBRIS.length]! * left * (2 - left);
      const breadth = length * birth[at + DEBRIS.breadth]!, thickness = length * birth[at + DEBRIS.thickness]!;
      this.axis.set(birth[at + DEBRIS.axisX]!, birth[at + DEBRIS.axisY]!, birth[at + DEBRIS.axisZ]!);
      this.matrix.makeRotationAxis(this.axis, birth[at + DEBRIS.angle]! + birth[at + DEBRIS.spin]! * age);
      for (let row = 0; row < 3; row++) {
        elements[row] = elements[row]! * length;
        elements[4 + row] = elements[4 + row]! * breadth;
        elements[8 + row] = elements[8 + row]! * thickness;
      }
      elements[12] = this.at.x;
      elements[13] = this.at.y;
      elements[14] = this.at.z;
      const index = batch.shown++;
      batch.mesh.setMatrixAt(index, this.matrix);
      const shade = birth[at + DEBRIS.shade]!;
      for (let channel = 0; channel < 3; channel++) {
        tint[index * 3 + channel] = look.dark[channel]! + (look.light[channel]! - look.dark[channel]!) * shade;
      }
    }
  }

  // Puffs billow out fast and slow at once, spreading toward their full size as they drift, rise or settle, and thin away.
  private drawDust(slot: number, age: number, look: DustLook): void {
    const birth = this.dust, batch = this.dustBatch;
    const tint = batch.tint.array as Float32Array, puffs = batch.puff!.array as Float32Array;
    for (let puff = 0; puff < this.dustCount[slot]!; puff++) {
      const at = (slot * IMPACT.dust + puff) * DUST.stride;
      const life = birth[at + LIFE]!;
      if (age >= life) continue;
      this.fly(birth, at, age, IMPACT.dustDrag, -look.rise);
      const size = birth[at + DUST.size]! +
        (birth[at + DUST.grown]! - birth[at + DUST.size]!) * (1 - Math.exp(-IMPACT.dustGrowth * age));
      const angle = birth[at + DUST.angle]! + birth[at + DUST.spin]! * age;
      const cos = Math.cos(angle) * size, sin = Math.sin(angle) * size;
      this.matrix.set(
        cos, -sin, 0, this.at.x,
        sin, cos, 0, this.at.y,
        0, 0, 1, this.at.z,
        0, 0, 0, 1,
      );
      const index = batch.shown++;
      batch.mesh.setMatrixAt(index, this.matrix);
      const shade = birth[at + DUST.shade]!;
      tint[index * 3] = look.albedo[0] * shade;
      tint[index * 3 + 1] = look.albedo[1] * shade;
      tint[index * 3 + 2] = look.albedo[2] * shade;
      puffs[index * 3] = birth[at + DUST.opacity]! * Math.min(1, age / IMPACT.dustIn) * (1 - age / life) ** 1.5;
      puffs[index * 3 + 1] = birth[at + DUST.seed]!;
      puffs[index * 3 + 2] = age;
    }
  }

  // Sparks streak along their flight, arcing down, and cool from white through orange to red.
  private drawSparks(slot: number, age: number): void {
    const birth = this.sparks, batch = this.sparkBatch, tint = batch.tint.array as Float32Array;
    for (let spark = 0; spark < this.sparkCount[slot]!; spark++) {
      const at = (slot * IMPACT.sparks + spark) * SPARK.stride;
      const life = birth[at + LIFE]!;
      if (age >= life) continue;
      this.fly(birth, at, age, IMPACT.sparkDrag, IMPACT.gravity);
      const speed = Math.hypot(this.at.vx, this.at.vy);
      const cos = speed > 0 ? this.at.vx / speed : 1, sin = speed > 0 ? this.at.vy / speed : 0;
      const width = birth[at + SPARK.width]!;
      const length = Math.max(width * 2.5, speed * IMPACT.streak);
      // The streak's head is the spark; its tail trails behind along its flight.
      this.matrix.set(
        cos * length, -sin * width, 0, this.at.x - cos * length / 2,
        sin * length, cos * width, 0, this.at.y - sin * length / 2,
        0, 0, 1, this.at.z,
        0, 0, 0, 1,
      );
      const index = batch.shown++;
      batch.mesh.setMatrixAt(index, this.matrix);
      const heat = birth[at + SPARK.heat]! * (1 - age / life);
      const light = 4 * heat ** 1.3;
      tint[index * 3] = light;
      tint[index * 3 + 1] = light * (0.1 + 0.8 * heat ** 1.6);
      tint[index * 3 + 2] = light * 0.6 * heat ** 3;
    }
  }

  // The flash swells and fades at once; each glint drifts with the dust and twinkles once, after its delay.
  private drawGlows(slot: number, age: number, look: SurfaceLook): void {
    const birth = this.glows, batch = this.glowBatch, tint = batch.tint.array as Float32Array;
    for (let glow = 0; glow < this.glowCount[slot]!; glow++) {
      const at = (slot * IMPACT.glows + glow) * GLOW.stride;
      const shown = age - birth[at + GLOW.delay]!, life = birth[at + LIFE]!;
      if (shown < 0 || shown >= life) continue;
      const twinkles = birth[at + GLOW.twinkle] === 1;
      const color = twinkles ? look.glints!.color : look.flash!.color;
      this.fly(birth, at, age, IMPACT.dustDrag, twinkles ? -look.glints!.rise : 0);
      const progress = shown / life;
      const swell = Math.sin(Math.PI * progress);
      const size = birth[at + GLOW.size]! * (twinkles ? 0.6 + 0.4 * swell : 0.65 + 0.35 * Math.sqrt(progress));
      const brightness = birth[at + GLOW.brightness]! * (twinkles ? swell * swell : (1 - progress) ** 2);
      const angle = birth[at + GLOW.angle]!;
      const cos = Math.cos(angle) * size, sin = Math.sin(angle) * size;
      this.matrix.set(
        cos, -sin, 0, this.at.x,
        sin, cos, 0, this.at.y,
        0, 0, 1, this.at.z,
        0, 0, 0, 1,
      );
      const index = batch.shown++;
      batch.mesh.setMatrixAt(index, this.matrix);
      tint[index * 3] = color[0] * brightness;
      tint[index * 3 + 1] = color[1] * brightness;
      tint[index * 3 + 2] = color[2] * brightness;
    }
  }
}
