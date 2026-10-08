import { LEVEL_LIMITS } from './level';
import { ProjectError, validateFields } from './project-fields';
import type { FieldSpec } from './project-fields';

export interface ThemeLight {
  readonly color: string;
  readonly intensity: number;
}

// The scene's look: sky, fog, camera, lighting, backdrop, aim marker and the procedural character palette.
export interface GameTheme {
  readonly sky: string;
  // Depths behind the course plane (z = 0), so fog looks the same at any camera distance.
  readonly fog: { readonly color: string; readonly near: number; readonly far: number };
  readonly exposure: number;
  // The background's blur, a share of the view height, from sharp at blurNear to full at blurFar metres behind the course.
  readonly camera: {
    readonly perspective: boolean; readonly fieldOfView: number;
    readonly blur: number; readonly blurNear: number; readonly blurFar: number;
  };
  readonly hemisphere: { readonly sky: string; readonly ground: string; readonly intensity: number };
  readonly ambient: ThemeLight;
  readonly sun: ThemeLight;
  // The sunlight on the characters: the angle it comes from around the view and its tilt toward the camera, in
  // degrees, and the shadows the player's 3D character casts on itself, how dark (%) and how soft (cm).
  readonly characterLight: { readonly angle: number; readonly tilt: number; readonly shadow: number; readonly softness: number };
  readonly rim: ThemeLight;
  readonly sunDisc: { readonly visible: boolean; readonly color: string };
  readonly backdrop: { readonly visible: boolean; readonly far: string; readonly middle: string; readonly near: string };
  readonly aim: { readonly cursor: string; readonly line: string };
  readonly character: {
    readonly pot: string; readonly trim: string; readonly dark: string;
    readonly suit: string; readonly ceramic: string; readonly wood: string;
  };
}

// The nearest the background blur can start: behind everything on the course plane, which reaches half the deepest
// terrain's depth behind it, so what is played on stays as the screen draws it.
const BLUR_START = LEVEL_LIMITS.maximumDepth / 2 + 1;

const intensity = (path: string, label: string): FieldSpec =>
  ({ kind: 'number', path, label, min: 0, max: 10, step: 0.05, unit: 'x' });

export const THEME_FIELDS: readonly FieldSpec[] = [
  { kind: 'color', path: 'sky', label: 'Sky colour', description: 'Background colour behind the backdrop.' },
  { kind: 'color', path: 'fog.color', label: 'Fog colour', description: 'Distant objects fade toward this colour; usually close to the sky.' },
  { kind: 'number', path: 'fog.near', label: 'Fog start', min: -20, max: 1000, step: 1, unit: 'm', description: 'Depth behind the course where fog begins; below 0 the course itself is hazy.' },
  { kind: 'number', path: 'fog.far', label: 'Fog end', min: -19, max: 2000, step: 1, unit: 'm', description: 'Depth behind the course where fog is complete; must exceed the fog start. Decorations stand up to 1,000 m back.' },
  { kind: 'number', path: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.05, unit: 'x', description: 'Tone-mapping exposure for the whole scene.' },
  { kind: 'boolean', path: 'camera.perspective', label: 'Perspective camera', description: 'Nearer objects look larger and pass faster than distant ones. Off keeps the flat orthographic view; the course looks the same size either way.' },
  { kind: 'number', path: 'camera.fieldOfView', label: 'Field of view', min: 10, max: 90, step: 1, unit: '°', description: 'Vertical view angle of the perspective camera; wider angles deepen the perspective.' },
  { kind: 'number', path: 'camera.blur', label: 'Background blur', min: 0, max: 5, step: 0.05, unit: '%', description: 'How out of focus the background is, for an illusion of distance: the blur, in % of the view height, of what lies at the full-blur depth or farther behind the course, easing in from the blur start. The backdrop and sky blur too; whatever is nearer than the blur start, the characters and everything in front of the course stay sharp. 0 turns it off at no cost; on, what lies behind the blur start draws through an offscreen image.' },
  { kind: 'number', path: 'camera.blurNear', label: 'Blur start', min: BLUR_START, max: 999, step: 1, unit: 'm', description: `Depth behind the course up to which the background stays sharp: at least ${BLUR_START} m, behind everything on the course plane.` },
  { kind: 'number', path: 'camera.blurFar', label: 'Full blur', min: 1, max: 1000, step: 1, unit: 'm', description: 'Depth behind the course from which the background is fully blurred; must exceed the blur start. Decorations stand up to 1,000 m back.' },
  { kind: 'color', path: 'hemisphere.sky', label: 'Sky light colour' },
  { kind: 'color', path: 'hemisphere.ground', label: 'Ground bounce colour' },
  intensity('hemisphere.intensity', 'Sky light intensity'),
  { kind: 'color', path: 'ambient.color', label: 'Ambient light colour' },
  intensity('ambient.intensity', 'Ambient light intensity'),
  { kind: 'color', path: 'sun.color', label: 'Sunlight colour' },
  intensity('sun.intensity', 'Sunlight intensity'),
  { kind: 'number', path: 'characterLight.angle', label: 'Character light angle', min: 0, max: 360, step: 1, unit: '°', description: 'Where the sunlight on the characters comes from, around the view: 0° from the right, 90° from above, 180° from the left and 270° from below. It lights the player\'s character, enemies and phantoms with the sunlight\'s colour and intensity; the course keeps its own sunlight.' },
  { kind: 'number', path: 'characterLight.tilt', label: 'Character light tilt', min: -90, max: 90, step: 1, unit: '°', description: 'How far the light on the characters leans toward the camera, lighting their fronts (positive), or comes from behind the course, lighting their backs (negative); 0 skims along the course.' },
  { kind: 'number', path: 'characterLight.shadow', label: 'Character shadow', min: 0, max: 100, step: 1, unit: '%', description: 'How dark the shadows the player\'s 3D character casts on itself are, such as its hammer and arms on its body and jar or its head on its shoulders: 100% takes all of the light on the characters from what lies in shadow, leaving the sky, ambient and rim light. 0% turns them off at no cost; 2D characters never cast them.' },
  { kind: 'number', path: 'characterLight.softness', label: 'Character shadow softness', min: 0, max: 5, step: 0.5, unit: 'cm', description: 'How far the edges of the character\'s shadows blur.' },
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
  if (theme.camera.blurFar <= theme.camera.blurNear) throw new ProjectError('The full-blur depth must be farther than the blur start.');
  return theme;
}

// The original hand-tuned look; releases without a project keep rendering exactly this.
export const DEFAULT_THEME: GameTheme = validateTheme({
  sky: '#d8e3d6',
  fog: { color: '#d8e3d6', near: 15, far: 65 },
  exposure: 1.35,
  camera: { perspective: false, fieldOfView: 30, blur: 0, blurNear: 5, blurFar: 40 },
  hemisphere: { sky: '#fff6db', ground: '#4b6866', intensity: 2.4 },
  ambient: { color: '#f4e4ca', intensity: 0.5 },
  sun: { color: '#fff0d4', intensity: 3 },
  characterLight: { angle: 113, tilt: 38, shadow: 60, softness: 1 },
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
