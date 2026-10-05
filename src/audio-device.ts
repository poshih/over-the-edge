const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

/**
 * One game's shared Web Audio device. The host owns it, keeps its master volume in sync with the
 * project and disposes it after the audio output. Neither defaults nor plugins create another context.
 */
export class AudioDevice {
  private readonly lifecycle = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly unlockHandler = (): void => this.unlock();
  private audioContext: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume: number;
  private unlocked = false;
  private disposed = false;

  constructor(volume: number, enabled = true) {
    this.volume = volume;
    // The unchanged silent base needs neither a gesture listener nor a context. A plugin replacement
    // or wrapper enables the device even when the release contains no authored audio.
    if (!enabled) return;
    for (const type of UNLOCK_EVENTS) {
      window.addEventListener(type, this.unlockHandler, { capture: true, signal: this.lifecycle.signal });
    }
  }

  // Both are null until the first gesture, and remain null when Web Audio is unavailable.
  get context(): AudioContext | null { return this.audioContext; }
  get output(): GainNode | null { return this.master; }

  setVolume(volume: number): void {
    if (this.disposed) return;
    this.volume = volume;
    if (this.master !== null) this.master.gain.value = volume;
  }

  // A late subscriber runs immediately, even when only media-element audio is available.
  onUnlock(listener: () => void): () => void {
    if (this.disposed) throw new Error('Cannot subscribe to a disposed audio device.');
    if (this.unlocked) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.listeners.clear();
    void this.audioContext?.close();
    this.audioContext = null;
    this.master = null;
  }

  private unlock(): void {
    if (this.unlocked || this.disposed) return;
    this.unlocked = true;
    this.lifecycle.abort();
    if (typeof AudioContext !== 'undefined') {
      this.audioContext = new AudioContext();
      this.master = this.audioContext.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.audioContext.destination);
    }
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
}
