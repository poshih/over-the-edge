import { ProjectError, validateFields } from './project-fields';
import type { FieldSpec } from './project-fields';

export interface ThemeLight {
  readonly color: string;
  readonly intensity: number;
}

// The scene's look: sky, fog, lighting, backdrop, aim marker and the procedural character palette.
export interface GameTheme {
  readonly sky: string;
  readonly fog: { readonly color: string; readonly near: number; readonly far: number };
  readonly exposure: number;
  readonly hemisphere: { readonly sky: string; readonly ground: string; readonly intensity: number };
  readonly ambient: ThemeLight;
  readonly sun: ThemeLight;
  readonly rim: ThemeLight;
  readonly sunDisc: { readonly visible: boolean; readonly color: string };
  readonly backdrop: { readonly visible: boolean; readonly far: string; readonly middle: string; readonly near: string };
  readonly aim: { readonly cursor: string; readonly line: string };
  readonly character: {
    readonly pot: string; readonly trim: string; readonly dark: string;
    readonly suit: string; readonly ceramic: string; readonly wood: string;
  };
}

const intensity = (path: string, label: string): FieldSpec =>
  ({ kind: 'number', path, label, min: 0, max: 10, step: 0.05, unit: 'x' });

export const THEME_FIELDS: readonly FieldSpec[] = [
  { kind: 'color', path: 'sky', label: 'Sky colour', description: 'Background colour behind the backdrop.' },
  { kind: 'color', path: 'fog.color', label: 'Fog colour', description: 'Distant objects fade toward this colour; usually close to the sky.' },
  { kind: 'number', path: 'fog.near', label: 'Fog start', min: 0, max: 500, step: 1, unit: 'm', description: 'Distance from the camera where fog begins.' },
  { kind: 'number', path: 'fog.far', label: 'Fog end', min: 1, max: 1000, step: 1, unit: 'm', description: 'Distance where fog is complete; must exceed the fog start.' },
  { kind: 'number', path: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.05, unit: 'x', description: 'Tone-mapping exposure for the whole scene.' },
  { kind: 'color', path: 'hemisphere.sky', label: 'Sky light colour' },
  { kind: 'color', path: 'hemisphere.ground', label: 'Ground bounce colour' },
  intensity('hemisphere.intensity', 'Sky light intensity'),
  { kind: 'color', path: 'ambient.color', label: 'Ambient light colour' },
  intensity('ambient.intensity', 'Ambient light intensity'),
  { kind: 'color', path: 'sun.color', label: 'Sunlight colour' },
  intensity('sun.intensity', 'Sunlight intensity'),
  { kind: 'color', path: 'rim.color', label: 'Rim light colour' },
  intensity('rim.intensity', 'Rim light intensity'),
  { kind: 'boolean', path: 'sunDisc.visible', label: 'Show the sun disc' },
  { kind: 'color', path: 'sunDisc.color', label: 'Sun disc colour' },
  { kind: 'boolean', path: 'backdrop.visible', label: 'Show backdrop mountains' },
  { kind: 'color', path: 'backdrop.far', label: 'Far mountains' },
  { kind: 'color', path: 'backdrop.middle', label: 'Middle mountains' },
  { kind: 'color', path: 'backdrop.near', label: 'Near mountains' },
  { kind: 'color', path: 'aim.cursor', label: 'Aim cursor' },
  { kind: 'color', path: 'aim.line', label: 'Aim line' },
  { kind: 'color', path: 'character.pot', label: 'Pot metal', description: 'Procedural Mesh parts character; imported models keep their own colours.' },
  { kind: 'color', path: 'character.trim', label: 'Pot trim' },
  { kind: 'color', path: 'character.dark', label: 'Dark details' },
  { kind: 'color', path: 'character.suit', label: 'Suit' },
  { kind: 'color', path: 'character.ceramic', label: 'Skin and badge' },
  { kind: 'color', path: 'character.wood', label: 'Hammer handle' },
];

export function validateTheme(value: unknown): GameTheme {
  const theme = validateFields<GameTheme>(value, THEME_FIELDS, 'Theme');
  if (theme.fog.far <= theme.fog.near) throw new ProjectError('The fog end must be farther than the fog start.');
  return theme;
}

// The original hand-tuned look; releases without a project keep rendering exactly this.
export const DEFAULT_THEME: GameTheme = validateTheme({
  sky: '#d8e3d6',
  fog: { color: '#d8e3d6', near: 35, far: 85 },
  exposure: 1.35,
  hemisphere: { sky: '#fff6db', ground: '#4b6866', intensity: 2.4 },
  ambient: { color: '#f4e4ca', intensity: 0.5 },
  sun: { color: '#fff0d4', intensity: 3 },
  rim: { color: '#9ce7d5', intensity: 1.5 },
  sunDisc: { visible: true, color: '#f6e5bd' },
  backdrop: { visible: true, far: '#b9cbbc', middle: '#9fb7aa', near: '#87a69a' },
  aim: { cursor: '#ffffff', line: '#365650' },
  character: { pot: '#b9874e', trim: '#e5c180', dark: '#233f41', suit: '#cd7651', ceramic: '#ece1c6', wood: '#815636' },
});

// Whether text drawn over the sky needs a light colour to stay legible (WCAG relative luminance).
export function isDarkSky(theme: GameTheme): boolean {
  const channel = (offset: number): number => {
    const value = Number.parseInt(theme.sky.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) < 0.18;
}
