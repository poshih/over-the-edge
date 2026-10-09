// The player's own settings in a release: how loud it plays, how far the hammer moves for the pointer's travel and
// which character plays. Volume and sensitivity scale the project's own, and the browser keeps all three for the next
// visit. The corner character choice and a game's main menu change them; see docs/release-plugins.md#player-settings.
import type { AudioSettings } from './audio-settings';

export interface PlayerSettings {
  // Scales the project's master volume: 0 is silent, 1 plays as authored.
  readonly volume: number;
  // Scales the project's control sensitivity, for the mouse and touch alike.
  readonly sensitivity: number;
  // The character that plays: 0, or 1 for the second in a release with two.
  readonly character: number;
}

export const PLAYER_SETTINGS_LIMITS = Object.freeze({
  volume: Object.freeze({ min: 0, max: 1 }),
  sensitivity: Object.freeze({ min: 0.25, max: 4 }),
});

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = Object.freeze({ volume: 1, sensitivity: 1, character: 0 });

const STORAGE_KEY = 'over-the-edge:play:settings';

function within(value: unknown, limits: { readonly min: number; readonly max: number }): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= limits.min && value <= limits.max;
}

// `settings` with `changes`, any of its fields, in a release with `characters` characters. Throws a RangeError stating
// the rule a change breaks, such as "must set volume to a number from 0 to 1".
export function changePlayerSettings(settings: PlayerSettings, changes: unknown, characters: number): PlayerSettings {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    throw new RangeError('must change settings with an object of volume, sensitivity and character');
  }
  let { volume, sensitivity, character } = settings;
  for (const key of Object.keys(changes)) {
    const value: unknown = Reflect.get(changes, key);
    if (key === 'volume') {
      const limits = PLAYER_SETTINGS_LIMITS.volume;
      if (!within(value, limits)) throw new RangeError(`must set volume to a number from ${limits.min} to ${limits.max}`);
      volume = value;
    } else if (key === 'sensitivity') {
      const limits = PLAYER_SETTINGS_LIMITS.sensitivity;
      if (!within(value, limits)) throw new RangeError(`must set sensitivity to a number from ${limits.min} to ${limits.max}`);
      sensitivity = value;
    } else if (key === 'character') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= characters) {
        throw new RangeError(`must set character to a whole number from 0 to ${characters - 1}`);
      }
      character = value;
    } else {
      throw new RangeError(`must change only volume, sensitivity and character, not "${key}"`);
    }
  }
  return Object.freeze({ volume, sensitivity, character });
}

// The settings this browser keeps, or the defaults when it keeps none or they no longer fit. The release checks the
// character once it knows how many it has.
export function readPlayerSettings(): PlayerSettings {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text === null ? DEFAULT_PLAYER_SETTINGS
      : changePlayerSettings(DEFAULT_PLAYER_SETTINGS, JSON.parse(text), Number.POSITIVE_INFINITY);
  } catch (error) {
    // Storage may be unavailable, and what it holds may be malformed or out of range.
    if (error instanceof DOMException || error instanceof SyntaxError || error instanceof RangeError) return DEFAULT_PLAYER_SETTINGS;
    throw error;
  }
}

// Keeps the settings for the next visit, when the browser keeps anything.
export function writePlayerSettings(settings: PlayerSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

// The project's audio as the player hears it: its master volume scaled by theirs.
export function playerAudio(audio: AudioSettings, settings: PlayerSettings): AudioSettings {
  return Object.freeze({ ...audio, volume: audio.volume * settings.volume });
}
