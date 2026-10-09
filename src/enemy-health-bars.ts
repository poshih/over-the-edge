import { Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial } from 'three';
import type { MomentEffect } from './effects';
import { ENEMY_LIMITS, ENEMY_SPECS } from './enemy-types';
import type { EnemySpecies } from './enemy-types';
import type { Moment } from './moments';
import { OBSTACLE_LINE } from './obstacle-line';
import type { SceneFrame } from './scene-frame';

// Over a hurt enemy, a bar shows the share of its hit points left, with a pale chunk for what its latest hits took that
// drains away soon after. The bar shows for a few seconds after each hit, and goes when the enemy heals or falls to its
// death, and every bar goes when the enemies come back, as lighting a bonfire and every placement bring them. A hammer's
// killing blow empties it where the enemy fell, fading with the enemy.
const BAR = {
  // Seconds a bar shows after the enemy's latest hit, fading over the last `fade`.
  show: 5, fade: 0.6,
  // After a hit, the pale chunk holds for `hold` seconds, then drains over `drain`.
  hold: 0.5, drain: 0.4,
  // In metres: the bar's size, its frame's thickness and its gap above the enemy's drawing.
  width: 0.9, height: 0.085, edge: 0.012, gap: 0.18,
  // Over the strikes, under the aim marks.
  renderOrder: 19,
} as const;

// sRGB colours: the hit points left, the pale chunk, the emptied bar and the frame.
const COLORS = { fill: 0xb3261e, chunk: 0xe8c879, back: 0x1a1412, edge: 0x050404 } as const;

// Per bar: the share of hit points left, the pale chunk's top and the opacity.
const VERTEX = /* glsl */ `
attribute vec3 bar;
varying vec2 vUv;
varying vec3 vBar;
void main() {
  vUv = uv;
  vBar = bar;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 fillColor;
uniform vec3 chunkColor;
uniform vec3 backColor;
uniform vec3 edgeColor;
varying vec2 vUv;
varying vec3 vBar;
void main() {
  vec2 edge = vec2(${(BAR.edge / BAR.width).toFixed(5)}, ${(BAR.edge / BAR.height).toFixed(5)});
  bool framed = any(lessThan(vUv, edge)) || any(greaterThan(vUv, 1.0 - edge));
  float along = (vUv.x - edge.x) / (1.0 - 2.0 * edge.x);
  vec3 color = framed ? edgeColor : along < vBar.x ? fillColor : along < vBar.y ? chunkColor : backColor;
  float alpha = framed ? 0.9 : along < vBar.y ? 1.0 : 0.6;
  gl_FragColor = vec4(color, alpha * vBar.z);
  #include <colorspace_fragment>
}
`;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The engine's enemy health bars: one instanced batch in the marks pass, updated only while a bar shows. */
export class EnemyHealthBars implements MomentEffect {
  readonly root = new Group();
  readonly pass = 'marks';
  readonly moments = Object.freeze(['enemy-hit', 'enemy-defeat', 'placed', 'bonfire'] as const);
  private readonly mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>;
  private readonly bars: InstancedBufferAttribute;
  private readonly matrix = new Matrix4();
  // Bars fill the first `count` slots; removing one moves the last into its slot.
  private count = 0;
  private readonly slots = new Map<string, number>();
  private readonly ids = Array<string>(ENEMY_LIMITS.objects).fill('');
  private readonly species = Array<EnemySpecies>(ENEMY_LIMITS.objects).fill('bird');
  private readonly x = new Float32Array(ENEMY_LIMITS.objects);
  private readonly y = new Float32Array(ENEMY_LIMITS.objects);
  // The share of hit points left; the pale chunk's top as the latest hit left it, and when that hit landed; and when
  // the bar goes.
  private readonly left = new Float32Array(ENEMY_LIMITS.objects);
  private readonly chunk = new Float32Array(ENEMY_LIMITS.objects);
  private readonly hitAt = new Float64Array(ENEMY_LIMITS.objects);
  private readonly hideAt = new Float64Array(ENEMY_LIMITS.objects);
  // A defeated enemy's bar stays where it fell. A living enemy's follows its drawing, showing only while it is drawn.
  private readonly defeated = new Uint8Array(ENEMY_LIMITS.objects);
  private readonly drawn = new Uint8Array(ENEMY_LIMITS.objects);

  constructor() {
    const geometry = new PlaneGeometry(1, 1);
    this.bars = new InstancedBufferAttribute(new Float32Array(ENEMY_LIMITS.objects * 3), 3).setUsage(DynamicDrawUsage);
    geometry.setAttribute('bar', this.bars);
    const material = new ShaderMaterial({
      uniforms: {
        fillColor: { value: new Color(COLORS.fill) }, chunkColor: { value: new Color(COLORS.chunk) },
        backColor: { value: new Color(COLORS.back) }, edgeColor: { value: new Color(COLORS.edge) },
      },
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      // Marks ignore depth.
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new InstancedMesh(geometry, material, ENEMY_LIMITS.objects);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = BAR.renderOrder;
    this.root.add(this.mesh);
    this.root.visible = false;
  }

  moment(moment: Moment): void {
    // Every enemy comes back home at full health.
    if (moment.type === 'placed' || moment.type === 'bonfire') this.clear();
    else if (moment.type === 'enemy-hit') {
      this.hit(moment.id, moment.species, moment.x, moment.y, moment.time,
        (moment.health + moment.damage) / moment.max, moment.health / moment.max, false);
    } else if (moment.type === 'enemy-defeat') {
      if (moment.by === 'hammer') this.hit(moment.id, moment.species, moment.x, moment.y, moment.time, moment.damage / moment.max, 0, true);
      else {
        const slot = this.slots.get(moment.id);
        if (slot !== undefined) this.remove(slot);
      }
    }
  }

  update(frame: SceneFrame): boolean {
    const time = frame.time;
    if (this.count > 0) this.follow(frame);
    let shown = 0;
    for (let slot = 0; slot < this.count;) {
      if (time >= this.hideAt[slot]!) {
        this.remove(slot);
        continue;
      }
      if (this.defeated[slot] === 1 || this.drawn[slot] === 1) this.place(slot, shown++, time);
      slot++;
    }
    this.mesh.count = shown;
    if (shown > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.bars.needsUpdate = true;
    }
    this.root.visible = shown > 0;
    return this.count > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }

  // Living enemies' bars follow their drawings and hit points.
  private follow(frame: SceneFrame): void {
    this.drawn.fill(0, 0, this.count);
    const enemies = frame.enemies;
    for (let index = 0; index < enemies.length; index++) {
      const enemy = enemies[index]!;
      const slot = this.slots.get(enemy.id);
      if (slot === undefined || this.defeated[slot] === 1) continue;
      // Healed, as when the level's objects are restored.
      if (enemy.health >= enemy.maxHealth) {
        this.remove(slot);
        continue;
      }
      this.x[slot] = enemy.x;
      this.y[slot] = enemy.y;
      this.left[slot] = enemy.health / enemy.maxHealth;
      this.drawn[slot] = 1;
    }
  }

  // A hit that took the enemy from `before` to `after`, as shares of its hit points.
  private hit(id: string, species: EnemySpecies, x: number, y: number, time: number, before: number, after: number, defeated: boolean): void {
    let slot = this.slots.get(id);
    // A chunk still showing keeps its top, so quick hits add up in one chunk.
    const top = slot === undefined || this.defeated[slot] === 1 ? before : Math.max(before, this.chunkTop(slot, time));
    slot ??= this.add(id);
    this.species[slot] = species;
    this.x[slot] = x;
    this.y[slot] = y;
    this.left[slot] = after;
    this.chunk[slot] = top;
    this.hitAt[slot] = time;
    this.defeated[slot] = defeated ? 1 : 0;
    this.hideAt[slot] = time + (defeated ? BAR.hold + BAR.drain : BAR.show);
  }

  // The pale chunk's top at `time`: where the latest hit left it until the hold ends, then draining to what is left.
  private chunkTop(slot: number, time: number): number {
    const drained = clamp01((time - this.hitAt[slot]! - BAR.hold) / BAR.drain);
    return this.chunk[slot]! + (this.left[slot]! - this.chunk[slot]!) * drained;
  }

  private place(slot: number, instance: number, time: number): void {
    const above = ENEMY_SPECS[this.species[slot]!].height / 2 + BAR.gap + BAR.height / 2;
    this.matrix.makeScale(BAR.width, BAR.height, 1).setPosition(this.x[slot]!, this.y[slot]! + above, OBSTACLE_LINE);
    this.mesh.setMatrixAt(instance, this.matrix);
    const values = this.bars.array as Float32Array;
    values[instance * 3] = this.left[slot]!;
    values[instance * 3 + 1] = this.chunkTop(slot, time);
    values[instance * 3 + 2] = clamp01((this.hideAt[slot]! - time) / BAR.fade);
  }

  // A new bar's slot. With every slot taken, the bar that would go soonest gives way.
  private add(id: string): number {
    if (this.count === ENEMY_LIMITS.objects) {
      let soonest = 0;
      for (let slot = 1; slot < this.count; slot++) if (this.hideAt[slot]! < this.hideAt[soonest]!) soonest = slot;
      this.remove(soonest);
    }
    const slot = this.count++;
    this.ids[slot] = id;
    this.slots.set(id, slot);
    return slot;
  }

  private remove(slot: number): void {
    this.slots.delete(this.ids[slot]!);
    const last = --this.count;
    if (slot !== last) {
      const moved = this.ids[last]!;
      this.ids[slot] = moved;
      this.slots.set(moved, slot);
      this.species[slot] = this.species[last]!;
      this.x[slot] = this.x[last]!;
      this.y[slot] = this.y[last]!;
      this.left[slot] = this.left[last]!;
      this.chunk[slot] = this.chunk[last]!;
      this.hitAt[slot] = this.hitAt[last]!;
      this.hideAt[slot] = this.hideAt[last]!;
      this.defeated[slot] = this.defeated[last]!;
      this.drawn[slot] = this.drawn[last]!;
    }
    this.ids[last] = '';
  }

  private clear(): void {
    this.ids.fill('', 0, this.count);
    this.slots.clear();
    this.count = 0;
    this.mesh.count = 0;
    this.root.visible = false;
  }
}
