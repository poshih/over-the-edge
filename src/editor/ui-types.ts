import type { InputMode, UiAction, UiActionOptions } from '../config';
import type { GameSettings } from '../game-settings';
import type { HudSettings } from '../hud';
import type { GameHudState } from './game-ui';

export type PracticeId = 'start' | 'ledge' | 'pogo' | 'vault';
export type EditorAction = UiAction | 'debug';
export type WorkshopTab = 'project' | 'physics' | 'character' | 'appearance' | 'sprites' | 'level';

export interface HudState extends GameHudState {
  debug: boolean;
  practice: PracticeId;
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
}

export interface GameUi {
  projectMount: HTMLElement;
  characterMount: HTMLElement;
  appearanceMount: HTMLElement;
  spriteMount: HTMLElement;
  levelMount: HTMLElement;
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
