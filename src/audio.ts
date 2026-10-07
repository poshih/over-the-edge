import { AUDIO_CUES } from './audio-settings';
import type { AudioClip, AudioCue, AudioSettings } from './audio-settings';
import type { Moment } from './moments';
import type { MediaHost } from './media-host';
import type { AudioDevice } from './audio-device';
import type { GameAudio, GameAudioFactory, GameAudioSetup } from './game-audio';
import { momentCue } from './game-audio';

export const DEFAULT_AUDIO_OUTPUT: GameAudioFactory = (setup) => new AudioDirector(setup);

interface LoadedSound {
  readonly source: string;
  bytes: Promise<ArrayBuffer | null> | null;
  buffer: AudioBuffer | null;
  decoding: Promise<AudioBuffer | null> | null;
}

/**
 * Plays a project's music and sound effects. Files are fetched ahead of time and decoded once the
 * player first interacts with the page, because browsers only start audio after a user gesture.
 * Pause updates are event-driven; sounds allocate only when they actually play.
 */
export class AudioDirector implements GameAudio {
  private settings: AudioSettings;
  private media: MediaHost;
  private readonly device: AudioDevice;
  private readonly onError: (message: string) => void;
  private readonly sounds = new Map<string, LoadedSound>();
  private readonly reported = new Set<string>();
  private readonly lifecycle = new AbortController();
  private readonly unsubscribeUnlock: () => void;
  private music: HTMLAudioElement | null = null;
  private musicSource: string | null = null;
  // Whether the music element has its streamed URL yet; it plays only once it has.
  private musicReady = false;
  private musicRequest = 0;
  private unlocked = false;
  private paused = true;
  private played = 0;
  private disposed = false;

  constructor(setup: GameAudioSetup) {
    this.settings = setup.settings;
    this.media = setup.media;
    this.device = setup.device;
    this.onError = setup.notice;
    this.setSettings(setup.settings);
    this.preload(setup.sounds);
    this.unsubscribeUnlock = this.device.onUnlock(() => {
      this.unlocked = true;
      for (const sound of this.sounds.values()) void this.decode(sound);
      this.syncMusic();
    });
  }

  setSettings(settings: AudioSettings): void {
    if (this.disposed) return;
    this.settings = settings;
    this.preload(AUDIO_CUES.flatMap((cue) => settings.cues[cue] === null ? [] : [settings.cues[cue]!.source]));
    this.syncMusic();
  }

  // Changing the media host (for example when another project opens) reloads sources lazily.
  setMedia(media: MediaHost): void {
    if (this.disposed) return;
    this.media = media;
    this.sounds.clear();
    this.musicSource = null;
    this.setSettings(this.settings);
  }

  private preload(sources: readonly string[]): void {
    for (const source of sources) this.sound(source);
  }

  moment(moment: Moment): void {
    if (this.disposed) return;
    if (moment.type === 'sound') {
      this.play(moment.source, moment.volume);
      return;
    }
    const cue = momentCue(moment);
    if (cue !== null) this.cue(cue, moment.type === 'impact' ? moment.strength : 1);
  }

  preview(cue: AudioCue): void {
    if (!this.disposed) this.cue(cue, 1);
  }

  private cue(cue: AudioCue, strength: number): void {
    const clip = this.settings.cues[cue];
    if (clip === null) return;
    if (cue === 'impact') {
      this.play(clip.source, clip.volume * (0.25 + 0.75 * strength));
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
      loaded: [...this.sounds.values()].filter((sound) => sound.buffer !== null).map((sound) => sound.source),
      music: this.music === null ? null : { source: this.musicSource, playing: !this.music.paused, volume: this.music.volume },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycle.abort();
    this.unsubscribeUnlock();
    this.music?.pause();
    this.music?.removeAttribute('src');
    this.music = null;
    this.sounds.clear();
  }

  private sound(source: string): LoadedSound {
    let sound = this.sounds.get(source);
    if (sound === undefined) {
      sound = { source, bytes: null, buffer: null, decoding: null };
      this.sounds.set(source, sound);
      sound.bytes = this.load(source);
      if (this.device.context !== null) void this.decode(sound);
    }
    return sound;
  }

  private async load(source: string): Promise<ArrayBuffer | null> {
    try {
      return await this.media.load(source, this.lifecycle.signal);
    } catch (error) {
      if (this.disposed) return null;
      this.report(source, error);
      return null;
    }
  }

  private decode(sound: LoadedSound): Promise<AudioBuffer | null> {
    if (sound.decoding !== null) return sound.decoding;
    const context = this.device.context;
    if (context === null || sound.bytes === null) return Promise.resolve(null);
    sound.decoding = sound.bytes.then(async (bytes) => {
      if (bytes === null || this.disposed) return null;
      try {
        // decodeAudioData detaches its input, so decode a copy and keep the original for reloads.
        sound.buffer = await context.decodeAudioData(bytes.slice(0));
        return sound.buffer;
      } catch (error) {
        if (!this.disposed) this.report(sound.source, error);
        return null;
      }
    });
    return sound.decoding;
  }

  private play(source: string, volume: number): void {
    if (!this.unlocked || this.device.context === null || this.device.output === null) return;
    const sound = this.sound(source);
    const start = (buffer: AudioBuffer | null): void => {
      const { context, output } = this.device;
      if (buffer === null || this.disposed || context === null || output === null) return;
      const node = context.createBufferSource();
      node.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = volume;
      node.connect(gain).connect(output);
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
      this.musicReady = false;
      this.musicRequest++;
      return;
    }
    if (this.music === null) {
      this.music = new Audio();
      this.music.loop = true;
      this.music.preload = 'auto';
      this.music.addEventListener('error', () => {
        if (this.musicReady) this.report(this.musicSource ?? clip.source, new Error('the music could not be loaded'));
      }, { signal: this.lifecycle.signal });
    }
    if (this.musicSource !== clip.source) {
      const music = this.music;
      const source = clip.source;
      const request = ++this.musicRequest;
      this.musicSource = source;
      this.musicReady = false;
      music.pause();
      music.removeAttribute('src');
      this.media.stream(source, this.lifecycle.signal).then((stream) => {
        if (request !== this.musicRequest || this.disposed) return;
        if (stream.crossOrigin === null) music.removeAttribute('crossorigin');
        else music.crossOrigin = stream.crossOrigin;
        music.src = stream.url;
        this.musicReady = true;
        this.syncMusic();
      }, (error: unknown) => {
        if (request === this.musicRequest && !this.disposed) this.report(source, error);
      });
    }
    this.music.volume = Math.min(1, clip.volume * this.settings.volume);
    if (this.musicReady && this.unlocked && !this.paused) {
      const source = clip.source;
      void this.music.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) this.report(source, error);
      });
    } else {
      this.music.pause();
    }
  }

  private report(source: string, error: unknown): void {
    if (this.reported.has(source)) return;
    this.reported.add(source);
    this.onError(`Audio ${source} could not play: ${error instanceof Error ? error.message : String(error)}.`);
  }
}
