import type { InputMode, UiAction, UiActionOptions } from '../config';
import type { GameSettings } from '../game-settings';
import type { HudSettings } from '../hud';
import type { GameHudState } from './game-ui';
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

export interface HudState extends GameHudState {
  debug: boolean;
  // Whether play recording is on, and the Record toggle's tip: what it records, or what it waits for.
  recording: boolean;
  recordingNote: string;
  // Null while attempts start where the designer placed the player.
  practice: PracticeId | null;
  contacts: number;
  hingeLoad: number;
  sliderLoad: number;
}
export interface WorkshopState {
  open: boolean;
  compact: boolean;
  tab: WorkshopTab;
}

export interface UiOptions {
  mount: HTMLElement;
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
  update: (state: HudState) => void;
  // Applies a complete settings profile, e.g. from a project, as if loaded in Physics.
  applySettings: (settings: GameSettings) => void;
  settings: () => GameSettings;
  setHud: (hud: HudSettings) => void;
  setSceneTone: (dark: boolean) => void;
  notice: (message: string, kind: 'info' | 'error') => void;
  dispose: () => void;
}
