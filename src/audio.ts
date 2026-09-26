import { AUDIO_CUES, DEFAULT_AUDIO } from './audio-settings';
import type { AudioClip, AudioSettings, GameCue } from './audio-settings';
import { MEDIA_LIMITS } from './media';

const IMPACT_INTERVAL = 0.07;
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

interface LoadedSound {
  readonly url: string;
  bytes: Promise<ArrayBuffer | null> | null;
  buffer: AudioBuffer | null;
  decoding: Promise<AudioBuffer | null> | null;
}

/**
 * Plays a project's music and sound effects. Files are fetched ahead of time and decoded once the
 * player first interacts with the page, because browsers only start audio after a user gesture.
 * Per-frame work is a pause-state comparison; sounds allocate only when they actually play.
 */
export class AudioDirector {
  private settings: AudioSettings = DEFAULT_AUDIO;
  private resolve: (source: string) => string;
  private readonly onError: (message: string) => void;
  private readonly sounds = new Map<string, LoadedSound>();
  private readonly reported = new Set<string>();
  private readonly lifecycle = new AbortController();
  private readonly unlockHandler = (): void => this.unlock();
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private music: HTMLAudioElement | null = null;
  private musicSource: string | null = null;
  private unlocked = false;
  private paused = true;
  private lastImpact = -Infinity;
  private played = 0;
  private disposed = false;

  constructor(options: {
    settings: AudioSettings;
    resolve?: (source: string) => string;
    // Sources used by authored play-sound events, preloaded with the cues.
    sounds?: readonly string[];
    onError?: (message: string) => void;
  }) {
    this.resolve = options.resolve ?? ((source) => source);
    this.onError = options.onError ?? (() => {});
    for (const type of UNLOCK_EVENTS) {
      window.addEventListener(type, this.unlockHandler, { capture: true, signal: this.lifecycle.signal });
    }
    this.setSettings(options.settings);
    this.preload(options.sounds ?? []);
  }

  setSettings(settings: AudioSettings): void {
    if (this.disposed) return;
    this.settings = settings;
    this.preload(AUDIO_CUES.flatMap((cue) => settings.cues[cue] === null ? [] : [settings.cues[cue]!.source]));
    if (this.output !== null) this.output.gain.value = settings.volume;
    this.syncMusic();
  }

  // Changing the resolver (for example when another project opens) reloads sources lazily.
  setResolver(resolve: (source: string) => string): void {
    if (this.disposed) return;
    this.resolve = resolve;
    this.sounds.clear();
    this.musicSource = null;
    this.setSettings(this.settings);
  }

  preload(sources: readonly string[]): void {
    for (const source of sources) this.sound(source);
  }

  handle(cue: GameCue): void {
    if (this.disposed) return;
    if (cue.type === 'sound') {
      this.play(cue.source, cue.volume);
      return;
    }
    const clip = this.settings.cues[cue.cue];
    if (clip === null) return;
    if (cue.cue === 'impact') {
      const now = this.context?.currentTime ?? performance.now() / 1000;
      if (now - this.lastImpact < IMPACT_INTERVAL) return;
      this.lastImpact = now;
      this.play(clip.source, clip.volume * (0.25 + 0.75 * cue.strength));
    } else {
      this.play(clip.source, clip.volume);
    }
  }

  // Music follows the game: it pauses with gameplay and resumes with it.
  setPaused(paused: boolean): void {
    if (paused === this.paused || this.disposed) return;
    this.paused = paused;
    this.syncMusic();
  }

  inspect() {
    return {
      unlocked: this.unlocked, paused: this.paused, played: this.played,
      loaded: [...this.sounds.values()].filter((sound) => sound.buffer !== null).map((sound) => sound.url),
      music: this.music === null ? null : { source: this.musicSource, playing: !this.music.paused, volume: this.music.volume },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.music?.pause();
    this.music?.removeAttribute('src');
    this.music = null;
    this.sounds.clear();
    void this.context?.close();
    this.context = null;
  }

  private unlock(): void {
    if (this.unlocked || this.disposed) return;
    this.unlocked = true;
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, this.unlockHandler, { capture: true });
    if (typeof AudioContext !== 'undefined') {
      this.context = new AudioContext();
      this.output = this.context.createGain();
      this.output.gain.value = this.settings.volume;
      this.output.connect(this.context.destination);
      for (const sound of this.sounds.values()) void this.decode(sound);
    }
    this.syncMusic();
  }

  private sound(source: string): LoadedSound {
    const url = this.resolve(source);
    let sound = this.sounds.get(url);
    if (sound === undefined) {
      sound = { url, bytes: null, buffer: null, decoding: null };
      this.sounds.set(url, sound);
      sound.bytes = this.fetchBytes(url);
      if (this.context !== null) void this.decode(sound);
    }
    return sound;
  }

  private async fetchBytes(url: string): Promise<ArrayBuffer | null> {
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: this.lifecycle.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MEDIA_LIMITS.bytes) throw new Error('the file is too large');
      return bytes;
    } catch (error) {
      if (this.disposed) return null;
      this.report(url, error);
      return null;
    }
  }

  private decode(sound: LoadedSound): Promise<AudioBuffer | null> {
    if (sound.decoding !== null) return sound.decoding;
    const context = this.context;
    if (context === null || sound.bytes === null) return Promise.resolve(null);
    sound.decoding = sound.bytes.then(async (bytes) => {
      if (bytes === null || this.disposed) return null;
      try {
        // decodeAudioData detaches its input, so decode a copy and keep the original for reloads.
        sound.buffer = await context.decodeAudioData(bytes.slice(0));
        return sound.buffer;
      } catch (error) {
        if (!this.disposed) this.report(sound.url, error);
        return null;
      }
    });
    return sound.decoding;
  }

  private play(source: string, volume: number): void {
    if (!this.unlocked || this.context === null || this.output === null) return;
    const sound = this.sound(source);
    const start = (buffer: AudioBuffer | null): void => {
      if (buffer === null || this.disposed || this.context === null || this.output === null) return;
      const node = this.context.createBufferSource();
      node.buffer = buffer;
      const gain = this.context.createGain();
      gain.gain.value = volume;
      node.connect(gain).connect(this.output);
      node.start();
      this.played++;
    };
    if (sound.buffer !== null) start(sound.buffer);
    else void this.decode(sound).then(start);
  }

  private syncMusic(): void {
    const clip: AudioClip | null = this.settings.music;
    if (clip === null) {
      this.music?.pause();
      this.musicSource = null;
      return;
    }
    const url = this.resolve(clip.source);
    if (this.music === null) {
      this.music = new Audio();
      this.music.loop = true;
      this.music.preload = 'auto';
      this.music.addEventListener('error', () => this.report(this.musicSource ?? url, new Error('the music could not be loaded')),
        { signal: this.lifecycle.signal });
    }
    if (this.musicSource !== url) {
      this.musicSource = url;
      this.music.src = url;
    }
    this.music.volume = Math.min(1, clip.volume * this.settings.volume);
    if (this.unlocked && !this.paused) {
      void this.music.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) this.report(url, error);
      });
    } else {
      this.music.pause();
    }
  }

  private report(url: string, error: unknown): void {
    if (this.reported.has(url)) return;
    this.reported.add(url);
    this.onError(`Audio ${url} could not play: ${error instanceof Error ? error.message : String(error)}.`);
  }
}
