export type TriggerAction =
  | { readonly type: 'popup'; readonly title: string; readonly message: string }
  | { readonly type: 'play-video'; readonly source: string }
  | { readonly type: 'stop-timer' };

export type PresentationAction = Exclude<TriggerAction, { readonly type: 'stop-timer' }>;
export type EventOutcome = 'completed' | 'skipped' | 'cancelled';
export type TriggerExecutor = (action: TriggerAction, signal: AbortSignal) => EventOutcome | Promise<EventOutcome>;

export class EventExecutionError extends Error {}

export const ENDING_EVENTS: readonly TriggerAction[] = Object.freeze([
  Object.freeze({ type: 'stop-timer' }),
  Object.freeze({
    type: 'popup', title: 'Summit reached',
    message: 'A little closer to the sky.\n\nTake in the view. You earned it.',
  }),
]);
