import type { VisualPartId } from '../character';
import { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
import { validateAppearanceParts } from '../appearance-profile';
import type { VisualAlignment } from '../appearance-profile';
export { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
export { DEFAULT_ARM_IK } from '../character';
export type { ArmIkSettings, VisualPartId } from '../character';
export {
  ALIGNMENT_FIELDS, ARM_IK_FIELDS, ARM_IK_LIMITS, DEFAULT_ALIGNMENT,
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

export interface SavedAppearancePart {
  readonly schemaVersion: 1;
  readonly part: VisualPartId;
  readonly name: string;
  readonly alignment: Readonly<VisualAlignment>;
  readonly file: {
    readonly sha256: string;
    readonly bytes: number;
    readonly blob: Blob;
  };
}

export function validateSavedAppearancePart(value: unknown, part: VisualPartId): SavedAppearancePart {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 5 ||
    !['schemaVersion', 'part', 'name', 'alignment', 'file'].every((key) => Object.hasOwn(value, key)) ||
    Reflect.get(value, 'schemaVersion') !== 1 || Reflect.get(value, 'part') !== part) {
    throw new AppearanceError('The saved model record has an unsupported format.');
  }
  const file: unknown = Reflect.get(value, 'file');
  if (typeof file !== 'object' || file === null || Array.isArray(file) || Object.keys(file).length !== 3 ||
    !['sha256', 'bytes', 'blob'].every((key) => Object.hasOwn(file, key))) {
    throw new AppearanceError('The saved model file descriptor is invalid.');
  }
  const sha256: unknown = Reflect.get(file, 'sha256');
  const bytes: unknown = Reflect.get(file, 'bytes');
  const blob: unknown = Reflect.get(file, 'blob');
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MODEL_LIMITS.bytes ||
    !(blob instanceof Blob) || blob.size !== bytes) {
    throw new AppearanceError('The saved model bytes or digest are invalid.');
  }
  const entry = validateAppearanceParts([{
    part, name: Reflect.get(value, 'name'), alignment: Reflect.get(value, 'alignment'),
  }])[0]!;
  return Object.freeze({ schemaVersion: 1, ...entry, file: Object.freeze({ sha256, bytes, blob }) });
}
