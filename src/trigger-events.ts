export interface LaunchSettings {
  readonly height: number;
  readonly strength: number;
}

export const LAUNCH_FIELDS = {
  height: { label: 'Lift height', min: 0.5, max: 100, step: 0.5, unit: 'm' },
  strength: { label: 'Launch strength', min: 0.25, max: 2, step: 0.05, unit: 'x' },
} as const;
export const DEFAULT_LAUNCH: Readonly<LaunchSettings> = Object.freeze({ height: 8, strength: 1 });
export const SOUND_VOLUME = { label: 'Sound volume', min: 0, max: 1, step: 0.05, unit: '' } as const;

export type TriggerAction =
  // Shows a title and message in the project's message style: a toast, or a popup that pauses the game.
  | { readonly type: 'message'; readonly title: string; readonly message: string }
  | { readonly type: 'play-video'; readonly source: string }
  | ({ readonly type: 'launch-player' } & LaunchSettings)
  | { readonly type: 'stop-timer' }
  // Plays a sound effect without pausing the game; the next event starts immediately.
  | { readonly type: 'play-sound'; readonly source: string; readonly volume: number };

export type PresentationAction = Extract<TriggerAction, { readonly type: 'message' | 'play-video' }>;
export type MessageAction = Extract<TriggerAction, { readonly type: 'message' }>;
export type VideoAction = Extract<TriggerAction, { readonly type: 'play-video' }>;

// How message events appear: a toast that fades in and away while play goes on, or a popup that
// pauses the game until the player continues.
export const MESSAGE_STYLES = ['toast', 'popup'] as const;
export type MessageStyle = (typeof MESSAGE_STYLES)[number];
export const DEFAULT_MESSAGE_STYLE: MessageStyle = 'toast';
// Whether play-video events play, or are skipped at once so the trigger goes on: a release plays them, and
// the Workshop skips them, so testing is never interrupted.
export type VideoPlayback = 'play' | 'skip';
export const DEFAULT_VIDEO_PLAYBACK: VideoPlayback = 'play';
export type EventOutcome = 'completed' | 'skipped' | 'cancelled';
export type TriggerExecutor = (action: TriggerAction, signal: AbortSignal) => EventOutcome | Promise<EventOutcome>;

export class EventExecutionError extends Error {}

export const UPDRAFT_EVENTS: readonly TriggerAction[] = Object.freeze([
  Object.freeze({ type: 'launch-player', ...DEFAULT_LAUNCH }),
]);

export const ENDING_EVENTS: readonly TriggerAction[] = Object.freeze([
  Object.freeze({ type: 'stop-timer' }),
  Object.freeze({
    type: 'message', title: 'Summit reached',
    message: 'A little closer to the sky.\n\nTake in the view. You earned it.',
  }),
]);
