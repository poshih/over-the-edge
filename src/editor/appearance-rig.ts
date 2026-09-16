import { Box3, Euler, Group, MathUtils, Matrix4, Vector3 } from 'three';
import type { Object3D } from 'three';
import { RIG } from '../config';
import type { VisualBinding as RuntimeBinding } from '../character';
import { VISUAL_PARTS } from './appearance-types';
import type { VisualAlignment, VisualPartId } from './appearance-types';
import type { LoadedVisual } from './visual-model';

interface VisualBinding {
  anchor: Group;
  defaults: readonly Object3D[];
  bounds: Box3;
  model: LoadedVisual | null;
  replacement: Group | null;
  orientation: Group | null;
}

export class AppearanceRig {
  private readonly bindings = new Map<VisualPartId, VisualBinding>();

  constructor(slots: ReadonlyMap<VisualPartId, RuntimeBinding>) {
    for (const [slot, { anchor, defaults }] of slots) {
      const template = new Group();
      // Clone only object transforms: fitting must not inherit a live physics anchor's pose or scale.
      if (slot !== 'hammer-shaft') for (const object of defaults) template.add(object.clone());
      const bounds = slot === 'hammer-shaft' ? new Box3(
        new Vector3(-RIG.handleLength / 2, -RIG.handleHalfWidth, -RIG.handleHalfWidth),
        new Vector3(RIG.handleLength / 2, RIG.handleHalfWidth, RIG.handleHalfWidth),
      ) : new Box3().setFromObject(template, true);
      if (bounds.isEmpty()) throw new Error(`The visual slot ${slot} has no fitting bounds.`);
      this.bindings.set(slot, { anchor, defaults, bounds, model: null, replacement: null, orientation: null });
    }
  }

  assertComplete(): void {
    for (const slot of VISUAL_PARTS) this.binding(slot.id);
  }

  setModel(slot: VisualPartId, model: LoadedVisual, alignment: Readonly<VisualAlignment>): void {
    const binding = this.binding(slot);
    this.reset(slot);
    const centered = new Group();
    centered.position.copy(model.bounds.getCenter(new Vector3())).negate();
    centered.add(model.scene);
    const orientation = new Group();
    orientation.add(centered);
    const replacement = new Group();
    replacement.add(orientation);
    binding.anchor.add(replacement);
    binding.model = model;
    binding.replacement = replacement;
    binding.orientation = orientation;
    for (const object of binding.defaults) object.visible = false;
    this.align(slot, alignment);
  }

  align(slot: VisualPartId, alignment: Readonly<VisualAlignment>): void {
    const binding = this.binding(slot);
    if (!binding.model || !binding.replacement || !binding.orientation) {
      throw new Error(`Cannot align ${slot} without a custom model.`);
    }
    const rotation = new Euler(
      MathUtils.degToRad(alignment.rotationX),
      MathUtils.degToRad(alignment.rotationY),
      MathUtils.degToRad(alignment.rotationZ),
    );
    // Fitting uses asset-local bounds, never the moving physics anchor's world transform.
    const center = binding.model.bounds.getCenter(new Vector3());
    const orientedBounds = binding.model.bounds.clone()
      .translate(center.negate()).applyMatrix4(new Matrix4().makeRotationFromEuler(rotation));
    const size = orientedBounds.getSize(new Vector3());
    const target = binding.bounds.getSize(new Vector3());
    const ratios = [0, 1, 2].filter((axis) => size.getComponent(axis) > 1e-8)
      .map((axis) => target.getComponent(axis) / size.getComponent(axis));
    const scale = Math.min(...ratios) * alignment.scale;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Invalid visual fit for ${slot}.`);
    binding.orientation.rotation.copy(rotation);
    binding.replacement.scale.setScalar(scale);
    binding.replacement.position.copy(binding.bounds.getCenter(new Vector3()))
      .add(new Vector3(alignment.offsetX, alignment.offsetY, alignment.offsetZ));
  }

  isCustom(slot: VisualPartId): boolean {
    return this.binding(slot).model !== null;
  }

  reset(slot: VisualPartId): void {
    const binding = this.binding(slot);
    binding.replacement?.removeFromParent();
    binding.model?.dispose();
    binding.model = null;
    binding.replacement = null;
    binding.orientation = null;
    for (const object of binding.defaults) object.visible = true;
  }

  inspect(slot: VisualPartId) {
    const binding = this.binding(slot);
    const world = binding.anchor.getWorldPosition(new Vector3());
    return {
      custom: binding.model !== null,
      triangles: binding.model ? binding.model.triangles : 0,
      defaultsVisible: binding.defaults.every((object) => object.visible),
      anchor: { x: world.x, y: world.y, z: world.z },
      transform: binding.anchor.matrixWorld.toArray(),
    };
  }

  dispose(): void {
    for (const slot of this.bindings.keys()) this.reset(slot);
    this.bindings.clear();
  }

  private binding(slot: VisualPartId): VisualBinding {
    const binding = this.bindings.get(slot);
    if (!binding) throw new Error(`Unregistered visual slot: ${slot}`);
    return binding;
  }
}
