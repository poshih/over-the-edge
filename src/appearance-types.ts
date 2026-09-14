export const VISUAL_PARTS = [
  { id: 'pot', label: 'Pot', hint: 'Appearance only. The existing pot collider and mass stay unchanged.' },
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
  { id: 'hammer-shaft', label: 'Hammer shaft', hint: 'One full shaft along local X, stretched between its physical endpoints. It does not collide.' },
  { id: 'hammer-head', label: 'Hammer head', hint: 'Fit the model to the collision overlay. Importing does not change grip geometry or mass.' },
] as const;

export type VisualPartId = (typeof VISUAL_PARTS)[number]['id'];

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

export interface ArmIkSettings {
  leftElbowAngle: number;
  rightElbowAngle: number;
}

export const DEFAULT_ARM_IK: Readonly<ArmIkSettings> = Object.freeze({
  leftElbowAngle: 0, rightElbowAngle: 0,
});

export const ARM_IK_LIMITS = { min: -180, max: 180, step: 1, unit: 'deg' } as const;
export const ARM_IK_FIELDS = [
  { side: 'left', key: 'leftElbowAngle', label: 'Left elbow direction' },
  { side: 'right', key: 'rightElbowAngle', label: 'Right elbow direction' },
] as const;
export type ArmSide = (typeof ARM_IK_FIELDS)[number]['side'];

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

export const MODEL_LIMITS = {
  bytes: 20 * 1024 * 1024,
  triangles: 250_000,
  meshes: 128,
  nodes: 2048,
  textureEdge: 4096,
  minimumSpan: 0.000001,
  maximumSpan: 1_000_000,
} as const;

export class AppearanceError extends Error {}

export function validateArmIk(value: unknown): ArmIkSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== ARM_IK_FIELDS.length) {
    throw new AppearanceError('Arm IK settings must contain both elbow directions.');
  }
  const result = { ...DEFAULT_ARM_IK };
  for (const field of ARM_IK_FIELDS) {
    const angle: unknown = Reflect.get(value, field.key);
    if (typeof angle !== 'number' || !Number.isFinite(angle) ||
      angle < ARM_IK_LIMITS.min || angle > ARM_IK_LIMITS.max) {
      throw new AppearanceError(`${field.label} must be between ${ARM_IK_LIMITS.min} and ${ARM_IK_LIMITS.max} degrees.`);
    }
    result[field.key] = angle;
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
