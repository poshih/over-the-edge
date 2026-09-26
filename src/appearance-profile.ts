import { DEFAULT_ARM_IK, VISUAL_PART_IDS } from './character';
import type { ArmIkSettings, VisualPartId } from './character';
import { ModelError as AppearanceError } from './model-data';

// Per-part GLB replacements and elbow hints, shared by the Workshop, project files and releases.
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

export function isVisualPartId(value: unknown): value is VisualPartId {
  return typeof value === 'string' && (VISUAL_PART_IDS as readonly string[]).includes(value);
}

export const APPEARANCE_NAME_LIMIT = 255;

// One imported part model in a project: which part it replaces, its file name and its fit.
export interface AppearancePart {
  readonly part: VisualPartId;
  readonly name: string;
  readonly alignment: Readonly<VisualAlignment>;
}

export function validateAppearanceParts(value: unknown): readonly AppearancePart[] {
  if (!Array.isArray(value) || value.length > VISUAL_PART_IDS.length) {
    throw new AppearanceError(`Appearance must be a list of at most ${VISUAL_PART_IDS.length} part models.`);
  }
  const seen = new Set<VisualPartId>();
  return Object.freeze(value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.keys(entry).length !== 3) {
      throw new AppearanceError('Each appearance part must contain exactly part, name and alignment.');
    }
    const part: unknown = Reflect.get(entry, 'part');
    const name: unknown = Reflect.get(entry, 'name');
    if (!isVisualPartId(part)) throw new AppearanceError(`Unknown appearance part "${String(part)}". Use one of ${VISUAL_PART_IDS.join(', ')}.`);
    if (seen.has(part)) throw new AppearanceError(`Appearance part "${part}" is listed twice.`);
    seen.add(part);
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > APPEARANCE_NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new AppearanceError(`Appearance part "${part}" needs a file name of 1-${APPEARANCE_NAME_LIMIT} characters.`);
    }
    return Object.freeze({ part, name: name.trim(), alignment: Object.freeze(validateAlignment(Reflect.get(entry, 'alignment'))) });
  }));
}
