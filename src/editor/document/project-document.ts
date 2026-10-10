import type { LevelDefinition, LevelObject } from '../../level';
import type { WorkshopTab } from '../ui-types';

// The sections the document holds, named as projects name them.
// Stage A holds the level; later stages add the other sections and plugins/<id>.
export interface SectionValues {
  readonly level: LevelDefinition;
}

export type SectionName = keyof SectionValues;
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
}
