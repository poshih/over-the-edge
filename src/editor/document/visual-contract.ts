import type { VisualAlignment } from '../../appearance-profile';
import type { AvatarMotionEntry } from '../../avatar-motion-data';
import type { VisualPartId } from '../../character';
import type { CharacterArms } from '../../character-arms';
import type { AvatarModelSettings, CharacterModel, PropModelRole } from '../../character-profile';
import type { DirectionalPresentation } from '../../directional-data';
import type { Grips } from '../../grips';
import type { FacingDirection, SkeletonDefinition, SpriteSkin } from '../../skeleton-data';
import type { SpriteDocument, SpriteFlipbook } from '../../sprite-data';
import type { Command } from './history';
import type { ProjectCommandInfo } from './project-commands';
import type {
  ChangeCause, DocumentAppearance, DocumentAppearancePart, DocumentArmIk, StepInfo,
} from './project-document';

// What a projection shows of the document's value: loading it, showing it, or unable to.
export type ProjectionState<V, E extends Error> =
  | { readonly kind: 'loading'; readonly value: V }
  | { readonly kind: 'ready'; readonly value: V }
  | { readonly kind: 'failed'; readonly value: V; readonly error: E };

// A projection's change: a document change with its cause and step, or, with both null, a loading or status change.
export interface VisualProjectionEvent {
  readonly cause: ChangeCause | null;
  readonly step: StepInfo | null;
}

// What a layer edit changes; absent fields keep their values.
export interface SpriteLayerEdit {
  readonly name?: string;
  readonly anchor?: string;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly rotation?: number;
  readonly bone?: string | null;
  readonly directions?: readonly FacingDirection[];
  readonly skin?: SpriteSkin | null;
  readonly tileLength?: number | null;
  // null returns the layer to its first frame as a single image.
  readonly flipbook?: SpriteFlipbook | null;
}

/**
 * The primary character's commands. Each returns a command and changes nothing itself. Its run reads the document's
 * current profile, checks the whole result, its expectations and references included, and returns the change to the
 * next frozen profile, which keeps every unchanged branch; a no-op returns none. Runs never touch the rig, forms,
 * selection, storage or the history. They refuse with SpriteError, its subclasses kept (CharacterModelError,
 * AvatarRigError, AvatarMotionError) and skeleton or directional failures wrapped with their cause; anything else is a
 * bug and propagates.
 */
export interface CharacterCommands {
  // `value` checked as a whole profile, reusing `current`'s equal branches; `current` itself when equal.
  checkProfile(value: unknown, current: SpriteDocument): SpriteDocument;
  // Throws unless `value`, a profile a section holds, is one both character sections accept, its embedded models' release
  // checks included. It checks the value as it is, so Swap and Use current as alternate move that exact root.
  checkStoredProfile(value: SpriteDocument): void;
  // Replaces the profile; refused when `expected` is given and the profile is no longer it.
  profile(value: unknown, info: ProjectCommandInfo, expected?: SpriteDocument): Command;
  riggingType(value: unknown, info: ProjectCommandInfo): Command;
  armForwardDistance(value: unknown, info: ProjectCommandInfo): Command;
  waistLean(value: unknown, info: ProjectCommandInfo): Command;
  grips(build: (current: Grips) => unknown, info: ProjectCommandInfo): Command;
  arms(build: (current: CharacterArms | null) => unknown, info: ProjectCommandInfo): Command;
  avatarMotion(build: (current: readonly AvatarMotionEntry[]) => unknown, info: ProjectCommandInfo): Command;
  layer(id: string, edit: SpriteLayerEdit, info: ProjectCommandInfo): Command;
  removeLayer(id: string, info: ProjectCommandInfo): Command;
  skeleton(build: (current: SkeletonDefinition | null) => unknown, info: ProjectCommandInfo): Command;
  bindMesh(id: string, options: {
    readonly columns: number;
    readonly rows: number;
    readonly bones: readonly string[];
  }, info: ProjectCommandInfo): Command;
  presentation(build: (current: DirectionalPresentation | null) => unknown, info: ProjectCommandInfo): Command;
  // null removes the avatar and its model.
  avatar(value: {
    readonly model: CharacterModel;
    readonly settings: AvatarModelSettings;
  } | null, info: ProjectCommandInfo): Command;
  prop(role: PropModelRole, value: CharacterModel | null, info: ProjectCommandInfo): Command;
}

/**
 * The arm IK's and the appearance's commands, under the same rules as CharacterCommands, refusing with AppearanceError.
 * Part models are file handles the FileStore knows; no command reads their bytes. visual-values.ts builds the frozen
 * values.
 */
export interface AppearanceCommands {
  // `value` checked as a project's part models, in part order, reusing `current`'s unchanged entries; `current` itself
  // when equal.
  checkParts(value: DocumentAppearance, current: DocumentAppearance): DocumentAppearance;
  armIk(build: (current: DocumentArmIk) => unknown, info: ProjectCommandInfo): Command;
  alignment(part: VisualPartId, build: (current: Readonly<VisualAlignment>) => unknown, info: ProjectCommandInfo): Command;
  // Sets one part's model, null for its default visual; refused unless the part still holds `expected`.
  replacePart(part: VisualPartId, expected: DocumentAppearancePart | null, value: DocumentAppearancePart | null,
    info: ProjectCommandInfo): Command;
  // Replaces every part model; refused unless the appearance is still `expected`.
  parts(value: DocumentAppearance, expected: DocumentAppearance, info: ProjectCommandInfo): Command;
}
