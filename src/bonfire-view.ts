import { DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { BurningBonfire } from './bonfires';
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
// Seconds a fire takes to flare up once lit, and to die down before it goes out.
const KINDLE = 0.4;
const DIE_DOWN = 1.5;

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

/**
 * The level's bonfires, on the obstacle line in the course pass. One the player lights flares up, burns and dies down as
 * it goes out, all in the flames' shader from its times, so a burning fire costs nothing per frame.
 */
export class BonfireView extends ObjectView<BonfireObject> {
  private readonly burning = new Map<string, BurningBonfire>();
  // Per slot, the run seconds its bonfire was lit at and goes out at; both 0 for one that is out.
  private readonly fires: InstancedBufferAttribute;
  private readonly clock: { value: number };

  constructor() {
    const { logs, flames } = bonfireModel();
    const fires = new InstancedBufferAttribute(new Float32Array(HAZARD_LIMITS.bonfires * 2), 2);
    fires.setUsage(DynamicDrawUsage);
    fires.onUpload(() => fires.clearUpdateRanges());
    flames.setAttribute('fire', fires);
    const clock = { value: 0 };
    const fire = new MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    fire.onBeforeCompile = (shader) => {
      shader.uniforms.flameTime = clock;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 fire;\nuniform float flameTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // A fire grows from nothing as it is lit and shrinks back as it goes out; while it burns, each flickers at its
          // own pace.
          transformed *= clamp((flameTime - fire.x) / ${KINDLE.toFixed(2)}, 0.0, 1.0)
            * clamp((fire.y - flameTime) / ${DIE_DOWN.toFixed(2)}, 0.0, 1.0);
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
    this.fires = fires;
    this.clock = clock;
  }

  // Burns these bonfires, each from when it was lit until it goes out, and puts the rest out.
  setBurning(burning: readonly BurningBonfire[]): void {
    const previous = [...this.burning.keys()];
    this.burning.clear();
    for (const fire of burning) this.burning.set(fire.id, fire);
    for (const id of [...previous, ...this.burning.keys()]) {
      const drawn = this.drawn(id);
      if (drawn !== undefined) this.written(drawn.slot, drawn.object);
    }
  }

  update(time: number): void {
    this.updateBounds();
    if (this.root.visible) this.clock.value = time;
  }

  protected override written(slot: number, object: BonfireObject): void {
    const fire = this.burning.get(object.id);
    const litAt = Math.fround(fire?.litAt ?? 0), outAt = Math.fround(fire?.outAt ?? 0);
    if (this.fires.getX(slot) === litAt && this.fires.getY(slot) === outAt) return;
    this.fires.setXY(slot, litAt, outAt);
    markInstanceSlot(this.fires, slot);
  }
}
