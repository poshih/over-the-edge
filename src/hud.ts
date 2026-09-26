import { validateFields } from './project-fields';
import type { FieldSpec } from './project-fields';

// What the game-only release shows in its corner readout.
export interface HudSettings {
  readonly height: {
    readonly visible: boolean; readonly label: string; readonly unit: string;
    readonly scale: number; readonly decimals: number;
  };
  readonly timer: { readonly visible: boolean; readonly label: string };
}

export const HUD_FIELDS: readonly FieldSpec[] = [
  { kind: 'boolean', path: 'height.visible', label: 'Show the height readout' },
  { kind: 'text', path: 'height.label', label: 'Height label', minLength: 1, maxLength: 32 },
  { kind: 'text', path: 'height.unit', label: 'Height unit', minLength: 0, maxLength: 8, description: 'Shown after the number; may be empty.' },
  { kind: 'number', path: 'height.scale', label: 'Height scale', min: 0.001, max: 1000, step: 0.001, unit: 'x', description: 'Metres are multiplied by this; 3.28084 shows feet.' },
  { kind: 'number', path: 'height.decimals', label: 'Height decimals', min: 0, max: 3, step: 1, unit: '', integer: true },
  { kind: 'boolean', path: 'timer.visible', label: 'Show the timer' },
  { kind: 'text', path: 'timer.label', label: 'Timer label', minLength: 1, maxLength: 32 },
];

export function validateHud(value: unknown): HudSettings {
  return validateFields<HudSettings>(value, HUD_FIELDS, 'HUD');
}

export const DEFAULT_HUD: HudSettings = validateHud({
  height: { visible: true, label: 'CURRENT HEIGHT', unit: 'm', scale: 1, decimals: 1 },
  timer: { visible: true, label: 'ELAPSED' },
});

export function formatHeight(hud: HudSettings, metres: number): string {
  return (metres * hud.height.scale).toFixed(hud.height.decimals);
}
