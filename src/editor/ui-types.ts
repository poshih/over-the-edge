import type { InputMode, Tuning, UiAction, UiActionOptions } from '../config';
import type { GameHudState } from './game-ui';

export type PracticeId = 'start' | 'ledge' | 'pogo' | 'vault';
export type EditorAction = UiAction | 'debug';
export type WorkshopTab = 'physics' | 'appearance' | 'sprites' | 'level';

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
  initialTuning: Readonly<Tuning>;
  initialInputMode: InputMode;
  onAction: (action: EditorAction, options?: UiActionOptions) => void;
  onWorkshopChange: (state: WorkshopState) => void;
  onPractice: (practice: PracticeId) => void;
  onTuningChange: (tuning: Tuning) => void;
}

export interface GameUi {
  appearanceMount: HTMLElement;
  spriteMount: HTMLElement;
  levelMount: HTMLElement;
  workshopState: () => WorkshopState;
  closeWorkshop: () => void;
  update: (state: HudState) => void;
  setTuning: (tuning: Readonly<Tuning>) => void;
  notice: (message: string, kind: 'info' | 'error') => void;
  dispose: () => void;
}
