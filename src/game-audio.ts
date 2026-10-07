import type { AudioSettings, GameCue } from './audio-settings';
import type { MediaHost } from './media-host';
import type { AudioDevice } from './audio-device';
import { attributed, call0, call1, createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';

export interface GameAudio {
  handle(cue: GameCue): void;
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
  handle() {},
  setPaused() {},
  setSettings() {},
  setMedia() {},
  dispose() {},
});

const AUDIO_CONTRACT = instanceContract({
  returns: 'handle(cue), setPaused(paused), setSettings(settings), setMedia(media), dispose() and, when given, inspect()',
  methods: ['handle', 'setPaused', 'setSettings', 'setMedia', 'dispose'],
  optional: ['inspect'],
});

export function createGameAudio(factory: Attributed<GameAudioFactory>, setup: GameAudioSetup): Attributed<GameAudio> {
  const create = factory.value;
  const output = createInstance<GameAudio>(AUDIO_CONTRACT, factory, () => create(setup));
  let disposed = false;
  // The output's lifetime is independent of gameplay: editor previews can outlive a halted Game,
  // but neither a staged gameplay cue nor a preview may call a disposed output.
  const owned: GameAudio = {
    handle(cue) { if (!disposed) call1(output, 'handle', cue); },
    setPaused(paused) { if (!disposed) call1(output, 'setPaused', paused); },
    setSettings(settings) { if (!disposed) call1(output, 'setSettings', settings); },
    setMedia(media) { if (!disposed) call1(output, 'setMedia', media); },
    dispose() {
      if (disposed) return;
      disposed = true;
      call0(output, 'dispose');
    },
  };
  if (output.value.inspect !== undefined) owned.inspect = () => call0(output, 'inspect');
  return attributed(output.plugin, output.point, owned);
}
