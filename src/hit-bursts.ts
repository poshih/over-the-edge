import {
  AdditiveBlending, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { HurtCause, ProjectileBlock } from './hazards';
import { OBSTACLE_LINE } from './obstacle-line';
import type { SceneFrame } from './scene-layer';

// Where a blade or a projectile strikes the character, a burst shows the blow: a flash with a glint, a ring rushing
// outward and sparks thrown the way the hit knocks the character, cooling as they fly and falling. A blade also leaves
// a bright slash across the character, and a burning bolt breaks into glowing chips. Bursts stay where the blow landed,
// so one still plays out where the character fell when it comes back at a bonfire. A projectile blocked by the hammer
// instead flashes steel-white and throws sparks along its reflected flight, with the bolt's chips dropping from it.
const BURST = {
  // Bursts showing at once, replacing the oldest so several shots at the hammer show together.
  count: 4,
  // How long each part lasts, in seconds; the slash draws in `slashDraw`, then fades.
  flash: 0.14, ring: 0.32, slashDraw: 0.06, slash: 0.28,
  // Sparks per burst, their speed and life ranges, and how fast they slow and fall.
  sparks: 22, sparkSpeed: [3.5, 9.5], sparkLife: [0.22, 0.55], sparkDrag: 3.2, sparkGravity: 8,
  // The glowing chips a burning bolt breaks into.
  chips: 8, chipSpeed: [1.2, 4], chipLife: [0.4, 0.75], chipSize: [0.05, 0.09], chipDrag: 1.5, chipGravity: 9, chipSpin: 16,
  // Once the longest part is over, the burst's slot is free.
  life: 0.8,
  // In front of the obstacle line, so in perspective it lies over the character.
  depth: 0.7,
  // A block starts just off the struck face, in metres along its outward normal.
  blockOffset: 0.06,
} as const;

// How each impact looks: cold steel for a blade or a block, hot for a bolt hitting the character. Colours in linear
// light, sizes in metres, and the spark fan's spread in radians.
const LOOK = {
  axe: { flash: [0.75, 0.86, 1], ring: [0.45, 0.6, 0.9], flashSize: 1.5, ringSize: 1.7, spread: 0.85 },
  projectile: { flash: [1, 0.72, 0.38], ring: [0.9, 0.5, 0.2], flashSize: 1.1, ringSize: 1.2, spread: 1.1 },
  block: { flash: [0.82, 0.92, 1], ring: [0.6, 0.78, 1], flashSize: 1.1, ringSize: 1.2, spread: 0.65 },
} as const;
type BurstKind = keyof typeof LOOK;
const SLASH = [0.85, 0.94, 1] as const;

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

// A bloom with a hot core and a four-pointed glint.
const FLASH_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vec2 p = vUv - 0.5;
  float d = length(p) * 2.0;
  float bloom = pow(max(0.0, 1.0 - d), 2.5);
  float core = pow(max(0.0, 1.0 - d * 2.2), 3.0);
  float glint = max(0.0, 1.0 - abs(p.y) * 26.0) * max(0.0, 1.0 - abs(p.x) * 2.0)
    + max(0.0, 1.0 - abs(p.x) * 26.0) * max(0.0, 1.0 - abs(p.y) * 2.0);
  gl_FragColor = vec4(vTint * (bloom + core * 1.5 + glint * 0.7), 1.0);
}
`;

// A thin ring at the quad's edge, so it rushes outward as the quad grows.
const RING_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float ring = smoothstep(0.7, 0.9, d) * (1.0 - smoothstep(0.9, 1.0, d));
  gl_FragColor = vec4(vTint * ring, 1.0);
}
`;

// A streak along the quad's x, bright and round at its head and fading along its tail.
const SPARK_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vec2 p = vUv - 0.5;
  float across = 1.0 - smoothstep(0.0, 0.5, abs(p.y));
  float head = 1.0 - smoothstep(0.3, 0.5, p.x);
  float tail = smoothstep(-0.5, 0.3, p.x);
  gl_FragColor = vec4(vTint * across * across * head * tail, 1.0);
}
`;

// A small glowing shard.
const CHIP_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
void main() {
  vec2 p = vUv - 0.5;
  float chip = 1.0 - smoothstep(0.32, 0.5, abs(p.x) + abs(p.y) * 1.6);
  gl_FragColor = vec4(vTint * chip, 1.0);
}
`;

const SLASH_VERTEX = /* glsl */ `
attribute vec3 tint;
attribute vec2 state;
varying vec2 vUv;
varying vec3 vTint;
varying vec2 vState;
void main() {
  vUv = uv;
  vTint = tint;
  vState = state;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

// A crescent bowed toward the quad's +x, thickest in its middle, drawn from its top down as state.x goes from 0 to 1,
// with state.y its brightness: a white-hot core in a soft halo.
const SLASH_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
varying vec2 vState;
void main() {
  vec2 p = vUv - 0.5;
  float along = clamp(p.y + 0.5, 0.0, 1.0);
  float shown = smoothstep(1.0 - vState.x - 0.08, 1.0 - vState.x, along);
  float bow = sin(3.14159265 * along);
  float gap = abs(length(p - vec2(-0.45, 0.0)) - 0.62);
  float core = 1.0 - smoothstep(0.0, 0.004 + 0.04 * bow, gap);
  float halo = exp(-gap * 22.0) * bow;
  gl_FragColor = vec4(vTint * (core * 1.7 + halo * 0.55) * shown * vState.y, 1.0);
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

// Additive, ignoring depth as everything in the marks pass must.
function burstMaterial(vertexShader: string, fragmentShader: string): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader, fragmentShader, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false,
    // Mirrored slashes face away from the camera.
    side: DoubleSide,
  });
}

// A pool of instanced quads with a colour each, every quad hidden until placed.
function tintedQuads(fragmentShader: string, count: number, renderOrder: number): { mesh: InstancedMesh; tint: InstancedBufferAttribute } {
  const geometry = new PlaneGeometry(1, 1);
  const tint = new InstancedBufferAttribute(new Float32Array(count * 3), 3).setUsage(DynamicDrawUsage);
  geometry.setAttribute('tint', tint);
  const mesh = new InstancedMesh(geometry, burstMaterial(TINTED_VERTEX, fragmentShader), count);
  hideAll(mesh, renderOrder);
  return { mesh, tint };
}

const HIDDEN = new Matrix4().makeScale(0, 0, 0);

function hideAll(mesh: InstancedMesh, renderOrder: number): void {
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  for (let index = 0; index < mesh.count; index++) mesh.setMatrixAt(index, HIDDEN);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
}

function setTint(tint: InstancedBufferAttribute, index: number, color: readonly number[], brightness: number): void {
  const values = tint.array as Float32Array;
  values[index * 3] = color[0]! * brightness;
  values[index * 3 + 1] = color[1]! * brightness;
  values[index * 3 + 2] = color[2]! * brightness;
}

/** Shared instanced impact bursts; each presentation point owns its own pool and root. */
export class HitBursts {
  readonly root = new Group();
  private readonly flashes = tintedQuads(FLASH_FRAGMENT, BURST.count, 12);
  private readonly rings = tintedQuads(RING_FRAGMENT, BURST.count, 11);
  private readonly sparks = tintedQuads(SPARK_FRAGMENT, BURST.count * BURST.sparks, 14);
  private readonly chips = tintedQuads(CHIP_FRAGMENT, BURST.count * BURST.chips, 13);
  private readonly slashes: InstancedMesh;
  private readonly slashTint: InstancedBufferAttribute;
  private readonly slashState: InstancedBufferAttribute;
  private readonly matrix = new Matrix4();
  // Each burst: when it started in run time, -1 while its slot is free; where the blow landed; the unit direction it
  // travels; which kind of impact it was; and which side the character was knocked to (-1 or 1).
  private readonly born = new Float64Array(BURST.count).fill(-1);
  private readonly x = new Float32Array(BURST.count);
  private readonly y = new Float32Array(BURST.count);
  private readonly dirX = new Float32Array(BURST.count);
  private readonly dirY = new Float32Array(BURST.count);
  private readonly kind = Array<BurstKind>(BURST.count).fill('projectile');
  private readonly side = new Float32Array(BURST.count);
  private readonly order = new Float64Array(BURST.count);
  // Each spark's and chip's starting velocity, life and size, and each chip's starting angle and spin.
  private readonly sparkVX = new Float32Array(BURST.count * BURST.sparks);
  private readonly sparkVY = new Float32Array(BURST.count * BURST.sparks);
  private readonly sparkLife = new Float32Array(BURST.count * BURST.sparks);
  private readonly sparkSize = new Float32Array(BURST.count * BURST.sparks);
  private readonly chipVX = new Float32Array(BURST.count * BURST.chips);
  private readonly chipVY = new Float32Array(BURST.count * BURST.chips);
  private readonly chipLife = new Float32Array(BURST.count * BURST.chips);
  private readonly chipSize = new Float32Array(BURST.count * BURST.chips);
  private readonly chipAngle = new Float32Array(BURST.count * BURST.chips);
  private readonly chipSpin = new Float32Array(BURST.count * BURST.chips);
  // The latest impacts since the last drawn frame, which starts them: where, which way, which kind and, for a block,
  // the outward normal its sparks spread toward.
  private readonly pendingX = new Float32Array(BURST.count);
  private readonly pendingY = new Float32Array(BURST.count);
  private readonly pendingDirX = new Float32Array(BURST.count);
  private readonly pendingDirY = new Float32Array(BURST.count);
  private readonly pendingKind = Array<BurstKind>(BURST.count).fill('projectile');
  private readonly pendingNormalX = new Float32Array(BURST.count);
  private readonly pendingNormalY = new Float32Array(BURST.count);
  private pending = 0;
  private pendingHead = 0;
  private active = 0;
  // Every burst started so far, which seeds the next one's sparks and chips.
  private started = 0;
  private lastTime = 0;

  constructor() {
    const geometry = new PlaneGeometry(1, 1);
    this.slashTint = new InstancedBufferAttribute(new Float32Array(BURST.count * 3), 3).setUsage(DynamicDrawUsage);
    this.slashState = new InstancedBufferAttribute(new Float32Array(BURST.count * 2), 2).setUsage(DynamicDrawUsage);
    geometry.setAttribute('tint', this.slashTint);
    geometry.setAttribute('state', this.slashState);
    this.slashes = new InstancedMesh(geometry, burstMaterial(SLASH_VERTEX, SLASH_FRAGMENT), BURST.count);
    hideAll(this.slashes, 15);
    // Rings, then flashes, chips and sparks, the slash over all, all under the aim marks.
    this.root.add(this.rings.mesh, this.flashes.mesh, this.chips.mesh, this.sparks.mesh, this.slashes);
    this.root.visible = false;
  }

  hurt(cause: Readonly<HurtCause>): void {
    if ((cause.source !== 'axe' && cause.source !== 'projectile') || this.pending === BURST.count) return;
    this.queue(cause.source, cause.x, cause.y, cause.pushX, cause.pushY, 0, 0);
  }

  block(hit: Readonly<ProjectileBlock>): void {
    const dot = hit.directionX * hit.normalX + hit.directionY * hit.normalY;
    const reflectedX = hit.directionX - 2 * dot * hit.normalX;
    const reflectedY = hit.directionY - 2 * dot * hit.normalY;
    this.queue('block', hit.x + hit.normalX * BURST.blockOffset, hit.y + hit.normalY * BURST.blockOffset,
      reflectedX, reflectedY, hit.normalX, hit.normalY);
  }

  private queue(kind: BurstKind, x: number, y: number, directionX: number, directionY: number, normalX: number, normalY: number): void {
    const index = (this.pendingHead + this.pending) % BURST.count;
    if (this.pending < BURST.count) this.pending++;
    else this.pendingHead = (this.pendingHead + 1) % BURST.count;
    this.pendingX[index] = x;
    this.pendingY[index] = y;
    this.pendingDirX[index] = directionX;
    this.pendingDirY[index] = directionY;
    this.pendingKind[index] = kind;
    this.pendingNormalX[index] = normalX;
    this.pendingNormalY[index] = normalY;
  }

  // Bursts stay where the blow landed, so placing the player anew leaves them to play out.
  clear(): void {}

  update(frame: SceneFrame, rewind: 'discard-pending' | 'keep-pending' = 'discard-pending'): boolean {
    const time = frame.time;
    if (this.pending === 0 && this.active === 0) {
      this.lastTime = time;
      return false;
    }
    // A rewound run time ends the old bursts; blocks delivered for this frame can still start afterward.
    if (time < this.lastTime) this.reset(rewind === 'discard-pending');
    this.lastTime = time;
    for (let index = 0; index < this.pending; index++) this.start((this.pendingHead + index) % BURST.count, time);
    this.pending = this.pendingHead = 0;
    for (let burst = 0; burst < BURST.count; burst++) {
      if (this.born[burst]! < 0) continue;
      const age = time - this.born[burst]!;
      if (age >= BURST.life) this.end(burst);
      else this.place(burst, age);
    }
    this.flashes.mesh.instanceMatrix.needsUpdate = this.flashes.tint.needsUpdate = true;
    this.rings.mesh.instanceMatrix.needsUpdate = this.rings.tint.needsUpdate = true;
    this.sparks.mesh.instanceMatrix.needsUpdate = this.sparks.tint.needsUpdate = true;
    this.chips.mesh.instanceMatrix.needsUpdate = this.chips.tint.needsUpdate = true;
    this.slashes.instanceMatrix.needsUpdate = true;
    this.slashTint.needsUpdate = this.slashState.needsUpdate = true;
    this.root.visible = this.active > 0;
    return this.active > 0;
  }

  dispose(): void {
    for (const mesh of [this.flashes.mesh, this.rings.mesh, this.sparks.mesh, this.chips.mesh, this.slashes]) {
      mesh.geometry.dispose();
      (mesh.material as ShaderMaterial).dispose();
      mesh.dispose();
    }
  }

  private reset(discardPending: boolean): void {
    for (let burst = 0; burst < BURST.count; burst++) if (this.born[burst]! >= 0) this.end(burst);
    if (discardPending) this.pending = this.pendingHead = 0;
  }

  // Starts the pending blow in `index`, in a free slot or, with none, the oldest burst's.
  private start(index: number, time: number): void {
    let burst = 0;
    for (let slot = 0; slot < BURST.count; slot++) {
      if (this.born[slot]! < 0) {
        burst = slot;
        break;
      }
      if (this.born[slot]! < this.born[burst]! ||
        (this.born[slot] === this.born[burst] && this.order[slot]! < this.order[burst]!)) burst = slot;
    }
    if (this.born[burst]! >= 0) this.end(burst);
    this.active++;
    const kind = this.pendingKind[index]!;
    const blade = kind === 'axe', blocked = kind === 'block';
    const pushX = this.pendingDirX[index]!, pushY = this.pendingDirY[index]!;
    const push = Math.hypot(pushX, pushY);
    this.born[burst] = time;
    this.x[burst] = this.pendingX[index]!;
    this.y[burst] = this.pendingY[index]!;
    this.dirX[burst] = push > 0 ? pushX / push : 0;
    this.dirY[burst] = push > 0 ? pushY / push : 1;
    this.kind[burst] = kind;
    this.side[burst] = pushX < 0 ? -1 : 1;
    this.order[burst] = this.started++;
    const seed = this.order[burst]! * 131;
    const look = LOOK[kind];
    const toward = Math.atan2(this.dirY[burst]!, this.dirX[burst]!);
    const normalX = this.pendingNormalX[index]!, normalY = this.pendingNormalY[index]!;
    const normalAngle = Math.atan2(normalY, normalX);
    for (let spark = 0; spark < BURST.sparks; spark++) {
      const at = burst * BURST.sparks + spark;
      const speed = between(BURST.sparkSpeed, seeded(seed + spark, 2));
      if (blocked) {
        // Fan the reflected flight toward the outward normal; both directions stay off the struck face.
        const angle = normalAngle + (seeded(seed + spark, 1) - 0.5) * 2 * look.spread;
        const fan = 0.6 * seeded(seed + spark, 11);
        const dx = this.dirX[burst]! * (1 - fan) + Math.cos(angle) * fan;
        const dy = this.dirY[burst]! * (1 - fan) + Math.sin(angle) * fan;
        const length = Math.hypot(dx, dy);
        this.sparkVX[at] = dx / length * speed;
        this.sparkVY[at] = dy / length * speed;
      } else {
        // A blade throws its sparks the way it knocks the character; a bolt sprays most of them back from where it
        // struck, the rest on along its flight.
        const back = !blade && spark % 9 < 5;
        const angle = (back ? toward + Math.PI : toward) + (seeded(seed + spark, 1) - 0.5) * 2 * (back ? look.spread : look.spread * 0.5);
        this.sparkVX[at] = Math.cos(angle) * speed;
        this.sparkVY[at] = Math.sin(angle) * speed;
      }
      this.sparkLife[at] = between(BURST.sparkLife, seeded(seed + spark, 3));
      this.sparkSize[at] = 0.7 + 0.6 * seeded(seed + spark, 4);
    }
    for (let chip = 0; chip < BURST.chips; chip++) {
      const at = burst * BURST.chips + chip;
      const angle = toward + (seeded(seed + chip, 5) - 0.5) * 1.8;
      const speed = between(BURST.chipSpeed, seeded(seed + chip, 6));
      this.chipVX[at] = Math.cos(angle) * speed * (blocked ? 0.45 : 1);
      this.chipVY[at] = blocked ? -speed * (0.25 + 0.5 * seeded(seed + chip, 5)) : Math.sin(angle) * speed + 1.5;
      this.chipLife[at] = between(BURST.chipLife, seeded(seed + chip, 7));
      this.chipSize[at] = between(BURST.chipSize, seeded(seed + chip, 8));
      this.chipAngle[at] = seeded(seed + chip, 9) * Math.PI * 2;
      this.chipSpin[at] = (seeded(seed + chip, 10) - 0.5) * 2 * BURST.chipSpin;
    }
  }

  private end(burst: number): void {
    this.born[burst] = -1;
    this.active--;
    this.flashes.mesh.setMatrixAt(burst, HIDDEN);
    this.rings.mesh.setMatrixAt(burst, HIDDEN);
    this.slashes.setMatrixAt(burst, HIDDEN);
    for (let spark = 0; spark < BURST.sparks; spark++) this.sparks.mesh.setMatrixAt(burst * BURST.sparks + spark, HIDDEN);
    for (let chip = 0; chip < BURST.chips; chip++) this.chips.mesh.setMatrixAt(burst * BURST.chips + chip, HIDDEN);
  }

  // Draws the burst in slot `burst`, `age` seconds after it started.
  private place(burst: number, age: number): void {
    const x = this.x[burst]!, y = this.y[burst]!;
    const kind = this.kind[burst]!;
    const blade = kind === 'axe';
    const look = LOOK[kind];
    const depth = kind === 'block' ? OBSTACLE_LINE : BURST.depth;
    const flash = age / BURST.flash;
    if (flash < 1) {
      const size = look.flashSize * (0.55 + 0.45 * Math.sqrt(flash));
      this.flashes.mesh.setMatrixAt(burst, this.matrix.makeScale(size, size, 1).setPosition(x, y, depth));
      setTint(this.flashes.tint, burst, look.flash, (1 - flash) ** 2 * 1.4);
    } else {
      this.flashes.mesh.setMatrixAt(burst, HIDDEN);
    }
    const ring = age / BURST.ring;
    if (ring < 1) {
      const size = look.ringSize * (0.25 + 0.75 * (1 - (1 - ring) ** 3));
      this.rings.mesh.setMatrixAt(burst, this.matrix.makeScale(size, size, 1).setPosition(x, y, depth));
      setTint(this.rings.tint, burst, look.ring, (1 - ring) ** 1.5 * 0.9);
    } else {
      this.rings.mesh.setMatrixAt(burst, HIDDEN);
    }
    if (blade && age < BURST.slash) {
      // A slash across the character, bowed the way the blow knocks it.
      const wipe = Math.min(1, age / BURST.slashDraw);
      const fade = age < BURST.slashDraw ? 1 : (1 - (age - BURST.slashDraw) / (BURST.slash - BURST.slashDraw)) ** 1.5;
      const side = this.side[burst]!;
      const angle = -0.5 * side;
      const cos = Math.cos(angle) * 1.7, sin = Math.sin(angle) * 1.7;
      this.slashes.setMatrixAt(burst, this.matrix.set(
        cos * side, -sin, 0, x,
        sin * side, cos, 0, y + 0.1,
        0, 0, 1, depth,
        0, 0, 0, 1,
      ));
      setTint(this.slashTint, burst, SLASH, 1);
      const state = this.slashState.array as Float32Array;
      state[burst * 2] = wipe;
      state[burst * 2 + 1] = fade;
    } else {
      this.slashes.setMatrixAt(burst, HIDDEN);
    }
    this.placeSparks(burst, age, x, y, depth);
    if (!blade) this.placeChips(burst, age, x, y, depth);
  }

  // Sparks fly from the strike, slowing and falling, each a streak along its flight. Character hits cool from white
  // through orange to red; steel blocks cool to dim blue-grey.
  private placeSparks(burst: number, age: number, x: number, y: number, depth: number): void {
    const drag = BURST.sparkDrag, fall = BURST.sparkGravity / drag;
    const slowed = 1 - Math.exp(-drag * age);
    const blocked = this.kind[burst] === 'block';
    for (let spark = 0; spark < BURST.sparks; spark++) {
      const at = burst * BURST.sparks + spark;
      const life = this.sparkLife[at]!;
      if (age >= life) {
        this.sparks.mesh.setMatrixAt(at, HIDDEN);
        continue;
      }
      const vx = this.sparkVX[at]!, vy = this.sparkVY[at]!;
      const sx = x + vx * slowed / drag;
      const sy = y + vy * slowed / drag - fall * (age - slowed / drag);
      const nowX = vx * (1 - slowed), nowY = vy * (1 - slowed) - fall * slowed;
      const speed = Math.hypot(nowX, nowY);
      const cos = speed > 0 ? nowX / speed : 1, sin = speed > 0 ? nowY / speed : 0;
      const length = Math.max(0.05, speed * 0.045) * this.sparkSize[at]!;
      const width = 0.035 * this.sparkSize[at]!;
      // The streak's head is the spark; its tail trails behind along its flight.
      this.sparks.mesh.setMatrixAt(at, this.matrix.set(
        cos * length, -sin * width, 0, sx - cos * length / 2,
        sin * length, cos * width, 0, sy - sin * length / 2,
        0, 0, 1, depth,
        0, 0, 0, 1,
      ));
      const left = 1 - age / life;
      const glow = left ** 1.2 * 1.8;
      const values = this.sparks.tint.array as Float32Array;
      if (blocked) {
        values[at * 3] = glow * (0.32 + 0.6 * left);
        values[at * 3 + 1] = glow * (0.45 + 0.52 * left);
        values[at * 3 + 2] = glow * (0.6 + 0.4 * left);
      } else {
        values[at * 3] = glow;
        values[at * 3 + 1] = glow * (0.25 + 0.6 * left);
        values[at * 3 + 2] = glow * (0.05 + 0.5 * left * left);
      }
    }
  }

  // A burning bolt's chips tumble away from where it struck, falling and dimming.
  private placeChips(burst: number, age: number, x: number, y: number, depth: number): void {
    const drag = BURST.chipDrag, fall = BURST.chipGravity / drag;
    const slowed = 1 - Math.exp(-drag * age);
    for (let chip = 0; chip < BURST.chips; chip++) {
      const at = burst * BURST.chips + chip;
      const life = this.chipLife[at]!;
      if (age >= life) {
        this.chips.mesh.setMatrixAt(at, HIDDEN);
        continue;
      }
      const cx = x + this.chipVX[at]! * slowed / drag;
      const cy = y + this.chipVY[at]! * slowed / drag - fall * (age - slowed / drag);
      const angle = this.chipAngle[at]! + this.chipSpin[at]! * age;
      const left = 1 - age / life;
      const size = this.chipSize[at]! * (0.6 + 0.4 * left);
      const cos = Math.cos(angle) * size, sin = Math.sin(angle) * size;
      this.chips.mesh.setMatrixAt(at, this.matrix.set(
        cos * 1.6, -sin, 0, cx,
        sin * 1.6, cos, 0, cy,
        0, 0, 1, depth,
        0, 0, 0, 1,
      ));
      const glow = left * 1.6;
      const values = this.chips.tint.array as Float32Array;
      values[at * 3] = glow;
      values[at * 3 + 1] = glow * 0.42;
      values[at * 3 + 2] = glow * 0.08;
    }
  }
}
