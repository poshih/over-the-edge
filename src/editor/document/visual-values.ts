import { ALIGNMENT_FIELDS, ARM_IK_FIELDS, validateAlignment, validateAppearanceParts, validateArmIk } from '../../appearance-profile';
import type { VisualAlignment } from '../../appearance-profile';
import { DEFAULT_ARM_IK, VISUAL_PART_IDS } from '../../character';
import type { VisualPartId } from '../../character';
import { ModelError as AppearanceError, MODEL_LIMITS } from '../../model-data';
import type { AvatarHoldSettings } from '../../model-library';
import { PROJECT_LIMITS } from '../../project';
import { EMPTY_SPRITES } from '../../sprite-data';
import type { FileStore } from './files';
import type {
  DocumentAppearance, DocumentAppearancePart, DocumentArmIk, ProjectDocument, VisualSectionValues,
} from './project-document';

export const NO_APPEARANCE: DocumentAppearance = Object.freeze([]);

// The default character, elbow hints and part visuals.
export const DEFAULT_VISUAL_VALUES: VisualSectionValues = Object.freeze({
  'characters/primary': EMPTY_SPRITES,
  'arm-ik': DEFAULT_ARM_IK,
  appearance: NO_APPEARANCE,
});

const PART_ORDER: ReadonlyMap<VisualPartId, number> = new Map(VISUAL_PART_IDS.map((part, index) => [part, index]));

// The primary character's grips, arm lengths and arm forward distance, which a library avatar takes.
export function characterHoldSettings(document: ProjectDocument): AvatarHoldSettings {
  const { armForwardDistance, grips, arms } = document.get('characters/primary');
  return { armForwardDistance, grips, arms };
}

// Checked elbow hints, frozen, or `current` when they are its numbers.
export function armIkValue(value: unknown, current: DocumentArmIk): DocumentArmIk {
  const next = validateArmIk(value);
  return ARM_IK_FIELDS.every(({ key }) => next[key] === current[key]) ? current : Object.freeze(next);
}

function sameAlignment(left: Readonly<VisualAlignment>, right: Readonly<VisualAlignment>): boolean {
  return left === right || ALIGNMENT_FIELDS.every(({ key }) => left[key] === right[key]);
}

// A checked part fit, frozen, or `current` when it is its numbers.
export function alignmentValue(value: unknown, current: Readonly<VisualAlignment>): Readonly<VisualAlignment> {
  const next = validateAlignment(value);
  return sameAlignment(next, current) ? current : Object.freeze(next);
}

/**
 * The part models `value` lists, checked as a project's (one per part, names, fits, each GLB within the model limit and
 * all within the appearance budget) and in part order. Unchanged entries and fits are `current`'s own, and an equal list
 * is `current` itself. Every file is a handle `files` knows; its bytes are never read here.
 */
export function appearanceValue(value: DocumentAppearance, current: DocumentAppearance, files: FileStore): DocumentAppearance {
  if (value === current) return current;
  const parts = validateAppearanceParts(value.map(({ part, name, alignment }) => ({ part, name, alignment })));
  const previous = new Map(current.map((entry) => [entry.part, entry]));
  let total = 0;
  const entries = parts.map((entry, index): DocumentAppearancePart => {
    const file = value[index]!.file;
    files.locations(file);
    if (!Object.isFrozen(file)) throw new Error('A document file handle must be frozen.');
    if (file.bytes < 1 || file.bytes > MODEL_LIMITS.bytes) {
      throw new AppearanceError(`The ${entry.part} GLB must hold 1 byte to ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
    }
    total += file.bytes;
    const before = previous.get(entry.part);
    if (before === undefined) return Object.freeze({ ...entry, file });
    const alignment = sameAlignment(before.alignment, entry.alignment) ? before.alignment : entry.alignment;
    return before.name === entry.name && before.file === file && alignment === before.alignment
      ? before : Object.freeze({ part: entry.part, name: entry.name, alignment, file });
  }).sort((left, right) => PART_ORDER.get(left.part)! - PART_ORDER.get(right.part)!);
  if (total > PROJECT_LIMITS.appearanceBytes) {
    throw new AppearanceError(`The project's appearance files exceed ${PROJECT_LIMITS.appearanceBytes / 1024 ** 2} MiB.`);
  }
  return entries.length === current.length && entries.every((entry, index) => entry === current[index])
    ? current : Object.freeze(entries);
}
