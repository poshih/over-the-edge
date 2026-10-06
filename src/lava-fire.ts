import {
  AdditiveBlending, Color, DataTexture, DynamicDrawUsage, InstancedMesh, LinearFilter, Matrix4, MeshBasicMaterial,
  PlaneGeometry, RGBAFormat,
} from 'three';
import type { HurtCause } from './hazards';
import type { HurtEffects } from './hurt-effects';
import type { SceneFrame } from './scene-layer';

// Flames rising over the character while lava burns it. Lava burns once a second while the pot stays in it, so each
// burn keeps the fire going a little longer than that, and the fire dies down once the character is out.
const FIRE = {
  flames: 18,
  // How long a burn keeps the fire going, then how long it takes to die down, in seconds.
  burn: 1.15, fade: 0.35,
  // Where flames are born about the character's root: across the pot, and a little below its middle.
  halfWidth: 0.42, base: -0.35,
  // Each flame's life in seconds, its height at birth in metres and how far it rises, ranges picked per flame.
  life: [0.45, 0.8], size: [0.35, 0.62], rise: [0.9, 1.5],
  // In front of the character's middle, so in perspective it lies over the character.
  depth: 0.55,
} as const;

// A per-flame number in 0-1, the same on every run.
function seeded(index: number, salt: number): number {
  let hash = Math.imul(index + 1, 0x27d4eb2d) ^ Math.imul(salt, 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

function between(range: readonly [number, number], at: number): number {
  return range[0] + (range[1] - range[0]) * at;
}

// A soft tongue of flame, widest and brightest at its base, in the alpha of a white texture.
function flameTexture(): DataTexture {
  const width = 32, height = 64;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const v = (row + 0.5) / height;
    const halfWidth = 0.5 * (1 - v) ** 0.65 * Math.min(1, 0.35 + v / 0.12);
    for (let column = 0; column < width; column++) {
      const u = Math.abs((column + 0.5) / width - 0.5);
      const alpha = Math.max(0, 1 - u / halfWidth) ** 1.4 * (1 - v) ** 0.5;
      const offset = (row * width + column) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 255;
      data[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The engine's hurt effects: the character catches fire while lava burns it. Other hits show nothing more. */
export class LavaFire implements HurtEffects {
  readonly root: InstancedMesh;
  private readonly texture = flameTexture();
  private readonly geometry = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
  private readonly material = new MeshBasicMaterial({
    map: this.texture, transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false, fog: false,
    toneMapped: false,
  });
  // Each flame's life, delay after the fire starts, offset across the pot (-1 to 1), size, rise and sway.
  private readonly life = new Float32Array(FIRE.flames);
  private readonly delay = new Float32Array(FIRE.flames);
  private readonly across = new Float32Array(FIRE.flames);
  private readonly size = new Float32Array(FIRE.flames);
  private readonly rise = new Float32Array(FIRE.flames);
  private readonly sway = new Float32Array(FIRE.flames);
  private readonly matrix = new Matrix4();
  private readonly color = new Color();
  private readonly hidden = new Matrix4().makeScale(0, 0, 0);
  // A burn arrived since the last drawn frame.
  private igniting = false;
  private burning = false;
  // When, in run time, the fire started, and when its latest burn stops keeping it going.
  private start = 0;
  private burnUntil = 0;

  constructor() {
    this.root = new InstancedMesh(this.geometry, this.material, FIRE.flames);
    this.root.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let index = 0; index < FIRE.flames; index++) {
      this.life[index] = between(FIRE.life, seeded(index, 1));
      this.delay[index] = seeded(index, 2) * this.life[index]!;
      this.across[index] = seeded(index, 3) * 2 - 1;
      this.size[index] = between(FIRE.size, seeded(index, 4));
      this.rise[index] = between(FIRE.rise, seeded(index, 5));
      this.sway[index] = seeded(index, 6) * Math.PI * 2;
      this.root.setMatrixAt(index, this.hidden);
      this.root.setColorAt(index, this.color.setRGB(0, 0, 0));
    }
    this.root.instanceColor!.setUsage(DynamicDrawUsage);
    this.root.frustumCulled = false;
    // Under the aim marks.
    this.root.renderOrder = 10;
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
    if (this.igniting) {
      this.igniting = false;
      // A new fire, or one whose run time was rewound, starts its flames afresh from the pot.
      if (!this.burning || time < this.start) this.start = time;
      this.burning = true;
      this.burnUntil = time + FIRE.burn;
    }
    if (!this.burning) return false;
    const strength = time <= this.burnUntil ? 1 : 1 - (time - this.burnUntil) / FIRE.fade;
    let root: SceneFrame['parts'][number] | undefined;
    for (let index = 0; index < frame.parts.length; index++) {
      if (frame.parts[index]!.kind === 'root') root = frame.parts[index];
    }
    if (strength <= 0 || time < this.start || root === undefined) {
      this.clear();
      return false;
    }
    const elapsed = time - this.start;
    for (let index = 0; index < FIRE.flames; index++) {
      const life = this.life[index]!;
      const lived = elapsed - this.delay[index]!;
      // Not born yet, or born once the burns stopped keeping the fire going.
      if (lived < 0 || time - lived % life > this.burnUntil) {
        this.root.setMatrixAt(index, this.hidden);
        continue;
      }
      const progress = (lived % life) / life;
      const sway = Math.sin(time * 7 + this.sway[index]!) * 0.05 * progress;
      const x = root.x + this.across[index]! * FIRE.halfWidth * (1 - 0.6 * progress) + sway;
      const y = root.y + FIRE.base + this.rise[index]! * progress;
      const flicker = 0.85 + 0.15 * Math.sin(time * 23 + index * 1.7);
      const height = this.size[index]! * (1 - 0.55 * progress) * flicker;
      this.root.setMatrixAt(index, this.matrix.makeScale(height * 0.6, height, 1).setPosition(x, y, FIRE.depth));
      // White-hot at birth, through orange to a deep red as it dies away.
      const glow = strength * Math.min(1, progress / 0.12) * (1 - progress) ** 1.2 * 1.6;
      this.root.setColorAt(index, this.color.setRGB(glow, glow * (0.85 - 0.6 * progress), glow * (0.45 - 0.42 * progress)));
    }
    this.root.instanceMatrix.needsUpdate = true;
    this.root.instanceColor!.needsUpdate = true;
    this.root.visible = true;
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.root.dispose();
  }
}
