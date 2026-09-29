import './event-presenter.css';
import { setText } from './dom';
import type { EventOutcome, MessageAction, PresentationAction } from './trigger-events';
import { EventExecutionError } from './trigger-events';
import { urlMediaHost } from './media-host';
import type { MediaHost } from './media-host';
import { MessageToasts } from './message-toast';
import type { MessageToastStatus } from './message-toast';

export type EventPresenterState = 'idle' | 'popup' | 'loading' | 'awaiting-input' | 'playing';

export interface EventPresenterStatus {
  readonly state: EventPresenterState;
  readonly action: PresentationAction | null;
  readonly toasts: MessageToastStatus;
}

export interface EventPresenterOptions {
  readonly mount: HTMLElement;
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

// Construction is inert; the presenter owns the session before start() invokes callbacks.
// Cleanup is synchronous so an old session cannot tear down a newer presentation.
class Presentation {
  readonly kind: 'popup' | 'video';
  readonly action: PresentationAction;
  state: EventPresenterState;

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

  private readonly host: {
    mount: HTMLElement;
    onModalChange: (state: { active: boolean }) => void;
    onSettle: () => void;
    media: MediaHost;
  };

  constructor(
    action: PresentationAction,
    host: {
      mount: HTMLElement;
      onModalChange: (state: { active: boolean }) => void;
      onSettle: () => void;
      media: MediaHost;
    },
  ) {
    this.host = host;
    this.action = action;
    this.kind = action.type === 'message' ? 'popup' : 'video';
    this.state = this.kind === 'popup' ? 'popup' : 'loading';
    this.promise = new Promise<EventOutcome>((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectOutcome = reject;
    });
    this.root = document.createElement('div');
    this.root.className = 'event-presenter';
  }

  start(signal: AbortSignal): void {
    signal.addEventListener('abort', () => this.finish('cancelled'), { signal: this.controller.signal });
    if (signal.aborted) { this.finish('cancelled'); return; }

    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.host.mount.append(this.root);
    this.host.onModalChange({ active: true });
    if (this.settled) return; // onModalChange synchronously aborted the signal.

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
    this.host.onSettle();
    this.host.onModalChange({ active: false });
    if (this.previouslyFocused && this.previouslyFocused !== document.body && document.contains(this.previouslyFocused)) {
      this.previouslyFocused.focus({ preventScroll: true });
    }
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

  private buildVideo(action: Extract<PresentationAction, { type: 'play-video' }>): void {
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
    this.state = 'loading';
    this.playButton.hidden = true;
    setText(this.statusText, '');
    try {
      void this.videoEl.play().then(() => {
        if (this.settled) return;
        this.state = 'playing';
      }, (error: unknown) => this.playbackFailed(error));
    } catch (error) {
      this.playbackFailed(error);
    }
  }

  private playbackFailed(error: unknown): void {
    if (this.settled) return;
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      this.state = 'awaiting-input';
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

export class EventPresenter {
  private readonly mount: HTMLElement;
  private readonly onModalChange: (state: { active: boolean }) => void;
  private readonly toasts: MessageToasts;
  private media: MediaHost;
  private active: Presentation | null = null;
  private disposed = false;

  constructor(options: EventPresenterOptions) {
    this.mount = options.mount;
    this.toasts = new MessageToasts({ mount: options.mount });
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
    const presentation = new Presentation(action, {
      mount: this.mount,
      onModalChange: this.onModalChange,
      onSettle: () => {
        if (this.active === presentation) this.active = null;
      },
      media: this.media,
    });
    this.active = presentation;
    try {
      presentation.start(signal);
    } catch (error) {
      presentation.forceCancel();
      throw error;
    }
    return presentation.promise;
  }

  // Shows a message as a toast; it never pauses the game or takes input, so its event is done at once.
  toast(action: MessageAction): void {
    if (this.disposed) throw new Error('EventPresenter.toast was called after dispose().');
    if (!this.toasts.show(action)) {
      throw new EventExecutionError('Too many trigger messages are already waiting.');
    }
  }

  // A new run begins: the toast showing leaves quickly and waiting ones are dropped.
  clearToasts(): void {
    this.toasts.clear();
  }

  inspect(): EventPresenterStatus {
    const toasts = this.toasts.inspect();
    if (!this.active) return { state: 'idle', action: null, toasts };
    return { state: this.active.state, action: this.active.action, toasts };
  }

  dispose(): void {
    this.disposed = true;
    this.active?.forceCancel();
    this.active = null;
    this.toasts.dispose();
  }
}
