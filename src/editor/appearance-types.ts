import type { VisualPartId } from '../character';
import { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
import { validateAlignment } from '../appearance-profile';
import type { VisualAlignment } from '../appearance-profile';
export { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
export { DEFAULT_ARM_IK, ARM_SIDES } from '../character';
export type { ArmIkSettings, ArmSide, VisualPartId } from '../character';
export {
  ALIGNMENT_FIELDS, ARM_IK_FIELDS, ARM_IK_LIMITS, DEFAULT_ALIGNMENT, validateAlignment, validateArmIk,
} from '../appearance-profile';
export type { VisualAlignment } from '../appearance-profile';

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

export function isVisualPart(value: unknown): value is VisualPartId {
  return typeof value === 'string' && VISUAL_PARTS.some((part) => part.id === value);
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
