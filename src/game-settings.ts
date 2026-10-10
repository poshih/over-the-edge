import { DEFAULT_TUNING } from './config';
import type { Tuning } from './config';
import { ENEMY_BEHAVIOR } from './enemy-types';
import { HammerHeadError, validateHammerHead } from './hammer-head';
import { ARROW } from './hazards';
import { PotOutlineError, validatePotOutline } from './pot-outline';
import { DEFAULT_RIG_SETTINGS, MAX_RIG_REACH, MIN_SLIDER_TRAVEL, minReachLimit, RIG_LIMITS, rigGeometry } from './rig';
import type { RigLength, RigSettings } from './rig';

export const GAME_SETTINGS_SCHEMA_VERSION = 21;

export interface CursorSettings {
  // The farthest from the shoulder hinge the hammer aims; at most the rig's reach.
  readonly maxTargetRadius: number;
  // How far the cursor moves around the hammer's target before the hammer follows.
  readonly deadZone: number;
  // How much of the character's movement, in percent, the cursor and target share: 100 keeps their offset from the
  // shoulder hinge, 0 leaves them where they were in the world.
  readonly followCharacter: number;
  // Whether the target eases back toward the hammer head once aiming pauses while the head touches something. Off,
  // the target keeps its offset from the hinge until the player aims again.
  readonly returnToHammer: boolean;
  // How long aiming must pause, in run time, before the return starts.
  readonly returnDelay: number;
  // How fast it eases back, per second, and to where: this offset from the head's centre, in world metres.
  readonly returnRate: number;
  readonly returnOffsetX: number;
  readonly returnOffsetY: number;
}

export interface DeathSettings {
  readonly wait: number;
  readonly angularDamping: number;
  readonly friction: number;
}

export interface GameSettings {
  readonly schemaVersion: typeof GAME_SETTINGS_SCHEMA_VERSION;
  readonly physics: Readonly<Tuning>;
  readonly rig: Readonly<RigSettings>;
  readonly cursor: Readonly<CursorSettings>;
  readonly death: Readonly<DeathSettings>;
}

export const GAME_SETTINGS_LIMITS = { fileBytes: 64 * 1024 } as const;
export const DEFAULT_CURSOR_SETTINGS: Readonly<CursorSettings> = Object.freeze({
  maxTargetRadius: rigGeometry(DEFAULT_RIG_SETTINGS).maxReach,
  // About the hammer head's half-width, so small, unsteady input leaves the hammer where it is.
  deadZone: 0.1,
  followCharacter: 100,
  returnToHammer: false, returnDelay: 0.15, returnRate: 8, returnOffsetX: 0, returnOffsetY: 0,
});
export const DEFAULT_DEATH_SETTINGS: Readonly<DeathSettings> = Object.freeze({
  wait: 4, angularDamping: 2, friction: 0.45,
});
export const DEFAULT_GAME_SETTINGS: GameSettings = Object.freeze({
  schemaVersion: GAME_SETTINGS_SCHEMA_VERSION, physics: DEFAULT_TUNING, rig: DEFAULT_RIG_SETTINGS, cursor: DEFAULT_CURSOR_SETTINGS, death: DEFAULT_DEATH_SETTINGS,
});

interface NumericSetting {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  description: string;
}

interface TuningField extends NumericSetting {
  key: keyof Tuning;
  group: 'Mass & recoil' | 'Motors' | 'Downswing' | 'Response' | 'Materials' | 'Input' | 'Health' | 'Bonfires' | 'Hazards' | 'Enemies'
    | 'Liquids';
  // Whether the setting takes whole numbers only.
  whole?: true;
}

type RigField = NumericSetting & { key: RigLength };
type CursorField = NumericSetting & { key: Exclude<keyof CursorSettings, 'returnToHammer'> };
type DeathField = NumericSetting & { key: keyof DeathSettings };

export const DEATH_FIELDS: readonly DeathField[] = [
  { key: 'wait', label: 'Respawn wait', min: 0.5, max: 15, step: 0.1, unit: 's', description: 'Time from death to returning at the bonfire lit last, or restarting when none was. A death keeps the wait it entered with; the HUD fade does not change it.' },
  { key: 'angularDamping', label: 'Corpse angular damping', min: 0, max: 10, step: 0.1, unit: '/s', description: 'Passive rotational drag on the six ragdoll bodies. A death keeps the settings it entered with.' },
  { key: 'friction', label: 'Corpse friction', min: 0.05, max: 2, step: 0.05, unit: '', description: 'Contact friction on the ragdoll and released hammer shaft. The jar and hammer head keep their own materials. Applies at the next death.' },
];

export const RIG_FIELDS: readonly RigField[] = [
  { key: 'handleLength', label: 'Handle length', ...RIG_LIMITS.handleLength, step: 0.05, unit: 'm', description: 'From the butt to the centre of the head. Fully retracted, the head stops at the minimum reach from the shoulder hinge, so with none the butt travels this far behind it. Changing it rebuilds the player and restarts the run.' },
  { key: 'maxExtension', label: 'Maximum extension', ...RIG_LIMITS.maxExtension, step: 0.05, unit: 'm', description: 'How far the butt can slide past the shoulder hinge. The reach is the handle length plus this. Changing it rebuilds the player and restarts the run.' },
  { key: 'minReach', label: 'Minimum reach', ...RIG_LIMITS.minReach, step: 0.05, unit: 'm', description: `How close the head can come to the shoulder hinge, up to ${MIN_SLIDER_TRAVEL * 100} cm short of the reach: fully retracted, it stops this far out, and aiming nearer only turns the hammer. 0 lets the head reach the hinge. Changing it rebuilds the player and restarts the run.` },
];

// The radius is also capped at the rig's reach, which validateGameSettings checks.
export const CURSOR_FIELDS: readonly CursorField[] = [
  { key: 'maxTargetRadius', label: 'Maximum target radius', min: 0.25, max: MAX_RIG_REACH, step: 0.05, unit: 'm', description: 'Maximum distance from the shoulder hinge the hammer pivots on to the point the hammer aims at, up to the rig\'s reach (handle length plus maximum extension). Aiming moves this offset; character movement carries it along.' },
  { key: 'deadZone', label: 'Dead zone', min: 0, max: 0.5, step: 0.01, unit: 'm', description: 'How far the cursor can move around the point the hammer aims at before the hammer follows. Beyond it, the cursor drags that point along, so the cursor reaches this far past the maximum target radius; motion beyond that is discarded. Zero makes the hammer follow every movement.' },
  { key: 'followCharacter', label: 'Follow character', min: 0, max: 100, step: 1, unit: '%', description: 'How much of the character\'s movement the cursor and target share. At 100% they keep their offset from the shoulder hinge and ride along with the jar, so a jar that sinks or bounces drives the hammer into what it rests on, which can bounce the character with no input. Lower values leave them partly where they were in the world; at 0% only aiming and the return to the hammer move them. The target still stays within the maximum target radius.' },
];

// How the target returns to the hammer, used only while returnToHammer is on.
export const CURSOR_RETURN_FIELDS: readonly CursorField[] = [
  { key: 'returnDelay', label: 'Return delay', min: 0.05, max: 5, step: 0.05, unit: 's', description: 'How long aiming must pause, in run time, before the target starts returning while the hammer head touches a surface; any aiming input restarts the wait. At least 0.05 s, so the target never eases back between pointer updates while you aim.' },
  { key: 'returnRate', label: 'Return speed', min: 0.1, max: 60, step: 0.1, unit: '/s', description: 'How quickly the target eases toward the hammer head plus the return offset, once aiming pauses while the head touches a surface: it closes 63% of the gap in 1/speed seconds, so 1 /s takes about a second and 60 /s is all but instant. The cursor moves with it.' },
  { key: 'returnOffsetX', label: 'Return offset X', min: -MAX_RIG_REACH, max: MAX_RIG_REACH, step: 0.05, unit: 'm', description: 'Where the target returns to, across from the hammer head\'s centre in world space. Positive goes right; it does not turn with the hammer.' },
  { key: 'returnOffsetY', label: 'Return offset Y', min: -MAX_RIG_REACH, max: MAX_RIG_REACH, step: 0.05, unit: 'm', description: 'Where the target returns to, above or below the hammer head\'s centre in world space. Positive goes up; it does not turn with the hammer.' },
];

// The jar's and each terrain surface's friction coefficient.
const FRICTION_LIMITS = { min: 0.05, max: 10, step: 0.05, unit: '' } as const;

export const TUNING_FIELDS: readonly TuningField[] = [
  { key: 'hammerMass', label: 'Hammer head mass', group: 'Mass & recoil', min: 0.5, max: 4, step: 0.1, unit: 'kg', description: 'Lower head mass reduces swing recoil; higher mass increases momentum and motor load.' },
  { key: 'playerMass', label: 'Player mass', group: 'Mass & recoil', min: 6, max: 24, step: 0.5, unit: 'kg', description: 'Character mass shared by the root and pot, excluding hinge and tool components. A heavier player recoils less but is harder to lift.' },
  { key: 'angularSpeed', label: 'Rotation speed cap', group: 'Mass & recoil', min: 2, max: 18, step: 0.5, unit: 'rad/s', description: 'Lower this limit to soften fast swing kicks. It caps the hinge velocity target.' },
  { key: 'shaftMass', label: 'Shaft mass (total)', group: 'Mass & recoil', min: 0.15, max: 3, step: 0.01, unit: 'kg', description: 'Total shaft mass, evenly distributed along its length. It does not collide during live play; ragdoll death releases it and enables its contacts. Lower values reduce recoil.' },
  { key: 'hingeCarrierMass', label: 'Hinge carrier mass', group: 'Mass & recoil', min: 0.1, max: 2, step: 0.05, unit: 'kg', description: 'Hinge component mass carried at the shoulder, with matching rotor inertia on the driven tool. Its rotational inertia scales with its mass.' },
  { key: 'sliderCarriageMass', label: 'Slider carriage mass', group: 'Mass & recoil', min: 0.1, max: 2, step: 0.05, unit: 'kg', description: 'Carriage mass at the handle butt, part of the single tool body when rigid. Lower values reduce extension recoil.' },
  { key: 'hingeTorque', label: 'Hinge strength', group: 'Motors', min: 80, max: 1000, step: 10, unit: 'N m', description: 'Maximum rotational effort. This is not the requested motor speed.' },
  { key: 'sliderForce', label: 'Slider strength', group: 'Motors', min: 150, max: 2000, step: 25, unit: 'N', description: 'Maximum extension effort, including support against gravity.' },
  { key: 'linearSpeed', label: 'Extension speed cap', group: 'Motors', min: 1, max: 12, step: 0.5, unit: 'm/s', description: 'Upper bound on the slider velocity target.' },
  { key: 'hingeDownswingBoost', label: 'Hinge downswing boost', group: 'Downswing', min: 1, max: 3, step: 0.05, unit: 'x', description: 'Multiplies the hinge strength while input moves the hammer\'s target down and the hinge speeds the head up downward: fully for a head swung straight down, less the more sideways it swings. Holds without input keep the tuned strength. 1 turns the boost off.' },
  { key: 'sliderDownswingBoost', label: 'Slider downswing boost', group: 'Downswing', min: 1, max: 3, step: 0.05, unit: 'x', description: 'Multiplies the slider strength while input moves the hammer\'s target down and the slider speeds the head up downward, extending a hammer that points down or retracting one that points up: fully straight down, less the more sideways. 1 turns the boost off.' },
  { key: 'angleGain', label: 'Rotation response', group: 'Response', min: 2, max: 30, step: 0.5, unit: '/s', description: 'Angular position error becomes requested hinge speed.' },
  { key: 'angleDamping', label: 'Rotation damping', group: 'Response', min: 0, max: 0.8, step: 0.02, unit: '', description: 'Measured hinge speed opposes the angular command.' },
  { key: 'extensionGain', label: 'Extension response', group: 'Response', min: 2, max: 35, step: 0.5, unit: '/s', description: 'Error along the handle becomes requested slider speed.' },
  { key: 'extensionDamping', label: 'Extension damping', group: 'Response', min: 0, max: 0.8, step: 0.02, unit: '', description: 'Measured slider speed opposes the extension command.' },
  { key: 'bodyDamping', label: 'Body damping', group: 'Materials', min: 0, max: 1, step: 0.02, unit: '/s', description: 'Passive linear and angular drag on moving bodies.' },
  { key: 'gripFriction', label: 'Hammer friction', group: 'Materials', min: 0.2, max: 10, step: 0.05, unit: '', description: 'Contact friction on the hammer head, not an artificial grip. The shaft does not collide during live play; a released shaft takes the Death group\'s friction.' },
  { key: 'potFriction', label: 'Jar friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction on the pot, the jar, against what it stands on: any contact pushing it up at least as steeply as standing does, within 60° of straight up. It sets how well the jar rests on slopes and how much it scrapes as it slides. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'potSideFriction', label: 'Jar side friction', group: 'Materials', min: 0, max: 10, step: 0.05, unit: '', description: 'Contact friction on the jar\'s sides and top: every contact pushing it less steeply upward than standing does. 0 leaves them smooth, so the jar glides up an edge or a wall instead of catching on it. A contact\'s friction is the geometric mean of its two sides\', so 0 is smooth against any surface.' },
  { key: 'rockFriction', label: 'Rock friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Rock surface, the default. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'woodFriction', label: 'Wood friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Wood surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'metalFriction', label: 'Metal friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Metal surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'iceFriction', label: 'Ice friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Ice surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'rubberFriction', label: 'Rubber friction', group: 'Materials', ...FRICTION_LIMITS, description: 'Contact friction of terrain with the Rubber surface. A contact\'s friction is the geometric mean of its two sides\', so 3 against 0.45 grips like 1.16.' },
  { key: 'potBounciness', label: 'Jar bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much the pot, the jar, bounces off what it hits: 0% stops dead and 100% bounces back as fast as it came. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'hammerBounciness', label: 'Hammer bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much the hammer head bounces off what it hits: 0% stops dead and 100% bounces back as fast as it came. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'rockBounciness', label: 'Rock bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Rock surface, the default, bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'woodBounciness', label: 'Wood bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Wood surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'metalBounciness', label: 'Metal bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Metal surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'iceBounciness', label: 'Ice bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Ice surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'rubberBounciness', label: 'Rubber bounciness', group: 'Materials', min: 0, max: 100, step: 1, unit: '%', description: 'How much terrain with the Rubber surface bounces what hits it. A contact bounces as much as the bouncier of its two sides, and only when they meet faster than 1 m/s.' },
  { key: 'handleFrequency', label: 'Handle compliance', group: 'Materials', min: 0, max: 30, step: 1, unit: 'Hz', description: 'Zero uses one rigid tool body. Positive values enable rotational spring compliance. Crossing zero rebuilds the rig and restarts the run.' },
  { key: 'handleDamping', label: 'Handle damping', group: 'Materials', min: 0.1, max: 1, step: 0.05, unit: '', description: 'Damping ratio of compliant handle welds; only active above zero Hz.' },
  { key: 'mouseSensitivity', label: 'Control sensitivity', group: 'Input', min: 0.3, max: 2.5, step: 0.05, unit: 'x', description: 'Relative pointer movement. Touch uses the same CSS-pixel gain in either orientation; mouse follows the scene scale.' },
  { key: 'health', label: 'Health', group: 'Health', min: 1, max: 1000, step: 1, unit: 'HP', whole: true, description: 'Hit points the character has, shown as a bar. Every hurt source deals its damage in hit points: enemies the Enemies group\'s bump damage and archers its arrow damage, traps their own damage and lava its damage each second. Lighting a bonfire heals the player to full. A death, like a fall out of the level, brings the player back at the bonfire lit last, or restarts the run when none was. Shown only in levels with enemies, traps or lava.' },
  { key: 'hurtInvulnerability', label: 'Hurt invulnerability', group: 'Health', min: 0, max: 5, step: 0.05, unit: 's', description: 'How long an accepted damaging hit leaves the character unharmed. Zero turns this protection off. Applies to the next hit; an active protection keeps its deadline.' },
  { key: 'respawnInvulnerability', label: 'Respawn invulnerability', group: 'Health', min: 0, max: 10, step: 0.1, unit: 's', description: 'How long returning at a bonfire leaves the character unharmed. Zero turns this protection off. Applies at the next respawn.' },
  { key: 'bonfireBurnTime', label: 'Bonfire burn time', group: 'Bonfires', min: 1, max: 120, step: 0.5, unit: 's', description: 'How long a bonfire burns once the player reaches it and lights it, healing them to full, bringing every enemy back home at full health and making it the bonfire a death returns to, which brings the enemies back too. It goes out on its own, and only then does coming within reach again light it, healing the player and bringing the enemies back once more. Once out, it is still the bonfire a death returns to. Applies to the next bonfire lit; a burning one keeps its time.' },
  { key: 'hurtWidth', label: 'Hurt box width', group: 'Hazards', min: 0.2, max: 4, step: 0.05, unit: 'm', description: 'Width of the character box traps and arrows can hit, centred on the player\'s root. Changes apply live without changing the player collider.' },
  { key: 'hurtHeight', label: 'Hurt box height', group: 'Hazards', min: 0.2, max: 4, step: 0.02, unit: 'm', description: 'Height of the hurt box traps and arrows hit, measured from the pot\'s bottom up. Changes apply live without changing the player collider.' },
  { key: 'hurtDepth', label: 'Hurt box depth', group: 'Hazards', min: 0.1, max: 3, step: 0.05, unit: 'm', description: 'Total depth, half either side of the obstacle line, where axe blades can hit the character. Changes apply live and rebuild only the axe reach index.' },
  { key: 'projectilePush', label: 'Projectile push', group: 'Hazards', min: 0, max: 20, step: 0.1, unit: 'm/s', description: 'Velocity a projectile hit adds along its flight direction. Changes apply to the next hit, including projectiles already in flight.' },
  { key: 'projectileLift', label: 'Projectile lift', group: 'Hazards', min: 0, max: 20, step: 0.1, unit: 'm/s', description: 'Upward velocity a projectile hit adds on top of its push along the shot. Changes apply to the next hit.' },
  { key: 'axePush', label: 'Axe push', group: 'Hazards', min: 0, max: 30, step: 0.1, unit: 'm/s', description: 'Horizontal velocity an axe hit adds away from where its blade struck. Changes apply to the next hit.' },
  { key: 'axeLift', label: 'Axe lift', group: 'Hazards', min: 0, max: 20, step: 0.1, unit: 'm/s', description: 'Upward velocity an axe hit adds. Changes apply to the next hit.' },
  { key: 'hammerDamage', label: 'Hammer damage', group: 'Enemies', min: 1, max: 1000, step: 1, unit: 'HP', whole: true, description: `Hit points a hammer-head strike takes from an enemy when it closes at the full-damage speed or faster; slower strikes take proportionally less, at least 1. Strikes no faster than the enemy's armor, and repeats on an enemy within ${ENEMY_BEHAVIOR.hitSeconds} s, deal none. Applies to the next strike.` },
  { key: 'hammerFullSpeed', label: 'Full-damage strike speed', group: 'Enemies', min: 1, max: 20, step: 0.5, unit: 'm/s', description: 'Closing speed along the contact at which a hammer-head strike deals the full hammer damage; a strike at half this speed deals half. Applies to the next strike.' },
  { key: 'birdHealth', label: 'Bird health', group: 'Enemies', min: 1, max: 2000, step: 1, unit: 'HP', whole: true, description: 'Hit points of a bird; each hammer-head strike takes the hammer damage its speed earns. Applies at its next reset or spawn; existing enemies keep their current and maximum health.' },
  { key: 'birdArmor', label: 'Bird armor', group: 'Enemies', min: ENEMY_BEHAVIOR.minimumArmor, max: 20, step: 0.1, unit: 'm/s', description: `How fast a hammer-head strike must close on a bird to hurt it: slower strikes glance off, dealing no damage, and faster ones deal the hammer damage their speed earns. At least ${ENEMY_BEHAVIOR.minimumArmor} m/s, so brushing or holding the head against one never hurts. Applies to the next strike.` },
  { key: 'birdMass', label: 'Bird mass', group: 'Enemies', min: 0.1, max: 10, step: 0.05, unit: 'kg', description: 'Mass of a bird\'s collider. Changes update live bodies immediately; inactive birds take it when they wake.' },
  { key: 'birdAcceleration', label: 'Bird acceleration', group: 'Enemies', min: 1, max: 80, step: 1, unit: 'm/s²', description: 'Maximum acceleration as a bird steers toward its patrol, dive or recovery velocity. Applies live.' },
  { key: 'birdSight', label: 'Bird sight', group: 'Enemies', min: 0, max: 30, step: 0.5, unit: 'm', description: 'How far an active bird sees a player before warning and diving, also limited to this distance beyond its authored patrol radius. Applies live.' },
  { key: 'birdDiveSpeed', label: 'Bird dive speed', group: 'Enemies', min: 0.5, max: 20, step: 0.1, unit: 'm/s', description: 'Speed toward a bird\'s telegraphed target during its dive. Changes apply immediately, including during a dive.' },
  { key: 'soldierHealth', label: 'Soldier health', group: 'Enemies', min: 1, max: 2000, step: 1, unit: 'HP', whole: true, description: 'Hit points of a hollow soldier; each hammer-head strike takes the hammer damage its speed earns. Applies at its next reset or spawn; existing enemies keep their current and maximum health.' },
  { key: 'soldierArmor', label: 'Soldier armor', group: 'Enemies', min: ENEMY_BEHAVIOR.minimumArmor, max: 20, step: 0.1, unit: 'm/s', description: `How fast a hammer-head strike must close on a hollow soldier to hurt it: slower strikes glance off, dealing no damage, and faster ones deal the hammer damage their speed earns. At least ${ENEMY_BEHAVIOR.minimumArmor} m/s, so brushing or holding the head against one never hurts. Applies to the next strike.` },
  { key: 'soldierMass', label: 'Soldier mass', group: 'Enemies', min: 0.5, max: 30, step: 0.1, unit: 'kg', description: 'Mass of a hollow soldier\'s collider. Changes update live bodies immediately; inactive soldiers take it when they wake.' },
  { key: 'soldierAcceleration', label: 'Soldier acceleration', group: 'Enemies', min: 1, max: 80, step: 1, unit: 'm/s²', description: 'Maximum acceleration toward a hollow soldier\'s patrol velocity. Applies live.' },
  { key: 'archerHealth', label: 'Archer health', group: 'Enemies', min: 1, max: 2000, step: 1, unit: 'HP', whole: true, description: 'Hit points of a hollow archer; each hammer-head strike takes the hammer damage its speed earns. Applies at its next reset or spawn; existing enemies keep their current and maximum health.' },
  { key: 'archerArmor', label: 'Archer armor', group: 'Enemies', min: ENEMY_BEHAVIOR.minimumArmor, max: 20, step: 0.1, unit: 'm/s', description: `How fast a hammer-head strike must close on a hollow archer to hurt it: slower strikes glance off, dealing no damage, and faster ones deal the hammer damage their speed earns. At least ${ENEMY_BEHAVIOR.minimumArmor} m/s, so brushing or holding the head against one never hurts. Applies to the next strike.` },
  { key: 'archerMass', label: 'Archer mass', group: 'Enemies', min: 0.5, max: 30, step: 0.1, unit: 'kg', description: 'Mass of a hollow archer\'s collider. Changes update live bodies immediately; inactive archers take it when they wake.' },
  { key: 'archerAcceleration', label: 'Archer acceleration', group: 'Enemies', min: 1, max: 80, step: 1, unit: 'm/s²', description: 'Maximum acceleration toward a hollow archer\'s patrol velocity. Applies live.' },
  { key: 'archerSight', label: 'Archer sight', group: 'Enemies', min: 0, max: 30, step: 0.5, unit: 'm', description: `How far an active archer sees a player. It draws, warning, only when an arrow can reach the player within the ${ARROW.range} m it flies, along an arc clear of terrain, the low one or else the high one, and looses at the end of the draw if it still can. Applies live.` },
  { key: 'arrowSpeed', label: 'Arrow speed', group: 'Enemies', min: 2, max: 30, step: 0.5, unit: 'm/s', description: 'Speed an archer\'s arrows leave the bow at; they then fall under gravity, so this sets their reach: speed squared over gravity on level ground, 14.7 m at 12 m/s, and less uphill. Applies to the next shot.' },
  { key: 'arrowDamage', label: 'Arrow damage', group: 'Enemies', min: 0, max: 1000, step: 1, unit: 'HP', whole: true, description: 'Hit points an arrow takes from the player. It knocks the player with the Hazards group\'s projectile push and lift; zero leaves that knockback but deals no damage and grants no invulnerability. Applies to arrows loosed after the change.' },
  { key: 'bumpDamage', label: 'Enemy bump damage', group: 'Enemies', min: 0, max: 1000, step: 1, unit: 'HP', whole: true, description: 'Hit points an enemy\'s scripted bump takes from the player, in addition to knockback. Zero turns off bump damage. Applies to the next bump.' },
  { key: 'bumpSpeed', label: 'Enemy bump speed', group: 'Enemies', min: 0, max: 20, step: 0.1, unit: 'm/s', description: 'Horizontal velocity an enemy\'s scripted bump adds away from the enemy. Applies to the next bump.' },
  { key: 'bumpLift', label: 'Enemy bump lift', group: 'Enemies', min: 0, max: 20, step: 0.1, unit: 'm/s', description: 'Upward velocity an enemy\'s scripted bump adds. Applies to the next bump.' },
  { key: 'lavaBuoyancy', label: 'Lava buoyancy', group: 'Liquids', min: 0, max: 300, step: 5, unit: '%', description: 'How much of the player\'s weight lava holds up with the pot all under its surface: above 100% the player floats with part of the pot out, below it sinks. Only the pot floats: lava slows the hammer but does not hold it up.' },
  { key: 'lavaDrag', label: 'Lava drag', group: 'Liquids', min: 0, max: 20, step: 0.1, unit: '/s', description: 'How thick lava is: with the pot all under its surface the player slows at this rate, losing 63% of its speed in 1/rate seconds. The hammer meets it too, so swinging it through lava rows the player along.' },
  { key: 'lavaDamage', label: 'Lava damage', group: 'Liquids', min: 1, max: 1000, step: 1, unit: 'HP/s', whole: true, description: 'Hit points lava takes from the character while the pot is in it: on touching it, then each second it stays. The hammer does not burn.' },
  { key: 'swampBuoyancy', label: 'Swamp buoyancy', group: 'Liquids', min: 0, max: 300, step: 5, unit: '%', description: 'How much of the player\'s weight swamp holds up with the pot all under its surface: below 100% the player sinks through it, as slowly as its drag allows. Only the pot floats.' },
  { key: 'swampDrag', label: 'Swamp drag', group: 'Liquids', min: 0, max: 20, step: 0.1, unit: '/s', description: 'How thick swamp is: with the pot all under its surface the player slows at this rate, and the hammer drags through it too. Swamp does no damage; a thick one holds the player back.' },
];

export class GameSettingsError extends Error {}

function settingsFields(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new GameSettingsError(`${label} contains missing or unknown settings.`);
  }
}

function settingNumber(value: unknown, field: Pick<NumericSetting, 'label' | 'min' | 'max'>): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) {
    throw new GameSettingsError(`${field.label} must be between ${field.min} and ${field.max}.`);
  }
  return value;
}

function validateTuning(value: unknown): Tuning {
  settingsFields(value, TUNING_FIELDS.map((field) => field.key), 'Physics tuning');
  const result = { ...DEFAULT_TUNING };
  for (const field of TUNING_FIELDS) {
    result[field.key] = settingNumber(value[field.key], field);
    if (field.whole && !Number.isInteger(result[field.key])) throw new GameSettingsError(`${field.label} must be a whole number.`);
  }
  return Object.freeze(result);
}

function validateRig(value: unknown): RigSettings {
  settingsFields(value, [...RIG_FIELDS.map((field) => field.key), 'head', 'pot'], 'Hammer rig');
  const result = { ...DEFAULT_RIG_SETTINGS };
  for (const field of RIG_FIELDS) {
    result[field.key] = settingNumber(value[field.key], field);
  }
  try {
    result.head = validateHammerHead(value.head);
  } catch (error) {
    if (!(error instanceof HammerHeadError)) throw error;
    throw new GameSettingsError(`The hammer head: ${error.message}`);
  }
  try {
    result.pot = validatePotOutline(value.pot);
  } catch (error) {
    if (!(error instanceof PotOutlineError)) throw error;
    throw new GameSettingsError(`The jar: ${error.message}`);
  }
  const limit = minReachLimit(result);
  if (result.minReach > limit) {
    throw new GameSettingsError(`Minimum reach must be at most ${Number(limit.toFixed(3))} m, ${MIN_SLIDER_TRAVEL * 100} cm short of the hammer's ` +
      `${Number(rigGeometry(result).maxReach.toFixed(3))} m reach, so the slider can still move.`);
  }
  return Object.freeze(result);
}

// A new rig keeps a full-reach target radius at the full reach and caps a smaller one at the new reach; the minimum
// reach is capped where the slider can still move.
export function withRig(settings: Readonly<GameSettings>, rig: Readonly<RigSettings>): GameSettings {
  const previousReach = rigGeometry(settings.rig).maxReach;
  const reach = rigGeometry(rig).maxReach;
  const fullReach = settings.cursor.maxTargetRadius >= previousReach;
  return {
    ...settings, rig: { ...rig, minReach: Math.min(rig.minReach, minReachLimit(rig)) },
    cursor: { ...settings.cursor, maxTargetRadius: fullReach ? reach : Math.min(settings.cursor.maxTargetRadius, reach) },
  };
}

export function validateGameSettings(value: unknown): GameSettings {
  settingsFields(value, ['schemaVersion', 'physics', 'rig', 'cursor', 'death'], 'Game settings profile');
  if (value.schemaVersion !== GAME_SETTINGS_SCHEMA_VERSION) {
    throw new GameSettingsError(`Game settings require schema version ${GAME_SETTINGS_SCHEMA_VERSION}.`);
  }
  const rig = validateRig(value.rig);
  const numbers = [...CURSOR_FIELDS, ...CURSOR_RETURN_FIELDS];
  settingsFields(value.cursor, ['returnToHammer', ...numbers.map((field) => field.key)], 'Cursor settings');
  if (typeof value.cursor.returnToHammer !== 'boolean') throw new GameSettingsError('Return target to hammer must be true or false.');
  const cursor = { ...DEFAULT_CURSOR_SETTINGS, returnToHammer: value.cursor.returnToHammer };
  for (const field of numbers) cursor[field.key] = settingNumber(value.cursor[field.key], field);
  const reach = rigGeometry(rig).maxReach;
  if (cursor.maxTargetRadius > reach) {
    throw new GameSettingsError(`Maximum target radius must not exceed the hammer's ${Number(reach.toFixed(3))} m reach.`);
  }
  settingsFields(value.death, DEATH_FIELDS.map((field) => field.key), 'Death settings');
  const death: { -readonly [K in keyof DeathSettings]: DeathSettings[K] } = { ...DEFAULT_DEATH_SETTINGS };
  for (const field of DEATH_FIELDS) death[field.key] = settingNumber(value.death[field.key], field);
  return Object.freeze({ schemaVersion: GAME_SETTINGS_SCHEMA_VERSION, physics: validateTuning(value.physics), rig, cursor: Object.freeze(cursor), death: Object.freeze(death) });
}
