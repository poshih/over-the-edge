import type { AudioCue, AudioSettings } from './audio-settings';
import type { Moment } from './moments';
import type { MediaHost } from './media-host';
import type { AudioDevice } from './audio-device';
import { call0, call1, createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';

export interface GameAudio {
  // Every moment, after effects; borrowed only for this synchronous call.
  moment(moment: Moment): void;
  // Workshop tests one authored cue at full strength, without gameplay's impact limit.
  preview(cue: AudioCue): void;
  setPaused(paused: boolean): void;
  setSettings(settings: AudioSettings): void;
  setMedia(media: MediaHost): void;
  dispose(): void;
  inspect?(): unknown;
}

export interface GameAudioSetup {
  readonly settings: AudioSettings;
  readonly media: MediaHost;
  // Authored play-sound sources, preloaded along with the project's cues.
  readonly sounds: readonly string[];
  readonly device: AudioDevice;
  notice(message: string): void;
}

export type GameAudioFactory = (setup: GameAudioSetup) => GameAudio;

export const AUDIO = slotPoint('audio.output', 'runtime', (value: unknown): GameAudioFactory => {
  if (typeof value !== 'function') throw new TypeError('An audio output must be a factory.');
  return value as GameAudioFactory;
});

// The silent release base has no dependency on the optional AudioDirector implementation.
export const SILENT_AUDIO_OUTPUT: GameAudioFactory = () => ({
  moment() {},
  preview() {},
  setPaused() {},
  setSettings() {},
  setMedia() {},
  dispose() {},
});

export function momentCue(moment: Moment): AudioCue | null {
  switch (moment.type) {
    case 'hurt': return moment.health > 0 ? 'hurt' : null;
    case 'placed':
    case 'sound': return null;
    default: return moment.type;
  }
}

const AUDIO_CONTRACT = instanceContract({
  returns: 'moment(moment), preview(cue), setPaused(paused), setSettings(settings), setMedia(media), dispose() and, when given, inspect()',
  methods: ['moment', 'preview', 'setPaused', 'setSettings', 'setMedia', 'dispose'],
  optional: ['inspect'],
});

// Host-owned: it can outlive a halted Game, but no method calls the plugin after disposal.
export class AudioOutput {
  private disposed = false;
  private readonly output: Attributed<GameAudio>;

  constructor(output: Attributed<GameAudio>) { this.output = output; }

  moment(moment: Moment): void { if (!this.disposed) call1(this.output, 'moment', moment); }
  preview(cue: AudioCue): void { if (!this.disposed) call1(this.output, 'preview', cue); }
  setPaused(paused: boolean): void { if (!this.disposed) call1(this.output, 'setPaused', paused); }
  setSettings(settings: AudioSettings): void { if (!this.disposed) call1(this.output, 'setSettings', settings); }
  setMedia(media: MediaHost): void { if (!this.disposed) call1(this.output, 'setMedia', media); }
  inspect(): unknown {
    return this.disposed || this.output.value.inspect === undefined ? null : call0(this.output, 'inspect');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    call0(this.output, 'dispose');
  }
}

export function createAudioOutput(factory: Attributed<GameAudioFactory>, setup: GameAudioSetup): AudioOutput {
  const create = factory.value;
  return new AudioOutput(createInstance<GameAudio>(AUDIO_CONTRACT, factory, () => create(setup)));
}
