import type { InputMode, Point, UiAction, UiActionOptions } from './config';

interface InputCallbacks {
  onAction: (action: UiAction, options?: UiActionOptions) => void;
  onShortcut?: (event: KeyboardEvent) => void;
  onNotice: (message: string) => void;
}

const CLICK_MOVEMENT_LIMIT = 4;

export function inputModeForPointer(pointerType: string): InputMode | undefined {
  if (pointerType === 'touch' || pointerType === 'pen') return 'touch';
  if (pointerType === 'mouse') return 'mouse';
  return undefined;
}

export class PointerInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InputCallbacks;
  private readonly events = new AbortController();
  private readonly movement: Point = { x: 0, y: 0 };
  private dragId: number | null = null;
  private lastPoint: Point | null = null;
  private dragDistance = 0;
  private currentMode: InputMode;
  private interactionEnabled = true;

  constructor(canvas: HTMLCanvasElement, callbacks: InputCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.currentMode = window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
    const options = { signal: this.events.signal };
    document.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary) return;
      const mode = inputModeForPointer(event.pointerType);
      if (mode) this.setMode(mode);
    }, { ...options, capture: true });
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.interactionEnabled || event.button !== 0 || !event.isPrimary) return;
      if (this.locked && this.currentMode === 'mouse') return;
      canvas.focus({ preventScroll: true });
      this.dragId = event.pointerId;
      this.lastPoint = { x: event.clientX, y: event.clientY };
      this.dragDistance = 0;
      canvas.setPointerCapture(event.pointerId);
    }, options);
    document.addEventListener('pointermove', (event) => {
      if (!this.interactionEnabled || !event.isPrimary) return;
      if (this.locked && this.currentMode === 'mouse' && event.pointerType === 'mouse') {
        this.movement.x += event.movementX;
        this.movement.y += event.movementY;
      } else if (event.pointerId === this.dragId && this.lastPoint) {
        const dx = event.clientX - this.lastPoint.x;
        const dy = event.clientY - this.lastPoint.y;
        this.movement.x += dx;
        this.movement.y += dy;
        this.dragDistance += Math.hypot(dx, dy);
        this.lastPoint = { x: event.clientX, y: event.clientY };
      }
    }, options);
    canvas.addEventListener('pointerup', (event) => {
      if (!this.interactionEnabled || event.pointerId !== this.dragId) return;
      const wasClick = this.dragDistance < CLICK_MOVEMENT_LIMIT;
      this.endDrag();
      if (wasClick && event.pointerType === 'mouse') this.callbacks.onAction('play', { inputMode: 'mouse' });
    }, options);
    canvas.addEventListener('pointercancel', () => this.cancelGesture(), options);
    canvas.addEventListener('lostpointercapture', (event) => {
      if (event.pointerId === this.dragId) this.cancelGesture();
    }, options);
    document.addEventListener('pointerlockchange', () => {
      this.clear();
      if (this.locked && (this.currentMode === 'touch' || !this.interactionEnabled)) {
        document.exitPointerLock();
      } else if (this.currentMode === 'mouse') {
        this.endDrag();
      }
    }, options);
    window.addEventListener('blur', () => this.cancelGesture(), options);
    window.addEventListener('resize', () => this.cancelGesture(), options);
    document.addEventListener('keydown', (event) => {
      if (!this.interactionEnabled) return;
      if (event.key === 'Escape' && this.locked) {
        document.exitPointerLock();
        event.stopPropagation();
        return;
      }
      if (event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLElement &&
        event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === ' ' && event.target instanceof HTMLElement && event.target.closest('button, summary')) return;
      const actions: Record<string, UiAction> = { r: 'reset', p: 'pause', ' ': 'pause', c: 'recenter' };
      const action = actions[key];
      if (action) {
        event.preventDefault();
        this.callbacks.onAction(action);
      } else this.callbacks.onShortcut?.(event);
    }, { ...options, capture: true });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  get mode(): InputMode {
    return this.currentMode;
  }

  activate(mode: InputMode): void {
    if (!this.interactionEnabled) {
      this.callbacks.onNotice('Finish the current interaction before playing.');
      return;
    }
    this.setMode(mode);
    if (mode === 'touch') {
      if (this.locked) document.exitPointerLock();
      return;
    }
    if (this.locked) return;
    if (typeof this.canvas.requestPointerLock !== 'function') {
      this.callbacks.onNotice('Mouse capture is unavailable in this browser. Hold and drag on the game canvas to play.');
      return;
    }
    void Promise.resolve(this.canvas.requestPointerLock()).catch((error: unknown) => {
      if (!(error instanceof DOMException)) throw error;
      this.callbacks.onNotice(`Mouse capture was denied (${error.name}). Hold and drag on the game canvas to play.`);
    });
  }

  takeMovement(): Point {
    const result = { ...this.movement };
    this.clear();
    return result;
  }

  clear(): void {
    this.movement.x = 0;
    this.movement.y = 0;
  }

  setInteraction(options: { enabled: boolean }): void {
    if (this.interactionEnabled === options.enabled) return;
    this.interactionEnabled = options.enabled;
    this.cancelGesture();
    if (!options.enabled && this.locked) document.exitPointerLock();
  }

  dispose(): void {
    this.events.abort();
    this.endDrag();
    if (this.locked) document.exitPointerLock();
  }

  private endDrag(): void {
    if (this.dragId !== null && this.canvas.hasPointerCapture(this.dragId)) {
      this.canvas.releasePointerCapture(this.dragId);
    }
    this.dragId = null;
    this.lastPoint = null;
  }

  private cancelGesture(): void {
    this.endDrag();
    this.clear();
  }

  private setMode(mode: InputMode): void {
    if (mode === this.currentMode) return;
    this.cancelGesture();
    this.currentMode = mode;
    if (mode === 'touch' && this.locked) document.exitPointerLock();
  }
}
