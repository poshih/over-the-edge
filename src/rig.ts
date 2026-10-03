import { RIG } from './config.ts';
import { DEFAULT_HAMMER_HEAD } from './hammer-head.ts';
import type { HammerHead } from './hammer-head.ts';

// The configurable part of the hammer rig, set per game in its settings.
export interface RigSettings {
  // From the butt to the head's centre.
  readonly handleLength: number;
  // How far the butt can slide past the shoulder hinge.
  readonly maxExtension: number;
  // The closest the head comes to the shoulder hinge, at least MIN_SLIDER_TRAVEL short of the reach; 0 lets it
  // reach the hinge.
  readonly minReach: number;
  // The default hammer's head outline; a model-library hammer brings its own.
  readonly head: HammerHead;
}

// The rig settings set by sliders.
export type RigLength = Exclude<keyof RigSettings, 'head'>;

export const DEFAULT_RIG_SETTINGS: Readonly<RigSettings> = Object.freeze({ handleLength: 1.5, maxExtension: 1.15, minReach: 0, head: DEFAULT_HAMMER_HEAD });

// The least usable slider travel. Keep a nonzero workspace between the polar drive's two stops.
export const MIN_SLIDER_TRAVEL = 0.05;
const HANDLE_LENGTH_LIMITS = { min: 0.75, max: 3 } as const;
const MAX_EXTENSION_LIMITS = { min: 0, max: 2 } as const;
// The longest reach any valid rig has.
export const MAX_RIG_REACH = HANDLE_LENGTH_LIMITS.max + MAX_EXTENSION_LIMITS.max;

export const RIG_LIMITS = {
  handleLength: HANDLE_LENGTH_LIMITS,
  maxExtension: MAX_EXTENSION_LIMITS,
  // Also capped at minReachLimit, which validateGameSettings checks.
  minReach: { min: 0, max: MAX_RIG_REACH - MIN_SLIDER_TRAVEL },
} as const;

// Everything the physics, rendering and input derive from the rig settings.
export interface RigGeometry extends RigSettings {
  // Fully retracted, the head sits the minimum reach from the shoulder hinge.
  readonly minExtension: number;
  readonly maxReach: number;
  readonly segmentLength: number;
}

export function rigGeometry(settings: Readonly<RigSettings>): RigGeometry {
  return Object.freeze({
    handleLength: settings.handleLength,
    maxExtension: settings.maxExtension,
    minReach: settings.minReach,
    head: settings.head,
    minExtension: settings.minReach - settings.handleLength,
    // Float sums such as 2.05 + 0.55 land just off their decimal; nanometres keep the reach equal to it.
    maxReach: Math.round((settings.handleLength + settings.maxExtension) * 1e9) / 1e9,
    segmentLength: settings.handleLength / RIG.handleSegments,
  });
}

// The largest minimum reach a rig with this handle and extension allows: the slider keeps MIN_SLIDER_TRAVEL.
export function minReachLimit(settings: Readonly<Pick<RigSettings, 'handleLength' | 'maxExtension'>>): number {
  return Math.round((settings.handleLength + settings.maxExtension - MIN_SLIDER_TRAVEL) * 1e9) / 1e9;
}

// Whether two rigs build the same player. The head is not compared: it changes in place, mid-run.
export function sameRig(left: Readonly<RigSettings>, right: Readonly<RigSettings>): boolean {
  return left.handleLength === right.handleLength && left.maxExtension === right.maxExtension && left.minReach === right.minReach;
}
