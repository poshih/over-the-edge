// How a game looks, as one value: what a project says about the theme, the HUD, the enemies' art and the course's GLBs.
// A release makes its game with the look its content holds; the Workshop gives its game the open project's look, as
// edited, through `Game.setLook`. Nothing else sets how a game looks.
import { NO_DECORATION_ART } from './decoration-art';
import type { DecorationArt } from './decoration-art';
import { DEFAULT_ENEMY_ART } from './enemy-art-data';
import type { EnemyArtSettings } from './enemy-art-data';
import { DEFAULT_HUD } from './hud';
import type { HudSettings } from './hud';
import { DEFAULT_THEME } from './theme';
import type { GameTheme } from './theme';

/** The course artwork a game draws: its GLBs, by asset ID with their names, and the GLB drawing each model it maps. */
export interface CourseArtwork {
  readonly assets: readonly { readonly id: string; readonly name: string }[];
  readonly decorations: DecorationArt;
}

export interface GameLook {
  readonly theme: GameTheme;
  readonly hud: HudSettings;
  readonly enemies: EnemyArtSettings;
  readonly art: CourseArtwork;
}

export const NO_COURSE_ARTWORK: CourseArtwork = Object.freeze({ assets: Object.freeze([]), decorations: NO_DECORATION_ART });

export const DEFAULT_LOOK: GameLook = Object.freeze({
  theme: DEFAULT_THEME, hud: DEFAULT_HUD, enemies: DEFAULT_ENEMY_ART, art: NO_COURSE_ARTWORK,
});
