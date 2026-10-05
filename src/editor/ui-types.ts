import type { InputMode, UiAction, UiActionOptions } from '../config';
import type { GameSettings } from '../game-settings';
import type { HudSettings } from '../hud';
import type { HudFrame } from '../hud-readouts';
import type { RuntimePlugins } from '../plugins/runtime';
import type { PracticeId } from './practices';
import type { ProjectSaveTarget } from './project-save';
import type { ServerCopies } from './server-copies';

export type EditorAction = UiAction | 'debug' | 'record';
export type BuiltinWorkshopTab = 'project' | 'physics' | 'character' | 'appearance' | 'sprites' | 'level';
// A Workshop plugin's tab: plugin_<plugin ID>_<tab ID>.
export type PluginWorkshopTab = `plugin_${string}`;
export type WorkshopTab = BuiltinWorkshopTab | PluginWorkshopTab;
// The built-in tabs that hold Workshop plugins' sections.
export type PluginSectionTab = 'character' | 'level' | 'physics' | 'project';

// Workshop chrome, kept separately from the shared, read-only HUD frame and reused by main.ts.
export interface HudState {
  debug: boolean;
  // Whether play recording is on, and the Record toggle's tip: what it records, or what it waits for.
  recording: boolean;
  recordingNote: string;
  capturing: boolean;
  // Null while attempts start where the designer placed the player.
  practice: PracticeId | null;
}
export interface WorkshopState {
  open: boolean;
  compact: boolean;
  tab: WorkshopTab;
}

export interface UiOptions {
  mount: HTMLElement;
  plugins: RuntimePlugins;
  // Physics diagnostics only, requested while its tab is visible, never as part of the HUD frame.
  readStatus: () => { readonly contacts: number; readonly hingeLoad: number; readonly sliderLoad: number };
  initialSettings: Readonly<GameSettings>;
  initialInputMode: InputMode;
  onAction: (action: EditorAction, options?: UiActionOptions) => void;
  onWorkshopChange: (state: WorkshopState) => void;
  onPractice: (practice: PracticeId) => void;
  onSettingsChange: (settings: GameSettings) => void;
  // The open server project, for Physics' Save to project, and the copies shared on the server.
  projectSave: ProjectSaveTarget;
  serverCopies: ServerCopies;
}

export interface GameUi {
  projectMount: HTMLElement;
  characterMount: HTMLElement;
  appearanceMount: HTMLElement;
  spriteMount: HTMLElement;
  levelMount: HTMLElement;
  // Physics / Hammer head, which main.ts fills: it edits the game settings and the model library together.
  hammerHeadMount: HTMLElement;
  // A Workshop plugin's tab after the built-in ones: its button and pane, and its removal.
  addTab: (options: { readonly id: PluginWorkshopTab; readonly label: string; readonly title?: string }) =>
    { readonly body: HTMLElement; remove(): void };
  // Where Workshop plugins' sections go in a built-in tab: after its own.
  pluginSections: (tab: PluginSectionTab) => HTMLElement;
  workshopState: () => WorkshopState;
  closeWorkshop: () => void;
  update: (frame: HudFrame, state: HudState) => void;
  // Applies a complete settings profile, e.g. from a project, as if loaded in Physics.
  applySettings: (settings: GameSettings) => void;
  settings: () => GameSettings;
  setHud: (hud: HudSettings) => void;
  setSceneTone: (dark: boolean) => void;
  notice: (message: string, kind: 'info' | 'error') => void;
  dispose: () => void;
}
