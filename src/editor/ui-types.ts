import type { InputMode, UiAction, UiActionOptions } from '../config';
import type { GameSettings } from '../game-settings';
import type { GameHudState } from './game-ui';

export type PracticeId = 'start' | 'ledge' | 'pogo' | 'vault';
export type EditorAction = UiAction | 'debug';
export type WorkshopTab = 'physics' | 'character' | 'appearance' | 'sprites' | 'level';

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
  characterMount: HTMLElement;
  appearanceMount: HTMLElement;
  spriteMount: HTMLElement;
  levelMount: HTMLElement;
  workshopState: () => WorkshopState;
  closeWorkshop: () => void;
  update: (state: HudState) => void;
  notice: (message: string, kind: 'info' | 'error') => void;
  dispose: () => void;
}
