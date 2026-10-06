import {
  AdditiveBlending, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { HurtCause } from './hazards';
import type { HurtEffects } from './hurt-effects';
import type { SceneFrame } from './scene-layer';

// A fire that takes the character while lava burns it: tongues of flame shaded from a turbulence field, licking up the
// character, bending away from its motion and flaring at each burn, with embers rising from it, smoke above it and a
// glow about it. Lava burns once a second while the pot stays in it, so each burn keeps the fire going a little longer
// than that. While it burns, the flames grow and embers and smoke are born at the character, each living its own life in
// the world; once the burns stop, the flames die down and the last embers and smoke finish rising. A new burn grows the
// flames again from where they are and starts new embers and smoke at the base, so nothing appears mid-flight.
const FIRE = {
  // How long a burn keeps the fire going; how long the flames take to grow from nothing, and to die down.
  burn: 1.15, kindle: 0.15, fade: 0.5,
  // How much brighter a burn makes the fire for a moment, and how fast that flare fades, in seconds.
  flare: 0.35, flareFade: 0.18,
  // The flames: each one's offset from the character's root, its width and height, all in metres.
  flames: [
    { x: 0, y: -0.48, width: 1.2, height: 1.95 },
    { x: -0.3, y: -0.42, width: 0.85, height: 1.4 },
    { x: 0.32, y: -0.44, width: 0.9, height: 1.5 },
    { x: -0.16, y: -0.52, width: 0.62, height: 0.95 },
    { x: 0.2, y: -0.52, width: 0.6, height: 0.9 },
  ],
  // Embers and smoke: how many can show at once, how many are born a second at the fire's height, and each one's
  // life, rise and size, in seconds and metres, picked per particle.
  embers: 28, emberRate: 24, emberLife: [0.7, 1.3], emberRise: [1.3, 2.3], emberSize: [0.035, 0.07],
  smoke: 10, smokeRate: 5.5, smokeLife: [1.4, 2], smokeRise: [1.2, 2], smokeSize: [0.9, 1.3],
  // How much the flames lean, per metre a second the character moves, and at most.
  lean: 0.1, maxLean: 0.45,
  // Each layer's depth in front of the obstacle line, so in perspective it lies over the character.
  depth: { glow: 0.4, smoke: 0.5, flames: 0.55, embers: 0.6 },
} as const;

// Value noise and its fractal sum, shared by the flames and the smoke.
const NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    sum += amplitude * valueNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amplitude *= 0.5;
  }
  return sum;
}
`;

const FLAME_VERTEX = /* glsl */ `
attribute float seed;
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = seed;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

// A tongue of flame on a quad whose bottom edge is its base: broad there, narrowing to licking tips, eaten at its edges
// and top by turbulence rising through it and warped by itself, so tongues curl and break away.
const FLAME_FRAGMENT = /* glsl */ `
uniform float time;
uniform float intensity;
uniform float lean;
varying vec2 vUv;
varying float vSeed;
${NOISE}
void main() {
  float y = vUv.y;
  float x = vUv.x - 0.5 - (lean + 0.06 * sin(time * 1.3 + vSeed * 6.28)) * y * y;
  float t = time + vSeed * 31.0;
  vec2 p = vec2(x * 2.6, y * 2.0 - t * 1.9);
  float warp = fbm(p * 1.4 + vec2(vSeed * 7.0, -t * 0.7));
  float n = fbm(p + vec2(warp * 1.2, warp * 0.6));
  float width = mix(0.46, 0.06, pow(y, 0.75));
  float body = 1.0 - smoothstep(width * 0.35, width, abs(x) + (n - 0.5) * 0.28 * (0.3 + y));
  float tip = 1.0 - smoothstep(0.25, 0.95, y + (0.55 - n) * 0.55);
  float base = smoothstep(0.0, 0.1, y);
  float heat = clamp(body * tip * base * (0.55 + 0.9 * n) * intensity, 0.0, 1.5);
  // Black-body colour: deep red where it is cool, through orange and yellow, to a white-hot core.
  vec3 color = vec3(0.9, 0.12, 0.02) * smoothstep(0.02, 0.35, heat)
    + vec3(0.6, 0.38, 0.03) * smoothstep(0.25, 0.7, heat)
    + vec3(0.25, 0.4, 0.3) * smoothstep(0.6, 1.1, heat);
  gl_FragColor = vec4(color * heat * 1.6, 1.0);
}
`;

const EMBER_VERTEX = /* glsl */ `
attribute vec3 tint;
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vUv = uv;
  vTint = tint;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const EMBER_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  float core = 1.0 - smoothstep(0.0, 1.0, length(vUv - 0.5) * 2.0);
  gl_FragColor = vec4(vTint * core * core, 1.0);
}
`;

const SMOKE_VERTEX = /* glsl */ `
attribute float seed;
attribute float fade;
varying vec2 vUv;
varying float vSeed;
varying float vFade;
void main() {
  vUv = uv;
  vSeed = seed;
  vFade = fade;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

// A soft, ragged puff of dark smoke.
const SMOKE_FRAGMENT = /* glsl */ `
uniform float time;
varying vec2 vUv;
varying float vSeed;
varying float vFade;
${NOISE}
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float n = fbm(vUv * 3.0 + vec2(vSeed * 13.0, -time * 0.25));
  float puff = 1.0 - smoothstep(0.35, 1.0, d + (n - 0.5) * 0.7);
  gl_FragColor = vec4(0.07, 0.06, 0.055, puff * vFade);
}
`;

const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Heat light about the burning character, flickering with the flames.
const GLOW_FRAGMENT = /* glsl */ `
uniform float time;
uniform float intensity;
varying vec2 vUv;
void main() {
  float d = length((vUv - vec2(0.5, 0.42)) * vec2(1.0, 0.85)) * 2.0;
  float flicker = 0.85 + 0.15 * sin(time * 17.0) * sin(time * 7.3 + 1.2);
  float glow = pow(max(0.0, 1.0 - d), 2.2) * intensity * flicker;
  gl_FragColor = vec4(vec3(1.0, 0.42, 0.1) * glow * 0.55, 1.0);
}
`;

// A number in 0-1 for `index` and `salt`, the same on every run.
function seeded(index: number, salt: number): number {
  let hash = Math.imul(index + 1, 0x27d4eb2d) ^ Math.imul(salt + 1, 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

function between(range: readonly [number, number], at: number): number {
  return range[0] + (range[1] - range[0]) * at;
}

// A quad whose bottom edge is at the origin, so it grows upward from where it is placed.
function standingQuad(): PlaneGeometry {
  return new PlaneGeometry(1, 1).translate(0, 0.5, 0);
}

// Every layer draws in the marks pass, so it ignores depth.
function layerMaterial(vertexShader: string, fragmentShader: string, uniforms: ShaderMaterial['uniforms'], additive: boolean): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader, fragmentShader, uniforms, transparent: true, depthTest: false, depthWrite: false,
    ...(additive ? { blending: AdditiveBlending } : {}),
  });
}

// The ranges each particle's life, rise and size are picked from, in seconds and metres.
interface ParticleRanges {
  readonly life: readonly [number, number];
  readonly rise: readonly [number, number];
  readonly size: readonly [number, number];
}

// Embers or smoke: a fixed set of particles, each born at the character and living its own life in the world.
class Particles {
  // Each particle's birth in run time, -1 while its slot is free; where the character's root was then; its life, rise,
  // size, offset across the fire (-1 to 1) and phase.
  readonly born: Float64Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly life: Float32Array;
  readonly rise: Float32Array;
  readonly size: Float32Array;
  readonly across: Float32Array;
  readonly phase: Float32Array;
  readonly count: number;
  private readonly ranges: ParticleRanges;
  // Births owed but not yet made, so slow frames still bear the right number.
  private owed = 0;

  constructor(count: number, ranges: ParticleRanges) {
    this.count = count;
    this.ranges = ranges;
    this.born = new Float64Array(count).fill(-1);
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.life = new Float32Array(count);
    this.rise = new Float32Array(count);
    this.size = new Float32Array(count);
    this.across = new Float32Array(count);
    this.phase = new Float32Array(count);
  }

  // Bears `rate` a second for `dt` seconds at the character's root, into free slots; `seed` counts every birth so far.
  bear(rate: number, dt: number, time: number, root: Readonly<{ x: number; y: number }>, seed: number): number {
    this.owed += rate * dt;
    for (let index = 0; index < this.count && this.owed >= 1; index++) {
      if (this.born[index]! >= 0) continue;
      this.owed -= 1;
      this.born[index] = time;
      this.x[index] = root.x;
      this.y[index] = root.y;
      this.life[index] = between(this.ranges.life, seeded(seed, 1));
      this.rise[index] = between(this.ranges.rise, seeded(seed, 2));
      this.size[index] = between(this.ranges.size, seeded(seed, 3));
      this.across[index] = seeded(seed, 4) * 2 - 1;
      this.phase[index] = seeded(seed, 5) * Math.PI * 2;
      seed++;
    }
    // A full set waits for free slots rather than saving births up.
    this.owed = Math.min(this.owed, 1);
    return seed;
  }

  // How far through its life the particle in `index` is, 0-1, or -1 once its slot is free.
  progress(index: number, time: number): number {
    const born = this.born[index]!;
    if (born < 0) return -1;
    const progress = (time - born) / this.life[index]!;
    if (progress < 1) return progress;
    this.born[index] = -1;
    return -1;
  }

  // Ends every particle and every birth owed.
  reset(): void {
    this.born.fill(-1);
    this.owed = 0;
  }

  // Stops owing births once the fire no longer bears any.
  rest(): void {
    this.owed = 0;
  }
}

/** The engine's hurt effects: the character catches fire while lava burns it. Other hits show nothing more. */
export class LavaFire implements HurtEffects {
  readonly root = new Group();
  private readonly flameUniforms = { time: { value: 0 }, intensity: { value: 0 }, lean: { value: 0 } };
  private readonly glowUniforms = { time: { value: 0 }, intensity: { value: 0 } };
  private readonly smokeUniforms = { time: { value: 0 } };
  private readonly flames: InstancedMesh;
  private readonly embers: InstancedMesh;
  private readonly smoke: InstancedMesh;
  private readonly glow: Mesh;
  private readonly emberTint: InstancedBufferAttribute;
  private readonly smokeFade: InstancedBufferAttribute;
  private readonly emberParticles = new Particles(FIRE.embers, { life: FIRE.emberLife, rise: FIRE.emberRise, size: FIRE.emberSize });
  private readonly smokeParticles = new Particles(FIRE.smoke, { life: FIRE.smokeLife, rise: FIRE.smokeRise, size: FIRE.smokeSize });
  private readonly matrix = new Matrix4();
  private readonly hidden = new Matrix4().makeScale(0, 0, 0);
  // Every particle born so far, which seeds what the next one is born with.
  private births = 0;
  // A burn arrived since the last drawn frame.
  private igniting = false;
  // The flames' strength before a burn's flare, 0-1: it grows while the fire burns and dies down after.
  private heat = 0;
  // In run time: until when the latest burn keeps the fire going, and when that burn flared.
  private burnUntil = -Infinity;
  private flaredAt = -Infinity;
  // Whether anything showed on the last drawn frame; when that was, where the character was, and how far the flames
  // lean from its motion.
  private showing = false;
  private lastTime = 0;
  private lastX = 0;
  private lean = 0;

  constructor() {
    const flameGeometry = standingQuad();
    flameGeometry.setAttribute('seed', new InstancedBufferAttribute(Float32Array.from(FIRE.flames, (_, index) => seeded(index, 9)), 1));
    this.flames = new InstancedMesh(flameGeometry, layerMaterial(FLAME_VERTEX, FLAME_FRAGMENT, this.flameUniforms, true), FIRE.flames.length);
    const emberGeometry = new PlaneGeometry(1, 1);
    this.emberTint = new InstancedBufferAttribute(new Float32Array(FIRE.embers * 3), 3).setUsage(DynamicDrawUsage);
    emberGeometry.setAttribute('tint', this.emberTint);
    this.embers = new InstancedMesh(emberGeometry, layerMaterial(EMBER_VERTEX, EMBER_FRAGMENT, {}, true), FIRE.embers);
    const smokeGeometry = new PlaneGeometry(1, 1);
    smokeGeometry.setAttribute('seed', new InstancedBufferAttribute(Float32Array.from({ length: FIRE.smoke }, (_, index) => seeded(index, 10)), 1));
    this.smokeFade = new InstancedBufferAttribute(new Float32Array(FIRE.smoke), 1).setUsage(DynamicDrawUsage);
    smokeGeometry.setAttribute('fade', this.smokeFade);
    this.smoke = new InstancedMesh(smokeGeometry, layerMaterial(SMOKE_VERTEX, SMOKE_FRAGMENT, this.smokeUniforms, false), FIRE.smoke);
    this.glow = new Mesh(new PlaneGeometry(2.4, 2.8), layerMaterial(GLOW_VERTEX, GLOW_FRAGMENT, this.glowUniforms, true));
    // Glow, then smoke, the flames over them and the embers over all, under the aim marks.
    const layers = [this.glow, this.smoke, this.flames, this.embers];
    layers.forEach((layer, index) => {
      layer.renderOrder = 6 + index;
      layer.frustumCulled = false;
    });
    for (const mesh of [this.flames, this.embers, this.smoke]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let index = 0; index < mesh.count; index++) mesh.setMatrixAt(index, this.hidden);
    }
    this.root.add(...layers);
    this.root.visible = false;
  }

  hurt(cause: Readonly<HurtCause>): void {
    if (cause.source === 'lava') this.igniting = true;
  }

  clear(): void {
    this.igniting = false;
    this.reset();
  }

  update(frame: SceneFrame): boolean {
    const time = frame.time;
    // Out and not lit: nothing to do, as while only other effects show.
    if (!this.showing && !this.igniting) {
      this.lastTime = time;
      return false;
    }
    let root: SceneFrame['parts'][number] | undefined;
    for (let index = 0; index < frame.parts.length; index++) {
      if (frame.parts[index]!.kind === 'root') root = frame.parts[index];
    }
    // Without a character, or with its run time rewound, the fire is out.
    if (root === undefined || time < this.lastTime) this.reset();
    if (root === undefined) {
      this.igniting = false;
      return false;
    }
    // Time passes for the fire only while it shows: a fire just lit starts here.
    const dt = this.showing ? time - this.lastTime : 0;
    if (!this.showing) this.lean = 0;
    if (this.igniting) {
      this.igniting = false;
      this.burnUntil = time + FIRE.burn;
      this.flaredAt = time;
    }
    const burning = time <= this.burnUntil;
    this.heat = burning ? Math.min(1, this.heat + dt / FIRE.kindle) : Math.max(0, this.heat - dt / FIRE.fade);
    const intensity = this.heat * (1 + FIRE.flare * Math.exp(-(time - this.flaredAt) / FIRE.flareFade));
    // The flames trail the character's motion, easing toward the lean it calls for.
    if (dt > 0) {
      const target = Math.max(-FIRE.maxLean, Math.min(FIRE.maxLean, -(root.x - this.lastX) / dt * FIRE.lean));
      this.lean += (target - this.lean) * Math.min(1, dt * 5);
    }
    this.lastX = root.x;
    this.lastTime = time;
    if (burning) {
      this.births = this.emberParticles.bear(FIRE.emberRate * this.heat, dt, time, root, this.births);
      this.births = this.smokeParticles.bear(FIRE.smokeRate * this.heat, dt, time, root, this.births);
    } else {
      this.emberParticles.rest();
      this.smokeParticles.rest();
    }
    this.flameUniforms.time.value = this.glowUniforms.time.value = this.smokeUniforms.time.value = time;
    this.flameUniforms.intensity.value = intensity;
    this.flameUniforms.lean.value = this.lean;
    this.glowUniforms.intensity.value = intensity;
    this.placeFlames(root, time, intensity);
    const embers = this.placeEmbers(time);
    const smoke = this.placeSmoke(time);
    this.glow.position.set(root.x, root.y + 0.45, FIRE.depth.glow);
    this.flames.visible = this.glow.visible = this.heat > 0;
    this.showing = burning || this.heat > 0 || embers + smoke > 0;
    this.root.visible = this.showing;
    return this.showing;
  }

  dispose(): void {
    for (const mesh of [this.flames, this.embers, this.smoke, this.glow]) {
      mesh.geometry.dispose();
      (mesh.material as ShaderMaterial).dispose();
    }
    this.flames.dispose();
    this.embers.dispose();
    this.smoke.dispose();
  }

  // Puts the fire out at once: no flames, embers or smoke, and nothing owed.
  private reset(): void {
    this.heat = 0;
    this.burnUntil = this.flaredAt = -Infinity;
    this.emberParticles.reset();
    this.smokeParticles.reset();
    this.showing = false;
    this.root.visible = false;
  }

  // Each flame stands on its offset from the character and breathes, growing with the fire.
  private placeFlames(root: Readonly<{ x: number; y: number }>, time: number, intensity: number): void {
    const grown = Math.sqrt(Math.min(1, intensity));
    for (let index = 0; index < FIRE.flames.length; index++) {
      const flame = FIRE.flames[index]!;
      const breath = grown * (0.9 + 0.1 * Math.sin(time * 5 + index * 2.1));
      this.flames.setMatrixAt(index, this.matrix.makeScale(flame.width * (0.8 + 0.2 * grown), flame.height * breath, 1)
        .setPosition(root.x + flame.x, root.y + flame.y, FIRE.depth.flames));
    }
    this.flames.instanceMatrix.needsUpdate = true;
  }

  // Embers rise from where they were born, speeding up and wavering, and twinkle out. Returns how many show.
  private placeEmbers(time: number): number {
    const particles = this.emberParticles;
    const tint = this.emberTint.array as Float32Array;
    let showing = 0;
    for (let index = 0; index < particles.count; index++) {
      const progress = particles.progress(index, time);
      if (progress < 0) {
        this.embers.setMatrixAt(index, this.hidden);
        continue;
      }
      showing++;
      const phase = particles.phase[index]!;
      const x = particles.x[index]! + particles.across[index]! * 0.35 + Math.sin(time * 3 + phase) * 0.12 * progress;
      const y = particles.y[index]! - 0.2 + particles.rise[index]! * (progress + 0.6 * progress * progress);
      const size = particles.size[index]! * (1 - 0.6 * progress);
      this.embers.setMatrixAt(index, this.matrix.makeScale(size, size, 1).setPosition(x, y, FIRE.depth.embers));
      const glow = Math.min(1, progress / 0.08) * (1 - progress) ** 1.6 * (0.7 + 0.3 * Math.sin(time * 25 + phase * 5)) * 2.2;
      tint[index * 3] = glow;
      tint[index * 3 + 1] = glow * (0.55 - 0.25 * progress);
      tint[index * 3 + 2] = glow * 0.12;
    }
    this.embers.instanceMatrix.needsUpdate = true;
    this.emberTint.needsUpdate = true;
    return showing;
  }

  // Smoke rises above where it was born, spreading and wavering, and thins away. Returns how many puffs show.
  private placeSmoke(time: number): number {
    const particles = this.smokeParticles;
    const fade = this.smokeFade.array as Float32Array;
    let showing = 0;
    for (let index = 0; index < particles.count; index++) {
      const progress = particles.progress(index, time);
      if (progress < 0) {
        this.smoke.setMatrixAt(index, this.hidden);
        fade[index] = 0;
        continue;
      }
      showing++;
      const x = particles.x[index]! + particles.across[index]! * 0.25 + Math.sin(time * 0.9 + particles.phase[index]!) * 0.1 * progress;
      const y = particles.y[index]! + 0.7 + particles.rise[index]! * progress;
      const size = particles.size[index]! * (0.45 + 0.85 * progress);
      this.smoke.setMatrixAt(index, this.matrix.makeScale(size, size, 1).setPosition(x, y, FIRE.depth.smoke));
      fade[index] = Math.min(1, progress / 0.2) * (1 - progress) ** 1.3 * 0.32;
    }
    this.smoke.instanceMatrix.needsUpdate = true;
    this.smokeFade.needsUpdate = true;
    return showing;
  }
}
