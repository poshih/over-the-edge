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
// than that; once the burns stop, the flames die down, the last embers rise and the smoke clears.
const FIRE = {
  // How long a burn keeps the fire going; how long the flames take to flare up, and to die down.
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
  embers: 28, emberLife: [0.7, 1.3], emberRise: [1.3, 2.3], emberSize: [0.035, 0.07],
  smoke: 10, smokeLife: [1.4, 2], smokeRise: [1.2, 2], smokeSize: [0.9, 1.3],
  // Embers and smoke outlive the flames by at most this long.
  linger: 2.1,
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
  // Each ember's and puff's life and delay after the fire starts, and how far it rises and how big it is.
  private readonly emberLife = new Float32Array(FIRE.embers);
  private readonly emberDelay = new Float32Array(FIRE.embers);
  private readonly emberRise = new Float32Array(FIRE.embers);
  private readonly emberSize = new Float32Array(FIRE.embers);
  private readonly smokeLife = new Float32Array(FIRE.smoke);
  private readonly smokeDelay = new Float32Array(FIRE.smoke);
  private readonly smokeRise = new Float32Array(FIRE.smoke);
  private readonly smokeSize = new Float32Array(FIRE.smoke);
  private readonly matrix = new Matrix4();
  private readonly hidden = new Matrix4().makeScale(0, 0, 0);
  // A burn arrived since the last drawn frame.
  private igniting = false;
  private burning = false;
  // In run time: when the fire started, when its latest burn stops keeping it going, and when that burn flared.
  private start = 0;
  private burnUntil = 0;
  private flaredAt = 0;
  // Where the character was on the previous drawn frame, and how far the flames lean from its motion.
  private lastX = 0;
  private lastTime = 0;
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
    for (let index = 0; index < FIRE.embers; index++) {
      this.emberLife[index] = between(FIRE.emberLife, seeded(index, 1));
      this.emberDelay[index] = seeded(index, 2) * this.emberLife[index]!;
      this.emberRise[index] = between(FIRE.emberRise, seeded(index, 3));
      this.emberSize[index] = between(FIRE.emberSize, seeded(index, 4));
    }
    for (let index = 0; index < FIRE.smoke; index++) {
      this.smokeLife[index] = between(FIRE.smokeLife, seeded(index, 5));
      this.smokeDelay[index] = 0.25 + seeded(index, 6) * this.smokeLife[index]!;
      this.smokeRise[index] = between(FIRE.smokeRise, seeded(index, 7));
      this.smokeSize[index] = between(FIRE.smokeSize, seeded(index, 8));
    }
    this.root.add(...layers);
    this.root.visible = false;
  }

  hurt(cause: Readonly<HurtCause>): void {
    if (cause.source === 'lava') this.igniting = true;
  }

  clear(): void {
    this.igniting = false;
    this.burning = false;
    this.root.visible = false;
  }

  update(frame: SceneFrame): boolean {
    const time = frame.time;
    let root: SceneFrame['parts'][number] | undefined;
    for (let index = 0; index < frame.parts.length; index++) {
      if (frame.parts[index]!.kind === 'root') root = frame.parts[index];
    }
    if (root === undefined) {
      this.clear();
      return false;
    }
    if (this.igniting) {
      this.igniting = false;
      // A new fire, or one whose run time was rewound, starts afresh.
      if (!this.burning || time < this.start) {
        this.start = time;
        this.lastX = root.x;
        this.lastTime = time;
        this.lean = 0;
      }
      this.burning = true;
      this.burnUntil = time + FIRE.burn;
      this.flaredAt = time;
    }
    if (!this.burning) return false;
    if (time < this.start || time > this.burnUntil + FIRE.linger) {
      this.clear();
      return false;
    }
    const kindled = Math.min(1, (time - this.start) / FIRE.kindle);
    const dying = time <= this.burnUntil ? 1 : Math.max(0, 1 - (time - this.burnUntil) / FIRE.fade);
    const intensity = kindled * dying * (1 + FIRE.flare * Math.exp(-(time - this.flaredAt) / FIRE.flareFade));
    // The flames trail the character's motion, easing toward the lean it calls for.
    const dt = time - this.lastTime;
    if (dt > 0) {
      const target = Math.max(-FIRE.maxLean, Math.min(FIRE.maxLean, -(root.x - this.lastX) / dt * FIRE.lean));
      this.lean += (target - this.lean) * Math.min(1, dt * 5);
    }
    this.lastX = root.x;
    this.lastTime = time;
    this.flameUniforms.time.value = this.glowUniforms.time.value = this.smokeUniforms.time.value = time;
    this.flameUniforms.intensity.value = intensity;
    this.flameUniforms.lean.value = this.lean;
    this.glowUniforms.intensity.value = intensity;
    this.placeFlames(root, time, intensity);
    this.placeEmbers(root, time);
    this.placeSmoke(root, time);
    this.glow.position.set(root.x, root.y + 0.45, FIRE.depth.glow);
    this.flames.visible = this.glow.visible = intensity > 0;
    this.root.visible = true;
    return true;
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

  // Embers rise, speeding up, drift away from the character's motion and twinkle out; only those born while the fire
  // burns show.
  private placeEmbers(root: Readonly<{ x: number; y: number }>, time: number): void {
    const elapsed = time - this.start;
    const tint = this.emberTint.array as Float32Array;
    for (let index = 0; index < FIRE.embers; index++) {
      const life = this.emberLife[index]!;
      const lived = elapsed - this.emberDelay[index]!;
      const cycle = Math.floor(lived / life);
      const progress = lived / life - cycle;
      if (lived < 0 || time - progress * life > this.burnUntil) {
        this.embers.setMatrixAt(index, this.hidden);
        continue;
      }
      const across = seeded(index * 97 + cycle, 11) * 2 - 1;
      const x = root.x + across * 0.35 + Math.sin(time * (3 + index % 3) + index) * 0.12 * progress - this.lean * 0.8 * progress;
      const y = root.y - 0.2 + this.emberRise[index]! * (progress + 0.6 * progress * progress);
      const size = this.emberSize[index]! * (1 - 0.6 * progress);
      this.embers.setMatrixAt(index, this.matrix.makeScale(size, size, 1).setPosition(x, y, FIRE.depth.embers));
      const glow = (1 - progress) ** 1.6 * (0.7 + 0.3 * Math.sin(time * 25 + index * 3.1)) * 2.2;
      tint[index * 3] = glow;
      tint[index * 3 + 1] = glow * (0.55 - 0.25 * progress);
      tint[index * 3 + 2] = glow * 0.12;
    }
    this.embers.instanceMatrix.needsUpdate = true;
    this.emberTint.needsUpdate = true;
  }

  // Smoke rises above the flames, spreading and drifting away from the character's motion, and thins away.
  private placeSmoke(root: Readonly<{ x: number; y: number }>, time: number): void {
    const elapsed = time - this.start;
    const fade = this.smokeFade.array as Float32Array;
    for (let index = 0; index < FIRE.smoke; index++) {
      const life = this.smokeLife[index]!;
      const lived = elapsed - this.smokeDelay[index]!;
      const cycle = Math.floor(lived / life);
      const progress = lived / life - cycle;
      if (lived < 0 || time - progress * life > this.burnUntil) {
        this.smoke.setMatrixAt(index, this.hidden);
        fade[index] = 0;
        continue;
      }
      const across = seeded(index * 53 + cycle, 12) * 2 - 1;
      const x = root.x + across * 0.25 + Math.sin(time * 0.9 + index) * 0.1 * progress - this.lean * 1.2 * progress;
      const y = root.y + 0.7 + this.smokeRise[index]! * progress;
      const size = this.smokeSize[index]! * (0.45 + 0.85 * progress);
      this.smoke.setMatrixAt(index, this.matrix.makeScale(size, size, 1).setPosition(x, y, FIRE.depth.smoke));
      fade[index] = Math.min(1, progress / 0.2) * (1 - progress) ** 1.3 * 0.32;
    }
    this.smoke.instanceMatrix.needsUpdate = true;
    this.smokeFade.needsUpdate = true;
  }
}
