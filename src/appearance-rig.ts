import { Euler, Group, MathUtils, Matrix4, Vector3 } from 'three';
import type { Box3, Object3D } from 'three';
import { VISUAL_PART_IDS } from './character';
import type { VisualBinding as RuntimeBinding, VisualPartId } from './character';
import type { VisualVisibility } from './visual-visibility';
import { validateAlignment } from './appearance-profile';
import type { VisualAlignment } from './appearance-profile';
import type { LoadedVisual } from './visual-model';
import { ModelError as AppearanceError } from './model-data';
import { Disposal } from './disposal';

interface VisualBinding {
  anchor: Group;
  defaults: readonly Object3D[];
  bounds: Box3;
  visibility: VisualVisibility;
  model: LoadedVisual | null;
  replacement: Group | null;
  orientation: Group | null;
}

interface VisualFit {
  readonly centering: Vector3;
  readonly rotation: Euler;
  readonly scale: number;
  readonly position: Vector3;
}

export class AppearanceRig {
  private readonly bindings = new Map<VisualPartId, VisualBinding>();
  private disposed = false;

  constructor(slots: ReadonlyMap<VisualPartId, RuntimeBinding>) {
    for (const [slot, { modelAnchor, defaults, bounds, visibility }] of slots) {
      if (bounds.isEmpty()) throw new Error(`The visual slot ${slot} has no fitting bounds.`);
      this.bindings.set(slot, { anchor: modelAnchor, defaults, bounds: bounds.clone(), visibility,
        model: null, replacement: null, orientation: null });
    }
  }

  assertComplete(): void {
    for (const slot of VISUAL_PART_IDS) this.binding(slot);
  }

  setModel(slot: VisualPartId, model: LoadedVisual, alignment: Readonly<VisualAlignment>): void {
    const binding = this.binding(slot);
    const fit = this.prepareFit(slot, binding, model, alignment);
    this.clear(binding);
    const centered = new Group();
    centered.position.copy(fit.centering);
    centered.add(model.scene);
    const orientation = new Group();
    orientation.add(centered);
    const replacement = new Group();
    replacement.add(orientation);
    binding.anchor.add(replacement);
    binding.model = model;
    binding.replacement = replacement;
    binding.orientation = orientation;
    this.applyFit(slot, binding, model, fit);
    binding.visibility.setReplacement(replacement);
  }

  align(slot: VisualPartId, alignment: Readonly<VisualAlignment>): void {
    const binding = this.binding(slot);
    const model = binding.model;
    if (model === null) throw new AppearanceError(`Cannot align ${slot} without a custom model.`);
    const fit = this.prepareFit(slot, binding, model, alignment);
    this.applyFit(slot, binding, model, fit);
  }

  reset(slot: VisualPartId): void {
    const binding = this.binding(slot);
    this.clear(binding);
  }

  private prepareFit(slot: VisualPartId, binding: VisualBinding, model: LoadedVisual,
    input: Readonly<VisualAlignment>): VisualFit {
    const alignment = validateAlignment(input);
    const rotation = new Euler(
      MathUtils.degToRad(alignment.rotationX),
      MathUtils.degToRad(alignment.rotationY),
      MathUtils.degToRad(alignment.rotationZ),
    );
    // Fitting uses asset-local bounds, never the moving physics anchor's world transform.
    const centering = model.bounds.getCenter(new Vector3()).negate();
    const orientedBounds = model.bounds.clone()
      .translate(centering).applyMatrix4(new Matrix4().makeRotationFromEuler(rotation));
    const size = orientedBounds.getSize(new Vector3());
    const target = binding.bounds.getSize(new Vector3());
    const ratios = [0, 1, 2].filter((axis) => size.getComponent(axis) > 1e-8)
      .map((axis) => target.getComponent(axis) / size.getComponent(axis));
    const scale = Math.min(...ratios) * alignment.scale;
    if (!Number.isFinite(scale) || scale <= 0) throw new AppearanceError(`Invalid visual fit for ${slot}.`);
    const position = binding.bounds.getCenter(new Vector3())
      .add(new Vector3(alignment.offsetX, alignment.offsetY, alignment.offsetZ));
    return { centering, rotation, scale, position };
  }

  private applyFit(slot: VisualPartId, binding: VisualBinding, model: LoadedVisual, fit: VisualFit): void {
    if (binding.model !== model || binding.replacement === null || binding.orientation === null) {
      throw new AppearanceError(`The prepared visual fit for ${slot} no longer matches its model.`);
    }
    binding.orientation.rotation.copy(fit.rotation);
    binding.replacement.scale.setScalar(fit.scale);
    binding.replacement.position.copy(fit.position);
  }

  private clear(binding: VisualBinding): void {
    binding.replacement?.removeFromParent();
    binding.model?.dispose();
    binding.model = null;
    binding.replacement = null;
    binding.orientation = null;
    binding.visibility.setReplacement(null);
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
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    for (const binding of this.bindings.values()) disposal.run(() => this.clear(binding));
    this.bindings.clear();
    disposal.finish();
  }

  private binding(slot: VisualPartId): VisualBinding {
    if (this.disposed) throw new Error('The appearance rig has been disposed.');
    const binding = this.bindings.get(slot);
    if (!binding) throw new Error(`Unregistered visual slot: ${slot}`);
    return binding;
  }
}
