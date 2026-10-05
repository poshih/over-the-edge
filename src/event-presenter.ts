import './event-presenter.css';
import { setText } from './dom';
import type { EventOutcome, MessageAction, PresentationAction, VideoAction } from './trigger-events';
import { EventExecutionError } from './trigger-events';
import { urlMediaHost } from './media-host';
import type { MediaHost } from './media-host';
import { MessageToasts } from './message-toast';
import { PluginError, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';

export type EventPresenterState = 'idle' | 'popup' | 'loading' | 'awaiting-input' | 'playing';
export type PresentationState = Exclude<EventPresenterState, 'idle'>;

export interface Toasts {
  show(message: MessageAction): boolean;
  clear(): void;
  setHeld(held: boolean): void;
  dispose(): void;
  inspect?(): unknown;
}
export type ToastsFactory = (mount: HTMLElement) => Toasts;

export interface PresentationContext {
  readonly mount: HTMLElement;
  readonly signal: AbortSignal;
  readonly media: MediaHost;
  // Captured before modal input blocking can change focus.
  readonly previouslyFocused: HTMLElement | null;
  // Diagnostic state only; modal pause, input blocking and coversGame stay with EventPresenter.
  setState(state: PresentationState): void;
  // Call after synchronous teardown, just before settling, to release the modal before restoring focus.
  // A presenter that only settles its promise is closed by the host when that promise settles.
  onClose(): void;
}
export type PopupPresenter = (action: MessageAction, context: PresentationContext) => Promise<EventOutcome>;
export type VideoPresenter = (action: VideoAction, context: PresentationContext) => Promise<EventOutcome>;

function presenterFunction<T>(value: unknown): T {
  if (typeof value !== 'function') throw new TypeError('A message presentation point must be a function.');
  return value as T;
}

export const MESSAGES = Object.freeze({
  toasts: slotPoint('messages.toasts', 'runtime', presenterFunction<ToastsFactory>),
  popup: slotPoint('messages.popup', 'runtime', presenterFunction<PopupPresenter>),
  video: slotPoint('messages.video', 'runtime', presenterFunction<VideoPresenter>),
});

export const DEFAULT_MESSAGE_TOASTS: ToastsFactory = (mount) => new MessageToasts({ mount });

function createToasts(factory: ToastsFactory, mount: HTMLElement, plugin: string | null): Toasts {
  try {
    const toasts: unknown = factory(mount);
    if (typeof toasts !== 'object' || toasts === null || Array.isArray(toasts) ||
      !['show', 'clear', 'setHeld', 'dispose'].every((method) => typeof Reflect.get(toasts, method) === 'function') ||
      Reflect.get(toasts, 'inspect') !== undefined && typeof Reflect.get(toasts, 'inspect') !== 'function') {
      throw new PluginError('invalid-contribution',
        `Plugin "${plugin ?? 'engine'}": "${MESSAGES.toasts.id}" must return show(message), clear(), setHeld(held), dispose() and, when given, inspect().`,
        plugin, MESSAGES.toasts.id);
    }
    return toasts as Toasts;
  } catch (error) {
    if (error instanceof PluginError && error.plugin === plugin && error.point === MESSAGES.toasts.id) throw error;
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${MESSAGES.toasts.id}".`,
      plugin, MESSAGES.toasts.id, { cause: error });
  }
}

export interface EventPresenterStatus {
  readonly state: EventPresenterState;
  readonly action: PresentationAction | null;
  readonly toasts: unknown;
}

export interface EventPresenterOptions {
  readonly mount: HTMLElement;
  readonly plugins: RuntimePlugins;
  readonly onModalChange: (state: { active: boolean }) => void;
  // Streams authored video sources, e.g. a release's packaged /media/ files; by default sources are URLs.
  readonly media?: MediaHost;
}

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${++uid}`;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeMediaError(error: MediaError | null): string {
  if (!error) return 'Video playback failed for an unknown reason.';
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED: return 'Video playback was aborted.';
    case MediaError.MEDIA_ERR_NETWORK: return 'Video playback failed because of a network error.';
    case MediaError.MEDIA_ERR_DECODE: return 'Video playback failed: the media could not be decoded.';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return 'Video playback failed: the source is not supported.';
    default: return error.message || 'Video playback failed for an unknown reason.';
  }
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

function restoreFocus(previouslyFocused: HTMLElement | null): void {
  if (previouslyFocused && previouslyFocused !== document.body && document.contains(previouslyFocused)) {
    previouslyFocused.focus({ preventScroll: true });
  }
}

// The engine's popup and video UI. Modal ownership lives in EventPresenter, not in this default.
// Cleanup is synchronous so an old session cannot tear down a newer presentation.
class Presentation {
  private readonly action: PresentationAction;

  readonly promise: Promise<EventOutcome>;
  private resolveOutcome!: (outcome: EventOutcome) => void;
  private rejectOutcome!: (error: unknown) => void;
  private settled = false;

  private readonly controller = new AbortController();
  private readonly root: HTMLElement;
  private container!: HTMLElement;
  private previouslyFocused: HTMLElement | null = null;

  private videoEl: HTMLVideoElement | null = null;
  private shell: HTMLElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private fullscreenButton: HTMLButtonElement | null = null;
  private statusText: HTMLElement | null = null;

  private readonly host: PresentationContext;

  constructor(action: PresentationAction, host: PresentationContext) {
    this.host = host;
    this.action = action;
    this.promise = new Promise<EventOutcome>((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectOutcome = reject;
    });
    this.root = document.createElement('div');
    this.root.className = 'event-presenter';
  }

  start(): void {
    const signal = this.host.signal;
    signal.addEventListener('abort', () => this.finish('cancelled'), { signal: this.controller.signal });
    if (signal.aborted) { this.finish('cancelled'); return; }

    this.previouslyFocused = this.host.previouslyFocused;
    this.host.mount.append(this.root);

    if (this.action.type === 'message') this.buildPopup(this.action);
    else this.buildVideo(this.action);
    if (this.settled) return; // building (e.g. a synchronous play() throw) already settled us.

    this.installModalBehavior();
    this.container.focus({ preventScroll: true });
  }

  forceCancel(): void {
    this.finish('cancelled');
  }

  private finish(outcome: EventOutcome): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.resolveOutcome(outcome);
  }

  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.rejectOutcome(error);
  }

  private teardown(): void {
    this.controller.abort();
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
    }
    // Detaching the owned fullscreen element lets the browser exit fullscreen.
    this.root.remove();
    this.host.onClose();
    restoreFocus(this.previouslyFocused);
  }

  private focusableElements(): HTMLElement[] {
    return Array.from(this.container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => !el.hidden && el.getClientRects().length > 0);
  }

  // A native modal dialog conflicts with Escape-exits-fullscreen in Chromium.
  private installModalBehavior(): void {
    this.container.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // If we (or the browser) are in native fullscreen, let the browser exit fullscreen
        // on its own; do not also skip the presentation from the same keypress.
        if (document.fullscreenElement) return;
        event.preventDefault();
        event.stopPropagation();
        this.finish('skipped');
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = this.focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        this.container.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || !this.container.contains(current)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (current === last || !this.container.contains(current)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }, { signal: this.controller.signal, capture: true });

    document.addEventListener('focusin', (event) => {
      if (event.target instanceof Node && this.container.contains(event.target)) return;
      const focusable = this.focusableElements();
      (focusable[0] ?? this.container).focus({ preventScroll: true });
    }, { signal: this.controller.signal, capture: true });
  }

  private buildPopup(action: MessageAction): void {
    this.root.classList.add('event-presenter--popup');
    const backdrop = document.createElement('div');
    backdrop.className = 'event-presenter-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'event-presenter-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    this.container = dialog;

    const titleId = nextId('event-presenter-title');
    const messageId = nextId('event-presenter-message');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', messageId);

    const title = document.createElement('h2');
    title.className = 'event-presenter-title';
    title.id = titleId;
    title.textContent = action.title;

    const message = document.createElement('p');
    message.className = 'event-presenter-message';
    message.id = messageId;
    message.textContent = action.message;

    const actions = document.createElement('div');
    actions.className = 'event-presenter-actions';
    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.className = 'event-presenter-button event-presenter-button-primary';
    continueButton.textContent = 'Continue';
    continueButton.addEventListener('click', () => this.finish('completed'), { signal: this.controller.signal });
    actions.append(continueButton);

    dialog.append(title, message, actions);
    this.root.append(backdrop, dialog);
  }

  private buildVideo(action: VideoAction): void {
    this.root.classList.add('event-presenter--video');

    const shell = document.createElement('div');
    shell.className = 'event-presenter-video-shell';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Video');
    shell.tabIndex = -1;
    this.shell = shell;
    this.container = shell;

    const video = document.createElement('video');
    video.className = 'event-presenter-video';
    video.controls = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    this.videoEl = video;

    const topBar = document.createElement('div');
    topBar.className = 'event-presenter-video-controls';

    const fullscreenButton = document.createElement('button');
    fullscreenButton.type = 'button';
    fullscreenButton.className = 'event-presenter-button event-presenter-fullscreen';
    fullscreenButton.textContent = 'Fullscreen';
    fullscreenButton.hidden = typeof shell.requestFullscreen !== 'function';
    fullscreenButton.addEventListener('click', () => this.toggleFullscreen(), { signal: this.controller.signal });
    this.fullscreenButton = fullscreenButton;

    const skipButton = document.createElement('button');
    skipButton.type = 'button';
    skipButton.className = 'event-presenter-button event-presenter-skip';
    skipButton.textContent = 'Skip';
    skipButton.addEventListener('click', () => this.finish('skipped'), { signal: this.controller.signal });

    topBar.append(fullscreenButton, skipButton);

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'event-presenter-button event-presenter-button-primary event-presenter-play';
    playButton.textContent = 'Play video';
    playButton.hidden = true;
    playButton.addEventListener('click', () => this.attemptPlay(), { signal: this.controller.signal });
    this.playButton = playButton;

    const status = document.createElement('p');
    status.className = 'event-presenter-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    this.statusText = status;

    shell.append(video, topBar, playButton, status);
    this.root.append(shell);

    video.addEventListener('ended', () => this.finish('completed'), { signal: this.controller.signal });
    video.addEventListener('error', () => {
      if (this.settled) return;
      this.fail(new EventExecutionError(describeMediaError(video.error)));
    }, { signal: this.controller.signal });
    document.addEventListener('fullscreenchange', () => this.onFullscreenChange(), { signal: this.controller.signal });

    this.host.media.stream(action.source, this.controller.signal).then((stream) => {
      if (this.settled) return;
      if (stream.crossOrigin === null) video.removeAttribute('crossorigin');
      else video.crossOrigin = stream.crossOrigin;
      video.src = stream.url;
      this.attemptPlay();
    }, (error: unknown) => {
      if (this.settled) return;
      // A video that cannot be granted fails its event; it never stops the game.
      this.fail(new EventExecutionError(`The video could not load: ${describeError(error)}`));
    });
  }

  private attemptPlay(): void {
    if (!this.videoEl || !this.playButton || !this.statusText) throw new Error('Video controls are not initialized.');
    this.host.setState('loading');
    this.playButton.hidden = true;
    setText(this.statusText, '');
    try {
      void this.videoEl.play().then(() => {
        if (this.settled) return;
        this.host.setState('playing');
      }, (error: unknown) => this.playbackFailed(error));
    } catch (error) {
      this.playbackFailed(error);
    }
  }

  private playbackFailed(error: unknown): void {
    if (this.settled) return;
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      this.host.setState('awaiting-input');
      if (this.playButton) this.playButton.hidden = false;
      if (this.statusText) setText(this.statusText, 'Playback needs your input. Press "Play video" to continue.');
      return;
    }
    this.fail(error instanceof DOMException
      ? new EventExecutionError(`Video playback failed to start: ${describeError(error)}`)
      : error);
  }

  private toggleFullscreen(): void {
    if (!this.shell) return;
    if (document.fullscreenElement === this.shell) {
      document.exitFullscreen().catch((error: unknown) => {
        if (this.settled || !this.statusText) return;
        setText(this.statusText, `Could not exit fullscreen: ${describeError(error)}`);
      });
      return;
    }
    if (typeof this.shell.requestFullscreen !== 'function') return;
    this.shell.requestFullscreen().catch((error: unknown) => {
      if (this.settled || !this.statusText) return;
      setText(this.statusText, `Fullscreen unavailable: ${describeError(error)}`);
    });
  }

  private onFullscreenChange(): void {
    if (!this.fullscreenButton || !this.shell) return;
    const isFullscreen = document.fullscreenElement === this.shell;
    setText(this.fullscreenButton, isFullscreen ? 'Exit fullscreen' : 'Fullscreen');
  }
}

function defaultPresentation(action: PresentationAction, context: PresentationContext): Promise<EventOutcome> {
  const presentation = new Presentation(action, context);
  try {
    presentation.start();
  } catch (error) {
    presentation.forceCancel();
    throw error;
  }
  return presentation.promise;
}

export const DEFAULT_MESSAGE_POPUP: PopupPresenter = defaultPresentation;
export const DEFAULT_MESSAGE_VIDEO: VideoPresenter = defaultPresentation;

interface ActivePresentation {
  readonly kind: 'popup' | 'video';
  readonly action: PresentationAction;
  state: PresentationState;
  cancel(): void;
}

function presentationFailure(error: unknown, point: string, plugin: string | null): unknown {
  // Media failures are event refusals, not plugin faults: the trigger reports them and play goes on.
  if (error instanceof EventExecutionError ||
    error instanceof PluginError && error.plugin === plugin && error.point === point) return error;
  return new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed presenting "${point}".`,
    plugin, point, { cause: error });
}

export class EventPresenter {
  private readonly mount: HTMLElement;
  private readonly onModalChange: (state: { active: boolean }) => void;
  private readonly toasts: Toasts;
  private readonly popup: PopupPresenter;
  private readonly video: VideoPresenter;
  private readonly toastsOwner: string | null;
  private readonly popupOwner: string | null;
  private readonly videoOwner: string | null;
  private readonly lifecycle = new AbortController();
  private media: MediaHost;
  private active: ActivePresentation | null = null;
  private disposed = false;

  constructor(options: EventPresenterOptions) {
    this.mount = options.mount;
    const plugins = options.plugins;
    // Resolve all three once, even when the Workshop's policy skips videos.
    const toasts = plugins.slot(MESSAGES.toasts, DEFAULT_MESSAGE_TOASTS);
    this.popup = plugins.slot(MESSAGES.popup, DEFAULT_MESSAGE_POPUP);
    this.video = plugins.slot(MESSAGES.video, DEFAULT_MESSAGE_VIDEO);
    this.toastsOwner = plugins.owner(MESSAGES.toasts);
    this.popupOwner = plugins.owner(MESSAGES.popup);
    this.videoOwner = plugins.owner(MESSAGES.video);
    this.toasts = createToasts(toasts, options.mount, this.toastsOwner);
    // Toasts hold while a popup or video has the player's attention.
    this.onModalChange = (state) => {
      this.toasts.setHeld(state.active);
      options.onModalChange(state);
    };
    this.media = options.media ?? urlMediaHost((source) => source);
  }

  setMedia(media: MediaHost): void {
    this.media = media;
  }

  /** True while a full-window video presentation is covering the game view. */
  get coversGame(): boolean {
    return this.active !== null && this.active.kind === 'video';
  }

  present(action: PresentationAction, signal: AbortSignal): Promise<EventOutcome> {
    if (this.disposed) throw new Error('EventPresenter.present was called after dispose().');
    if (this.active) throw new Error('EventPresenter.present was called while a presentation is already active.');
    if (signal.aborted) return Promise.resolve('cancelled');
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const cancellation = AbortSignal.any([signal, this.lifecycle.signal]);
    const point = action.type === 'message' ? MESSAGES.popup.id : MESSAGES.video.id;
    const plugin = action.type === 'message' ? this.popupOwner : this.videoOwner;
    const controller = new AbortController();
    let settled = false;
    let closed = false;
    let invoked = false;
    let resolveOutcome!: (outcome: EventOutcome) => void;
    let rejectOutcome!: (error: unknown) => void;
    const outcome = new Promise<EventOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      // The default calls onClose after synchronous teardown, before restoring focus.
      // A normal close must not abort a wrapper still awaiting the default's outcome.
      if (this.active === presentation) {
        this.active = null;
        this.onModalChange({ active: false });
      }
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      close();
      rejectOutcome(presentationFailure(error, point, plugin));
    };
    const presentation: ActivePresentation = {
      kind: action.type === 'message' ? 'popup' : 'video',
      action,
      state: action.type === 'message' ? 'popup' : 'loading',
      cancel: () => {
        if (settled) return;
        settled = true;
        // Abort tears down the old UI synchronously before releasing modal ownership.
        controller.abort();
        close();
        if (!invoked) restoreFocus(previouslyFocused);
        resolveOutcome('cancelled');
      },
    };
    const context: PresentationContext = {
      mount: this.mount,
      signal: controller.signal,
      media: this.media,
      previouslyFocused,
      setState: (state) => {
        if (controller.signal.aborted || closed || this.active !== presentation) return;
        if (state !== 'popup' && state !== 'loading' && state !== 'awaiting-input' && state !== 'playing') {
          throw new PluginError('invalid-contribution',
            `Plugin "${plugin ?? 'engine'}": "${point}" reported an invalid presentation state.`, plugin, point);
        }
        presentation.state = state;
      },
      onClose: close,
    };
    this.active = presentation;
    cancellation.addEventListener('abort', presentation.cancel, { signal: controller.signal });
    try {
      this.onModalChange({ active: true });
    } catch (error) {
      // Modal hooks can run other points (toasts and audio). Preserve their own error attribution,
      // even if releasing the modal throws too.
      try { presentation.cancel(); } finally { throw error; }
    }
    if (settled) return outcome; // The modal callback synchronously cancelled us.
    const popup = this.popup;
    const video = this.video;
    try {
      invoked = true;
      const pending: unknown = action.type === 'message' ? popup(action, context) : video(action, context);
      if (typeof pending !== 'object' || pending === null || typeof Reflect.get(pending, 'then') !== 'function') {
        throw new PluginError('invalid-contribution',
          `Plugin "${plugin ?? 'engine'}": "${point}" must return a Promise<EventOutcome>.`, plugin, point);
      }
      void Promise.resolve(pending as Promise<unknown>).then((result) => {
        if (settled) return;
        if (result !== 'completed' && result !== 'skipped' && result !== 'cancelled') {
          fail(new PluginError('invalid-contribution',
            `Plugin "${plugin ?? 'engine'}": "${point}" returned an invalid EventOutcome.`, plugin, point));
          return;
        }
        settled = true;
        cancellation.removeEventListener('abort', presentation.cancel);
        close();
        resolveOutcome(result);
      }, fail);
    } catch (error) {
      try { presentation.cancel(); } finally { throw presentationFailure(error, point, plugin); }
    }
    return outcome;
  }

  // Shows a message as a toast; it never pauses the game or takes input, so its event is done at once.
  toast(action: MessageAction): void {
    if (this.disposed) throw new Error('EventPresenter.toast was called after dispose().');
    let accepted: unknown;
    try { accepted = this.toasts.show(action); } catch (error) {
      throw presentationFailure(error, MESSAGES.toasts.id, this.toastsOwner);
    }
    if (typeof accepted !== 'boolean') {
      throw new PluginError('invalid-contribution',
        `Plugin "${this.toastsOwner ?? 'engine'}": "${MESSAGES.toasts.id}" show(message) must return a boolean.`,
        this.toastsOwner, MESSAGES.toasts.id);
    }
    if (!accepted) {
      throw new EventExecutionError('Too many trigger messages are already waiting.');
    }
  }

  // A new run begins: the toast showing leaves quickly and waiting ones are dropped.
  clearToasts(): void {
    this.toasts.clear();
  }

  inspect(): EventPresenterStatus {
    const toasts = this.toasts.inspect?.() ?? null;
    if (!this.active) return { state: 'idle', action: null, toasts };
    return { state: this.active.state, action: this.active.action, toasts };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.active?.cancel();
    this.active = null;
    this.toasts.dispose();
  }
}
