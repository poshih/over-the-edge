import { DEFAULT_ARM_IK } from '../character';
import type { ArmIkSettings, VisualPartId } from '../character';
import { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
export { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
export { DEFAULT_ARM_IK, ARM_SIDES } from '../character';
export type { ArmIkSettings, ArmSide, VisualPartId } from '../character';

export const VISUAL_PARTS = [
  { id: 'pot', label: 'Pot', hint: 'Appearance only. The existing pot collider and mass stay unchanged. Hidden while the character profile has a pot model.' },
  { id: 'torso', label: 'Torso and neck', hint: 'Follows the non-rotating player root.' },
  { id: 'character-head', label: 'Character head', hint: 'Head, helmet or face model. This is not the hammer head.' },
  { id: 'left-upper-arm', label: 'Left upper arm', hint: 'Length along local Y. Follows visual-only arm IK.' },
  { id: 'right-upper-arm', label: 'Right upper arm', hint: 'Length along local Y. Follows visual-only arm IK.' },
  { id: 'left-forearm', label: 'Left forearm', hint: 'Length along local Y. Follows visual-only arm IK.' },
  { id: 'right-forearm', label: 'Right forearm', hint: 'Length along local Y. Follows visual-only arm IK.' },
  { id: 'left-elbow', label: 'Left elbow', hint: 'Optional visual joint cover; no physics body is added.' },
  { id: 'right-elbow', label: 'Right elbow', hint: 'Optional visual joint cover; no physics body is added.' },
  { id: 'left-hand', label: 'Left hand', hint: 'Follows the left grip point on the handle.' },
  { id: 'right-hand', label: 'Right hand', hint: 'Follows the right grip point on the handle.' },
  { id: 'hammer-shaft', label: 'Hammer shaft', hint: 'One full shaft along local X, stretched between its physical endpoints. It does not collide. Hidden while the character profile has a hammer model.' },
  { id: 'hammer-head', label: 'Hammer head', hint: 'Fit the model to the collision overlay. Importing does not change grip geometry or mass. Hidden while the character profile has a hammer model.' },
] as const;

export interface VisualAlignment {
  scale: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

export const DEFAULT_ALIGNMENT: Readonly<VisualAlignment> = Object.freeze({
  scale: 1, rotationX: 0, rotationY: 0, rotationZ: 0, offsetX: 0, offsetY: 0, offsetZ: 0,
});

export const ARM_IK_LIMITS = { min: -2, max: 2, step: 0.01, unit: 'm' } as const;
export const ARM_IK_FIELDS = [
  { side: 'left', key: 'leftHintX', label: 'Left elbow hint X' },
  { side: 'left', key: 'leftHintY', label: 'Left elbow hint Y' },
  { side: 'left', key: 'leftHintZ', label: 'Left elbow hint Z' },
  { side: 'right', key: 'rightHintX', label: 'Right elbow hint X' },
  { side: 'right', key: 'rightHintY', label: 'Right elbow hint Y' },
  { side: 'right', key: 'rightHintZ', label: 'Right elbow hint Z' },
] as const;

export const ALIGNMENT_FIELDS: readonly {
  key: keyof VisualAlignment; label: string; min: number; max: number; step: number; unit: string;
}[] = [
  { key: 'scale', label: 'Visual scale', min: 0.1, max: 4, step: 0.05, unit: 'x' },
  { key: 'rotationX', label: 'Rotate X', min: -180, max: 180, step: 1, unit: 'deg' },
  { key: 'rotationY', label: 'Rotate Y', min: -180, max: 180, step: 1, unit: 'deg' },
  { key: 'rotationZ', label: 'Rotate Z', min: -180, max: 180, step: 1, unit: 'deg' },
  { key: 'offsetX', label: 'Offset X', min: -1, max: 1, step: 0.01, unit: 'local' },
  { key: 'offsetY', label: 'Offset Y', min: -1, max: 1, step: 0.01, unit: 'local' },
  { key: 'offsetZ', label: 'Offset Z', min: -1, max: 1, step: 0.01, unit: 'local' },
];

export function validateArmIk(value: unknown): ArmIkSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== ARM_IK_FIELDS.length) {
    throw new AppearanceError('Arm IK settings must contain all six body-relative hint coordinates.');
  }
  const result = { ...DEFAULT_ARM_IK };
  for (const field of ARM_IK_FIELDS) {
    const coordinate: unknown = Reflect.get(value, field.key);
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) ||
      coordinate < ARM_IK_LIMITS.min || coordinate > ARM_IK_LIMITS.max) {
      throw new AppearanceError(`${field.label} must be between ${ARM_IK_LIMITS.min} and ${ARM_IK_LIMITS.max} metres.`);
    }
    result[field.key] = coordinate;
  }
  return result;
}

export function isVisualPart(value: unknown): value is VisualPartId {
  return typeof value === 'string' && VISUAL_PARTS.some((part) => part.id === value);
}

export function validateAlignment(value: unknown): VisualAlignment {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== ALIGNMENT_FIELDS.length) {
    throw new AppearanceError('The saved visual alignment has an invalid format.');
  }
  const result = { ...DEFAULT_ALIGNMENT };
  for (const field of ALIGNMENT_FIELDS) {
    const candidate: unknown = Reflect.get(value, field.key);
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) ||
      candidate < field.min || candidate > field.max) {
      throw new AppearanceError(`${field.label} must be between ${field.min} and ${field.max}.`);
    }
    result[field.key] = candidate;
  }
  return result;
}

export interface StoredVisual {
  schemaVersion: 1;
  slot: VisualPartId;
  name: string;
  data: Blob;
  alignment: VisualAlignment;
}

export function validateStoredVisual(value: unknown, slot: VisualPartId): StoredVisual {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 5 ||
    Reflect.get(value, 'schemaVersion') !== 1 || Reflect.get(value, 'slot') !== slot) {
    throw new AppearanceError('The saved model record has an unsupported format.');
  }
  const name: unknown = Reflect.get(value, 'name');
  const data: unknown = Reflect.get(value, 'data');
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 ||
    !(data instanceof Blob) || data.size === 0 || data.size > MODEL_LIMITS.bytes) {
    throw new AppearanceError('The saved model file is missing or exceeds the import limit.');
  }
  return { schemaVersion: 1, slot, name, data, alignment: validateAlignment(Reflect.get(value, 'alignment')) };
}
