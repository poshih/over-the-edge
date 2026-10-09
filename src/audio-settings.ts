import { exactRecord, numberValue } from './project-fields';
import { mediaSource } from './media';

// Gameplay moments that can play a sound effect.
export const AUDIO_CUES = ['impact', 'block', 'enemy-hit', 'enemy-defeat', 'launch', 'finish', 'hurt', 'death', 'fall', 'bonfire'] as const;
export type AudioCue = (typeof AUDIO_CUES)[number];
export const AUDIO_CUE_LABELS: Readonly<Record<AudioCue, string>> = {
  impact: 'Hammer impact', block: 'Hammer block', 'enemy-hit': 'Enemy hit', 'enemy-defeat': 'Enemy defeated',
  launch: 'Updraft launch', finish: 'Timer stops', hurt: 'Player hurt', death: 'Player death', fall: 'Fall out of the level',
  bonfire: 'Bonfire lit',
};
export const AUDIO_CUE_DESCRIPTIONS: Readonly<Record<AudioCue, string>> = {
  impact: 'The hammer head strikes terrain or an enemy; louder for faster strikes.',
  block: 'A projectile strikes the hammer head, held or released.',
  'enemy-hit': 'A strike damages an enemy that survives it.',
  'enemy-defeat': 'An enemy is defeated.',
  launch: 'A Launch player event (for example an updraft) fires.',
  finish: 'A Stop timer event fires, usually at the summit.',
  hurt: 'An enemy, a trap or lava hurts the player, who survives it.',
  death: 'The player\'s health runs out.',
  fall: 'The player falls out of the level.',
  bonfire: 'The hammer lights a bonfire, which heals the player, brings every enemy back and becomes where a death returns.',
};

export interface AudioClip {
  readonly source: string;
  readonly volume: number;
}

export interface AudioSettings {
  readonly volume: number;
  readonly music: AudioClip | null;
  readonly cues: Readonly<Record<AudioCue, AudioClip | null>>;
}

export const AUDIO_VOLUME = { label: 'Volume', min: 0, max: 1, step: 0.05, unit: '' } as const;

export function validateAudioClip(value: unknown, label: string): AudioClip {
  const clip = exactRecord(value, ['source', 'volume'], label);
  return Object.freeze({
    source: mediaSource(clip.source, `${label} source`),
    volume: numberValue(clip.volume, AUDIO_VOLUME.min, AUDIO_VOLUME.max, `${label} volume`),
  });
}

export function validateAudio(value: unknown): AudioSettings {
  const audio = exactRecord(value, ['volume', 'music', 'cues'], 'Audio');
  const cues = exactRecord(audio.cues, AUDIO_CUES, 'Audio cues');
  return Object.freeze({
    volume: numberValue(audio.volume, AUDIO_VOLUME.min, AUDIO_VOLUME.max, 'Master volume'),
    music: audio.music === null ? null : validateAudioClip(audio.music, 'Music'),
    cues: Object.freeze(Object.fromEntries(AUDIO_CUES.map(cue =>
      [cue, cues[cue] === null ? null : validateAudioClip(cues[cue], AUDIO_CUE_LABELS[cue])])) as Record<AudioCue, AudioClip | null>),
  });
}

export const DEFAULT_AUDIO: AudioSettings = validateAudio({
  volume: 1, music: null, cues: Object.fromEntries(AUDIO_CUES.map(cue => [cue, null])),
});

export function audioSources(audio: AudioSettings): string[] {
  return [audio.music, ...AUDIO_CUES.map(cue => audio.cues[cue])].flatMap(clip => clip === null ? [] : [clip.source]);
}

export function hasAudio(audio: AudioSettings): boolean {
  return audio.music !== null || AUDIO_CUES.some(cue => audio.cues[cue] !== null);
}
