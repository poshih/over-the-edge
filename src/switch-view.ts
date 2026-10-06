import { BoxGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial } from 'three';
import type { LevelObject, TriggerObject } from './level';
import { TRIGGER_LIMITS, triggerBounds } from './level';
import { markInstanceSlot } from './instancing';
import { ObjectView } from './object-view';

const SWITCH_HEIGHT = 0.08;
const SWITCH_DEPTH = 0.9;

/** A pressure switch plate at the bottom of its trigger. */
export class SwitchView extends ObjectView<TriggerObject> {
  private readonly pressed = new Set<string>();
  private readonly attribute: InstancedBufferAttribute;

  constructor() {
    const geometry = new BoxGeometry(1, 1, 1);
    const pressed = new InstancedBufferAttribute(new Float32Array(TRIGGER_LIMITS.objects), 1);
    pressed.setUsage(DynamicDrawUsage);
    pressed.onUpload(() => pressed.clearUpdateRanges());
    geometry.setAttribute('pressed', pressed);
    const material = new MeshStandardMaterial({ color: 0x60666a, roughness: 0.75, metalness: 0.45 });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float pressed;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y -= pressed * 0.55;');
    };
    super({
      matches: (object: LevelObject): object is TriggerObject => object.kind === 'trigger' && object.marker === 'switch',
      capacity: TRIGGER_LIMITS.objects, label: 'Pressure switch',
      meshes: [new InstancedMesh(geometry, material, TRIGGER_LIMITS.objects)],
      transform: (object, matrix) => {
        const bounds = triggerBounds(object);
        const width = object.region.type === 'circle' ? object.region.radius * 2 : object.region.width;
        matrix.makeScale(width, SWITCH_HEIGHT, SWITCH_DEPTH);
        matrix.setPosition(object.x, bounds.minY + SWITCH_HEIGHT / 2, 0);
        return matrix;
      },
    });
    this.attribute = pressed;
  }

  setPressed(ids: readonly string[]): void {
    const next = new Set(ids);
    for (const id of [...this.pressed, ...next]) {
      if (this.pressed.has(id) === next.has(id)) continue;
      if (next.has(id)) this.pressed.add(id);
      else this.pressed.delete(id);
      const drawn = this.drawn(id);
      if (drawn !== undefined) this.written(drawn.slot, drawn.object);
    }
  }

  update(): void {
    this.updateBounds();
  }

  protected override written(slot: number, object: TriggerObject): void {
    const value = this.pressed.has(object.id) ? 1 : 0;
    if (this.attribute.getX(slot) === value) return;
    this.attribute.setX(slot, value);
    markInstanceSlot(this.attribute, slot);
  }
}
