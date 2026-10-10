import type { AppearancePart } from '../../appearance-profile';
import type { AudioSettings } from '../../audio-settings';
import type { ArmIkSettings } from '../../character';
import type { DecorationArt } from '../../decoration-art';
import type { EnemyArtSettings } from '../../enemy-art-data';
import type { GameSettings } from '../../game-settings';
import type { HudSettings } from '../../hud';
import type { LevelDefinition, LevelObject } from '../../level';
import type { LibraryAvatarEntry, LibraryEntry, LibraryHammerEntry } from '../../model-library';
import type { PluginData } from '../../plugin-data';
import type { SpriteDocument } from '../../sprite-data';
import type { GameTheme } from '../../theme';
import type { WorkshopTab } from '../ui-types';
import type { FileHandle } from './files';

export type PluginSectionName = `plugins/${string}`;

export interface DocumentArtAsset {
  readonly id: string;
  readonly name: string;
  readonly file: FileHandle;
}

export interface DocumentArt {
  readonly assets: readonly DocumentArtAsset[];
  readonly decorations: DecorationArt;
}

export interface DocumentMediaFile {
  readonly path: string;
  readonly file: FileHandle;
}

export type DocumentMedia = readonly DocumentMediaFile[];

export interface DocumentModel<E> {
  readonly entry: E;
  readonly file: FileHandle;
}

export interface DocumentModels {
  readonly avatar: readonly DocumentModel<LibraryAvatarEntry>[];
  readonly hammer: readonly DocumentModel<LibraryHammerEntry>[];
  readonly pot: readonly DocumentModel<LibraryEntry>[];
}

export type DocumentArmIk = Readonly<ArmIkSettings>;

// One imported part model: its fit, and its GLB wherever the FileStore finds it.
export interface DocumentAppearancePart extends AppearancePart {
  readonly file: FileHandle;
}

// At most one entry per part, in VISUAL_PART_IDS order.
export type DocumentAppearance = readonly DocumentAppearancePart[];

// Validation provenance; null data is an absent section, not a wrapper.
export interface FrozenPluginData {
  readonly data: Exclude<PluginData, null>;
  readonly bytes: number;
}

// The sections the document holds, named as projects name them.
export interface SectionValues {
  readonly title: string;
  readonly level: LevelDefinition;
  readonly settings: GameSettings;
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly audio: AudioSettings;
  readonly enemies: EnemyArtSettings;
  readonly art: DocumentArt;
  readonly media: DocumentMedia;
  readonly models: DocumentModels;
  // EMPTY_SPRITES is the default character.
  readonly 'characters/primary': SpriteDocument;
  readonly 'characters/alternate': SpriteDocument | null;
  readonly 'arm-ik': DocumentArmIk;
  readonly appearance: DocumentAppearance;
  readonly [section: PluginSectionName]: FrozenPluginData | null;
}

export type VisualSectionName = 'characters/primary' | 'arm-ik' | 'appearance';
export type VisualSectionValues = Pick<SectionValues, VisualSectionName>;

export type SectionName = keyof SectionValues;
export type BuiltinDocumentSectionName = Exclude<SectionName, PluginSectionName>;
export type WholeSectionName = Exclude<BuiltinDocumentSectionName, 'level'>;
export type SectionValue<S extends SectionName> = SectionValues[S];
export type ChangeCause = 'edit' | 'undo' | 'redo' | 'open' | 'server';

// What the game's LevelChange carries, and what it replaced, so inversion needs no level scan.
export interface LevelDelta {
  readonly kind: 'edit' | 'replace';
  // After's additions or objects not identical to before's with the same ID, each ID once.
  readonly upsert: readonly LevelObject[];
  // Before's IDs absent after, each once and never in upsert.
  readonly remove: readonly string[];
  // Before's objects for every touched ID it has; absent for additions.
  readonly previous: ReadonlyMap<string, LevelObject>;
}

export interface SectionChange<S extends SectionName = SectionName> {
  readonly section: S;
  readonly before: SectionValue<S>;                 // The exact value it replaces.
  readonly after: SectionValue<S>;                  // Frozen.
  readonly delta: S extends 'level' ? LevelDelta : null;
}

// Any one section's change, discriminated by section.
export type SomeSectionChange = { readonly [S in SectionName]: SectionChange<S> }[SectionName];

export interface Selection {
  readonly before: readonly string[];               // IDs to restore on Undo.
  readonly after: readonly string[];                // IDs to restore on Redo.
}

// Where a step was made: its tab, Workshop section and selection to restore.
export interface StepPlace {
  readonly tab: WorkshopTab | null;                 // null for a plugin's step.
  readonly section: string | null;                  // The details element's data-section value.
  readonly select: Selection | null;                // The selection to restore on Undo/Redo.
}

export interface StepInfo {
  readonly label: string;                           // 'Move Block at D7'.
  readonly place: StepPlace;                        // Where the step was made.
}

// The open project, one frozen value per section, written only by History.
export interface ProjectDocument {
  get<S extends SectionName>(section: S): SectionValue<S>;
  // Hears each change after all sections of its step are set, in subscription order; returns the unsubscribe.
  subscribe<S extends SectionName>(section: S,
    listener: (change: SectionChange<S>, cause: ChangeCause, step: StepInfo | null) => void): () => void;
  sections(): readonly SectionName[];
  subscribeAll(
    listener: (changes: readonly SomeSectionChange[], cause: ChangeCause, step: StepInfo | null) => void,
  ): () => void;
}
