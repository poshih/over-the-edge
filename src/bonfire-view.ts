import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { ModelKit } from './decoration-geometry';
import { HAZARD_LIMITS } from './hazards';
import { markInstanceSlot } from './instancing';
import type { BonfireObject, LevelObject } from './level';
import { ObjectView } from './object-view';

const ASH = 0x3a3634;
const STONE = 0x6f6a62;
const STONE_DARK = 0x4d4944;
const WOOD = 0x4a3526;
const CHARRED = 0x231b16;
const EMBER = 0xff7a1f;
const FLAME = 0xffc35a;

// A ring of stones round an ash bed and logs leaning together, its base centre at the origin; the flames glow.
function bonfireModel() {
  const kit = new ModelKit(0xb0f1e);
  kit.cylinder(0.4, 0.44, 0.06, ASH, { y: 0.03 }, 10);
  for (let index = 0; index < 8; index++) {
    const turn = (index / 8) * Math.PI * 2 + kit.between(-0.15, 0.15);
    kit.rock(kit.between(0.1, 0.13), index % 3 === 0 ? STONE_DARK : STONE, {
      x: Math.cos(turn) * 0.46, y: 0.06, z: Math.sin(turn) * 0.38, sy: 0.7, ry: turn,
    });
  }
  for (let index = 0; index < 5; index++) {
    const turn = (index / 5) * Math.PI * 2 + 0.3;
    kit.beam([Math.cos(turn) * 0.34, 0.04, Math.sin(turn) * 0.28], [Math.cos(turn) * 0.05, 0.52, Math.sin(turn) * 0.04],
      0.055, 0.04, index % 2 === 0 ? WOOD : CHARRED, 6);
  }
  for (let index = 0; index < 6; index++) {
    const tall = kit.between(0.55, 1.15);
    kit.cone(kit.between(0.1, 0.17), tall, index % 2 === 0 ? EMBER : FLAME, {
      x: kit.between(-0.18, 0.18), y: 0.12 + tall / 2, z: kit.between(-0.12, 0.12), rz: kit.between(-0.15, 0.15),
    }, 5, true);
  }
  const model = kit.build('own');
  if (model.lit === null || model.glow === null) throw new Error('A bonfire needs its logs and its flames.');
  return { logs: model.lit, flames: model.glow };
}

/** The level's bonfires, on the obstacle line in the course pass. Those the player has reached burn. */
export class BonfireView extends ObjectView<BonfireObject> {
  private readonly lit = new Set<string>();
  // 1 for each slot whose bonfire burns, 0 for one that is out.
  private readonly burning: InstancedBufferAttribute;
  private readonly clock: { value: number };

  constructor() {
    const { logs, flames } = bonfireModel();
    const burning = new InstancedBufferAttribute(new Float32Array(HAZARD_LIMITS.bonfires), 1);
    burning.setUsage(DynamicDrawUsage);
    burning.onUpload(() => burning.clearUpdateRanges());
    flames.setAttribute('burning', burning);
    const clock = { value: 0 };
    const fire = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    fire.onBeforeCompile = (shader) => {
      shader.uniforms.flameTime = clock;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float burning;\nuniform float flameTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // A fire that is out shrinks to nothing; one that burns flickers, each at its own pace.
          transformed *= burning;
          transformed.y *= 0.85 + 0.15 * sin(flameTime * 9.0 + position.x * 13.0 + instanceMatrix[3].x * 1.7);`);
    };
    super({
      matches: (object: LevelObject): object is BonfireObject => object.kind === 'bonfire',
      capacity: HAZARD_LIMITS.bonfires, label: 'Bonfire',
      meshes: [
        new InstancedMesh(logs, new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05, flatShading: true }),
          HAZARD_LIMITS.bonfires),
        new InstancedMesh(flames, fire, HAZARD_LIMITS.bonfires),
      ],
      transform: (object, matrix) => matrix.makeTranslation(object.x, object.y, 0),
    });
    this.burning = burning;
    this.clock = clock;
  }

  // Burns the bonfires with these IDs and puts the rest out.
  setLit(ids: readonly string[]): void {
    const next = new Set(ids);
    for (const id of [...this.lit, ...next]) {
      if (this.lit.has(id) === next.has(id)) continue;
      if (next.has(id)) this.lit.add(id);
      else this.lit.delete(id);
      const drawn = this.drawn(id);
      if (drawn !== undefined) this.written(drawn.slot, drawn.object);
    }
  }

  update(time: number): void {
    this.updateBounds();
    if (this.root.visible) this.clock.value = time;
  }

  protected override written(slot: number, object: BonfireObject): void {
    const value = this.lit.has(object.id) ? 1 : 0;
    if (this.burning.getX(slot) === value) return;
    this.burning.setX(slot, value);
    markInstanceSlot(this.burning, slot);
  }
}
