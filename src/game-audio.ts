import type { AudioSettings, GameCue } from './audio-settings';
import type { MediaHost } from './media-host';
import type { AudioDevice } from './audio-device';
import { PluginError, slotPoint } from './plugins/kernel';

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

export function createGameAudio(factory: GameAudioFactory, setup: GameAudioSetup, plugin: string | null): GameAudio {
  try {
    const audio: unknown = factory(setup);
    if (typeof audio !== 'object' || audio === null || Array.isArray(audio) ||
      !['handle', 'setPaused', 'setSettings', 'setMedia', 'dispose'].every((method) => typeof Reflect.get(audio, method) === 'function') ||
      Reflect.get(audio, 'inspect') !== undefined && typeof Reflect.get(audio, 'inspect') !== 'function') {
      throw new PluginError('invalid-contribution',
        `Plugin "${plugin ?? 'engine'}": "${AUDIO.id}" must return handle(cue), setPaused(paused), setSettings(settings), setMedia(media), dispose() and, when given, inspect().`,
        plugin, AUDIO.id);
    }
    const output = audio as GameAudio;
    let disposed = false;
    // The output's lifetime is independent of gameplay: editor previews can outlive a halted Game,
    // but a queued cue must never call a plugin after its audio has been disposed.
    const owned: GameAudio = {
      handle(cue) { if (!disposed) output.handle(cue); },
      setPaused(paused) { if (!disposed) output.setPaused(paused); },
      setSettings(settings) { if (!disposed) output.setSettings(settings); },
      setMedia(media) { if (!disposed) output.setMedia(media); },
      dispose() {
        if (disposed) return;
        disposed = true;
        output.dispose();
      },
    };
    if (output.inspect !== undefined) owned.inspect = () => output.inspect!();
    return owned;
  } catch (error) {
    if (error instanceof PluginError && error.plugin === plugin && error.point === AUDIO.id) throw error;
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${AUDIO.id}".`,
      plugin, AUDIO.id, { cause: error });
  }
}
